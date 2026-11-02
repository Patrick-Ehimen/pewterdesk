import type { Market, MarketSummary, VenueId } from "@pewterdesk/core";
import {
  enteredState,
  fundingPerHour,
  inRuleState,
  oiChangeOver,
  readingsOf,
  type ScanRule,
  t,
} from "@pewterdesk/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { venueClient } from "../api/venueClient";
import { notifyEvent } from "../lib/notifications";
import { loadOi } from "../lib/oiStore";
import {
  loadScanAlerts,
  type ScanAlert,
  saveScanAlerts,
  toggledScanAlert,
} from "../lib/scanAlerts";
import { OI_HISTORY_VENUES } from "./useMapData";
import { useMarketSummaries } from "./useVenueFeeds";
import { starredOn } from "./useWatchlist";

/** How often the markets alerted on are read again. */
const CHECK_MS = 5 * 60_000;
/** Between one market's reads and the next, to stay well inside rate limits. */
const PACE_MS = 150;
/** Starred markets read per venue: a list can be long, and this runs unattended. */
const MAX_STARRED = 40;
const HOURS = 168;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listOf = (feed: ReturnType<typeof useMarketSummaries>) =>
  feed.status === "live" || feed.status === "closed" ? feed.data : undefined;

/** Open interest's change over a day, however the venue lets it be known. */
async function oiChange(venue: VenueId, market: string, summary: MarketSummary) {
  const now = { time: Date.now(), oi: Number(summary.openInterest), price: 0 };
  if (OI_HISTORY_VENUES.includes(venue)) {
    const points = await venueClient.openInterestHistory(venue, market, 26).catch(() => undefined);
    const samples = (points ?? []).map((p) => ({ time: p.time, oi: Number(p.openInterest) }));
    return oiChangeOver([...samples, now], 24);
  }
  return oiChangeOver([...(loadOi(venue).markets[market] ?? []), now], 24);
}

/**
 * The scan alerts: every few minutes while the app runs, the markets alerted
 * on have their hourly candles read, a market at a time, and any that has just
 * entered a rule's state says so through `notifyEvent`. Read-only: it places
 * nothing. The first look at a market only notes where it stands, so nothing
 * fires for a state it was already in.
 */
export function useScanAlerts(markets: readonly Market[]) {
  const [alerts, setAlerts] = useState<ScanAlert[]>(loadScanAlerts);
  useEffect(() => saveScanAlerts(alerts), [alerts]);

  const uses = (venue: VenueId) => alerts.some((a) => a.venue === venue);
  const hyperliquid = listOf(useMarketSummaries("hyperliquid", uses("hyperliquid")));
  const aster = listOf(useMarketSummaries("aster", uses("aster")));
  const bybit = listOf(useMarketSummaries("bybit", uses("bybit")));
  const binance = listOf(useMarketSummaries("binance", uses("binance")));
  const blofin = listOf(useMarketSummaries("blofin", uses("blofin")));
  const summaries = useRef<Partial<Record<VenueId, readonly MarketSummary[]>>>({});
  summaries.current = { hyperliquid, aster, bybit, binance, blofin };
  const names = useRef(markets);
  names.current = markets;
  /** Where each rule last stood, per venue and market. */
  const stood = useRef(new Map<string, boolean>());
  const latest = useRef(alerts);
  latest.current = alerts;

  const check = useCallback(async (live: () => boolean) => {
    const rules = new Map<string, { venue: VenueId; market: string; rules: Set<ScanRule> }>();
    for (const a of latest.current) {
      const ids = a.market ? [a.market] : starredOn(a.venue).slice(0, MAX_STARRED);
      for (const market of ids) {
        const key = `${a.venue}:${market}`;
        const entry = rules.get(key) ?? { venue: a.venue, market, rules: new Set<ScanRule>() };
        entry.rules.add(a.rule);
        rules.set(key, entry);
      }
    }
    for (const [key, { venue, market, rules: wanted }] of rules) {
      if (!live()) return;
      const summary = summaries.current[venue]?.find((s) => s.market === market);
      const price = Number(summary?.markPrice);
      if (!summary || !(price > 0)) continue;
      try {
        const candles = await venueClient.candles(venue, market, "1h", Date.now() + 1, HOURS);
        const prev = Number(summary.prevDayPrice);
        const read = readingsOf(
          candles,
          price,
          Date.now(),
          fundingPerHour(summary),
          prev > 0 ? price / prev - 1 : undefined,
          wanted.has("squeeze") ? await oiChange(venue, market, summary) : undefined,
        );
        for (const rule of wanted) {
          const now = inRuleState(rule, read);
          const ruleKey = `${key}:${rule}`;
          if (enteredState(stood.current.get(ruleKey), now)) {
            const symbol = names.current.find((m) => m.id === market)?.symbol ?? market;
            notifyEvent({
              type: "alert",
              title: t("mapx.alert.fired", { symbol, rule: t(`mapx.alert.rule.${rule}`) }),
              venue,
              market,
            });
          }
          stood.current.set(ruleKey, now);
        }
      } catch {
        // Skipped this round; the next one tries again.
      }
      await sleep(PACE_MS);
    }
  }, []);

  const any = alerts.length > 0;
  useEffect(() => {
    if (!any) return;
    let running = true;
    const live = () => running;
    // A moment in, so summaries have arrived for the first look.
    const first = setTimeout(() => void check(live), 15_000);
    const id = setInterval(() => void check(live), CHECK_MS);
    return () => {
      running = false;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [any, check]);

  const toggle = useCallback(
    (rule: ScanRule, venue: VenueId, market: string | null, symbol?: string) =>
      setAlerts((now) => toggledScanAlert(now, { rule, venue, market, symbol })),
    [],
  );
  const remove = useCallback(
    (id: string) => setAlerts((now) => now.filter((a) => a.id !== id)),
    [],
  );
  return useMemo(() => ({ alerts, toggle, remove }), [alerts, toggle, remove]);
}
