import type { MarketSummary, VenueId } from "@pewterdesk/core";
import {
  type AlertDraft,
  type AlertKind,
  canFire,
  crossed,
  type FiredAlert,
  isToday,
  type MarketAlert,
  watchedValue,
} from "@pewterdesk/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AlertsState, loadAlerts, saveAlerts } from "../lib/alerts";
import { useMarketSummaries } from "./useVenueFeeds";

/** Fired alerts kept for the "Fired today" list. */
const FIRED_KEPT = 50;

const summaryOf = (feed: ReturnType<typeof useMarketSummaries>) =>
  feed.status === "live" || feed.status === "closed" ? feed.data : undefined;

/**
 * The market alerts: kept on this machine, and checked against each venue's
 * market summaries while pewterdesk runs (the main window's page keeps
 * running in the menu bar when the window is closed). A venue's summaries
 * stream only while it has an alert to check, or while the popover is open
 * to show how close each one is.
 */
export function useAlerts(popoverOpen: boolean) {
  const [state, setState] = useState<AlertsState>(loadAlerts);
  useEffect(() => saveAlerts(state), [state]);

  // Open, the popover shows every alert's distance (and the form any venue's
  // "now"), so it wants every venue's prices.
  const watching = (venue: VenueId) =>
    popoverOpen || (!state.paused && state.alerts.some((a) => a.active && a.venue === venue));
  const hyperliquid = useMarketSummaries("hyperliquid", watching("hyperliquid"));
  const aster = useMarketSummaries("aster", watching("aster"));
  const bybit = useMarketSummaries("bybit", watching("bybit"));
  const hyperliquidSummaries = summaryOf(hyperliquid);
  const asterSummaries = summaryOf(aster);
  const bybitSummaries = summaryOf(bybit);
  // Each venue's summaries by market id.
  const byVenue = useMemo(() => {
    const index = (list: readonly MarketSummary[] | undefined) =>
      new Map((list ?? []).map((s) => [s.market, s]));
    return new Map<VenueId, Map<string, MarketSummary>>([
      ["hyperliquid", index(hyperliquidSummaries)],
      ["aster", index(asterSummaries)],
      ["bybit", index(bybitSummaries)],
    ]);
  }, [hyperliquidSummaries, asterSummaries, bybitSummaries]);

  // The last value each alert saw, so a crossing needs two readings.
  const previous = useRef(new Map<string, number>());
  useEffect(() => {
    if (state.paused) {
      // Resuming starts from fresh readings rather than firing on the gap.
      previous.current.clear();
      return;
    }
    const now = Date.now();
    const fired: FiredAlert[] = [];
    const updates = new Map<string, Partial<MarketAlert>>();
    for (const alert of state.alerts) {
      const summaries = byVenue.get(alert.venue);
      if (!summaries || summaries.size === 0) continue;
      const current = watchedValue(alert.kind, summaries.get(alert.market));
      const before = previous.current.get(alert.id);
      if (current !== undefined) previous.current.set(alert.id, current);
      if (current === undefined || !canFire(alert, now) || !crossed(alert, before, current)) {
        continue;
      }
      fired.push({
        id: crypto.randomUUID(),
        alertId: alert.id,
        kind: alert.kind,
        venue: alert.venue,
        market: alert.market,
        symbol: alert.symbol,
        condition: alert.condition,
        value: alert.value,
        actual: current,
        time: now,
      });
      updates.set(alert.id, { firedAt: now, active: alert.repeat === "every" });
    }
    if (fired.length === 0) return;
    setState((s) => ({
      ...s,
      alerts: s.alerts.map((a) => {
        const update = updates.get(a.id);
        return update ? { ...a, ...update } : a;
      }),
      fired: [...fired.reverse(), ...s.fired].slice(0, FIRED_KEPT),
    }));
  }, [byVenue, state.alerts, state.paused]);

  const currentOf = useCallback(
    (venue: VenueId, market: string, kind: AlertKind) =>
      watchedValue(kind, byVenue.get(venue)?.get(market)),
    [byVenue],
  );

  const create = useCallback((draft: AlertDraft) => {
    const alert: MarketAlert = {
      ...draft,
      id: crypto.randomUUID(),
      active: true,
      createdAt: Date.now(),
    };
    setState((s) => ({ ...s, alerts: [...s.alerts, alert] }));
  }, []);
  const toggle = useCallback((id: string, active: boolean) => {
    // Switched back on: wait for a fresh crossing, not the one it just saw.
    previous.current.delete(id);
    setState((s) => ({
      ...s,
      alerts: s.alerts.map((a) => (a.id === id ? { ...a, active, firedAt: undefined } : a)),
    }));
  }, []);
  const remove = useCallback((id: string) => {
    previous.current.delete(id);
    setState((s) => ({ ...s, alerts: s.alerts.filter((a) => a.id !== id) }));
  }, []);
  const setPaused = useCallback((paused: boolean) => setState((s) => ({ ...s, paused })), []);
  const clearFired = useCallback(() => setState((s) => ({ ...s, fired: [] })), []);
  const markSeen = useCallback(() => setState((s) => ({ ...s, seenAt: Date.now() })), []);

  const firedToday = state.fired.filter((f) => isToday(f.time));
  const unseen = firedToday.filter((f) => f.time > state.seenAt).length;

  return {
    alerts: state.alerts,
    fired: firedToday,
    paused: state.paused,
    unseen,
    currentOf,
    create,
    toggle,
    remove,
    setPaused,
    clearFired,
    markSeen,
  };
}
