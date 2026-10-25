import type { CandleInterval, MarketSummary, VenueId } from "@pewterdesk/core";
import type { AiChartMarks, AiProvider, AiSnapshotRow } from "../api/venueClient";

// PewterDesk AI's conversations, kept on this machine in a file Rust writes
// in the app's data folder (`ai_assistant.rs`): what the page shows (each
// question and answer as text, with the chart marks an answer drew) and the
// API's own transcript, handed back to Rust whole with the next question.
// The transcript holds questions, market data and answers - never a key.
// Not the webview's storage: the market caches fill that, and a save that
// doesn't fit there is lost.

/** Where chats were kept before the file, read once to move them over. */
export const LEGACY_KEY = "pd.ai.chats";
const MAX_CHATS = 100;
/** The file, at most, written; under Rust's own cap. */
export const MAX_STORE_CHARS = 40 * 1024 * 1024;
/** A chat's title: its first question, cut short. */
export const TITLE_MAX = 60;

/** Where a chat was started: the chat page, or beside a chart. */
export type ChatMode = "chat" | "chart";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  /** The tools the analyst used for this answer. */
  tools?: string[];
  marks?: AiChartMarks;
  /** The answer was declined, or stopped short. */
  note?: "refused" | "cutShort";
}

/** Chats from before there was a choice were Claude's. */
export const LEGACY_PROVIDER: AiProvider = "claude";
export const LEGACY_MODEL = "claude-opus-5-5";
const PROVIDERS: readonly string[] = ["claude", "gemini", "openai"];

export interface AiChat {
  id: string;
  title: string;
  mode: ChatMode;
  /** Who answers it, for good: its transcript is that provider's own. */
  provider: AiProvider;
  model: string;
  venue: VenueId;
  market?: string;
  interval?: CandleInterval;
  messages: ChatMessage[];
  /** The API's conversation, opaque to the page. */
  transcript: unknown;
  updated: number;
}

const VENUE_IDS: readonly string[] = ["hyperliquid", "aster", "bybit", "binance"];

function parseMessage(v: unknown): ChatMessage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const m = v as Partial<ChatMessage>;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return undefined;
  return {
    role: m.role,
    text: m.text,
    time: typeof m.time === "number" ? m.time : 0,
    tools: Array.isArray(m.tools) ? m.tools.filter((t) => typeof t === "string") : undefined,
    marks: m.marks && typeof m.marks === "object" ? m.marks : undefined,
    note: m.note === "refused" || m.note === "cutShort" ? m.note : undefined,
  };
}

/** What was stored, made safe: malformed chats dropped, newest first. */
export function parseChats(raw: string | null): AiChat[] {
  try {
    return chatsOf(JSON.parse(raw ?? "[]"));
  } catch {
    return [];
  }
}

function chatsOf(value: unknown): AiChat[] {
  if (!Array.isArray(value)) return [];
  const out: AiChat[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const c = v as Partial<AiChat>;
    if (typeof c.id !== "string" || out.some((x) => x.id === c.id)) continue;
    if (typeof c.venue !== "string" || !VENUE_IDS.includes(c.venue)) continue;
    out.push({
      id: c.id,
      title: typeof c.title === "string" ? c.title.slice(0, TITLE_MAX) : "",
      mode: c.mode === "chart" ? "chart" : "chat",
      provider:
        typeof c.provider === "string" && PROVIDERS.includes(c.provider)
          ? c.provider
          : LEGACY_PROVIDER,
      model: typeof c.model === "string" && c.model ? c.model : LEGACY_MODEL,
      venue: c.venue,
      market: typeof c.market === "string" ? c.market : undefined,
      interval: typeof c.interval === "string" ? c.interval : undefined,
      messages: Array.isArray(c.messages) ? c.messages.flatMap((m) => parseMessage(m) ?? []) : [],
      transcript: Array.isArray(c.transcript) ? c.transcript : null,
      updated: typeof c.updated === "number" ? c.updated : 0,
    });
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, MAX_CHATS);
}

/** The chat open in each view. */
export type OpenChats = Partial<Record<ChatMode, string>>;

/** What the chats file holds. */
export interface ChatStore {
  version: 1;
  chats: AiChat[];
  open: OpenChats;
}

/** The chats file as read, made safe; empty for nothing or junk. */
export function parseStore(raw: string | null | undefined): ChatStore {
  const empty: ChatStore = { version: 1, chats: [], open: {} };
  if (!raw) return empty;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const v = value as { chats?: unknown; open?: unknown };
    const chats = chatsOf(v.chats);
    const open: OpenChats = {};
    if (v.open && typeof v.open === "object") {
      for (const mode of ["chat", "chart"] as const) {
        const id = (v.open as Record<string, unknown>)[mode];
        if (typeof id === "string" && chats.some((c) => c.id === id)) open[mode] = id;
      }
    }
    return { version: 1, chats, open };
  } catch {
    return empty;
  }
}

/** The chats in `kept` and `extra`, by id, `kept`'s copy winning; newest first. */
export function mergeChats(kept: readonly AiChat[], extra: readonly AiChat[]): AiChat[] {
  const ids = new Set(kept.map((c) => c.id));
  return [...kept, ...extra.filter((c) => !ids.has(c.id))]
    .sort((a, b) => b.updated - a.updated)
    .slice(0, MAX_CHATS);
}

/**
 * The chats file to write: newest first, the oldest chats dropped until it
 * fits under `max` characters. Says how many were dropped.
 */
export function storeToSave(
  chats: readonly AiChat[],
  open: OpenChats,
  max = MAX_STORE_CHARS,
): { store: ChatStore; dropped: number } {
  const sorted = [...chats].sort((a, b) => b.updated - a.updated);
  let kept = sorted.slice(0, MAX_CHATS);
  const sizes = kept.map((c) => JSON.stringify(c).length + 1);
  let total = sizes.reduce((a, b) => a + b, 64);
  while (kept.length > 1 && total > max) {
    total -= sizes[kept.length - 1] ?? 0;
    kept = kept.slice(0, -1);
  }
  const ids = new Set(kept.map((c) => c.id));
  const stillOpen: OpenChats = {};
  for (const mode of ["chat", "chart"] as const) {
    const id = open[mode];
    if (id && ids.has(id)) stillOpen[mode] = id;
  }
  return {
    store: { version: 1, chats: kept, open: stillOpen },
    dropped: sorted.length - kept.length,
  };
}

/**
 * A title the trader typed: one line, at most `TITLE_MAX` characters, or
 * undefined when nothing is left (the chat keeps the title it had).
 */
export function cleanTitle(title: string): string | undefined {
  const line = title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX).trim();
  return line || undefined;
}

/** A chat's title from its first question: one line, cut at a word. */
export function titleFrom(question: string): string {
  const line = question.trim().replace(/\s+/g, " ");
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > TITLE_MAX / 2 ? cut.slice(0, space) : cut}…`;
}

export const newChatId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The snapshot sent with a question: the market on screen first, then the
 * busiest markets by volume, at most `limit`.
 */
export function snapshotOf(
  summaries: readonly MarketSummary[],
  symbolOf: (id: string) => string,
  focus: string | undefined,
  limit = 40,
): AiSnapshotRow[] {
  const num = (s: string | null | undefined) => {
    const n = Number(s);
    return s != null && s !== "" && Number.isFinite(n) ? n : null;
  };
  const row = (s: MarketSummary): AiSnapshotRow => {
    const price = Number(s.markPrice);
    const prev = Number(s.prevDayPrice);
    return {
      symbol: symbolOf(s.market),
      price,
      change: prev > 0 ? (price / prev - 1) * 100 : null,
      funding: num(s.fundingRate),
      volume: num(s.dayVolume),
      openInterest: num(s.openInterest),
    };
  };
  const ranked = summaries
    .filter((s) => Number(s.markPrice) > 0 && s.market !== focus)
    .sort((a, b) => (num(b.dayVolume) ?? 0) - (num(a.dayVolume) ?? 0));
  const first = summaries.find((s) => s.market === focus);
  return [...(first ? [first] : []), ...ranked].slice(0, limit).map(row);
}

/** The headline numbers over every market: what the page's insight cards show. */
export interface MarketPulse {
  /** Markets up over 24 hours, as a share of those with a change, 0 to 1. */
  breadth?: number;
  /** Total 24-hour volume, in the quote currency. */
  volume?: number;
  /** Volume-weighted funding, as a fraction. */
  funding?: number;
  gainers: { market: string; change: number }[];
  losers: { market: string; change: number }[];
}

export function marketPulse(summaries: readonly MarketSummary[], top = 3): MarketPulse {
  let up = 0;
  let counted = 0;
  let volume = 0;
  let fundingWeighted = 0;
  let fundingVolume = 0;
  const changes: { market: string; change: number }[] = [];
  for (const s of summaries) {
    const price = Number(s.markPrice);
    const prev = Number(s.prevDayPrice);
    const vol = Number(s.dayVolume);
    if (price > 0 && prev > 0) {
      const change = (price / prev - 1) * 100;
      counted += 1;
      if (change > 0) up += 1;
      if (vol > 0) changes.push({ market: s.market, change });
    }
    if (Number.isFinite(vol) && vol > 0) {
      volume += vol;
      const f = Number(s.fundingRate);
      if (Number.isFinite(f)) {
        fundingWeighted += f * vol;
        fundingVolume += vol;
      }
    }
  }
  changes.sort((a, b) => b.change - a.change);
  return {
    breadth: counted > 0 ? up / counted : undefined,
    volume: volume > 0 ? volume : undefined,
    funding: fundingVolume > 0 ? fundingWeighted / fundingVolume : undefined,
    gainers: changes.slice(0, top),
    losers: changes.slice(-top).reverse(),
  };
}
