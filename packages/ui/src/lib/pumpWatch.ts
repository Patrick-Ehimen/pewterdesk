// The Maps page's pump / dump watch: which markets are starting a big move,
// and how, by what three years of Bybit's 30%-and-over moves had in common.
// A pump came with volume several times the usual and, in a squeeze, funding
// gone negative as shorts faded it; a dump with open interest closing, or
// as the fade of a pump. Nothing reliably showed beforehand, so this flags a
// move as it starts, not before. The one thing ahead of the price is news: a
// listing, delisting or warning on another exchange flags its token at once.

export type WatchState =
  | "squeeze"
  | "leverage"
  | "spotLed"
  | "pumpStarting"
  | "longUnwind"
  | "shortPileOn"
  | "dumpStarting"
  | "fadeRisk"
  | "listingNews"
  | "delistingNews";

export type WatchSide = "pump" | "dump";

export const WATCH_SIDE: Record<WatchState, WatchSide> = {
  squeeze: "pump",
  leverage: "pump",
  spotLed: "pump",
  pumpStarting: "pump",
  listingNews: "pump",
  longUnwind: "dump",
  shortPileOn: "dump",
  dumpStarting: "dump",
  fadeRisk: "dump",
  delistingNews: "dump",
};

export type NoticeKind = "listing" | "delisting" | "warning" | "other";

/** A notice of an exchange's about this market's coin. */
export interface WatchNotice {
  kind: NoticeKind;
  /** Milliseconds since the Unix epoch. */
  time: number;
}

export interface WatchInput {
  /** Price changes, as fractions. */
  change4h?: number;
  change24h?: number;
  change7d?: number;
  /** Funding per hour: below zero, shorts pay. */
  fundingPerHour?: number;
  /** Open interest's change over the day, in contracts (coins). */
  oiChange?: number;
  /** The last four hours' volume against the market's usual for as long. */
  spike?: number;
  /** The newest notice naming the coin, if any. */
  notice?: WatchNotice;
  /** Now, in milliseconds. */
  now: number;
}

export interface WatchRead {
  state: WatchState;
  side: WatchSide;
  /** For ranking: how big and how heavy the move is. */
  strength: number;
}

/** A move: this much over four hours, or over the day. */
const MOVE_4H = 0.05;
const MOVE_24H = 0.08;
/** Volume this many times the usual: every big move in the study had it. */
export const WATCH_SPIKE = 2.5;
/** Open interest this flat, in coins, while the price rises: buyers off the perp. */
const OI_FLAT = 0.05;
/** Open interest this far down, in coins: positions closing. */
const OI_UNWIND = -0.1;
/** Open interest this far up, in coins, while the price falls and shorts pay. */
const OI_PILE = 0.1;
/** Open interest in dollars this far up, and ahead of the price: new leverage. */
const OI_BUILD = 0.25;
/** A week this good, then a red day: the fade most big dumps were. */
const FADE_WEEK = 0.5;
const FADE_DAY = -0.05;
/** A notice this fresh flags its coin. */
export const NOTICE_HOURS = 48;

const HOUR = 3_600_000;

/** What a market is doing, if it's one to watch. */
export function watchRead(m: WatchInput): WatchRead | undefined {
  const c4 = m.change4h ?? 0;
  const c24 = m.change24h ?? 0;
  const spike = m.spike ?? 0;
  const funding = m.fundingPerHour;
  const oi = m.oiChange;
  const move = Math.max(Math.abs(c4), Math.abs(c24));
  const strength = move * Math.min(spike, 10);
  const up = c4 >= MOVE_4H || c24 >= MOVE_24H;
  const down = c4 <= -MOVE_4H || c24 <= -MOVE_24H;
  const heavy = spike >= WATCH_SPIKE;
  const read = (state: WatchState, s = strength): WatchRead => ({
    state,
    side: WATCH_SIDE[state],
    strength: s,
  });

  if (up && heavy) {
    if (funding !== undefined && funding < 0) return read("squeeze");
    const oiUsd = oi === undefined ? undefined : (1 + oi) * (1 + c24) - 1;
    if (
      oiUsd !== undefined &&
      oiUsd >= Math.max(OI_BUILD, c24 * 1.5) &&
      funding !== undefined &&
      funding > 0
    ) {
      return read("leverage");
    }
    if (oi !== undefined && oi <= OI_FLAT) return read("spotLed");
    return read("pumpStarting");
  }
  if (down && heavy) {
    if (funding !== undefined && funding > 0 && oi !== undefined && oi <= OI_UNWIND) {
      return read("longUnwind");
    }
    if (funding !== undefined && funding < 0 && oi !== undefined && oi >= OI_PILE) {
      return read("shortPileOn");
    }
    return read("dumpStarting");
  }
  if ((m.change7d ?? 0) >= FADE_WEEK && c24 <= FADE_DAY) {
    return read("fadeRisk", Math.abs(c24) * (1 + (m.change7d ?? 0)));
  }
  const notice = m.notice;
  if (notice && m.now - notice.time <= NOTICE_HOURS * HOUR) {
    // Fresh news ranks under a move under way, newest first.
    const fresh = 1 - (m.now - notice.time) / (NOTICE_HOURS * HOUR);
    if (notice.kind === "listing") return read("listingNews", fresh * 0.01);
    if (notice.kind === "delisting" || notice.kind === "warning") {
      return read("delistingNews", fresh * 0.01);
    }
  }
  return undefined;
}
