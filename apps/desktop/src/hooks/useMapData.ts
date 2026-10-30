import type {
  Candle,
  Market,
  MarketHistory,
  MarketSummary,
  OrderBook,
  VenueId,
} from "@pewterdesk/core";
import {
  type BookColumn,
  bookColumn,
  bookStep,
  type CoinRow,
  type FlowTrade,
  joinByCoin,
  type LongShortRow,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { venueClient } from "../api/venueClient";
import { recordOi } from "../lib/oiStore";
import { useMarketSummaries, useMarkets, useOrderBook } from "./useVenueFeeds";

// The data behind the Maps page's newer views. Each hook only reads while
// its view is open (`enabled`), except `useOiRecorder`, which samples open
// interest from summaries the app streams anyway.

const summariesOf = (feed: ReturnType<typeof useMarketSummaries>) =>
  feed.status === "live" || feed.status === "closed" ? feed.data : undefined;
const marketsOf = (feed: ReturnType<typeof useMarkets>) =>
  feed.status === "live" || feed.status === "closed" ? feed.data : undefined;

/** Histories already streamed, per venue, so reopening a view doesn't start over. */
const historyCache = new Map<VenueId, Map<string, MarketHistory>>();

/**
 * Every market's last 7 days of hourly candles, streamed in busiest first
 * (the same stream the screener reads), kept across visits to the page.
 */
export function useMarketHistories(venue: VenueId, enabled: boolean) {
  const [histories, setHistories] = useState<ReadonlyMap<string, MarketHistory>>(
    () => historyCache.get(venue) ?? new Map(),
  );
  useEffect(() => {
    setHistories(historyCache.get(venue) ?? new Map());
    if (!enabled) return;
    // Batched: a full pass is hundreds of messages.
    let pending: MarketHistory[] = [];
    const flush = setInterval(() => {
      if (pending.length === 0) return;
      const cache = new Map(historyCache.get(venue) ?? []);
      for (const h of pending) cache.set(h.market, h);
      pending = [];
      historyCache.set(venue, cache);
      setHistories(cache);
    }, 1000);
    const stop = venueClient.subscribeMarketHistory(venue, {
      onUpdate: (history) => pending.push(history),
      onClosed: () => {},
      onError: () => {},
    });
    return () => {
      clearInterval(flush);
      stop();
    };
  }, [venue, enabled]);
  return histories;
}

/** A venue's crypto perps by coin: stocks and the like share tickers with unrelated coins. */
function cryptoBases(markets: readonly Market[] | undefined) {
  const map = new Map<string, string>();
  for (const m of markets ?? []) {
    if (m.category && m.category !== "innovation") continue;
    map.set(m.id, m.base);
  }
  return map;
}

/**
 * Every venue's summaries joined by coin, for the funding and spread views:
 * three streams the status bar already keeps open.
 */
export function useCrossVenue(enabled: boolean) {
  const hlMarkets = marketsOf(useMarkets(enabled ? "hyperliquid" : undefined));
  const asterMarkets = marketsOf(useMarkets(enabled ? "aster" : undefined));
  const bybitMarkets = marketsOf(useMarkets(enabled ? "bybit" : undefined));
  const binanceMarkets = marketsOf(useMarkets(enabled ? "binance" : undefined));
  const blofinMarkets = marketsOf(useMarkets(enabled ? "blofin" : undefined));
  const hl = summariesOf(useMarketSummaries("hyperliquid", enabled));
  const aster = summariesOf(useMarketSummaries("aster", enabled));
  const bybit = summariesOf(useMarketSummaries("bybit", enabled));
  const binance = summariesOf(useMarketSummaries("binance", enabled));
  const blofin = summariesOf(useMarketSummaries("blofin", enabled));
  const rows = useMemo<CoinRow[]>(() => {
    const bases: Record<VenueId, Map<string, string>> = {
      hyperliquid: cryptoBases(hlMarkets),
      aster: cryptoBases(asterMarkets),
      bybit: cryptoBases(bybitMarkets),
      binance: cryptoBases(binanceMarkets),
      blofin: cryptoBases(blofinMarkets),
    };
    return joinByCoin({ hyperliquid: hl, aster, bybit, binance, blofin }, (venue, market) =>
      bases[venue].get(market),
    );
  }, [
    hl,
    aster,
    bybit,
    binance,
    blofin,
    hlMarkets,
    asterMarkets,
    bybitMarkets,
    binanceMarkets,
    blofinMarkets,
  ]);
  return { rows, loading: !hl && !aster && !bybit && !binance && !blofin };
}

/**
 * Samples open interest once an hour while the app runs, on the venues that
 * publish no history of it: Hyperliquid, Aster and BloFin.
 */
export function useOiRecorder() {
  const hl = summariesOf(useMarketSummaries("hyperliquid", true));
  const aster = summariesOf(useMarketSummaries("aster", true));
  const blofin = summariesOf(useMarketSummaries("blofin", true));
  useEffect(() => {
    if (hl) recordOi("hyperliquid", hl, Date.now());
  }, [hl]);
  useEffect(() => {
    if (aster) recordOi("aster", aster, Date.now());
  }, [aster]);
  useEffect(() => {
    if (blofin) recordOi("blofin", blofin, Date.now());
  }, [blofin]);
}

/** Markets whose open-interest history is fetched, busiest by open interest first. */
const OI_MARKETS = 40;
const OI_REFRESH_MS = 10 * 60_000;
/** Between one market's request and the next, to stay well inside rate limits. */
const PACE_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NONE: string[] = [];
const NO_IDS: { id: string; base: string }[] = [];

/** The venues that publish an hourly open-interest history. */
export const OI_HISTORY_VENUES: readonly VenueId[] = ["bybit", "binance"];

/**
 * The venue's own hourly open-interest history for its busiest markets
 * (only on `OI_HISTORY_VENUES`), refreshed every few minutes.
 */
export function useOiHistory(
  venue: VenueId,
  summaries: readonly MarketSummary[] | undefined,
  enabled: boolean,
) {
  const [state, setState] = useState<{
    venue?: VenueId;
    samples: Map<string, { time: number; oi: number }[]>;
  }>({ samples: new Map() });
  // The markets to read, ranked once per venue from the first summaries to
  // arrive (not on every tick, which would restart the reads).
  const [ranked, setRanked] = useState<{ venue: VenueId; ids: string[] }>();
  useEffect(() => {
    if (!summaries || ranked?.venue === venue) return;
    setRanked({
      venue,
      ids: [...summaries]
        .sort(
          (a, b) =>
            Number(b.openInterest) * Number(b.markPrice) -
            Number(a.openInterest) * Number(a.markPrice),
        )
        .slice(0, OI_MARKETS)
        .map((s) => s.market),
    });
  }, [summaries, venue, ranked]);
  const ids = ranked?.venue === venue ? ranked.ids : NONE;
  useEffect(() => {
    if (!enabled || ids.length === 0 || !OI_HISTORY_VENUES.includes(venue)) return;
    let live = true;
    const load = async () => {
      const samples = new Map<string, { time: number; oi: number }[]>();
      for (const id of ids) {
        if (!live) return;
        try {
          const points = await venueClient.openInterestHistory(venue, id, 26);
          samples.set(
            id,
            points.map((p) => ({ time: p.time, oi: Number(p.openInterest) })),
          );
        } catch {
          // Skipped this round; the next refresh tries again.
        }
        if (live) setState({ venue, samples: new Map(samples) });
        await sleep(PACE_MS);
      }
    };
    void load();
    const id = setInterval(load, OI_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [venue, enabled, ids]);
  return state.venue === venue ? state.samples : new Map<string, { time: number; oi: number }[]>();
}

/** Markets whose long / short ratio is read. */
const LS_MARKETS = 30;

/** The venues that publish an account long / short ratio. */
export const LONG_SHORT_VENUES: readonly VenueId[] = ["bybit", "binance"];

/**
 * Whose long / short ratio the Maps page reads: the venue on screen's, where
 * it publishes one, and Bybit's on a venue that doesn't.
 */
export const longShortSource = (venue: VenueId): VenueId =>
  LONG_SHORT_VENUES.includes(venue) ? venue : "bybit";

/**
 * `source`'s share of accounts long on its busiest USDT perps, now and a
 * day ago, refreshed every few minutes (see `longShortSource`).
 */
export function useLongShort(enabled: boolean, source: VenueId) {
  const summaries = summariesOf(useMarketSummaries(source, enabled));
  const sourceMarkets = marketsOf(useMarkets(enabled ? source : undefined));
  const [state, setState] = useState<{
    rows: LongShortRow[];
    done: number;
    total: number;
    error?: string;
  }>({ rows: [], done: 0, total: 0 });
  // Ranked once per source, from the first summaries to arrive.
  const [ranked, setRanked] = useState<{ source: VenueId; ids: { id: string; base: string }[] }>();
  const ids = ranked?.source === source ? ranked.ids : NO_IDS;
  useEffect(() => {
    if (!summaries || !sourceMarkets || ranked?.source === source) return;
    const bases = cryptoBases(sourceMarkets);
    const top = [...summaries]
      .filter((s) => s.market.endsWith("USDT") && bases.has(s.market))
      .sort((a, b) => Number(b.dayVolume) - Number(a.dayVolume))
      .slice(0, LS_MARKETS)
      .map((s) => ({ id: s.market, base: bases.get(s.market) ?? s.market }));
    if (top.length === 0) return;
    setRanked({ source, ids: top });
    setState({ rows: [], done: 0, total: top.length });
  }, [summaries, sourceMarkets, ranked, source]);
  useEffect(() => {
    if (!enabled || ids.length === 0) return;
    let live = true;
    const load = async () => {
      const rows: LongShortRow[] = [];
      let failed = 0;
      let lastError = "";
      for (const [i, { id, base }] of ids.entries()) {
        if (!live) return;
        try {
          const points = await venueClient.longShortRatio(source, id, 25);
          const last = points[points.length - 1];
          if (last) {
            rows.push({
              base,
              long: Number(last.longRatio),
              dayAgo: points.length >= 24 ? Number(points[0]?.longRatio) : undefined,
            });
          }
        } catch (err) {
          failed += 1;
          lastError = String(err);
        }
        if (live) {
          setState({
            rows: [...rows],
            done: i + 1,
            total: ids.length,
            error: failed === i + 1 && failed >= 3 ? lastError : undefined,
          });
        }
        await sleep(PACE_MS);
      }
    };
    void load();
    const id = setInterval(load, OI_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [enabled, ids, source]);
  return state;
}

/** Days of hourly candles behind the seasonality and sessions views. */
export const SEASON_DAYS = 30;

/** One market's last `SEASON_DAYS` days of hourly candles, refreshed hourly. */
export function useSeasonCandles(venue: VenueId, market: string | undefined, enabled: boolean) {
  const [state, setState] = useState<{
    key?: string;
    candles?: Candle[];
    error?: string;
  }>({});
  const key = `${venue}:${market}`;
  useEffect(() => {
    if (!enabled || !market) return;
    let live = true;
    const load = () =>
      venueClient.candles(venue, market, "1h", Date.now() + 1, SEASON_DAYS * 24).then(
        (candles) => live && setState({ key, candles }),
        (err) => live && setState({ key, error: err instanceof Error ? err.message : String(err) }),
      );
    void load();
    const id = setInterval(load, 60 * 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [venue, market, key, enabled]);
  return state.key === key ? state : {};
}

/** Rows in the order book heatmap, and columns (seconds) across it. */
export const BOOK_ROWS = 90;
export const BOOK_COLUMNS = 300;

/**
 * The order book sampled once a second into price rows, ±`span` around the
 * price, for the last `BOOK_COLUMNS` seconds. The rows are set from the
 * first book and set again (the history cleared) once the price nears an
 * edge, or the market or span changes.
 */
export function useBookHeat(
  venue: VenueId,
  market: string | undefined,
  span: number,
  enabled: boolean,
) {
  const feed = useOrderBook(venue, enabled ? market : undefined);
  const book: OrderBook | undefined =
    feed.status === "live" || feed.status === "closed" ? feed.data : undefined;
  const latest = useRef<OrderBook | undefined>(undefined);
  latest.current = book;
  const [state, setState] = useState<{
    columns: BookColumn[];
    top: number;
    step: number;
  }>({ columns: [], top: 0, step: 0 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: a venue switch starts over, even on a market id two venues share
  useEffect(() => {
    if (!enabled || !market) return;
    let grid: { top: number; step: number } | undefined;
    let columns: BookColumn[] = [];
    setState({ columns: [], top: 0, step: 0 });
    const id = setInterval(() => {
      const b = latest.current;
      if (!b || b.market !== market) return;
      const mid = (Number(b.bids[0]?.price) + Number(b.asks[0]?.price)) / 2;
      if (!(mid > 0)) return;
      const row = grid ? (grid.top + grid.step - mid) / grid.step : -1;
      if (!grid || row < BOOK_ROWS * 0.1 || row > BOOK_ROWS * 0.9) {
        const step = bookStep(mid, span, BOOK_ROWS);
        if (!(step > 0)) return;
        grid = { step, top: Math.ceil(mid / step) * step + (BOOK_ROWS / 2 - 1) * step };
        columns = [];
      }
      const col = bookColumn(b, grid.top, grid.step, BOOK_ROWS, Date.now());
      if (!col) return;
      columns = [...columns.slice(-(BOOK_COLUMNS - 1)), col];
      setState({ columns, top: grid.top, step: grid.step });
    }, 1000);
    return () => clearInterval(id);
  }, [venue, market, span, enabled]);

  return { ...state, error: feed.status === "error" ? feed.message : undefined };
}

/** Funding read for the funding history view, per venue and market, and when. */
const fundingCache = new Map<string, { at: number; rates: { time: number; rate: number }[] }>();
/** How long a market's funding history is kept before it's read again. */
const FUNDING_FRESH_MS = 10 * 60_000;
/** Markets read at once: the venue's rate limits are per account of requests. */
const FUNDING_PARALLEL = 3;

/**
 * The last 7 days of funding for `markets` (ids), read a few at a time and
 * kept for ten minutes, while `enabled`. Each market's rates arrive as
 * they're read.
 */
export function useFundingHistory(
  venue: VenueId,
  markets: readonly string[],
  start: number,
  enabled: boolean,
) {
  const [version, setVersion] = useState(0);
  const wanted = markets.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` is `markets`, by value
  useEffect(() => {
    if (!enabled || markets.length === 0) return;
    let live = true;
    const due = markets.filter((m) => {
      const had = fundingCache.get(`${venue}:${m}`);
      return !had || Date.now() - had.at > FUNDING_FRESH_MS;
    });
    const queue = [...due];
    const worker = async () => {
      for (let m = queue.shift(); m !== undefined && live; m = queue.shift()) {
        try {
          const rates = await venueClient.fundingHistory(venue, m, start);
          fundingCache.set(`${venue}:${m}`, {
            at: Date.now(),
            rates: rates.map((r) => ({ time: r.time, rate: Number(r.rate) })),
          });
        } catch {
          // Unread: the row shows empty buckets.
          fundingCache.set(`${venue}:${m}`, { at: Date.now(), rates: [] });
        }
        if (live) setVersion((v) => v + 1);
      }
    };
    void Promise.all(Array.from({ length: FUNDING_PARALLEL }, worker));
    return () => {
      live = false;
    };
  }, [venue, wanted, start, enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` brings in what was read
  return useMemo(() => {
    const rates = new Map<string, { time: number; rate: number }[]>();
    for (const m of markets) {
      const had = fundingCache.get(`${venue}:${m}`);
      if (had) rates.set(m, had.rates);
    }
    return { rates, done: rates.size, total: markets.length };
  }, [venue, wanted, version]);
}

/** Trades kept for the order-flow views: the last few hours, and this many at most. */
const FLOW_KEEP_MS = 4 * 60 * 60_000;
const FLOW_KEEP = 40_000;

/**
 * One market's trades for the order-flow views, collected from the venue's
 * trade stream (a snapshot of the latest trades, re-sent as they print)
 * while `enabled`: each trade once, oldest dropped past the cap. Starts
 * with the recent trades the stream opens with; nothing older is read.
 */
export function useTradeFlow(venue: VenueId, market: string | undefined, enabled: boolean) {
  const [trades, setTrades] = useState<FlowTrade[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setTrades([]);
    setError(undefined);
    if (!enabled || !market) return;
    const seen = new Map<string, FlowTrade>();
    let changed = false;
    const flush = setInterval(() => {
      if (!changed) return;
      changed = false;
      const cutoff = Date.now() - FLOW_KEEP_MS;
      let list = [...seen.values()].filter((tr) => tr.time >= cutoff);
      if (list.length > FLOW_KEEP) {
        list = list.sort((a, b) => a.time - b.time).slice(-FLOW_KEEP);
      }
      if (list.length !== seen.size) {
        seen.clear();
        for (const tr of list) seen.set(tr.id, tr);
      }
      setTrades(list);
    }, 1000);
    const stop = venueClient.subscribeTrades(venue, market, {
      onUpdate: (batch) => {
        for (const tr of batch) {
          if (seen.has(tr.id)) continue;
          const price = Number(tr.price);
          const size = Number(tr.size);
          if (!(price > 0) || !(size > 0)) continue;
          seen.set(tr.id, { id: tr.id, time: tr.time, price, size, side: tr.side });
          changed = true;
        }
      },
      onClosed: () => {},
      onError: (message) => setError(message),
    });
    return () => {
      clearInterval(flush);
      stop();
    };
  }, [venue, market, enabled]);
  return { trades, error };
}
