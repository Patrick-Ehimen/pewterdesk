//! The router: one method per trading operation, each doing
//! `trading_account` → gate → adapter, and recording each step in the event
//! log. The only caller of an adapter's trading methods.
//!
//! Security-relevant - review any change against
//! `.claude/commands/security-review.md` and `docs/bots/safety.md`:
//! - The router builds the account's key reference itself
//!   (`trading_account`): the caller names an account, never a key.
//! - A Bybit demo account or a Binance or BloFin Demo Trading account (demo
//!   funds, on the venue's demo host) trades as soon as it's connected.
//!   Every other account is live - a Bybit or Binance live account, and any
//!   Hyperliquid or Aster account - and trades only once live trading has
//!   been turned on for it (`live`). A live BloFin account never trades:
//!   BloFin can't say whether a key may transfer funds, so there's no
//!   switch for one.
//! - The trader's rules (`rules`) are checked before an order is placed, an
//!   order is amended, or a position's protection is changed. A cancel, and
//!   leverage and margin mode (which open nothing), pass the switch only.
//! - Every command is logged with its origin (`Origin`, a label only: it
//!   grants nothing), then the gate's decision, then - for an order - its
//!   client order id before it's sent, then the venue's answer. Nothing
//!   logged is key material: not the key, not the keychain reference.
//! - Every order carries a client order id the router makes:
//!   `0x` + the log's engine id + the command's sequence number, so it is
//!   deterministic and never reused. An opening order whose id can't be
//!   written to the log is refused (`Blocked("unrecorded")`); a reduce-only
//!   one, a cancel and the rest still go through, so a failing log never
//!   stops the trader closing a position.

use std::path::{Path, PathBuf};

use pewterdesk_core::accounts::{
    binance_account, binance_key_entry, blofin_account, blofin_key_entry, bybit_account,
    bybit_key_entry, normalize_address, wallet_key_entry,
};
use pewterdesk_core::{
    Decimal, MarginMode, Order, OrderAmend, OrderRequest, Origin, PositionProtection,
    TradingAccount, VenueError, VenueId,
};
use pewterdesk_store::{EventLog, NewEvent};
use serde::Serialize;
use serde_json::{json, Value};

use crate::algo::Algos;
use crate::live::{self, LiveTrading};
use crate::owner::Owners;
use crate::rules::{self, now_ms, TradingRules};
use crate::{Adapters, Calendar};

/// Who trades for `account` on `venue`, if it may trade at all.
pub fn trading_account(
    venue: VenueId,
    account: &str,
    live: &LiveTrading,
) -> Result<TradingAccount, VenueError> {
    match venue {
        VenueId::Bybit => {
            let (demo, uid) = bybit_account(account)?;
            if !demo && !live.is_on(uid) {
                return Err(VenueError::Rejected(
                    "live trading is off for this account; turn it on under Accounts".into(),
                ));
            }
            Ok(TradingAccount {
                address: account.to_owned(),
                key: bybit_key_entry(account)?,
            })
        }
        VenueId::Binance => {
            let (demo, _) = binance_account(account)?;
            if !demo && !live.is_on(&live::binance_id(account)?) {
                return Err(VenueError::Rejected(
                    "live trading is off for this account; turn it on under Accounts".into(),
                ));
            }
            Ok(TradingAccount {
                address: account.to_owned(),
                key: binance_key_entry(account)?,
            })
        }
        // Demo Trading only: a live key can't be shown to be trade-only.
        VenueId::Blofin => {
            let (demo, _) = blofin_account(account)?;
            if !demo {
                return Err(VenueError::Rejected(
                    "live trading isn't available on BloFin; use a Demo Trading account".into(),
                ));
            }
            Ok(TradingAccount {
                address: account.to_owned(),
                key: blofin_key_entry(account)?,
            })
        }
        // Always real funds, so always behind the switch.
        VenueId::Hyperliquid | VenueId::Aster => {
            let address = normalize_address(account)?;
            if !live.is_on(&live::wallet_id(venue, &address)?) {
                return Err(VenueError::Rejected(
                    "live trading is off for this account; turn it on in the wallet's details"
                        .into(),
                ));
            }
            Ok(TradingAccount {
                key: wallet_key_entry(venue, &address),
                address,
            })
        }
    }
}

/// The client order id for command `seq` in a log with `engine_id`: 16
/// bytes as `0x` hex, which every venue takes (Hyperliquid's `cloid`,
/// Bybit's `orderLinkId`, Aster's and Binance's `newClientOrderId`, and
/// Binance's `clientAlgoId`).
pub fn client_id(engine_id: u64, seq: u64) -> String {
    format!("0x{engine_id:016x}{seq:016x}")
}

/// Who sent a command: where in the app, and the algo, if an algo did.
#[derive(Clone, Copy, Debug)]
pub struct By<'a> {
    pub origin: Origin,
    pub algo: Option<&'a str>,
}

impl By<'_> {
    fn app(origin: Origin) -> Self {
        Self { origin, algo: None }
    }
}

/// The router and the gate it checks - the live-trading switch and the
/// trader's rules - with the event log it records to, and the algos it runs.
pub struct Engine {
    live: LiveTrading,
    rules: TradingRules,
    /// `None` when the log couldn't be opened: opening orders are refused.
    log: Option<EventLog>,
    algos: Algos,
    /// The accounts this engine has taken: one engine per account.
    owners: Owners,
}

/// A value as the log keeps it.
fn as_json(value: &impl Serialize) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

impl Engine {
    /// The gate as kept in `config_dir` (`live-trading.json` and
    /// `trading-rules.json`), recording to `log`. Without a folder nothing
    /// can be kept: no live account trades, and no rules are set. Without a
    /// log, no opening order is sent.
    pub fn load(config_dir: Option<&Path>, log: Option<EventLog>) -> Self {
        Self {
            live: LiveTrading::load(config_dir.map(|dir| dir.join(live::FILE))),
            rules: TradingRules::load(config_dir.map(|dir| dir.join(rules::FILE))),
            log,
            algos: Algos::default(),
            owners: Owners::default(),
        }
    }

    /// One engine per account, with the accounts' locks kept in `dir`: an
    /// account another engine (the app's or the daemon's) trades is refused
    /// here until that one exits.
    pub fn with_locks(mut self, dir: PathBuf) -> Self {
        self.owners = Owners::in_dir(dir);
        self
    }

    /// The accounts this engine holds.
    pub fn owners(&self) -> &Owners {
        &self.owners
    }

    /// The live-trading switch, for the host's commands that show and set it.
    pub fn live(&self) -> &LiveTrading {
        &self.live
    }

    /// The trader's rules, for the host's commands that show and set them.
    pub fn rules(&self) -> &TradingRules {
        &self.rules
    }

    /// The event log, if it's open.
    pub fn log(&self) -> Option<&EventLog> {
        self.log.as_ref()
    }

    /// The algo orders running in this engine.
    pub fn algos(&self) -> &Algos {
        &self.algos
    }

    /// Logs a command (an algo's, with `by.algo`) and returns its sequence
    /// number, if it was written.
    fn begin(
        &self,
        by: By<'_>,
        venue: VenueId,
        account: &str,
        operation: &str,
        detail: Value,
    ) -> Option<u64> {
        let venue = as_json(&venue);
        self.log
            .as_ref()?
            .append(&NewEvent {
                at: now_ms(),
                kind: "command",
                origin: Some(by.origin.as_str()),
                venue: venue.as_str(),
                account: Some(account),
                operation: Some(operation),
                algo: by.algo,
                detail,
                ..NewEvent::default()
            })
            .ok()
    }

    /// Logs one step of command `command`; whether it was written.
    fn note(
        &self,
        command: Option<u64>,
        kind: &str,
        client_id: Option<&str>,
        detail: Value,
    ) -> bool {
        let (Some(log), Some(command)) = (self.log.as_ref(), command) else {
            return false;
        };
        log.append(&NewEvent {
            at: now_ms(),
            command: Some(command),
            kind,
            client_id,
            detail,
            ..NewEvent::default()
        })
        .is_ok()
    }

    /// Logs the gate's decision, and passes it on.
    fn gate<T>(
        &self,
        command: Option<u64>,
        decision: Result<T, VenueError>,
    ) -> Result<T, VenueError> {
        let detail = match &decision {
            Ok(_) => json!({ "passed": true }),
            Err(why) => json!({ "passed": false, "error": as_json(why) }),
        };
        self.note(command, "gate", None, detail);
        decision
    }

    /// Logs the venue's answer, and passes it on.
    fn finish<T: Serialize>(
        &self,
        command: Option<u64>,
        result: Result<T, VenueError>,
    ) -> Result<T, VenueError> {
        let detail = match &result {
            Ok(value) => json!({ "ok": as_json(value) }),
            Err(why) => json!({ "error": as_json(why) }),
        };
        self.note(command, "result", None, detail);
        result
    }

    /// Places an order for `account`, under a client order id of the
    /// router's own.
    pub async fn place_order(
        &self,
        venues: &dyn Adapters,
        calendar: &dyn Calendar,
        origin: Origin,
        venue: VenueId,
        account: &str,
        request: &OrderRequest,
    ) -> Result<Order, VenueError> {
        self.place(venues, calendar, By::app(origin), venue, account, request)
            .await
            .1
    }

    /// `place_order` for whoever `by` names, also returning the client order
    /// id the order went out under - even when the venue's answer is an
    /// error, so a timed-out order can be looked up rather than resent.
    pub async fn place(
        &self,
        venues: &dyn Adapters,
        calendar: &dyn Calendar,
        by: By<'_>,
        venue: VenueId,
        account: &str,
        request: &OrderRequest,
    ) -> (Option<String>, Result<Order, VenueError>) {
        let command = self.begin(by, venue, account, "placeOrder", as_json(request));
        let decision = async {
            self.owners.claim(venue, account)?;
            let trading = trading_account(venue, account, &self.live)?;
            // The trader's own rules, before anything is signed.
            self.rules
                .guard_order(venues, calendar, venue, account, request)
                .await?;
            Ok(trading)
        }
        .await;
        let trading = match self.gate(command, decision) {
            Ok(trading) => trading,
            Err(refused) => return (None, Err(refused)),
        };
        let mut request = request.clone();
        request.client_id = match (self.log.as_ref(), command) {
            (Some(log), Some(seq)) => Some(client_id(log.engine_id(), seq)),
            _ => None,
        };
        // The id is on record before the order is sent, or an opening order
        // isn't sent at all.
        let recorded = self.note(command, "sent", request.client_id.as_deref(), Value::Null);
        if !recorded && !request.reduce_only {
            return (None, Err(VenueError::Blocked("unrecorded".into())));
        }
        if !recorded {
            request.client_id = None;
        }
        let adapter = match venues.adapter(venue) {
            Ok(adapter) => adapter,
            Err(e) => return (request.client_id, Err(e)),
        };
        let placed = adapter.place_order(&trading, &request).await;
        (request.client_id, self.finish(command, placed))
    }

    /// Cancels `account`'s open order `order_id`.
    pub async fn cancel_order(
        &self,
        venues: &dyn Adapters,
        origin: Origin,
        venue: VenueId,
        account: &str,
        market: &str,
        order_id: &str,
    ) -> Result<(), VenueError> {
        self.cancel(venues, By::app(origin), venue, account, market, order_id)
            .await
    }

    /// `cancel_order` for whoever `by` names.
    pub async fn cancel(
        &self,
        venues: &dyn Adapters,
        by: By<'_>,
        venue: VenueId,
        account: &str,
        market: &str,
        order_id: &str,
    ) -> Result<(), VenueError> {
        let detail = json!({ "market": market, "orderId": order_id });
        let command = self.begin(by, venue, account, "cancelOrder", detail);
        let trading = self.gate(command, trading_account(venue, account, &self.live))?;
        let cancelled = venues
            .adapter(venue)?
            .cancel_order(&trading, market, order_id)
            .await;
        self.finish(command, cancelled)
    }

    /// Changes `account`'s open order `order_id`: price, size, or attached TP/SL.
    #[allow(clippy::too_many_arguments)]
    pub async fn amend_order(
        &self,
        venues: &dyn Adapters,
        origin: Origin,
        venue: VenueId,
        account: &str,
        market: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        let by = By::app(origin);
        self.amend(venues, by, venue, account, market, order_id, amend)
            .await
    }

    /// `amend_order` for whoever `by` names.
    #[allow(clippy::too_many_arguments)]
    pub async fn amend(
        &self,
        venues: &dyn Adapters,
        by: By<'_>,
        venue: VenueId,
        account: &str,
        market: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        let detail = json!({ "market": market, "orderId": order_id, "amend": as_json(amend) });
        let command = self.begin(by, venue, account, "amendOrder", detail);
        let decision = async {
            self.owners.claim(venue, account)?;
            let trading = trading_account(venue, account, &self.live)?;
            self.rules
                .guard_amend(venues, venue, account, order_id, amend)
                .await?;
            Ok(trading)
        }
        .await;
        let trading = self.gate(command, decision)?;
        let amended = venues
            .adapter(venue)?
            .amend_order(&trading, market, order_id, amend)
            .await;
        self.finish(command, amended)
    }

    /// Sets the take-profit, stop-loss and trailing stop on `account`'s
    /// position in `market`, all at once (`None` removes one). Protective only.
    #[allow(clippy::too_many_arguments)]
    pub async fn set_position_protection(
        &self,
        venues: &dyn Adapters,
        origin: Origin,
        venue: VenueId,
        account: &str,
        market: &str,
        protection: &PositionProtection,
    ) -> Result<(), VenueError> {
        let detail = json!({ "market": market, "protection": as_json(protection) });
        let command = self.begin(
            By::app(origin),
            venue,
            account,
            "setPositionProtection",
            detail,
        );
        let decision = async {
            self.owners.claim(venue, account)?;
            let trading = trading_account(venue, account, &self.live)?;
            self.rules
                .guard_protection(venues, venue, account, market, protection)
                .await?;
            Ok(trading)
        }
        .await;
        let trading = self.gate(command, decision)?;
        let protected = venues
            .adapter(venue)?
            .set_position_protection(&trading, market, protection)
            .await;
        self.finish(command, protected)
    }

    /// Arms (or, with `None`, disarms) the venue's dead-man's switch for
    /// `account`: unless it's armed again within `after_ms`, the venue
    /// cancels the account's open orders (on `market`, where the switch is
    /// per market). Part of cancelling: it opens nothing. Behind the switch
    /// like any trading command, and logged.
    pub async fn schedule_cancel(
        &self,
        venues: &dyn Adapters,
        by: By<'_>,
        venue: VenueId,
        account: &str,
        market: &str,
        after_ms: Option<u64>,
    ) -> Result<(), VenueError> {
        let detail = json!({ "market": market, "afterMs": after_ms });
        let command = self.begin(by, venue, account, "scheduleCancel", detail);
        let trading = self.gate(command, trading_account(venue, account, &self.live))?;
        let armed = venues
            .adapter(venue)?
            .schedule_cancel(&trading, market, after_ms)
            .await;
        self.finish(command, armed)
    }

    /// Sets `account`'s leverage on `market`.
    #[allow(clippy::too_many_arguments)]
    pub async fn set_leverage(
        &self,
        venues: &dyn Adapters,
        origin: Origin,
        venue: VenueId,
        account: &str,
        market: &str,
        leverage: Decimal,
    ) -> Result<(), VenueError> {
        let detail = json!({ "market": market, "leverage": as_json(&leverage) });
        let command = self.begin(By::app(origin), venue, account, "setLeverage", detail);
        let decision = self
            .owners
            .claim(venue, account)
            .and_then(|()| trading_account(venue, account, &self.live));
        let trading = self.gate(command, decision)?;
        let set = venues
            .adapter(venue)?
            .set_leverage(&trading, market, leverage)
            .await;
        self.finish(command, set)
    }

    /// Switches `account` between cross and isolated margin (account-wide on Bybit).
    #[allow(clippy::too_many_arguments)]
    pub async fn set_margin_mode(
        &self,
        venues: &dyn Adapters,
        origin: Origin,
        venue: VenueId,
        account: &str,
        market: &str,
        mode: MarginMode,
    ) -> Result<(), VenueError> {
        let detail = json!({ "market": market, "mode": as_json(&mode) });
        let command = self.begin(By::app(origin), venue, account, "setMarginMode", detail);
        let decision = self
            .owners
            .claim(venue, account)
            .and_then(|()| trading_account(venue, account, &self.live));
        let trading = self.gate(command, decision)?;
        let set = venues
            .adapter(venue)?
            .set_margin_mode(&trading, market, mode)
            .await;
        self.finish(command, set)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use pewterdesk_core::{
        AccountSnapshot, Capabilities, ExchangeAdapter, Market, OrderKind, Side, TimeInForce,
    };
    use tokio::sync::mpsc;

    use super::*;
    use crate::CalendarEvent;

    /// A venue that records what it's asked to sign, and refuses to place.
    #[derive(Default)]
    struct Fake {
        placed: Mutex<Vec<OrderRequest>>,
        cancelled: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ExchangeAdapter for Fake {
        fn venue(&self) -> VenueId {
            VenueId::Bybit
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                order_book: true,
                order_types: Vec::new(),
                isolated_collateral: false,
            }
        }
        async fn markets(&self) -> Result<Vec<Market>, VenueError> {
            Ok(Vec::new())
        }
        async fn account(&self, _address: &str) -> Result<AccountSnapshot, VenueError> {
            Err(VenueError::Network("not in a test".into()))
        }
        async fn subscribe_account(
            &self,
            _address: &str,
        ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError> {
            Err(VenueError::Network("not in a test".into()))
        }
        async fn place_order(
            &self,
            _account: &TradingAccount,
            request: &OrderRequest,
        ) -> Result<Order, VenueError> {
            self.placed.lock().unwrap().push(request.clone());
            Err(VenueError::Rejected("the fake venue places nothing".into()))
        }
        async fn cancel_order(
            &self,
            _account: &TradingAccount,
            _market: &str,
            order_id: &str,
        ) -> Result<(), VenueError> {
            self.cancelled.lock().unwrap().push(order_id.into());
            Ok(())
        }
    }

    impl Adapters for Fake {
        fn adapter(&self, _venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
            Ok(self)
        }
    }

    struct NoCalendar;

    #[async_trait]
    impl Calendar for NoCalendar {
        async fn kept(&self) -> Option<Vec<CalendarEvent>> {
            None
        }
    }

    fn buy(reduce_only: bool) -> OrderRequest {
        OrderRequest {
            market: "BTCUSDT".into(),
            side: Side::Buy,
            size: Decimal("0.01".parse().unwrap()),
            reduce_only,
            collateral: None,
            // Whatever the caller says, the router sets its own.
            client_id: Some("caller-chosen".into()),
            take_profit: None,
            stop_loss: None,
            kind: OrderKind::Limit {
                price: Decimal("90000".parse().unwrap()),
                time_in_force: Some(TimeInForce::Gtc),
            },
        }
    }

    fn logged() -> Engine {
        Engine::load(None, Some(EventLog::open_in_memory().unwrap()))
    }

    #[tokio::test]
    async fn an_order_is_logged_with_its_origin_and_a_client_id_before_its_sent() {
        let engine = logged();
        let venue = Fake::default();
        let result = engine
            .place_order(
                &venue,
                &NoCalendar,
                Origin::Ticket,
                VenueId::Bybit,
                "demo:1",
                &buy(false),
            )
            .await;
        assert!(matches!(result, Err(VenueError::Rejected(_))));
        let log = engine.log().unwrap();
        let command = log.recent(10).unwrap().last().unwrap().seq;
        let events = log.for_command(command).unwrap();
        assert_eq!(
            events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            ["command", "gate", "sent", "result"]
        );
        let first = &events[0];
        assert_eq!(first.origin.as_deref(), Some("ticket"));
        assert_eq!(first.venue.as_deref(), Some("bybit"));
        assert_eq!(first.account.as_deref(), Some("demo:1"));
        assert_eq!(first.operation.as_deref(), Some("placeOrder"));
        assert_eq!(events[1].detail["passed"], true);
        // The id the venue was asked to sign with is the one on record.
        let id = client_id(log.engine_id(), command);
        assert_eq!(events[2].client_id.as_deref(), Some(id.as_str()));
        let placed = venue.placed.lock().unwrap();
        assert_eq!(placed[0].client_id.as_deref(), Some(id.as_str()));
        assert_eq!(id.len(), 34);
        assert!(events[3].detail["error"].is_object());
    }

    #[tokio::test]
    async fn every_order_gets_a_new_id() {
        let engine = logged();
        let venue = Fake::default();
        for _ in 0..2 {
            let _ = engine
                .place_order(
                    &venue,
                    &NoCalendar,
                    Origin::App,
                    VenueId::Bybit,
                    "demo:1",
                    &buy(false),
                )
                .await;
        }
        let placed = venue.placed.lock().unwrap();
        assert_ne!(placed[0].client_id, placed[1].client_id);
    }

    #[tokio::test]
    async fn a_refusal_is_logged_and_nothing_is_sent() {
        let engine = logged();
        let venue = Fake::default();
        // A live Bybit account with live trading off.
        let result = engine
            .place_order(
                &venue,
                &NoCalendar,
                Origin::Palette,
                VenueId::Bybit,
                "24617703",
                &buy(false),
            )
            .await;
        assert!(matches!(result, Err(VenueError::Rejected(_))));
        assert!(venue.placed.lock().unwrap().is_empty());
        let log = engine.log().unwrap();
        let events = log.recent(10).unwrap();
        assert_eq!(
            events
                .iter()
                .rev()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            ["command", "gate"]
        );
        assert_eq!(events[0].detail["passed"], false);
    }

    #[tokio::test]
    async fn without_a_log_only_reducing_orders_and_cancels_go_through() {
        let engine = Engine::load(None, None);
        let venue = Fake::default();
        let opening = engine
            .place_order(
                &venue,
                &NoCalendar,
                Origin::Ticket,
                VenueId::Bybit,
                "demo:1",
                &buy(false),
            )
            .await;
        assert_eq!(opening, Err(VenueError::Blocked("unrecorded".into())));
        assert!(venue.placed.lock().unwrap().is_empty());
        // Closing a position never waits on the log.
        let _ = engine
            .place_order(
                &venue,
                &NoCalendar,
                Origin::Drawer,
                VenueId::Bybit,
                "demo:1",
                &buy(true),
            )
            .await;
        let placed = venue.placed.lock().unwrap().clone();
        assert_eq!(placed.len(), 1);
        assert_eq!(placed[0].client_id, None);
        engine
            .cancel_order(
                &venue,
                Origin::Activity,
                VenueId::Bybit,
                "demo:1",
                "BTCUSDT",
                "o1",
            )
            .await
            .unwrap();
        assert_eq!(*venue.cancelled.lock().unwrap(), ["o1"]);
    }

    #[tokio::test]
    async fn a_cancel_is_logged_with_its_result() {
        let engine = logged();
        let venue = Fake::default();
        engine
            .cancel_order(
                &venue,
                Origin::Float,
                VenueId::Bybit,
                "demo:1",
                "BTCUSDT",
                "o1",
            )
            .await
            .unwrap();
        let log = engine.log().unwrap();
        let events = log.recent(10).unwrap();
        assert_eq!(
            events
                .iter()
                .rev()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            ["command", "gate", "result"]
        );
        let command = events.last().unwrap();
        assert_eq!(command.origin.as_deref(), Some("float"));
        assert_eq!(command.detail["orderId"], "o1");
        assert!(events[0].detail.get("ok").is_some());
    }

    #[test]
    fn origins_are_logged_as_they_are_spelled_on_the_wire() {
        for origin in [
            Origin::Ticket,
            Origin::QuickTrade,
            Origin::Palette,
            Origin::CliPanel,
            Origin::Float,
            Origin::Multichart,
            Origin::Chart,
            Origin::Activity,
            Origin::Drawer,
            Origin::App,
            Origin::Algo,
            Origin::Engine,
        ] {
            assert_eq!(serde_json::to_value(origin).unwrap(), origin.as_str());
        }
    }

    #[test]
    fn client_ids_fit_every_venue() {
        let id = client_id(u64::MAX, 1);
        assert_eq!(id, format!("0x{}{:016x}", "f".repeat(16), 1));
        // Hyperliquid: 0x and 32 lowercase hex. Bybit, Aster and Binance:
        // up to 36 letters, digits, - and _.
        assert_eq!(id.len(), 34);
        assert!(id[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }

    #[test]
    fn a_live_account_trades_only_once_its_turned_on() {
        let path = std::env::temp_dir()
            .join(format!("pewterdesk-gate-{}", std::process::id()))
            .join(live::FILE);
        let live = LiveTrading::load(Some(path.clone()));
        // Demo accounts need no switch.
        let demo = trading_account(VenueId::Bybit, "demo:24617703", &live).unwrap();
        assert_eq!(demo.address, "demo:24617703");
        assert_eq!(demo.key, "bybit:demo:24617703");
        assert!(trading_account(VenueId::Bybit, "demo:x", &live).is_err());
        // A live one is refused until it's on, and only that account is let through.
        assert!(matches!(
            trading_account(VenueId::Bybit, "24617703", &live),
            Err(VenueError::Rejected(_))
        ));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"["24617703"]"#).unwrap();
        let on = LiveTrading::load(Some(path.clone()));
        let account = trading_account(VenueId::Bybit, "24617703", &on).unwrap();
        assert_eq!(account.address, "24617703");
        assert_eq!(account.key, "bybit:24617703");
        assert!(matches!(
            trading_account(VenueId::Bybit, "24617704", &on),
            Err(VenueError::Rejected(_))
        ));
        // A wallet on Hyperliquid or Aster is always live: refused until
        // it's on, and then only that venue's account, under its own key.
        let wallet = format!("0x{}", "a".repeat(40));
        let other = format!("0x{}", "b".repeat(40));
        for venue in [VenueId::Hyperliquid, VenueId::Aster] {
            assert!(matches!(
                trading_account(venue, &wallet, &on),
                Err(VenueError::Rejected(_))
            ));
        }
        std::fs::write(&path, format!(r#"["hyperliquid:{wallet}"]"#)).unwrap();
        let on = LiveTrading::load(Some(path.clone()));
        // However the page spells the address, the key is the stored one's.
        let spelled = format!(" 0x{} ", "A".repeat(40));
        let account = trading_account(VenueId::Hyperliquid, &spelled, &on).unwrap();
        assert_eq!(account.address, wallet);
        assert_eq!(account.key, format!("hyperliquid:{wallet}"));
        assert!(matches!(
            trading_account(VenueId::Aster, &wallet, &on),
            Err(VenueError::Rejected(_))
        ));
        assert!(matches!(
            trading_account(VenueId::Hyperliquid, &other, &on),
            Err(VenueError::Rejected(_))
        ));
        assert!(matches!(
            trading_account(VenueId::Hyperliquid, "24617703", &on),
            Err(VenueError::InvalidRequest(_))
        ));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_binance_account_is_gated_like_a_bybit_one_but_apart() {
        let path = std::env::temp_dir()
            .join(format!("pewterdesk-gate-binance-{}", std::process::id()))
            .join(live::FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Bybit's switch for the same UID is on: it doesn't reach Binance.
        std::fs::write(&path, br#"["354937868"]"#).unwrap();
        let live = LiveTrading::load(Some(path.clone()));
        let demo = trading_account(VenueId::Binance, "demo:354937868", &live).unwrap();
        assert_eq!(demo.key, "binance:demo:354937868");
        assert!(matches!(
            trading_account(VenueId::Binance, "354937868", &live),
            Err(VenueError::Rejected(_))
        ));
        std::fs::write(&path, br#"["binance:354937868"]"#).unwrap();
        let on = LiveTrading::load(Some(path.clone()));
        let account = trading_account(VenueId::Binance, "354937868", &on).unwrap();
        assert_eq!(account.address, "354937868");
        assert_eq!(account.key, "binance:354937868");
        // And Binance's switch doesn't reach Bybit's account.
        assert!(matches!(
            trading_account(VenueId::Bybit, "354937868", &on),
            Err(VenueError::Rejected(_))
        ));
        assert!(trading_account(VenueId::Binance, "0xabc", &on).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_blofin_account_trades_only_on_demo() {
        let path = std::env::temp_dir()
            .join(format!("pewterdesk-gate-blofin-{}", std::process::id()))
            .join(live::FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Every other venue's switch for this UID is on: none reaches BloFin.
        std::fs::write(
            &path,
            br#"["20923487","binance:20923487","blofin:20923487"]"#,
        )
        .unwrap();
        let live = LiveTrading::load(Some(path.clone()));
        let demo = trading_account(VenueId::Blofin, "demo:20923487", &live).unwrap();
        assert_eq!(demo.address, "demo:20923487");
        assert_eq!(demo.key, "blofin:demo:20923487");
        assert!(matches!(
            trading_account(VenueId::Blofin, "20923487", &live),
            Err(VenueError::Rejected(_))
        ));
        assert!(trading_account(VenueId::Blofin, "demo:0xabc", &live).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
