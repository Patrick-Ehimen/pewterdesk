//! BloFin's hosts. Checked against BloFin's docs ("General Info", "Demo
//! Trading") and the live API (2026-10).
//!
//! Demo Trading is an exchange of its own: its own hosts, its own (shorter)
//! list of markets and its own book, at prices near mainnet's. A demo
//! account's requests, and the prices its orders are checked against, are
//! Demo Trading's.

pub struct Endpoints {
    /// The REST API: market data, and the account's own requests.
    pub rest: &'static str,
    /// The public WebSocket: books, trades, tickers, candles, funding.
    pub ws_public: &'static str,
    /// Demo Trading's REST API: demo accounts' requests, demo funds.
    pub demo_rest: Option<&'static str>,
    /// Demo Trading's public WebSocket, for the book a demo account trades
    /// on (an algo's prices).
    pub demo_ws_public: Option<&'static str>,
}

pub const MAINNET: Endpoints = Endpoints {
    rest: "https://openapi.blofin.com",
    ws_public: "wss://openapi.blofin.com/ws/public",
    demo_rest: Some("https://demo-trading-openapi.blofin.com"),
    demo_ws_public: Some("wss://demo-trading-openapi.blofin.com/ws/public"),
};
