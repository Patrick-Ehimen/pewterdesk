import type { VenueId } from "@pewterdesk/core";

/**
 * The Ideas page: a coin the trader is watching and what they think it will
 * do - a bias, a thesis, the levels that matter, and thoughts as it plays
 * out, with screenshots. Kept in PewterDesk Cloud (`ideas`), apart from the
 * journal and trades: an idea names a market, never an account, and places
 * nothing.
 */

export const BIASES = ["bullish", "bearish", "range"] as const;
export type Bias = (typeof BIASES)[number];

export const TIMEFRAMES = ["intraday", "swing", "position"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Where an idea is: still watched, or how it ended. */
export const STATUSES = ["watching", "playedOut", "wrong", "archived"] as const;
export type IdeaStatus = (typeof STATUSES)[number];

/**
 * How many colours levels can take, all different: the tag palette's eight
 * hues, each in two shades (`levelPaint` in `components/ideas/parts.tsx`).
 */
export const LEVEL_COLORS = 16;

export interface IdeaLevel {
  id: string;
  /** The trader's own name for it: "Support", "Supply zone", "Weekly high". */
  name: string;
  price: number;
  /** Its colour, 0 to `LEVEL_COLORS` - 1; no two levels of an idea share one. */
  color: number;
}

/** A thought written as the idea plays out, with the price then. */
export interface IdeaThought {
  id: string;
  at: number;
  price?: number;
  text: string;
}

/** Where reward to risk is measured from: one of the idea's levels, or the price now. */
export const ENTRY_NOW = "now";

/**
 * The levels reward to risk is read between, picked by the trader (levels
 * have no kinds): the entry (a level, or `ENTRY_NOW`), the stop and the target.
 */
export interface IdeaRisk {
  entry?: string;
  stop?: string;
  target?: string;
}

/** One way it could go: what happens, the trader's odds for it, and a line about it. */
export interface IdeaScenario {
  id: string;
  title: string;
  /** 0 to 100. */
  odds: number;
  text: string;
}

export interface Idea {
  id: string;
  venue: VenueId;
  /** `Market::id`. */
  market: string;
  /** As the venue shows it, for the list: "SOL-USDT". */
  symbol: string;
  bias: Bias;
  timeframe: Timeframe;
  /** 1 to 5. */
  conviction: number;
  status: IdeaStatus;
  thesis: string;
  /** What would make it wrong. */
  wrongIf: string;
  catalysts: string;
  tags: string[];
  levels: IdeaLevel[];
  thoughts: IdeaThought[];
  risk: IdeaRisk;
  scenarios: IdeaScenario[];
  /** Screenshots, by their path in the cloud's store. */
  shots: string[];
  /** When it was written, and the price then. */
  notedAt: number;
  notedPrice?: number;
}

export const MAX_TEXT = 4000;
export const MAX_LEVELS = 12;
export const MAX_LEVEL_NAME = 40;
export const MAX_THOUGHTS = 200;
export const MAX_SHOTS = 20;
export const MAX_TAGS = 8;
export const MAX_SCENARIOS = 6;
export const MAX_SCENARIO_TITLE = 60;
export const MAX_SCENARIO_TEXT = 300;

const VENUES: readonly VenueId[] = ["hyperliquid", "aster", "bybit", "binance", "blofin"];

const text = (raw: unknown, max = MAX_TEXT) => (typeof raw === "string" ? raw.slice(0, max) : "");
const one = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.find((a) => a === raw) ?? fallback;
const num = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined);
const list = (raw: unknown) => (Array.isArray(raw) ? raw : []);
const record = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

/** A new idea on a market, at its price now. */
export function newIdea(
  id: string,
  venue: VenueId,
  market: string,
  symbol: string,
  price?: number,
): Idea {
  return {
    id,
    venue,
    market,
    symbol,
    bias: "bullish",
    timeframe: "swing",
    conviction: 3,
    status: "watching",
    thesis: "",
    wrongIf: "",
    catalysts: "",
    tags: [],
    levels: [],
    thoughts: [],
    risk: {},
    scenarios: [],
    shots: [],
    notedAt: Date.now(),
    notedPrice: price,
  };
}

/** A stored idea, as far as it reads; undefined if it names no market. */
export function restoreIdea(id: string, raw: unknown): Idea | undefined {
  const r = record(raw);
  const venue = VENUES.find((v) => v === r.venue);
  const market = text(r.market, 64);
  if (!venue || !market) return undefined;
  const conviction = num(r.conviction);
  const idea: Idea = {
    id,
    venue,
    market,
    symbol: text(r.symbol, 64) || market,
    bias: one(r.bias, BIASES, "bullish"),
    timeframe: one(r.timeframe, TIMEFRAMES, "swing"),
    conviction: conviction ? Math.min(5, Math.max(1, Math.round(conviction))) : 3,
    status: one(r.status, STATUSES, "watching"),
    thesis: text(r.thesis),
    wrongIf: text(r.wrongIf),
    catalysts: text(r.catalysts),
    tags: list(r.tags)
      .map((t) => text(t, 32).trim())
      .filter(Boolean)
      .slice(0, MAX_TAGS),
    levels: distinctColors(
      list(r.levels)
        .flatMap((raw): IdeaLevel[] => {
          const l = record(raw);
          const price = num(l.price);
          if (!(price && price > 0)) return [];
          const color = num(l.color);
          return [
            {
              id: text(l.id, 64) || crypto.randomUUID(),
              // Levels written before they were named take their note, else their old kind.
              name: (
                text(l.name, MAX_LEVEL_NAME) ||
                text(l.note, MAX_LEVEL_NAME) ||
                oldKind(l.kind)
              ).trim(),
              price,
              color: color !== undefined && Number.isInteger(color) ? color : -1,
            },
          ];
        })
        .slice(0, MAX_LEVELS),
    ),
    thoughts: list(r.thoughts)
      .flatMap((raw): IdeaThought[] => {
        const t = record(raw);
        const at = num(t.at);
        const body = text(t.text).trim();
        if (!at || !body) return [];
        return [{ id: text(t.id, 64) || crypto.randomUUID(), at, price: num(t.price), text: body }];
      })
      .slice(-MAX_THOUGHTS),
    shots: list(r.shots)
      .filter((s): s is string => typeof s === "string")
      .slice(0, MAX_SHOTS),
    notedAt: num(r.notedAt) ?? Date.now(),
    notedPrice: num(r.notedPrice),
    risk: {},
    scenarios: list(r.scenarios)
      .flatMap((raw): IdeaScenario[] => {
        const sc = record(raw);
        const title = text(sc.title, MAX_SCENARIO_TITLE).trim();
        const odds = num(sc.odds);
        if (!title) return [];
        return [
          {
            id: text(sc.id, 64) || crypto.randomUUID(),
            title,
            odds: odds === undefined ? 0 : Math.min(100, Math.max(0, Math.round(odds))),
            text: text(sc.text, MAX_SCENARIO_TEXT),
          },
        ];
      })
      .slice(0, MAX_SCENARIOS),
  };
  // Reward to risk names levels by id: only those the idea still has.
  return { ...idea, risk: keptRisk(record(r.risk), idea.levels) };
}

/** `risk` with any pick that names no level of `levels` dropped. */
export function keptRisk(risk: Record<string, unknown>, levels: readonly IdeaLevel[]): IdeaRisk {
  const has = (id: unknown): id is string =>
    typeof id === "string" && levels.some((l) => l.id === id);
  return {
    ...(risk.entry === ENTRY_NOW || has(risk.entry) ? { entry: risk.entry as string } : {}),
    ...(has(risk.stop) ? { stop: risk.stop } : {}),
    ...(has(risk.target) ? { target: risk.target } : {}),
  };
}

/**
 * Reward to risk between the levels picked: the target's distance from the
 * entry over the stop's. Undefined until all three are set, or when the
 * target and the stop are on the same side of the entry.
 */
export function rewardRisk(
  idea: Pick<Idea, "levels" | "risk">,
  price: number | undefined,
): { ratio: number; reward: number; risk: number; entry: number } | undefined {
  const at = (id?: string) => idea.levels.find((l) => l.id === id)?.price;
  const entry = idea.risk.entry === ENTRY_NOW ? price : at(idea.risk.entry);
  const stop = at(idea.risk.stop);
  const target = at(idea.risk.target);
  if (!entry || !stop || !target) return undefined;
  const reward = target - entry;
  const risk = entry - stop;
  // A long has its target above and stop below; a short the other way round.
  if (reward === 0 || risk === 0 || Math.sign(reward) !== Math.sign(risk)) return undefined;
  return {
    ratio: Math.abs(reward) / Math.abs(risk),
    reward: Math.abs(reward) / entry,
    risk: Math.abs(risk) / entry,
    entry,
  };
}

/** The scenarios' odds added up, to say when they don't come to 100. */
export const oddsTotal = (scenarios: readonly IdeaScenario[]) =>
  scenarios.reduce((sum, sc) => sum + sc.odds, 0);

/** How far `level` is from `price`, as a share of the price (+ above, − below). */
export const distance = (price: number, level: number) => (level - price) / price;

/** The kinds levels had before they were named; their names now, in English. */
const OLD_KINDS: Record<string, string> = {
  target: "Target",
  trigger: "Trigger",
  resistance: "Resistance",
  support: "Support",
  invalidation: "Invalidation",
};
const oldKind = (raw: unknown) => (typeof raw === "string" ? (OLD_KINDS[raw] ?? "") : "");

const validColor = (c: number) => Number.isInteger(c) && c >= 0 && c < LEVEL_COLORS;

/** The first colour none of `levels` has. */
export function nextColor(levels: readonly Pick<IdeaLevel, "color">[]): number {
  const used = new Set(levels.map((l) => l.color));
  for (let c = 0; c < LEVEL_COLORS; c++) if (!used.has(c)) return c;
  return levels.length % LEVEL_COLORS;
}

/** `levels` with no colour twice: each keeps its own unless one before it has it. */
export function distinctColors(levels: readonly IdeaLevel[]): IdeaLevel[] {
  const out: IdeaLevel[] = [];
  for (const level of levels) {
    const taken = out.some((l) => l.color === level.color);
    out.push(validColor(level.color) && !taken ? level : { ...level, color: nextColor(out) });
  }
  return out;
}

/** The level nearest the price now, and how far it is (+ above, − below). */
export function nearest(
  idea: Pick<Idea, "levels">,
  price: number | undefined,
): { level: IdeaLevel; share: number } | undefined {
  if (!(price && price > 0)) return undefined;
  const level = [...idea.levels].sort(
    (a, b) => Math.abs(a.price - price) - Math.abs(b.price - price),
  )[0];
  return level ? { level, share: distance(price, level.price) } : undefined;
}

/** Ideas closest to one of their levels first; those without a price or levels last. */
export function byCloseness(ideas: readonly Idea[], priceOf: (idea: Idea) => number | undefined) {
  const key = (idea: Idea) => {
    const near = nearest(idea, priceOf(idea));
    return near ? Math.abs(near.share) : Number.POSITIVE_INFINITY;
  };
  return [...ideas].sort((a, b) => key(a) - key(b) || b.notedAt - a.notedAt);
}

/** Whether an idea matches a search: its market, thesis or tags. */
export function matches(idea: Idea, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [idea.symbol, idea.market, idea.thesis, ...idea.tags].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/** Prices written in a thesis ("under 187.77"), to offer as levels. */
export function pricesIn(thesis: string): number[] {
  const found = thesis.match(/\d[\d,]*\.\d+|\d{2,}(?:,\d{3})+|\d{3,}/g) ?? [];
  const prices = found.map((s) => Number(s.replace(/,/g, ""))).filter((n) => n > 0);
  return [...new Set(prices)].slice(0, 6);
}
