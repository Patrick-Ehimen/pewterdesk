//! The daemon's two doors and what's behind them: a Unix socket (mode
//! 0600) for `pd`, and a WebSocket on 127.0.0.1 for the app, both speaking
//! the protocol (`pewterdesk_protocol::rpc`), one JSON-RPC message per line
//! or per frame.
//!
//! Security-relevant (docs/bots/safety.md):
//! - This machine only: the socket is this user's alone, the WebSocket
//!   listens on 127.0.0.1, refuses any browser (an `Origin` header) and any
//!   `Host` but its own (DNS rebinding), as `browser_connect.rs` does.
//! - Paired clients only: until a client's `hello` carries a paired token,
//!   it can only ask to be paired.
//! - The six trading operations go through the engine's router - the gate,
//!   the log, client ids - as from the app; `pd`'s are logged as `pd`,
//!   whatever it says. Nothing here signs anything or touches a key.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use pewterdesk_core::{
    Decimal, Order, OrderKind, OrderRequest, Origin, PositionSide, Side, VenueError, VenueId,
};
use pewterdesk_protocol::rpc::{
    code, read_request, Call, ClientKind, Event, Halted, Notification, Response, RpcError, Status,
    Target, Welcome, PROTOCOL_VERSION,
};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request, Response as WsResponse,
};
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::host::Daemon;

/// The longest message read: anything larger closes the connection.
pub const MAX_MESSAGE: usize = 1 << 20;
/// The widest market-order bound `flatten` takes, in basis points.
const MAX_SLIPPAGE_BPS: u32 = 5_000;
const HISTORY_MAX: usize = 200;

/// One connection's state.
#[derive(Default)]
struct Session {
    /// `hello` said, with its client kind.
    kind: Option<ClientKind>,
    /// The paired client it proved to be.
    client: Option<String>,
    subscribed: bool,
}

fn venue_error(e: VenueError) -> RpcError {
    RpcError::venue(&e)
}

fn answer<T: Serialize>(result: Result<T, VenueError>) -> Result<Value, RpcError> {
    let value = result.map_err(venue_error)?;
    serde_json::to_value(value).map_err(|e| RpcError::new(code::INTERNAL, e.to_string()))
}

fn ok<T: Serialize>(value: T) -> Result<Value, RpcError> {
    answer(Ok::<T, VenueError>(value))
}

impl Session {
    /// Where in the app a command came from: `pd` for `pd`, whatever it
    /// says; the app's own label for the app.
    fn origin(&self, target: &Target) -> Origin {
        match self.kind {
            Some(ClientKind::App) => target.origin.unwrap_or(Origin::App),
            _ => Origin::Pd,
        }
    }

    fn origin_plain(&self) -> Origin {
        match self.kind {
            Some(ClientKind::App) => Origin::App,
            _ => Origin::Pd,
        }
    }
}

/// Closes `account`'s positions (one market's, or all) at market, reduce-only,
/// each through the router like any order.
async fn flatten(
    d: &Daemon,
    origin: Origin,
    venue: VenueId,
    account: &str,
    market: Option<&str>,
    max_slippage_bps: u32,
) -> Result<Vec<Order>, VenueError> {
    if max_slippage_bps == 0 || max_slippage_bps > MAX_SLIPPAGE_BPS {
        return Err(VenueError::InvalidRequest(
            "the slippage bound is out of range".into(),
        ));
    }
    let snapshot = d.venues.adapter(venue)?.account(account).await?;
    let mut placed = Vec::new();
    let mut failed = None;
    for position in snapshot
        .positions
        .iter()
        .filter(|p| market.is_none_or(|m| p.market == m))
    {
        let request = OrderRequest {
            market: position.market.clone(),
            side: match position.side {
                PositionSide::Long => Side::Sell,
                PositionSide::Short => Side::Buy,
            },
            size: Decimal(position.size.0.abs()),
            reduce_only: true,
            collateral: None,
            client_id: None,
            take_profit: None,
            stop_loss: None,
            kind: OrderKind::Market { max_slippage_bps },
        };
        match d
            .engine
            .place_order(&*d.venues, &*d.calendar, origin, venue, account, &request)
            .await
        {
            Ok(order) => placed.push(order),
            Err(e) => {
                failed.get_or_insert(e);
            }
        }
    }
    match failed {
        Some(e) if placed.is_empty() => Err(e),
        _ => Ok(placed),
    }
}

/// Does what one call asks.
async fn dispatch(d: &Daemon, session: &mut Session, call: Call) -> Result<Value, RpcError> {
    if let Call::Hello(hello) = &call {
        if hello.version != PROTOCOL_VERSION {
            return Err(RpcError::new(
                code::VERSION,
                format!(
                    "this daemon speaks protocol {PROTOCOL_VERSION}, the client {}",
                    hello.version
                ),
            ));
        }
        session.kind = Some(hello.client.kind);
        session.client = hello
            .token
            .as_deref()
            .and_then(|token| d.clients.verify(token))
            .map(|c| c.id);
        return ok(Welcome {
            version: PROTOCOL_VERSION,
            server: env!("CARGO_PKG_VERSION").into(),
            paired: session.client.is_some(),
        });
    }
    if session.kind.is_none() {
        return Err(RpcError::new(code::UNPAIRED, "say hello first"));
    }
    // Revoked since it said hello: not paired any more.
    if session
        .client
        .as_deref()
        .is_some_and(|id| !d.clients.contains(id))
    {
        session.client = None;
    }
    if session.client.is_none() && !call.open_to_unpaired() {
        return Err(RpcError::new(
            code::UNPAIRED,
            "not a paired client: pair it first (`pd pair`)",
        ));
    }
    let venues = &*d.venues;
    let calendar = &*d.calendar;
    let engine = &d.engine;
    match call {
        Call::Hello(_) => unreachable!("answered above"),
        Call::PairRequest { client } => ok(d.pairing.request(client)?),
        Call::PairStatus { request_id } => ok(d.pairing.status(&request_id)),
        Call::ClientsList => ok(d.clients.list()),
        Call::ClientsRevoke { id } => ok(d.clients.revoke(&id)),
        Call::Status => ok(Status {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: PROTOCOL_VERSION,
            started_at: d.started_at,
            log_open: engine.log().is_some(),
            algos_running: engine
                .algos()
                .list()
                .iter()
                .filter(|a| !a.status.is_over())
                .count(),
            accounts: engine.owners().held(),
        }),
        Call::Markets { venue } => answer(match venues.adapter(venue) {
            Ok(adapter) => adapter.markets().await,
            Err(e) => Err(e),
        }),
        Call::Book { venue, market } => answer(match venues.adapter(venue) {
            Ok(adapter) => adapter.order_book(&market).await,
            Err(e) => Err(e),
        }),
        Call::Account { venue, account } => answer(match venues.adapter(venue) {
            Ok(adapter) => adapter.account(&account).await,
            Err(e) => Err(e),
        }),
        Call::PlaceOrder { target, request } => {
            let origin = session.origin(&target);
            answer(
                engine
                    .place_order(
                        venues,
                        calendar,
                        origin,
                        target.venue,
                        &target.account,
                        &request,
                    )
                    .await,
            )
        }
        Call::CancelOrder {
            target,
            market,
            order_id,
        } => {
            let origin = session.origin(&target);
            answer(
                engine
                    .cancel_order(
                        venues,
                        origin,
                        target.venue,
                        &target.account,
                        &market,
                        &order_id,
                    )
                    .await,
            )
        }
        Call::AmendOrder {
            target,
            market,
            order_id,
            amend,
        } => {
            let origin = session.origin(&target);
            answer(
                engine
                    .amend_order(
                        venues,
                        origin,
                        target.venue,
                        &target.account,
                        &market,
                        &order_id,
                        &amend,
                    )
                    .await,
            )
        }
        Call::Protect {
            target,
            market,
            protection,
        } => {
            let origin = session.origin(&target);
            answer(
                engine
                    .set_position_protection(
                        venues,
                        origin,
                        target.venue,
                        &target.account,
                        &market,
                        &protection,
                    )
                    .await,
            )
        }
        Call::SetLeverage {
            target,
            market,
            leverage,
        } => {
            let origin = session.origin(&target);
            answer(
                engine
                    .set_leverage(
                        venues,
                        origin,
                        target.venue,
                        &target.account,
                        &market,
                        leverage,
                    )
                    .await,
            )
        }
        Call::SetMarginMode {
            target,
            market,
            mode,
        } => {
            let origin = session.origin(&target);
            answer(
                engine
                    .set_margin_mode(venues, origin, target.venue, &target.account, &market, mode)
                    .await,
            )
        }
        Call::AlgoStart { spec } => {
            answer(engine.algos().start(spec, session.origin_plain()).await)
        }
        Call::AlgoList => ok(engine.algos().list()),
        Call::AlgoHistory { limit } => ok(engine.algos().history(limit.min(HISTORY_MAX))),
        Call::AlgoPause { id } => answer(engine.algos().pause(&id)),
        Call::AlgoResume { id } => answer(engine.algos().resume(&id)),
        Call::AlgoStop { id, mode } => answer(engine.algos().stop(&id, mode)),
        Call::Halt => {
            let stopped = engine.algos().halt() + engine.bots().halt();
            eprintln!("pdd: halt: {stopped} algo(s) stopped");
            let halted = Halted { stopped };
            let _ = d.events.send(Event::Halted(halted));
            ok(halted)
        }
        Call::Flatten {
            target,
            market,
            max_slippage_bps,
        } => {
            let origin = session.origin(&target);
            answer(
                flatten(
                    d,
                    origin,
                    target.venue,
                    &target.account,
                    market.as_deref(),
                    max_slippage_bps,
                )
                .await,
            )
        }
        Call::BotCreate { spec } => answer(engine.bots().create(*spec).await),
        Call::BotList => ok(engine.bots().list()),
        Call::BotGet { id } => answer(engine.bots().get(&id)),
        Call::BotStart { id } => answer(engine.bots().start(&id).await),
        Call::BotLive { id } => answer(engine.bots().go_live(&id).await),
        Call::BotPause { id } => answer(engine.bots().pause(&id)),
        Call::BotResume { id } => answer(engine.bots().resume(&id)),
        Call::BotStop { id, flatten } => answer(engine.bots().stop(&id, flatten)),
        Call::BotDelete { id } => answer(engine.bots().delete(&id)),
        Call::BotBacktest {
            spec,
            since,
            hold_out_days,
        } => answer(engine.bots().backtest(&spec, since, hold_out_days).await),
        Call::Subscribe => {
            session.subscribed = true;
            ok(())
        }
    }
}

/// Forwards the daemon's events to one connection until it goes.
fn forward_events(mut events: broadcast::Receiver<Event>, out: mpsc::Sender<String>) {
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    let Ok(line) = serde_json::to_string(&Notification::event(event)) else {
                        continue;
                    };
                    if out.send(line).await.is_err() {
                        return;
                    }
                }
                // Fell behind: carry on from now.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

/// Answers one message.
async fn handle(
    d: &Daemon,
    session: &mut Session,
    text: &str,
    out: &mpsc::Sender<String>,
) -> String {
    let response = match read_request(text) {
        Err(bad) => *bad,
        Ok(request) => {
            let id = request.id.clone();
            let was_subscribed = session.subscribed;
            match dispatch(d, session, request.call).await {
                Ok(result) => {
                    if session.subscribed && !was_subscribed {
                        forward_events(d.events.subscribe(), out.clone());
                    }
                    Response::ok(id, result)
                }
                Err(error) => Response::err(Some(id), error),
            }
        }
    };
    serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"unanswerable"}}"#.into()
    })
}

/// A `pd` on the Unix socket: one message per line.
#[cfg(unix)]
pub async fn serve_unix(d: Arc<Daemon>, listener: tokio::net::UnixListener) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let d = Arc::clone(&d);
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let (out, mut outgoing) = mpsc::channel::<String>(64);
            tokio::spawn(async move {
                while let Some(line) = outgoing.recv().await {
                    if write.write_all(line.as_bytes()).await.is_err()
                        || write.write_all(b"\n").await.is_err()
                    {
                        return;
                    }
                }
            });
            let mut read = BufReader::new(read);
            let mut session = Session::default();
            loop {
                let mut line = String::new();
                // A line too long to be a request ends the connection.
                match (&mut read)
                    .take(MAX_MESSAGE as u64 + 1)
                    .read_line(&mut line)
                    .await
                {
                    Ok(0) | Err(_) => return,
                    Ok(_) if line.len() > MAX_MESSAGE => return,
                    Ok(_) => {}
                }
                if line.trim().is_empty() {
                    continue;
                }
                let reply = handle(&d, &mut session, line.trim_end(), &out).await;
                if out.send(reply).await.is_err() {
                    return;
                }
            }
        });
    }
}

/// Whether a WebSocket handshake is from a program on this machine to this
/// port: no `Origin` (a browser always sends one), and `Host` this port's.
pub fn allowed(request: &Request, port: u16) -> bool {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    if request.headers().contains_key("origin") {
        return false;
    }
    let host = header("host").unwrap_or_default();
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// The app on the WebSocket: one message per text frame.
pub async fn serve_ws(d: Arc<Daemon>, listener: tokio::net::TcpListener, port: u16) {
    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            continue;
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let d = Arc::clone(&d);
        tokio::spawn(async move {
            // The callback's type is tungstenite's, refusal and all.
            #[allow(clippy::result_large_err)]
            let check =
                |request: &Request, response: WsResponse| -> Result<WsResponse, ErrorResponse> {
                    if allowed(request, port) {
                        Ok(response)
                    } else {
                        let mut refusal =
                            ErrorResponse::new(Some("not from this machine's app".into()));
                        *refusal.status_mut() = http::StatusCode::FORBIDDEN;
                        Err(refusal)
                    }
                };
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_MESSAGE))
                .max_frame_size(Some(MAX_MESSAGE));
            let Ok(ws) =
                tokio_tungstenite::accept_hdr_async_with_config(stream, check, Some(config)).await
            else {
                return;
            };
            let (mut sink, mut source) = ws.split();
            let (out, mut outgoing) = mpsc::channel::<String>(64);
            tokio::spawn(async move {
                while let Some(text) = outgoing.recv().await {
                    if sink.send(Message::text(text)).await.is_err() {
                        return;
                    }
                }
                let _ = sink.close().await;
            });
            let mut session = Session::default();
            while let Some(Ok(message)) = source.next().await {
                match message {
                    Message::Text(text) => {
                        let reply = handle(&d, &mut session, text.as_str(), &out).await;
                        if out.send(reply).await.is_err() {
                            return;
                        }
                    }
                    Message::Close(_) => return,
                    // Pings are answered by the library; nothing else is spoken.
                    _ => {}
                }
            }
        });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::pairing::{Ask, Clients, Pairing};
    use async_trait::async_trait;
    use pewterdesk_core::{BookLevel, ExchangeAdapter, Market, OrderBook};
    use pewterdesk_engine::{Adapters, Calendar, CalendarEvent, Engine, EventLog};
    use pewterdesk_sim::SimVenue;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;

    struct Sim(SimVenue);
    impl Adapters for Sim {
        fn adapter(&self, _venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
            Ok(&self.0)
        }
    }
    struct NoCalendar;
    #[async_trait]
    impl Calendar for NoCalendar {
        async fn kept(&self) -> Option<Vec<CalendarEvent>> {
            Some(Vec::new())
        }
    }

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    fn market() -> Market {
        Market {
            venue: VenueId::Bybit,
            id: "BTCUSDT".into(),
            symbol: "BTC-USDT".into(),
            base: "BTC".into(),
            quote: "USDT".into(),
            tick_size: d("0.1"),
            size_step: d("0.01"),
            min_size: d("0.01"),
            max_leverage: 50,
            listed_by: None,
            category: None,
            listed_at: None,
        }
    }

    struct Fixture {
        dir: std::path::PathBuf,
        socket: std::path::PathBuf,
        daemon: Arc<Daemon>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A daemon on a socket of its own, over `SimVenue`, whose pairing
    /// prompts are answered `approve`.
    async fn daemon(name: &str, approve: bool) -> Fixture {
        // Short: a socket's path has a length limit.
        let dir = std::env::temp_dir().join(format!("pdd{}{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sim = SimVenue::new(VenueId::Bybit, vec![market()]);
        let level = |p: &str| BookLevel {
            price: d(p),
            size: d("10"),
        };
        sim.push_book(OrderBook {
            market: "BTCUSDT".into(),
            bids: vec![level("100")],
            asks: vec![level("100.1")],
            time: 0,
        });
        let clients = Arc::new(Clients::load(dir.join("clients.json")));
        let ask: Ask = Arc::new(move |_| tokio::spawn(async move { approve }));
        let (events, _) = broadcast::channel(16);
        let daemon = Arc::new(Daemon {
            engine: Engine::load(None, Some(EventLog::open_in_memory().unwrap()))
                .with_locks(dir.join("locks")),
            venues: Box::new(Sim(sim)),
            calendar: Box::new(NoCalendar),
            events,
            pairing: Pairing::new(Arc::clone(&clients), ask),
            clients,
            started_at: 0,
            recorder: None,
        });
        let socket = dir.join("s");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        tokio::spawn(serve_unix(Arc::clone(&daemon), listener));
        Fixture {
            dir,
            socket,
            daemon,
        }
    }

    struct Client {
        lines: tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
        write: tokio::net::unix::OwnedWriteHalf,
        next: u64,
    }

    impl Client {
        async fn connect(f: &Fixture) -> Self {
            let (read, write) = UnixStream::connect(&f.socket).await.unwrap().into_split();
            Self {
                lines: BufReader::new(read).lines(),
                write,
                next: 1,
            }
        }

        async fn raw(&mut self, line: &str) -> Value {
            self.write.write_all(line.as_bytes()).await.unwrap();
            self.write.write_all(b"\n").await.unwrap();
            loop {
                let line = self.lines.next_line().await.unwrap().expect("an answer");
                let value: Value = serde_json::from_str(&line).unwrap();
                // Events can come between; the answer has an id.
                if value.get("method").is_none() {
                    return value;
                }
            }
        }

        async fn call(&mut self, method: &str, params: Value) -> Value {
            let id = self.next;
            self.next += 1;
            let request = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
            self.raw(&request.to_string()).await
        }

        async fn hello(&mut self, token: Option<&str>) -> Value {
            let mut params = serde_json::json!({ "version": PROTOCOL_VERSION, "client": { "name": "pd", "kind": "pd" } });
            if let Some(token) = token {
                params["token"] = token.into();
            }
            self.call("hello", params).await
        }
    }

    fn error_code(answer: &Value) -> Option<i64> {
        answer["error"]["code"].as_i64()
    }

    /// Pairs a client through the protocol and returns its token.
    async fn pair(client: &mut Client) -> String {
        let ticket = client
            .call(
                "pair.request",
                serde_json::json!({ "client": { "name": "pd", "kind": "pd" } }),
            )
            .await;
        let request_id = ticket["result"]["requestId"].as_str().unwrap().to_owned();
        for _ in 0..200 {
            let state = client
                .call(
                    "pair.status",
                    serde_json::json!({ "requestId": request_id }),
                )
                .await;
            match state["result"]["state"].as_str() {
                Some("pending") => tokio::task::yield_now().await,
                Some("approved") => return state["result"]["token"].as_str().unwrap().to_owned(),
                other => panic!("pairing ended {other:?}"),
            }
        }
        panic!("never answered");
    }

    #[tokio::test]
    async fn nothing_before_hello_and_nothing_unpaired() {
        let f = daemon("a", true).await;
        let mut c = Client::connect(&f).await;
        assert_eq!(
            error_code(&c.call("status", Value::Null).await),
            Some(code::UNPAIRED)
        );
        let welcome = c.hello(None).await;
        assert_eq!(welcome["result"]["paired"], false);
        for (method, params) in [
            ("status", Value::Null),
            ("halt", Value::Null),
            ("clients.list", Value::Null),
            ("markets", serde_json::json!({ "venue": "bybit" })),
            (
                "order.cancel",
                serde_json::json!({ "venue": "bybit", "account": "demo:1", "market": "BTCUSDT", "orderId": "1" }),
            ),
        ] {
            assert_eq!(
                error_code(&c.call(method, params).await),
                Some(code::UNPAIRED),
                "{method}"
            );
        }
        // A token that isn't one is no better.
        assert_eq!(
            c.hello(Some("not-a-token")).await["result"]["paired"],
            false
        );
        assert_eq!(
            error_code(&c.call("status", Value::Null).await),
            Some(code::UNPAIRED)
        );
    }

    #[tokio::test]
    async fn another_protocol_version_is_turned_away() {
        let f = daemon("b", true).await;
        let mut c = Client::connect(&f).await;
        let answer = c
            .call(
                "hello",
                serde_json::json!({ "version": PROTOCOL_VERSION + 1, "client": { "name": "pd", "kind": "pd" } }),
            )
            .await;
        assert_eq!(error_code(&answer), Some(code::VERSION));
    }

    #[tokio::test]
    async fn a_paired_client_trades_through_the_gate_as_pd() {
        let f = daemon("c", true).await;
        let mut c = Client::connect(&f).await;
        c.hello(None).await;
        let token = pair(&mut c).await;
        // A new connection, proving itself with the token.
        let mut c = Client::connect(&f).await;
        assert_eq!(c.hello(Some(&token)).await["result"]["paired"], true);
        assert!(c.call("status", Value::Null).await["result"]["logOpen"]
            .as_bool()
            .unwrap());
        // It says it's the ticket; it's logged as pd.
        let placed = c
            .call(
                "order.place",
                serde_json::json!({
                    "venue": "bybit", "account": "demo:1", "origin": "ticket",
                    "request": { "market": "BTCUSDT", "side": "buy", "size": "0.5", "reduceOnly": false,
                                 "type": "limit", "price": "99" }
                }),
            )
            .await;
        assert!(placed.get("result").is_some(), "{placed}");
        let log = f.daemon.engine.log().unwrap().recent(20).unwrap();
        let command = log.iter().find(|e| e.kind == "command").unwrap();
        assert_eq!(command.origin.as_deref(), Some("pd"));
        // A live account with trading off is refused by the gate, as anywhere.
        let refused = c
            .call(
                "order.place",
                serde_json::json!({
                    "venue": "bybit", "account": "24617703",
                    "request": { "market": "BTCUSDT", "side": "buy", "size": "0.5", "reduceOnly": false,
                                 "type": "limit", "price": "99" }
                }),
            )
            .await;
        assert_eq!(error_code(&refused), Some(code::VENUE), "{refused}");
    }

    #[tokio::test]
    async fn a_denied_client_stays_unpaired_and_a_revoked_one_loses_access() {
        let f = daemon("d", false).await;
        let mut c = Client::connect(&f).await;
        c.hello(None).await;
        let ticket = c
            .call(
                "pair.request",
                serde_json::json!({ "client": { "name": "pd", "kind": "pd" } }),
            )
            .await;
        let request_id = ticket["result"]["requestId"].as_str().unwrap().to_owned();
        let mut state = Value::Null;
        for _ in 0..200 {
            state = c
                .call(
                    "pair.status",
                    serde_json::json!({ "requestId": request_id }),
                )
                .await;
            if state["result"]["state"] != "pending" {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(state["result"]["state"], "denied");

        // Paired another way, then revoked while connected.
        let f = daemon("e", true).await;
        let mut c = Client::connect(&f).await;
        c.hello(None).await;
        let token = pair(&mut c).await;
        let mut c = Client::connect(&f).await;
        c.hello(Some(&token)).await;
        let id = f.daemon.clients.list()[0].id.clone();
        assert!(c.call("status", Value::Null).await.get("result").is_some());
        assert!(f.daemon.clients.revoke(&id));
        assert_eq!(
            error_code(&c.call("status", Value::Null).await),
            Some(code::UNPAIRED)
        );
    }

    #[test]
    fn the_websocket_takes_only_this_machines_programs() {
        let request = |headers: &[(&str, &str)]| {
            let mut builder = http::Request::builder().uri("/");
            for (name, value) in headers {
                builder = builder.header(*name, *value);
            }
            builder.body(()).unwrap()
        };
        assert!(allowed(&request(&[("host", "127.0.0.1:4000")]), 4000));
        assert!(allowed(&request(&[("host", "localhost:4000")]), 4000));
        // A browser page, even on this machine.
        assert!(!allowed(
            &request(&[
                ("host", "127.0.0.1:4000"),
                ("origin", "http://127.0.0.1:4000")
            ]),
            4000
        ));
        // DNS rebinding: a name pointed at 127.0.0.1.
        assert!(!allowed(&request(&[("host", "evil.example:4000")]), 4000));
        assert!(!allowed(&request(&[("host", "127.0.0.1:4001")]), 4000));
        assert!(!allowed(&request(&[]), 4000));
    }
}
