//! The daemon as the engine's host: the venues' adapters (keys from the
//! keychain, as in the app), the economic calendar, and the engine with its
//! gate, log and accounts' locks - the same files as the app's. Algo
//! updates go out to subscribed clients as events.

use std::sync::Arc;

use pewterdesk_calendar::CalendarState;
use pewterdesk_core::{AlgoView, ExchangeAdapter, VenueError, VenueId};
use pewterdesk_engine::algo::Host;
use pewterdesk_engine::{Adapters, Calendar, Engine, EventLog};
use pewterdesk_exchange_aster::{constants::MAINNET as ASTER_MAINNET, AsterAdapter};
use pewterdesk_exchange_binance::{constants::MAINNET as BINANCE_MAINNET, BinanceAdapter};
use pewterdesk_exchange_blofin::{constants::MAINNET as BLOFIN_MAINNET, BlofinAdapter};
use pewterdesk_exchange_bybit::{constants::MAINNET as BYBIT_MAINNET, BybitAdapter};
use pewterdesk_exchange_hyperliquid::{constants::MAINNET, HyperliquidAdapter};
use pewterdesk_keychain::KeychainKeySource;
use pewterdesk_protocol::local::Paths;
use pewterdesk_protocol::rpc::Event;
use tokio::sync::broadcast;

use crate::pairing::{Clients, Pairing};

/// Each venue's adapter, as the app sets them up.
pub struct Venues {
    hyperliquid: HyperliquidAdapter,
    aster: AsterAdapter,
    bybit: BybitAdapter,
    binance: BinanceAdapter,
    blofin: BlofinAdapter,
}

impl Venues {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            hyperliquid: HyperliquidAdapter::new(&MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            aster: AsterAdapter::new(&ASTER_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            bybit: BybitAdapter::new(&BYBIT_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            binance: BinanceAdapter::new(&BINANCE_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            blofin: BlofinAdapter::new(&BLOFIN_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
        })
    }
}

impl Adapters for Venues {
    fn adapter(&self, venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
        match venue {
            VenueId::Hyperliquid => Ok(&self.hyperliquid),
            VenueId::Aster => Ok(&self.aster),
            VenueId::Bybit => Ok(&self.bybit),
            VenueId::Binance => Ok(&self.binance),
            VenueId::Blofin => Ok(&self.blofin),
        }
    }
}

/// Everything the daemon runs.
pub struct Daemon {
    pub engine: Engine,
    pub venues: Box<dyn Adapters>,
    pub calendar: Box<dyn Calendar>,
    pub events: broadcast::Sender<Event>,
    pub clients: Arc<Clients>,
    pub pairing: Pairing,
    pub started_at: u64,
}

impl Daemon {
    /// The engine over the app's own files: the gate in the config folder,
    /// the event log and the accounts' locks in the data folder. Without a
    /// log the engine still runs, but sends no opening order.
    pub fn engine_for(paths: &Paths) -> Engine {
        let log = match EventLog::open(&paths.event_log()) {
            Ok(log) => Some(log),
            Err(e) => {
                eprintln!(
                    "pdd: the event log couldn't be opened ({e}); no opening order will be sent"
                );
                None
            }
        };
        Engine::load(Some(&paths.config), log).with_locks(paths.locks())
    }

    pub fn calendar() -> Result<CalendarState, VenueError> {
        CalendarState::new(env!("CARGO_PKG_VERSION"))
    }
}

impl Host for Daemon {
    fn engine(&self) -> &Engine {
        &self.engine
    }

    fn venues(&self) -> &dyn Adapters {
        &*self.venues
    }

    fn calendar(&self) -> &dyn Calendar {
        &*self.calendar
    }

    fn publish(&self, view: &AlgoView) {
        // Nobody listening is fine.
        let _ = self.events.send(Event::Algo(Box::new(view.clone())));
    }
}
