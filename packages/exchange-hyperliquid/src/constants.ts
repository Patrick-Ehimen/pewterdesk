export const HYPERLIQUID_URLS = {
  mainnet: {
    rest: "https://api.hyperliquid.xyz",
    ws: "wss://api.hyperliquid.xyz/ws",
  },
  testnet: {
    rest: "https://api.hyperliquid-testnet.xyz",
    ws: "wss://api.hyperliquid-testnet.xyz/ws",
  },
} as const;

export type HyperliquidNetwork = keyof typeof HYPERLIQUID_URLS;
