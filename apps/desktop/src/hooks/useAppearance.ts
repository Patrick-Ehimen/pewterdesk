import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { useStoredChoice } from "./useStoredChoice";

/** Brand themes: see .claude/brand/BRAND.md. Keep in sync with public/boot.js. */
export const THEMES = [
  "dark",
  "graphite",
  "synthwave",
  "monokai",
  "palenight",
  "parchment",
] as const;
export type Theme = (typeof THEMES)[number];

/** Light-background themes, which take the light logo. */
export const isLightTheme = (theme: Theme) => theme === "parchment";
/** Market colors: the standard green/red, or the colorblind-safe blue/orange. */
export type MarketColors = "standard" | "colorblind";

const MARKET_COLORS = ["standard", "colorblind"] as const;

function applyAppearance(theme: Theme, market: MarketColors) {
  const root = document.documentElement;
  if (theme === "dark") delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (market === "colorblind") root.dataset.market = "colorblind";
  else delete root.dataset.market;
  syncWindowBackground();
}

/**
 * Matches the native window's background to the theme's --pd-bg. It shows
 * between documents during a reload; tauri.conf.json starts it on the dark
 * theme's color, and this keeps light-theme users from a dark flash.
 */
function syncWindowBackground() {
  if (!isTauri()) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--pd-bg").trim();
  if (bg)
    getCurrentWindow()
      .setBackgroundColor(bg)
      .catch(() => {});
}

/**
 * Applies the saved theme and market colors straight away, before React
 * renders, so a light-theme user doesn't see a dark splash first.
 */
export function applyStoredAppearance() {
  const read = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    try {
      const saved = localStorage.getItem(key);
      return allowed.find((a) => a === saved) ?? fallback;
    } catch {
      return fallback;
    }
  };
  applyAppearance(
    read("pd.theme", THEMES, "dark"),
    read("pd.marketColors", MARKET_COLORS, "standard"),
  );
}

/**
 * Theme and market colors, remembered between sessions and applied to
 * `<html>` as `data-theme` / `data-market`, which is where the brand tokens
 * (.claude/brand/pewterdesk-tokens.css) look for them.
 */
export function useAppearance() {
  const [theme, setTheme] = useStoredChoice<Theme>("pd.theme", THEMES, "dark");
  const [market, setMarket] = useStoredChoice<MarketColors>(
    "pd.marketColors",
    MARKET_COLORS,
    "standard",
  );

  useEffect(() => applyAppearance(theme, market), [theme, market]);

  return { theme, setTheme, market, setMarket };
}
