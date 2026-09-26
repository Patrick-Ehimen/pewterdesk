// Runs before the first paint: a plain, blocking script (not a module), so the
// saved theme is on <html> before anything is drawn and the page never flashes
// the wrong background. Same storage keys and values as src/hooks/useAppearance.ts.
(() => {
  try {
    const root = document.documentElement;
    const theme = localStorage.getItem("pd.theme");
    // Same list as THEMES in src/hooks/useAppearance.ts, minus the default "dark".
    if (["graphite", "synthwave", "monokai", "palenight", "parchment"].includes(theme)) {
      root.dataset.theme = theme;
    }
    if (localStorage.getItem("pd.marketColors") === "colorblind")
      root.dataset.market = "colorblind";
  } catch {
    // Storage unavailable: dark theme, the default.
  }
})();
