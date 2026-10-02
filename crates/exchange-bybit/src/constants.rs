//! Bybit's V5 API hosts. Checked against the live API (2026-10): the REST
//! market endpoints under `/v5/market/` and the public linear stream.

pub struct Endpoints {
    pub rest: &'static str,
    /// The public stream for USDT and USDC linear contracts; topics are
    /// subscribed by message after connecting.
    pub ws: &'static str,
    /// Demo Trading's REST host: private requests for demo accounts (keys
    /// made in Bybit's Demo Trading, with demo funds). Market data stays on
    /// `rest`, as demo trading runs on live prices. Checked live (2026-10).
    pub demo_rest: Option<&'static str>,
}

pub const MAINNET: Endpoints = Endpoints {
    rest: "https://api.bybit.com",
    ws: "wss://stream.bybit.com/v5/public/linear",
    demo_rest: Some("https://api-demo.bybit.com"),
};

pub const TESTNET: Endpoints = Endpoints {
    rest: "https://api-testnet.bybit.com",
    ws: "wss://stream-testnet.bybit.com/v5/public/linear",
    demo_rest: None,
};
