import type {
  Announcement,
  AnnouncementKind,
  Candle,
  Market,
  MarketSummary,
  Position,
  VenueId,
} from "@pewterdesk/core";

/** A headline in the feed: an announcement, with the markets it's about. */
export interface NewsItem {
  id: string;
  venue: VenueId;
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

export type NewsFilter = "all" | "mine" | "listing" | "delisting" | "maintenance";
export const NEWS_FILTERS: readonly NewsFilter[] = [
  "all",
  "mine",
  "listing",
  "delisting",
  "maintenance",
];

/** Markets shown per headline; a long listing round-up names dozens. */
const MAX_MARKETS = 4;
/** A bare coin name must be this long to count ("AI" and "IP" are words too). */
const MIN_BASE = 3;

/**
 * The markets a text names: a market id as written ("MONUSDT"), or a coin
 * ("MON") that has a market here. Only words written in capitals count, so
 * "Bybit AI Now Supports..." isn't about NOW, nor "Make Your Move" about
 * MOVE. Words that happen to be quote coins don't count either.
 */
export function mentionedMarkets(text: string, markets: readonly Market[]): string[] {
  const byId = new Map(markets.map((m) => [m.id.toUpperCase(), m.id]));
  const quotes = new Set(markets.map((m) => m.quote.toUpperCase()));
  const byBase = new Map<string, string>();
  for (const m of markets) {
    const base = m.base.toUpperCase();
    if (base.length >= MIN_BASE && !quotes.has(base) && !byBase.has(base)) byBase.set(base, m.id);
  }
  const found: string[] = [];
  for (const word of text.match(/\b[A-Z0-9]{2,}\b/g) ?? []) {
    const id = byId.get(word) ?? byBase.get(word);
    if (id && !found.includes(id)) found.push(id);
    if (found.length >= MAX_MARKETS) break;
  }
  return found;
}

/** The feed: each announcement with its markets and whether you hold one. */
export function buildNews(
  announcements: readonly Announcement[],
  markets: readonly Market[],
  positions: readonly Position[],
): NewsItem[] {
  const held = new Set(positions.map((p) => p.market));
  return announcements.map((a) => {
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
    const text = [item.title, item.description, ...item.tags, ...item.markets]
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
