pub struct Endpoints {
    pub rest: &'static str,
    pub ws: &'static str,
}

pub const MAINNET: Endpoints = Endpoints {
    rest: "https://api.hyperliquid.xyz",
    ws: "wss://api.hyperliquid.xyz/ws",
};

pub const TESTNET: Endpoints = Endpoints {
    rest: "https://api.hyperliquid-testnet.xyz",
    ws: "wss://api.hyperliquid-testnet.xyz/ws",
};
