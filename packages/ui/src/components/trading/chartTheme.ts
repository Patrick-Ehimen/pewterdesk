import { ColorType, CrosshairMode } from "lightweight-charts";

// Shared by the lightweight-charts wrappers (candles, funding).

/** The brand tokens the chart needs, read from the page so themes apply. */
export function tokens(el: HTMLElement) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    bg: v("--pd-surface"),
    text: v("--pd-pewter"),
    grid: v("--pd-border"),
    border: v("--pd-border-strong"),
    buy: v("--pd-buy"),
    sell: v("--pd-sell"),
    buyTint: v("--pd-buy-tint"),
    sellTint: v("--pd-sell-tint"),
    crosshair: v("--pd-pewter-dim"),
    line: v("--pd-text"),
    font: v("--pd-font-mono"),
    // Indicator lines: the accent, the two status colors, and a quiet one.
    brass: v("--pd-brass"),
    info: v("--pd-info"),
    warning: v("--pd-warning"),
    muted: v("--pd-pewter"),
  };
}

/** `color` (a token's #rrggbb or rgb()) at `alpha` opacity, for area fills. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb?.[1]) {
    const [r, g, b] = rgb[1].split(/[\s,/]+/).filter(Boolean);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

export type Tokens = ReturnType<typeof tokens>;

export function chartOptions(t: Tokens) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: t.bg },
      textColor: t.text,
      fontFamily: t.font,
      fontSize: 11,
      attributionLogo: false,
      // Indicator panes (RSI, MACD) are divided by a hairline, not the default white.
      panes: { separatorColor: t.border, separatorHoverColor: t.grid },
    },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    rightPriceScale: { borderColor: t.border },
    timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: t.crosshair, labelBackgroundColor: t.border },
      horzLine: { color: t.crosshair, labelBackgroundColor: t.border },
    },
  };
}
