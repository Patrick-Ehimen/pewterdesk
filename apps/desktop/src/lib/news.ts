import type {
  Announcement,
  AnnouncementKind,
  Candle,
  Market,
  MarketSummary,
  Position,
  VenueId,
} from "@pewterdesk/core";
import type { Article } from "../api/venueClient";

/** The news sites read (`news_feeds.rs`), in the order the Sources list shows them. */
export const PUBLISHERS = [
  { id: "coindesk", name: "CoinDesk" },
  { id: "cointelegraph", name: "Cointelegraph" },
  { id: "theblock", name: "The Block" },
  { id: "decrypt", name: "Decrypt" },
] as const;

/**
 * A headline in the feed: a venue's announcement or a news site's article,
 * with the markets it's about.
 */
export interface NewsItem {
  id: string;
  /** The venue that announced it; unset for an article. */
  venue?: VenueId;
  /** The news site that published it; unset for an announcement. */
  publisher?: { id: string; name: string };
  /** Names the article to `newsClient.open`; unset for an announcement. */
  article?: string;
  kind: AnnouncementKind;
  title: string;
  description: string;
  tags: string[];
  /** Milliseconds since the Unix epoch. */
  time: number;
  startsAt?: number;
  /** Ids of this venue's markets named in it, in the order they appear. */
  markets: string[];
  /** One of those markets has an open position. */
  held: boolean;
  /** A delisting or maintenance: it can stop you trading. */
  highImpact: boolean;
}

export type NewsFilter = "all" | "mine" | "news" | "listing" | "delisting" | "maintenance";
export const NEWS_FILTERS: readonly NewsFilter[] = [
  "all",
  "mine",
  "news",
  "listing",
  "delisting",
  "maintenance",
];

/** Markets shown per headline; a long listing round-up names dozens. */
const MAX_MARKETS = 4;
/** A bare coin name must be this long to count ("AI" and "IP" are words too). */
const MIN_BASE = 3;

/**
 * Coins the press writes out in full, by name. Only names that are no
 * ordinary word: "Near" and "Sui" would catch "near" and a surname.
 */
const COIN_NAMES: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  ether: "ETH",
  solana: "SOL",
  ripple: "XRP",
  dogecoin: "DOGE",
  cardano: "ADA",
  zcash: "ZEC",
  hyperliquid: "HYPE",
  chainlink: "LINK",
  avalanche: "AVAX",
  litecoin: "LTC",
  polkadot: "DOT",
  tron: "TRX",
  toncoin: "TON",
  monero: "XMR",
  uniswap: "UNI",
  aave: "AAVE",
  arbitrum: "ARB",
  aptos: "APT",
  stellar: "XLM",
  filecoin: "FIL",
  pepe: "PEPE",
};

/**
 * The markets a text names: a market id as written ("MONUSDT"), a coin
 * ("MON") that has a market here, or a coin's name ("Bitcoin"). A ticker
 * counts only written in capitals, so "Bybit AI Now Supports..." isn't
 * about NOW, nor "Make Your Move" about MOVE. Words that happen to be
 * quote coins don't count either.
 */
export function mentionedMarkets(text: string, markets: readonly Market[]): string[] {
  const byId = new Map(markets.map((m) => [m.id.toUpperCase(), m.id]));
  const quotes = new Set(markets.map((m) => m.quote.toUpperCase()));
  const byBase = new Map<string, string>();
  // A coin's first market, whatever its length: for the names.
  const byCoin = new Map<string, string>();
  for (const m of markets) {
    const base = m.base.toUpperCase();
    if (quotes.has(base)) continue;
    if (!byCoin.has(base)) byCoin.set(base, m.id);
    if (base.length >= MIN_BASE && !byBase.has(base)) byBase.set(base, m.id);
  }
  const found: string[] = [];
  for (const word of text.match(/\b[A-Za-z0-9]{2,}\b/g) ?? []) {
    const named = COIN_NAMES[word.toLowerCase()];
    const id =
      (word === word.toUpperCase() ? (byId.get(word) ?? byBase.get(word)) : undefined) ??
      (named && /^[A-Z]/.test(word) ? byCoin.get(named) : undefined);
    if (id && !found.includes(id)) found.push(id);
    if (found.length >= MAX_MARKETS) break;
  }
  return found;
}

/**
 * The feed, newest first: each announcement and article with its markets
 * and whether you hold one.
 */
export function buildNews(
  announcements: readonly Announcement[],
  markets: readonly Market[],
  positions: readonly Position[],
  articles: readonly Article[] = [],
): NewsItem[] {
  const held = new Set(positions.map((p) => p.market));
  const wire = articles.map((a): NewsItem => {
    const named = mentionedMarkets(`${a.title} ${a.summary}`, markets);
    return {
      id: a.id,
      publisher: { id: a.source, name: a.sourceName },
      article: a.id,
      kind: "news",
      title: a.title,
      description: a.summary,
      tags: a.tags,
      time: a.time,
      markets: named,
      held: named.some((m) => held.has(m)),
      highImpact: false,
    };
  });
  const announced = announcements.map((a): NewsItem => {
    const named = mentionedMarkets(`${a.title} ${a.description}`, markets);
    return {
      id: `${a.venue}:${a.time}:${a.title}`,
      venue: a.venue,
      kind: a.kind,
      title: a.title,
      description: a.description,
      tags: a.tags,
      time: a.time,
      startsAt: a.startsAt,
      markets: named,
      held: named.some((m) => held.has(m)),
      highImpact: a.kind === "delisting" || a.kind === "maintenance",
    };
  });
  return [...announced, ...wire].sort((a, b) => b.time - a.time);
}

/**
 * Other headlines to read after `item`: the ones about the same markets
 * first, then the same subject (its tags, its kind, its source), then
 * simply the newest. At most `limit`.
 */
export function moreNews(item: NewsItem, items: readonly NewsItem[], limit = 6): NewsItem[] {
  const score = (other: NewsItem) =>
    other.markets.filter((m) => item.markets.includes(m)).length * 4 +
    other.tags.filter((tag) => item.tags.includes(tag)).length * 2 +
    (other.kind === item.kind && item.kind !== "news" ? 1 : 0) +
    (other.publisher && other.publisher.id === item.publisher?.id ? 1 : 0);
  return items
    .filter((other) => other.id !== item.id)
    .map((other) => ({ other, score: score(other) }))
    .sort((a, b) => b.score - a.score || b.other.time - a.other.time)
    .slice(0, limit)
    .map((x) => x.other);
}

export interface Mover {
  market: string;
  price: string;
  /** The last day's change, in percent. */
  change: number;
}

/** The markets that rose and fell most over the last day, `count` of each. */
export function movers(
  summaries: readonly MarketSummary[],
  count = 5,
): { gainers: Mover[]; losers: Mover[] } {
  const all = summaries
    .filter((s) => Number(s.prevDayPrice) > 0 && Number(s.markPrice) > 0)
    .map((s) => ({
      market: s.market,
      price: s.markPrice,
      change: (Number(s.markPrice) / Number(s.prevDayPrice) - 1) * 100,
    }))
    .sort((a, b) => b.change - a.change);
  return {
    gainers: all.filter((m) => m.change > 0).slice(0, count),
    losers: all
      .filter((m) => m.change < 0)
      .slice(-count)
      .reverse(),
  };
}

const MUTED_KEY = "pd.news.muted";

/** The news sites switched off under Sources. */
export function loadMutedPublishers(): string[] {
  try {
    const known: readonly string[] = PUBLISHERS.map((p) => p.id);
    return (localStorage.getItem(MUTED_KEY) ?? "").split(",").filter((id) => known.includes(id));
  } catch {
    return [];
  }
}

export function saveMutedPublishers(ids: readonly string[]): void {
  try {
    localStorage.setItem(MUTED_KEY, ids.join(","));
  } catch {
    // Private mode or a full store: the choice lasts for this session.
  }
}

/**
 * The headlines to show. Campaigns (promotions) only with `campaigns` on;
 * `query` matches the title, description, tags and market ids.
 */
export function filterNews(
  items: readonly NewsItem[],
  options: { filter: NewsFilter; query: string; highOnly: boolean; campaigns: boolean },
): NewsItem[] {
  const words = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (item.kind === "campaign" && !options.campaigns) return false;
    if (options.highOnly && !item.highImpact) return false;
    if (options.filter === "mine" && !item.held) return false;
    if (options.filter !== "all" && options.filter !== "mine" && item.kind !== options.filter) {
      return false;
    }
    if (words.length === 0) return true;
    const text = [
      item.title,
      item.description,
      item.publisher?.name ?? "",
      ...item.tags,
      ...item.markets,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Something scheduled: funding on a held market, or an announcement taking effect. */
export type Upcoming =
  | { kind: "funding"; time: number; position: Position; rate: number }
  | { kind: "starts"; time: number; item: NewsItem };

/** What's coming, soonest first: at most `limit` entries after `now`. */
export function upcoming(
  items: readonly NewsItem[],
  positions: readonly Position[],
  summaries: readonly MarketSummary[],
  now: number,
  limit = 8,
): Upcoming[] {
  const out: Upcoming[] = [];
  const byMarket = new Map(summaries.map((s) => [s.market, s]));
  for (const position of positions) {
    const s = byMarket.get(position.market);
    // Funding falls on the interval's boundaries, counted from midnight UTC
    // (every hour, or 00:00 / 08:00 / 16:00 for eight hours).
    const every = (s?.fundingIntervalSecs ?? 0) * 1000;
    if (s && every > 0) {
      const time = (Math.floor(now / every) + 1) * every;
      out.push({ kind: "funding", time, position, rate: Number(s.fundingRate) });
    }
  }
  for (const item of items) {
    if (item.kind !== "campaign" && item.startsAt !== undefined && item.startsAt > now) {
      out.push({ kind: "starts", time: item.startsAt, item });
    }
  }
  return out.sort((a, b) => a.time - b.time).slice(0, limit);
}

/**
 * What a position gets (positive) or pays (negative) at the next funding:
 * longs pay a positive rate, shorts receive it.
 */
export function fundingDue(position: Position, rate: number): number {
  const value = Number(position.size) * Number(position.markPrice);
  return (position.side === "long" ? -1 : 1) * value * rate;
}

export interface PriceChart {
  /** The line through every close. */
  line: string;
  /** The same, closed down to the bottom edge. */
  area: string;
  /** Where the headline falls, if the candles reach back to it. */
  mark?: { x: number; y: number; price: number };
  first: Candle;
  last: Candle;
}

/** The closes as an SVG path in `width` x `height`, with the headline's time marked. */
export function priceChart(
  candles: readonly Candle[],
  headline: number,
  width: number,
  height: number,
): PriceChart | null {
  const first = candles[0];
  const last = candles.at(-1);
  if (!first || !last || candles.length < 2) return null;
  const closes = candles.map((c) => Number(c.close));
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const range = hi - lo || 1;
  const span = Math.max(1, last.openTime - first.openTime);
  const x = (time: number) => ((time - first.openTime) / span) * width;
  // A little room top and bottom, so the line doesn't sit on the edges.
  const y = (price: number) => height * 0.08 + (1 - (price - lo) / range) * height * 0.84;
  const line = candles
    .map(
      (c, i) =>
        `${i === 0 ? "M" : "L"}${x(c.openTime).toFixed(1)},${y(closes[i] as number).toFixed(1)}`,
    )
    .join("");
  const at = [...candles].reverse().find((c) => c.openTime <= headline);
  return {
    line,
    area: `${line}L${width},${height}L0,${height}Z`,
    mark:
      at && headline <= last.openTime
        ? { x: x(at.openTime), y: y(Number(at.close)), price: Number(at.close) }
        : undefined,
    first,
    last,
  };
}
