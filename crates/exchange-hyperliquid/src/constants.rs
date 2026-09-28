pub struct Endpoints {
    pub rest: &'static str,
    pub ws: &'static str,
    /// Hyperliquid's web app, for market logos only.
    pub assets: &'static str,
}

pub const MAINNET: Endpoints = Endpoints {
    rest: "https://api.hyperliquid.xyz",
    ws: "wss://api.hyperliquid.xyz/ws",
    assets: "https://app.hyperliquid.xyz",
};

pub const TESTNET: Endpoints = Endpoints {
    rest: "https://api.hyperliquid-testnet.xyz",
    ws: "wss://api.hyperliquid-testnet.xyz/ws",
    assets: "https://app.hyperliquid-testnet.xyz",
};
