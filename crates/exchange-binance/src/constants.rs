//! Binance's USDⓈ-M futures hosts. Checked against Binance's docs ("General
//! Info", "Important WebSocket Change Notice") and the live API (2026-10).
//!
//! Since 2026-04-23 the futures streams are split by route: book streams
//! (`@depth`, `@bookTicker`) only push on `/public`, everything else this
//! adapter reads (trades, klines, tickers, marks, liquidations) only on
//! `/market`. A stream on the wrong route connects and stays silent.

pub struct Endpoints {
    /// The futures REST API: market data, and the account's own requests.
    pub rest: &'static str,
    /// The combined-streams endpoint for book streams.
    pub ws_public: &'static str,
    /// The combined-streams endpoint for every other market stream.
    pub ws_market: &'static str,
    /// The spot REST API, for two signed reads only: the account's UID
    /// (`/api/v3/account`) and, for a live key, what it may do
    /// (`/sapi/v1/account/apiRestrictions`). Nothing is placed there.
    pub spot_rest: &'static str,
    /// Demo Trading's futures host (Binance's testnet, renamed): demo
    /// accounts' requests, with demo funds on a book of its own - its
    /// prices are not mainnet's, so a demo order is priced from here.
    pub demo_rest: Option<&'static str>,
    /// Demo Trading's spot host, for a demo key's UID.
    pub demo_spot_rest: Option<&'static str>,
    /// Demo Trading's stream routes, as `ws_public` and `ws_market`: its
    /// market data, while a demo account is on screen. Its positioning
    /// history (`/futures/data/`) answers with no data, so that stays
    /// mainnet's.
    pub demo_ws_public: Option<&'static str>,
    pub demo_ws_market: Option<&'static str>,
}

pub const MAINNET: Endpoints = Endpoints {
    rest: "https://fapi.binance.com",
    ws_public: "wss://fstream.binance.com/public/stream",
    ws_market: "wss://fstream.binance.com/market/stream",
    spot_rest: "https://api.binance.com",
    demo_rest: Some("https://demo-fapi.binance.com"),
    demo_spot_rest: Some("https://demo-api.binance.com"),
    demo_ws_public: Some("wss://demo-fstream.binance.com/public/stream"),
    demo_ws_market: Some("wss://demo-fstream.binance.com/market/stream"),
};
