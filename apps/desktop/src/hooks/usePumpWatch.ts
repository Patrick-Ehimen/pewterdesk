import type { Candle, Market, MarketHistory, MarketSummary, VenueId } from "@pewterdesk/core";
import {
  changeSince,
  fundingPerHour,
  NOTICE_HOURS,
  oiChangeOver,
  oiChangeSoFar,
  volumeSpike,
  type WatchCatalyst,
  type WatchRow,
  watchRead,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { type ExchangeNotice, type NoticeExchange, venueClient } from "../api/venueClient";
import { loadOi } from "../lib/oiStore";
import { namesToken } from "../lib/tokenDetails";
import { useLiveNews } from "./useLiveNews";
import { OI_HISTORY_VENUES } from "./useMapData";
import { useExchangeNotices, useMarketSummaries, useMarkets, useNewsWire } from "./useVenueFeeds";

// The pump / dump watch's markets, for the Maps view and for the alerts that
// notify while the app runs. Every market is screened on what's already at
// hand (its day's change from the summaries, and with the view open its
// hourly history), or on fresh exchange news naming its coin; only the
// markets that pass have their candles and open interest read, a few at a
// time, so it stays inside the venue's limits. Read-only: it places nothing.

/** A screened market's candles and open interest are read again after this. */
const READ_MS = 4 * 60_000;
/** How often the candidates are looked at again. */
const CHECK_MS = 5 * 60_000;
/** Markets read at most each round: the strongest first. */
const MAX_CANDIDATES = 80;
const PACE_MS = 150;
/** A day's move this big is worth a closer look without the hourly history. */
const SCREEN_DAY = 0.08;
const SCREEN_4H = 0.05;
/** A notice or headline this fresh is shown beside a watched market. */
const CATALYST_HOURS = 72;
const HOUR = 3_600_000;
const HOURS = 170;
/** Where open interest is borrowed from, for a venue that publishes no history. */
const OI_PROXIES: readonly VenueId[] = ["bybit", "binance"];

const NOTICE_SOURCE: Record<NoticeExchange, string> = {
  binance: "Binance",
  okx: "OKX",
  upbit: "Upbit",
};

/** A coin's ticker as other exchanges write it: Bybit's "1000PEPE" is PEPE. */
export const coinTicker = (base: string) => base.toUpperCase().replace(/^10{2,}(?=[A-Z])/, "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listOf = <T>(feed: { status: string; data?: T }) =>
  feed.status === "live" || feed.status === "closed" ? feed.data : undefined;

interface Read {
  at: number;
  candles?: Candle[];
  oiChange?: number;
  /** Where the open interest came from, when it isn't the venue's own. */
  oiFrom?: VenueId;
}

/** Shared by every watch, so the view and the alerts don't read a market twice. */
const reads = new Map<string, Read>();
const inFlight = new Map<string, Promise<Read>>();
const proxyMarkets = new Map<VenueId, Promise<Map<string, string>>>();

/** Each proxy venue's USDT perpetual per coin, read once. */
function proxyIds(venue: VenueId) {
  let ids = proxyMarkets.get(venue);
  if (!ids) {
    ids = venueClient
      .markets(venue)
      .then(
        (markets) =>
          new Map(
            markets
              .filter((m) => m.quote === "USDT" && !m.category)
              .map((m) => [coinTicker(m.base), m.id]),
          ),
      )
      .catch(() => new Map<string, string>());
    proxyMarkets.set(venue, ids);
  }
  return ids;
}

/** Open interest's change over a day, by the venue, the app's samples, or another venue. */
async function oiFor(
  venue: VenueId,
  market: Market,
  summary: MarketSummary,
): Promise<Pick<Read, "oiChange" | "oiFrom">> {
  const now = { time: Date.now(), oi: Number(summary.openInterest), price: 0 };
  const history = async (v: VenueId, id: string) => {
    const points = await venueClient.openInterestHistory(v, id, 26).catch(() => undefined);
    const samples = (points ?? []).map((p) => ({ time: p.time, oi: Number(p.openInterest) }));
    return samples;
  };
  if (OI_HISTORY_VENUES.includes(venue)) {
    return { oiChange: oiChangeOver([...(await history(venue, market.id)), now], 24) };
  }
  const sampled = [...(loadOi(venue).markets[market.id] ?? []), now];
  const own = oiChangeOver(sampled, 24);
  if (own !== undefined) return { oiChange: own };
  // Not a day of samples yet: the same coin's positioning on a venue that keeps one.
  const coin = coinTicker(market.base);
  for (const proxy of OI_PROXIES) {
    const id = (await proxyIds(proxy)).get(coin);
    if (!id) continue;
    const samples = await history(proxy, id);
    const last = samples.at(-1);
    const change = last ? oiChangeOver(samples, 24) : undefined;
    if (change !== undefined) return { oiChange: change, oiFrom: proxy };
  }
  return { oiChange: oiChangeSoFar(sampled)?.oi };
}

/** A market's candles and open interest, read now or taken from a recent read. */
function readMarket(
  venue: VenueId,
  market: Market,
  summary: MarketSummary,
  candles?: readonly Candle[],
): Promise<Read> {
  const key = `${venue}:${market.id}`;
  const held = reads.get(key);
  if (held && Date.now() - held.at < READ_MS) return Promise.resolve(held);
  const running = inFlight.get(key);
  if (running) return running;
  const read = (async () => {
    const own =
      candles ??
      (await venueClient.candles(venue, market.id, "1h", Date.now() + 1, HOURS).catch(() => []));
    const oi = await oiFor(venue, market, summary);
    const done: Read = { at: Date.now(), candles: [...own], ...oi };
    reads.set(key, done);
    return done;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, read);
  return read;
}

/** The newest notice that names a coin, of the kinds the watch reads. */
function noticeFor(notices: readonly ExchangeNotice[], coin: string) {
  return notices.find((n) => n.kind !== "other" && n.tickers.includes(coin));
}

const isCrypto = (m: Market) => !m.category || m.category === "innovation";

/**
 * The watch's rows for `venue`, while `enabled`. With the Maps view open,
 * `histories` (every market's hourly candles) widens the screen to four-hour
 * moves and spares the reads.
 */
export function usePumpWatch(
  venue: VenueId,
  enabled: boolean,
  {
    histories,
    scope = "crypto",
  }: {
    histories?: ReadonlyMap<string, MarketHistory>;
    scope?: "crypto" | "all";
  } = {},
) {
  const markets = listOf(useMarkets(enabled ? venue : undefined)) ?? [];
  const summaries = listOf(useMarketSummaries(venue, enabled));
  const noticesFeed = useExchangeNotices(enabled);
  const notices = listOf(noticesFeed)?.items ?? [];
  const headlines = listOf(useNewsWire(enabled)) ?? [];
  const wire = useLiveNews(enabled).items;
  const [round, setRound] = useState(0);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const byId = useMemo(() => new Map((summaries ?? []).map((s) => [s.market, s])), [summaries]);
  const scoped = useMemo(
    () => (scope === "all" ? markets : markets.filter(isCrypto)),
    [markets, scope],
  );

  // The markets worth a closer look, strongest first: a big day, a big four
  // hours on heavy volume (with the history), or fresh news about the coin.
  const candidates = useMemo(() => {
    const at = Date.now();
    const scored = scoped.flatMap((market) => {
      const s = byId.get(market.id);
      if (!s) return [];
      const price = Number(s.markPrice);
      const prev = Number(s.prevDayPrice);
      const day = prev > 0 ? price / prev - 1 : 0;
      const candles = histories?.get(market.id)?.candles;
      const four = candles ? (changeSince(candles, 4, price) ?? 0) : 0;
      const week = candles ? (changeSince(candles, 168, price) ?? 0) : 0;
      const notice = noticeFor(notices, coinTicker(market.base));
      const fresh = notice !== undefined && at - notice.time <= NOTICE_HOURS * HOUR;
      const moving = Math.abs(day) >= SCREEN_DAY || Math.abs(four) >= SCREEN_4H;
      const fading = week >= 0.5 && day <= -0.05;
      if (!moving && !fading && !fresh) return [];
      return [
        { market, score: fresh ? 1 + Math.abs(day) : Math.max(Math.abs(day), Math.abs(four)) },
      ];
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES)
      .map((c) => c.market);
  }, [scoped, byId, histories, notices]);

  // Read the candidates, a few at a time, and again every few minutes. The
  // set, not its order, decides a new pass: prices reorder it every few
  // seconds, and each reorder used to start the count again from 1. The
  // count is what's been read of the markets on the list, so it only climbs;
  // a new pass skips straight past what was read moments ago.
  const ids = candidates
    .map((m) => m.id)
    .sort()
    .join(",");
  const readCount = (list: readonly Market[]) =>
    list.filter((m) => reads.has(`${venue}:${m.id}`)).length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` names the candidates; `round` reads them again
  useEffect(() => {
    if (!enabled || candidates.length === 0) return;
    let live = true;
    const list = candidates;
    void (async () => {
      setProgress({ done: readCount(list), total: list.length });
      for (const market of list) {
        const s = byId.get(market.id);
        if (!live) return;
        const held = reads.get(`${venue}:${market.id}`);
        if (!s || (held && Date.now() - held.at < READ_MS)) continue;
        await readMarket(venue, market, s, histories?.get(market.id)?.candles).catch(() => {});
        if (!live) return;
        setProgress({ done: readCount(list), total: list.length });
        await sleep(PACE_MS);
      }
      if (live) setProgress({ done: readCount(list), total: list.length });
    })();
    return () => {
      live = false;
    };
  }, [enabled, venue, ids, round]);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setRound((n) => n + 1), CHECK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `progress` brings the reads in as they land
  const rows = useMemo<WatchRow[]>(() => {
    if (!enabled) return [];
    const at = Date.now();
    return candidates.flatMap((market) => {
      const s = byId.get(market.id);
      const read = reads.get(`${venue}:${market.id}`);
      if (!s || !read) return [];
      const price = Number(s.markPrice);
      const prev = Number(s.prevDayPrice);
      const candles = histories?.get(market.id)?.candles ?? read.candles ?? [];
      const change24h = prev > 0 ? price / prev - 1 : undefined;
      const change4h = changeSince(candles, 4, price);
      const perHour = fundingPerHour(s);
      const spike = volumeSpike(candles, 4)?.ratio;
      const coin = coinTicker(market.base);
      const notice = noticeFor(notices, coin);
      const watched = watchRead({
        change4h,
        change24h,
        change7d: changeSince(candles, 168, price),
        fundingPerHour: perHour,
        oiChange: read.oiChange,
        spike,
        notice: notice && { kind: notice.kind, time: notice.time },
        now: at,
      });
      if (!watched) return [];
      // The newest of: the exchange notice, a headline naming the coin, a wire item tagged with it.
      const article = headlines.find((a) => namesToken(`${a.title} ${a.summary}`, coin));
      const item = wire.find((w) => w.coins.includes(coin));
      const found: (WatchCatalyst | undefined)[] = [
        notice && {
          source: NOTICE_SOURCE[notice.exchange],
          title: notice.title,
          time: notice.time,
        },
        article && { source: article.sourceName, title: article.title, time: article.time },
        item && {
          source: item.handle ? `@${item.handle}` : item.author,
          title: item.text,
          time: item.time,
        },
      ];
      const catalyst = found
        .filter((c): c is WatchCatalyst => c !== undefined && at - c.time <= CATALYST_HOURS * HOUR)
        .sort((a, b) => b.time - a.time)[0];
      return [
        {
          market,
          read: watched,
          change4h,
          change24h,
          spike,
          fundingPerHour: perHour,
          oiUsd:
            read.oiChange === undefined
              ? undefined
              : (1 + read.oiChange) * (1 + (change24h ?? 0)) - 1,
          oiFrom: read.oiFrom,
          catalyst,
        },
      ];
    });
  }, [enabled, candidates, byId, venue, histories, notices, headlines, wire, progress]);

  return { rows, progress, noticesFailed: listOf(noticesFeed)?.failed ?? [] };
}
