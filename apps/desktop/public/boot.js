// Runs before the first paint: a plain, blocking script (not a module), so the
// saved theme is on <html> before anything is drawn and the page never flashes
// the wrong background. Same storage keys and values as src/hooks/useAppearance.ts.
(() => {
  const root = document.documentElement;
  try {
    // Nothing saved yet: Monokai Pro, the default (DEFAULT_THEME there).
    const theme = localStorage.getItem("pd.theme") ?? "monokai";
    // Same list as THEMES there, minus "dark" (Pewter): its tokens are the
    // bare :root ones, so it needs no attribute.
    if (
      [
        "graphite",
        "synthwave",
        "monokai",
        "palenight",
        "parchment",
        "bybit",
        "binance",
        "ftx",
        "hyrotrader",
        "bambam",
        "cosku",
      ].includes(theme)
    ) {
      root.dataset.theme = theme;
    }
    if (localStorage.getItem("pd.marketColors") === "colorblind")
      root.dataset.market = "colorblind";
  } catch {
    // Storage unavailable: the default theme.
    root.dataset.theme = "monokai";
  }
})();
