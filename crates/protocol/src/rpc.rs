//! What a client may ask the engine, over JSON-RPC 2.0: the six trading
//! operations, read-only queries, algo and bot control, `halt` and
//! `flatten`, and pairing. Nothing else - no withdrawal, transfer, key approval or
//! signing of caller-supplied data, and no key material in either
//! direction (`docs/bots/safety.md`). A key's existence goes no further
//! than whether an account can trade.
//!
//! Security-relevant: adding a method adds a way in. Review any change
//! against `.claude/commands/security-review.md`.

use pewterdesk_core::{
    AccountSnapshot, AlgoSpec, AlgoView, Decimal, MarginMode, Market, Order, OrderAmend, OrderBook,
    OrderRequest, Origin, PositionProtection, StopMode, VenueId,
};
use pewterdesk_strategy::bot::{BotSpec, BotView};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The protocol's version. A client and the daemon must agree on it in
/// `hello`; a change that breaks an old client bumps it.
pub const PROTOCOL_VERSION: u32 = 1;
const JSONRPC: &str = "2.0";

/// A request's id, as JSON-RPC allows it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Id {
    Num(u64),
    Str(String),
}

/// Who a client is, as it says itself. A label: what it may do comes from
/// its pairing, never from this.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    /// Shown when the user is asked to pair it, e.g. "pd on Ose's MacBook".
    pub name: String,
    pub kind: ClientKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientKind {
    /// The `pd` command line.
    Pd,
    /// The desktop app, when it runs as the daemon's client.
    App,
}

/// The first thing a client sends: its protocol version, and its pairing
/// token once it has one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub version: u32,
    pub client: ClientInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub version: u32,
    /// The daemon's own version, e.g. "0.3.0".
    pub server: String,
    /// Whether the token was a paired client's: until it is, only pairing
    /// and `hello` are answered.
    pub paired: bool,
}

/// A pairing request, waiting on the user.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairTicket {
    pub request_id: String,
    /// What the user sees on both sides, to know it's this client they're
    /// approving.
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PairState {
    Pending,
    /// Approved: the token to keep (in the client's keychain) and send in
    /// every `hello`. Given once.
    #[serde(rename_all = "camelCase")]
    Approved {
        client_id: String,
        token: String,
    },
    Denied,
    /// Not approved in time, or not known.
    Expired,
}

/// A paired client, as `pd clients` lists them. Never its token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedClient {
    pub id: String,
    pub name: String,
    pub kind: ClientKind,
    /// Milliseconds since the Unix epoch.
    pub paired_at: u64,
}

/// Where a trading operation acts: a venue, and an account on it as the
/// app names it (a Bybit UID or `demo:<uid>`, an address on Hyperliquid
/// and Aster). The daemon builds the keychain reference itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub venue: VenueId,
    pub account: String,
    /// Where in the app it came from, for the log. A label that grants
    /// nothing; ignored for `pd`, whose commands are always logged as `pd`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
}

/// The daemon at a glance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: String,
    pub protocol: u32,
    /// Milliseconds since the Unix epoch.
    pub started_at: u64,
    /// Whether the event log is open: without it no opening order is sent.
    pub log_open: bool,
    pub algos_running: usize,
    /// The accounts this daemon holds the lock for.
    pub accounts: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Halted {
    pub stopped: usize,
}

/// One call: its method and parameters.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum Call {
    #[serde(rename = "hello")]
    Hello(Hello),
    #[serde(rename = "pair.request")]
    PairRequest { client: ClientInfo },
    #[serde(rename = "pair.status", rename_all = "camelCase")]
    PairStatus { request_id: String },
    #[serde(rename = "clients.list")]
    ClientsList,
    #[serde(rename = "clients.revoke")]
    ClientsRevoke { id: String },

    #[serde(rename = "status")]
    Status,
    #[serde(rename = "markets")]
    Markets { venue: VenueId },
    #[serde(rename = "book")]
    Book { venue: VenueId, market: String },
    #[serde(rename = "account")]
    Account { venue: VenueId, account: String },

    // The six trading operations, each through the engine's router and gate.
    #[serde(rename = "order.place")]
    PlaceOrder {
        #[serde(flatten)]
        target: Target,
        request: OrderRequest,
    },
    #[serde(rename = "order.cancel", rename_all = "camelCase")]
    CancelOrder {
        #[serde(flatten)]
        target: Target,
        market: String,
        order_id: String,
    },
    #[serde(rename = "order.amend", rename_all = "camelCase")]
    AmendOrder {
        #[serde(flatten)]
        target: Target,
        market: String,
        order_id: String,
        amend: OrderAmend,
    },
    #[serde(rename = "position.protect")]
    Protect {
        #[serde(flatten)]
        target: Target,
        market: String,
        protection: PositionProtection,
    },
    #[serde(rename = "leverage.set")]
    SetLeverage {
        #[serde(flatten)]
        target: Target,
        market: String,
        leverage: Decimal,
    },
    #[serde(rename = "marginMode.set")]
    SetMarginMode {
        #[serde(flatten)]
        target: Target,
        market: String,
        mode: MarginMode,
    },

    // Algos: they send through the same router.
    #[serde(rename = "algo.start")]
    AlgoStart { spec: AlgoSpec },
    #[serde(rename = "algo.list")]
    AlgoList,
    #[serde(rename = "algo.history")]
    AlgoHistory { limit: usize },
    #[serde(rename = "algo.pause")]
    AlgoPause { id: String },
    #[serde(rename = "algo.resume")]
    AlgoResume { id: String },
    #[serde(rename = "algo.stop")]
    AlgoStop { id: String, mode: StopMode },

    /// Stops every algo and cancels what they placed.
    #[serde(rename = "halt")]
    Halt,
    /// Closes the account's positions (one market's, or all) at market,
    /// reduce-only, within the slippage bound.
    #[serde(rename = "flatten", rename_all = "camelCase")]
    Flatten {
        #[serde(flatten)]
        target: Target,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        market: Option<String>,
        max_slippage_bps: u32,
    },

    // Bots: they send through the same router, as `bot`.
    #[serde(rename = "bot.create")]
    BotCreate { spec: Box<BotSpec> },
    #[serde(rename = "bot.list")]
    BotList,
    #[serde(rename = "bot.get")]
    BotGet { id: String },
    /// Starts it in its mode (paper, or live once it's gone live).
    #[serde(rename = "bot.start")]
    BotStart { id: String },
    /// From paper to live: only after its paper run, on an account that can trade.
    #[serde(rename = "bot.live")]
    BotLive { id: String },
    #[serde(rename = "bot.pause")]
    BotPause { id: String },
    #[serde(rename = "bot.resume")]
    BotResume { id: String },
    #[serde(rename = "bot.stop")]
    BotStop { id: String, flatten: bool },
    #[serde(rename = "bot.delete")]
    BotDelete { id: String },
    /// A backtest of `spec` on its market's candles from `since` (ms).
    #[serde(rename = "bot.backtest", rename_all = "camelCase")]
    BotBacktest {
        spec: Box<BotSpec>,
        since: u64,
        hold_out_days: f64,
    },

    /// From here on, the daemon's events come as `event` notifications.
    #[serde(rename = "events.subscribe")]
    Subscribe,
}

impl Call {
    /// Whether an unpaired client may make it: only saying hello and asking
    /// to be paired.
    pub fn open_to_unpaired(&self) -> bool {
        matches!(
            self,
            Call::Hello(_) | Call::PairRequest { .. } | Call::PairStatus { .. }
        )
    }

    /// Whether it can send something to a venue.
    pub fn trades(&self) -> bool {
        matches!(
            self,
            Call::PlaceOrder { .. }
                | Call::CancelOrder { .. }
                | Call::AmendOrder { .. }
                | Call::Protect { .. }
                | Call::SetLeverage { .. }
                | Call::SetMarginMode { .. }
                | Call::AlgoStart { .. }
                | Call::AlgoStop { .. }
                | Call::BotStart { .. }
                | Call::BotLive { .. }
                | Call::BotStop { .. }
                | Call::Halt
                | Call::Flatten { .. }
        )
    }
}

/// A request on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub id: Id,
    #[serde(flatten)]
    pub call: Call,
}

impl Request {
    pub fn new(id: Id, call: Call) -> Self {
        Self {
            jsonrpc: JSONRPC.into(),
            id,
            call,
        }
    }
}

/// The error codes this protocol uses, besides JSON-RPC's own.
pub mod code {
    pub const PARSE: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL: i64 = -32603;
    /// No `hello` yet, or not a paired client.
    pub const UNPAIRED: i64 = -32001;
    /// The client speaks another version.
    pub const VERSION: i64 = -32002;
    /// Another engine holds the account.
    pub const LOCKED: i64 = -32003;
    /// The venue or the gate said no; `data` is the `VenueError`.
    pub const VENUE: i64 = -32010;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    /// A venue's or the gate's answer, with the error itself as data.
    pub fn venue(err: &pewterdesk_core::VenueError) -> Self {
        Self {
            code: code::VENUE,
            message: err.to_string(),
            data: serde_json::to_value(err).ok(),
        }
    }

    /// The `VenueError` kind it carries ("blocked", "rejected"...), if any.
    pub fn venue_kind(&self) -> Option<&str> {
        self.data.as_ref()?.get("kind")?.as_str()
    }

    /// The `VenueError` it stands for, as near as it can be rebuilt (a
    /// gate's refusal keeps its rule code); anything that isn't a venue's
    /// answer is a network error with its message.
    pub fn to_venue_error(&self) -> pewterdesk_core::VenueError {
        use pewterdesk_core::VenueError;
        let detail = self
            .data
            .as_ref()
            .and_then(|d| d.get("detail"))
            .and_then(Value::as_str)
            .map_or_else(|| self.message.clone(), str::to_owned);
        match self.venue_kind() {
            Some("blocked") => VenueError::Blocked(detail),
            Some("invalidRequest") => VenueError::InvalidRequest(detail),
            Some("rejected") => VenueError::Rejected(detail),
            Some("network") => VenueError::Network(detail),
            Some(_) => VenueError::Rejected(self.message.clone()),
            None => VenueError::Network(self.message.clone()),
        }
    }
}

/// A response on the wire: a result or an error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub jsonrpc: String,
    pub id: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: Id, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self {
                jsonrpc: JSONRPC.into(),
                id: Some(id),
                result: Some(result),
                error: None,
            },
            Err(e) => Self::err(Some(id), RpcError::new(code::INTERNAL, e.to_string())),
        }
    }

    pub fn err(id: Option<Id>, error: RpcError) -> Self {
        Self {
            jsonrpc: JSONRPC.into(),
            id,
            result: None,
            error: Some(error),
        }
    }

    /// The result as `T`, or the error.
    pub fn into_result<T: for<'de> Deserialize<'de>>(self) -> Result<T, RpcError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        serde_json::from_value(self.result.unwrap_or(Value::Null))
            .map_err(|e| RpcError::new(code::INTERNAL, format!("unexpected answer: {e}")))
    }
}

/// Something that happened in the engine, pushed to subscribed clients.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum Event {
    /// An algo's latest state.
    Algo(Box<AlgoView>),
    /// Everything was halted.
    Halted(Halted),
    /// A bot's latest state.
    Bot(Box<BotView>),
}

/// A notification on the wire: an event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Event,
}

impl Notification {
    pub fn event(event: Event) -> Self {
        Self {
            jsonrpc: JSONRPC.into(),
            method: "event".into(),
            params: event,
        }
    }
}

/// What a client reads: an answer to one of its requests, or an event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Incoming {
    Notification(Box<Notification>),
    Response(Box<Response>),
}

/// Reads one request; the error to answer with when it isn't one.
pub fn read_request(line: &str) -> Result<Request, Box<Response>> {
    let fail =
        |id, code, message: String| Box::new(Response::err(id, RpcError::new(code, message)));
    let value: Value =
        serde_json::from_str(line).map_err(|e| fail(None, code::PARSE, e.to_string()))?;
    let id = value
        .get("id")
        .and_then(|id| serde_json::from_value::<Id>(id.clone()).ok());
    if value.get("jsonrpc").and_then(Value::as_str) != Some(JSONRPC) {
        return Err(fail(id, code::INVALID_REQUEST, "not JSON-RPC 2.0".into()));
    }
    let Some(id) = id else {
        return Err(fail(
            None,
            code::INVALID_REQUEST,
            "a request needs an id".into(),
        ));
    };
    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    serde_json::from_value::<Request>(value.clone()).map_err(|e| {
        let code = if KNOWN_METHODS.contains(&method) {
            code::INVALID_PARAMS
        } else {
            code::METHOD_NOT_FOUND
        };
        fail(Some(id), code, e.to_string())
    })
}

/// Every method name, for telling a bad method from bad parameters.
pub const KNOWN_METHODS: &[&str] = &[
    "hello",
    "pair.request",
    "pair.status",
    "clients.list",
    "clients.revoke",
    "status",
    "markets",
    "book",
    "account",
    "order.place",
    "order.cancel",
    "order.amend",
    "position.protect",
    "leverage.set",
    "marginMode.set",
    "algo.start",
    "algo.list",
    "algo.history",
    "algo.pause",
    "algo.resume",
    "algo.stop",
    "halt",
    "flatten",
    "bot.create",
    "bot.list",
    "bot.get",
    "bot.start",
    "bot.live",
    "bot.pause",
    "bot.resume",
    "bot.stop",
    "bot.delete",
    "bot.backtest",
    "events.subscribe",
];

/// The answers' types, by method, for clients.
pub mod answer {
    use super::*;
    pub type Markets = Vec<Market>;
    pub type Book = OrderBook;
    pub type Account = AccountSnapshot;
    pub type Placed = Order;
    pub type Algos = Vec<AlgoView>;
    pub type Algo = AlgoView;
    pub type Flattened = Vec<Order>;
    pub type Clients = Vec<PairedClient>;
}
