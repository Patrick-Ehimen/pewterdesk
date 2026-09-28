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
  };
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
