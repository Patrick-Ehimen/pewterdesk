import type { AccountSnapshot, Market, MarketStats } from "@pewterdesk/core";
import { decimalsOf, formatNumber, formatSigned } from "@pewterdesk/ui";
import { useEffect, useRef } from "react";
import { appClient, type TitlePart, type TrayUpdate } from "../api/appClient";
import { useStoredChoice } from "./useStoredChoice";

/** What the menu-bar item shows beside the icon. */
export const TRAY_MODES = ["pricePnl", "price", "pnl", "icon"] as const;
export type TrayMode = (typeof TRAY_MODES)[number];

/** Each mode's label, for the tray panel's "Show in menu bar" choice. */
export const TRAY_MODE_LABEL = {
  pricePnl: "tray.pricePnl",
  price: "tray.price",
  pnl: "tray.pnl",
  icon: "tray.iconOnly",
} as const;

/**
 * An en space: the gap after the icon and between the title's groups
 * (name and price · 24h change · PnL), wider than a word space.
 */
const GAP = "\u2002";

/** Price ticks arrive often; the tray is redrawn at most this often. */
const SEND_AFTER_MS = 400;

/**
 * Keeps the menu-bar (tray) item's title in step with the app: the market on
 * screen with its price and 24h change, and the account's PnL. The window
 * can be closed (the app keeps running in the menu bar), so this runs
 * regardless of what's on screen. The tray panel (`tray/TrayPanel.tsx`)
 * shows the rest.
 */
export function useTraySync({
  market,
  stats,
  account,
}: {
  market?: Market;
  stats?: MarketStats;
  account?: AccountSnapshot;
}) {
  const [mode, setMode] = useStoredChoice<TrayMode>("pd.tray.mode", TRAY_MODES, "pricePnl");
  useEffect(
    () =>
      appClient.onTrayMode((picked) => {
        const next = TRAY_MODES.find((m) => m === picked);
        if (next) setMode(next);
      }),
    [setMode],
  );

  const price = stats ? formatNumber(stats.markPrice, decimalsOf(stats.markPrice)) : undefined;
  const mark = Number(stats?.markPrice);
  const prevDay = Number(stats?.prevDayPrice);
  const change = prevDay > 0 ? (mark - prevDay) / prevDay : undefined;
  const pnlTotal = account?.positions.reduce((sum, p) => sum + Number(p.unrealizedPnl), 0);
  const pnl = pnlTotal === undefined ? undefined : formatSigned(pnlTotal);
  const base = market?.base;

  // Green for a rise or a profit, red for a fall or a loss.
  const toned = (value: number, text: string): TitlePart => ({
    text,
    tone: value > 0 ? "up" : value < 0 ? "down" : "plain",
  });
  const priced: TitlePart[] =
    base && price
      ? [
          { text: `${base} ${price}`, tone: "plain" },
          ...(change === undefined ? [] : [toned(change, `${GAP}${formatSigned(change * 100)}%`)]),
        ]
      : [];
  const profit: TitlePart[] =
    pnlTotal === undefined || pnl === undefined ? [] : [toned(pnlTotal, pnl)];

  const groups: TitlePart[] = (() => {
    switch (mode) {
      case "pricePnl":
        return priced.length && profit.length
          ? [...priced, { text: GAP, tone: "plain" as const }, ...profit]
          : [...priced, ...profit];
      case "price":
        return priced;
      case "pnl":
        return profit;
      case "icon":
        return [];
    }
  })();
  // A gap between the icon and the text, when there is text.
  const title: TitlePart[] = groups.length ? [{ text: GAP, tone: "plain" }, ...groups] : [];

  const update: TrayUpdate = { title };

  // Send only what changed, and not on every tick.
  const key = JSON.stringify(update);
  const sent = useRef("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `update`
  useEffect(() => {
    if (key === sent.current) return;
    const id = setTimeout(() => {
      sent.current = key;
      appClient.updateTray(update).catch(() => {});
    }, SEND_AFTER_MS);
    return () => clearTimeout(id);
  }, [key]);
}
