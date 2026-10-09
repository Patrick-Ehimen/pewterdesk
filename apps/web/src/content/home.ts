// The home page's copy. English only: this is the marketing site, not the
// terminal, so it doesn't go through the app's `t()`. Keep the claims in
// step with what the app actually does (README's status note, CLAUDE.md's
// "Live trading").
import { REPO_URL, VERSION } from "../site";

export const hero = {
  what: "A trading terminal for crypto perpetuals that runs on your own machine.",
  how: "Chart, read the book and trade crypto perps on centralised and on-chain venues from one window. Keys sign locally and requests go straight to the venue.",
  download: `Download v${VERSION}`,
  source: "Build from source",
  note: "Pre-release · still in development",
};

export const figure = {
  alt: "Pewterdesk showing BTC-USDT on Bybit: chart, order book and trade ticket in one window",
  caption: "Fig. 1 — BTC-USDT on Bybit. Chart, book and ticket share one window.",
  note: "macOS · Windows · Linux",
};

// The strip under the screenshot, from the dark mockup: what each part of
// the window in Fig. 1 is.
export const callouts = [
  {
    title: "Venue and latency",
    body: "Switch venues from the top bar. Round-trip latency is shown beside each.",
  },
  {
    title: "Charts, depth, screener",
    body: "Standard charts today, TradingView to come, plus depth, screener and watchlist tabs.",
  },
  {
    title: "Book with imbalance",
    body: "Bid and ask share across the visible book, shown as one bar.",
  },
  {
    title: "One ticket",
    body: "Market, limit and pro orders, with reduce only and TP/SL.",
  },
] as const;

export const why = {
  headline: "A browser tab was never a trading floor.",
  body: [
    "Every venue ships its own web app, its own layout and its own hotkeys. Moving between them costs attention at the moment you can least afford it.",
    "Pewterdesk puts each venue behind one interface: one ticket, one book, one positions table. The venue changes; the desk does not.",
  ],
};

export const inside = {
  headline: "More than a chart and a button.",
  more: "All features",
  plates: [
    {
      id: "depth",
      title: "Depth",
      body: "The whole book as a shape, and how much of it sits near the mid.",
      alt: "The depth tab for ARC-USDT on Bybit: cumulative bids and asks either side of the mid price",
    },
    {
      id: "multiChart",
      title: "Multi-chart",
      body: "Up to nine charts in one grid, synced or independent.",
      alt: "The Multi-chart page with two EUL-USDT charts side by side, one hourly and one four-hourly",
    },
    {
      id: "liquidations",
      title: "Maps",
      body: "Who is being liquidated, in which market, right now.",
      alt: "The Maps page's liquidations view: a treemap of liquidations by market beside a live list",
    },
  ],
} as const;

// `id` names the venue's icon in assets/venues. Keep `coming` in step with
// `upcomingVenueLogos` in assets/index.ts, the app's own "coming soon" list.
export const venues = {
  now: {
    label: "Available now",
    items: [
      {
        id: "bybit",
        name: "Bybit",
        kind: "Centralised",
        chain: "—",
        status: "Trading",
        live: true,
      },
      {
        id: "hyperliquid",
        name: "Hyperliquid",
        kind: "Perp DEX",
        chain: "Hyperliquid L1",
        status: "Read-only",
        live: false,
      },
      {
        id: "aster",
        name: "Aster",
        kind: "Perp DEX",
        chain: "On-chain",
        status: "Read-only",
        live: false,
      },
    ],
  },
  coming: {
    label: "Coming",
    items: [
      { id: "binance", name: "Binance", kind: "Centralised" },
      { id: "okx", name: "OKX", kind: "Centralised" },
      { id: "coinbase", name: "Coinbase", kind: "Centralised" },
      { id: "kraken", name: "Kraken", kind: "Centralised" },
      { id: "kucoin", name: "KuCoin", kind: "Centralised" },
      { id: "bitget", name: "Bitget", kind: "Centralised" },
      { id: "backpack", name: "Backpack", kind: "Centralised" },
      { id: "gmx", name: "GMX", kind: "Perp DEX" },
      { id: "dydx", name: "dYdX", kind: "Perp DEX" },
    ],
  },
} as const;

export const status = {
  headline: "Still being built.",
  body: [
    "Pewterdesk is under active development and every release so far is a pre-release. Things change between versions, and some of them will break.",
    "Use a demo account until you trust it, keep sizes small when you go live, and tell us what goes wrong.",
  ],
  works: {
    title: "Works today",
    items: [
      "Market data on Bybit, Hyperliquid and Aster",
      "Orders on Bybit, demo and live",
      "Balances, positions and open orders on all three",
      "Maps, multi-chart, alerts and trading rules",
    ],
  },
  notYet: {
    title: "Not yet",
    items: [
      "Orders on Hyperliquid and Aster",
      "TradingView charts",
      "The trade journal",
      "The nine venues listed as coming",
    ],
  },
  report: "Report a problem",
};

export const install = {
  lede: "Download the app, or build it from the source that signs your orders.",
  download: `Download v${VERSION}`,
  note: "Pre-release, still in development. macOS 13+, Windows 10+, Linux with WebKitGTK 4.1.",
  commands: [`git clone ${REPO_URL}`, "cd pewterdesk && make install", "make dev"],
};
