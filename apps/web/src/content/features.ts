// The Features page's copy. Every line here describes something the app does
// today; check it against CLAUDE.md before adding to it.
export const head = {
  label: "Features",
  title: "Everything on the desk.",
  lede: "One window for the chart, the book and the ticket - and the pages around them for when you need to see more of the market than one pair.",
};

export const trade = {
  label: "§ 01 — Trade",
  title: "Chart, book and ticket in one window.",
  body: [
    "The workspace is one screen: the market's chart, its live order book and trade tape, and the ticket, with your balances, positions and orders underneath.",
    "Every number you need before you click is on screen before you click: available balance, order value, margin, estimated slippage and fees.",
  ],
  rows: [
    { label: "Markets panel", value: "Charts · Overview · Depth · Screener · Watchlist" },
    { label: "Chart", value: "1m to 1D · candles, Heikin Ashi, line and more · indicators" },
    { label: "Order book", value: "Three layouts · live bid / ask share" },
    { label: "Ticket", value: "Market · Limit · Reduce only · TP/SL" },
    { label: "Account", value: "Balances · Positions · Orders · History" },
  ],
  alt: "The Trade workspace on BTC-USDT: chart on the left, order book in the middle, ticket on the right",
  caption: "Fig. 1 — The Trade workspace. BTC-USDT on Bybit, hourly candles.",
};

export const depth = {
  label: "§ 02 — Depth",
  title: "See the shape of the book.",
  body: [
    "The depth tab draws cumulative bids and asks either side of the mid, so a wall is a step you can see rather than a row you have to find.",
    "It totals each side, shows how much sits within half a percent of the mid, and reads out price, size and share of side wherever you point.",
  ],
  alt: "The depth tab for ARC-USDT: bids in green to the left of the mid price, asks in red to the right, with a readout under the pointer",
  caption: "Fig. 2 — Depth on ARC-USDT. Bids $224.69K, asks $171.40K.",
};

export const multiChart = {
  label: "§ 03 — Multi-chart",
  title: "Nine charts, one crosshair.",
  body: [
    "Lay charts out in a grid and choose what they share: the interval, the symbol, the crosshair, the visible range - or nothing at all.",
    "Pop any chart out into a window of its own. Turn Trade on and each chart gets buy and sell buttons you have to hold, so a stray click can't send an order.",
  ],
  rows: [
    { label: "Layouts", value: "1×2 · 1×3 · 2×2 · 2×3 · 3×3 · 1+2" },
    { label: "Sync", value: "Interval · Symbol · Crosshair · Range" },
    { label: "Pop-out windows", value: "Up to 8" },
    { label: "Trade", value: "Hold 0.4s to buy or sell · drag TP / SL lines" },
  ],
  alt: "The Multi-chart page: two EUL-USDT charts side by side, hourly on the left and four-hourly on the right",
  caption: "Fig. 3 — One market at two intervals, crosshair synced.",
};

export const maps = {
  label: "§ 04 — Maps",
  title: "The market, not just your pair.",
  body: [
    "Four maps of everything listed: which markets are stretched, which sectors are moving, and where leverage is being flushed out.",
    "Liquidations arrive live and are sized by market, with the last day's totals split by longs and shorts beside them.",
  ],
  rows: [
    { label: "RSI heatmap", value: "Every market, from its own candles" },
    { label: "Market heatmap", value: "The largest coins, by sector" },
    { label: "Liquidations", value: "Live feed · 1H to 24H totals" },
    { label: "Liquidation heatmap", value: "Estimated from open interest" },
  ],
  alt: "The Maps page's liquidations view: a treemap sized by market, with totals and a live list on the right",
  caption: "Fig. 4 — Liquidations by market over four hours.",
};

export const palette = {
  label: "§ 05 — Command palette",
  title: "Type the trade.",
  body: [
    "One shortcut opens a palette that reads orders the way you'd say them, and finds markets, pages, venues and themes.",
    "Nothing is sent on the first Enter. The palette shows exactly what the order would be, and sends it on the second.",
  ],
  shortcut: "⌘K · Ctrl+K",
  commands: [
    { text: "buy 100 hype at 38.2", note: "a limit order" },
    { text: "buy 100 hype at 38.2 to 37.8 x5", note: "scaled across five prices" },
    { text: "sell 50% hype", note: "half the position" },
    { text: "tp hype 41", note: "a take-profit" },
    { text: "close eth", note: "close the position" },
    { text: "cancel all", note: "every open order" },
  ],
};

export const rules = {
  label: "§ 06 — Trading rules",
  title: "Rules you can't talk yourself out of.",
  body: [
    "Set your own limits per account, and the app checks every order against them before anything is signed. An order that breaks a rule is refused.",
    "Tightening a rule applies at once. Loosening one waits until the next midnight UTC, so the limit you set with a clear head still holds when you don't have one. Closing a position is never blocked.",
  ],
  list: [
    "Max daily loss",
    "Max drawdown",
    "Risk per trade",
    "Position size",
    "Trades per day",
    "Trading hours",
    "Cool-off after losses",
  ],
  note: "Enforced where orders are placed today: Bybit.",
};

export const edges = {
  label: "§ 07 — Around the edges",
  title: "The rest of the desk.",
  items: [
    {
      title: "Floating window",
      body: "A small window that stays over other apps, opened with a global shortcut and hidden from screen sharing by default.",
    },
    {
      title: "Alerts and notifications",
      body: "Fills, position changes, price alerts and liquidation warnings as toasts, desktop notifications or sound.",
    },
    {
      title: "Menu bar",
      body: "Closing the window keeps the desk running in the tray, a click away.",
    },
    {
      title: "Portfolio",
      body: "The connected account's equity and exposure on one page.",
    },
    {
      title: "News",
      body: "Venue announcements and headlines from news sites, as plain text inside the app.",
    },
    {
      title: "Six themes",
      body: "Monokai Pro, Graphite, Synthwave '84, Pewter, Palenight and Parchment.",
    },
    {
      title: "Eight languages",
      body: "English, Spanish, French, Japanese, Korean, Portuguese, Russian and Chinese.",
    },
    {
      title: "Keyboard first",
      body: "Shortcuts for the things you do most, all listed in Settings.",
    },
  ],
} as const;
