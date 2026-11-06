import type { CandleInterval, MarketSummary, VenueId } from "@pewterdesk/core";
import type { AiChatRecord, AiChatSummary } from "../api/cloudClient";
import type { AiChartMarks, AiProvider, AiSnapshotRow, AiSource, AiStep } from "../api/venueClient";

// PewterDesk AI's conversations, kept in PewterDesk Cloud (`cloud.rs`,
// `ai_chats`): what the page shows (each question and answer as text, with
// the chart marks an answer drew and the sources it cited) and the API's own
// transcript, handed back to Rust whole with the next question. The
// transcript holds questions, market data and answers - never a key. The
// list reads each chat's `meta` only; its messages and transcript are read
// when it's opened. Before the cloud they were kept in a file on this
// machine (and before that the webview's storage), read once to move them.

/** Where chats were kept before the file, read once to move them over. */
export const LEGACY_KEY = "pd.ai.chats";
const MAX_CHATS = 1000;
/** A message's cited sources, at most. */
const MAX_SOURCES = 60;
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
  /** What the answer cites, by its `[sN]` tag. */
  sources?: AiSource[];
  /** How long it took to answer, in milliseconds. */
  took?: number;
  /** How many requests it took. */
  rounds?: number;
  /** The trader's thumbs up or down. */
  rating?: "up" | "down";
  /** What it thought and read on the way. */
  steps?: AiStep[];
}

/** Chats from before there was a choice were Claude's. */
export const LEGACY_PROVIDER: AiProvider = "claude";
export const LEGACY_MODEL = "claude-opus-5-5";
const PROVIDERS: readonly string[] = ["claude", "gemini", "openai", "mistral"];

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
  /**
   * Only its summary is here (`meta`, from the list): its messages and
   * transcript are read from the cloud when it's opened.
   */
  partial?: boolean;
  /**
   * The markets its answers marked on a chart, as `venue:market`: kept in
   * its summary, so a chat not yet read can be found for a market's analysis.
   */
  marked?: string[];
}

const MAX_MARKED = 50;

/** A market as `marked` names it. */
export const marketKey = (venue: string, market: string) => `${venue}:${market}`;

/** The markets `chat`'s answers marked, newest last. */
export function markedOf(chat: Pick<AiChat, "messages" | "marked" | "partial">): string[] {
  if (chat.partial) return chat.marked ?? [];
  const keys: string[] = [];
  for (const m of chat.messages) {
    if (!m.marks) continue;
    const key = marketKey(m.marks.venue, m.marks.market);
    const at = keys.indexOf(key);
    if (at >= 0) keys.splice(at, 1);
    keys.push(key);
  }
  return keys.slice(-MAX_MARKED);
}

/** The latest analysis `chat` drew on `market`, if it drew one. */
function marksIn(chat: AiChat, venue: string, market: string): ChatMessage | undefined {
  return [...chat.messages]
    .reverse()
    .find((m) => m.marks && m.marks.venue === venue && m.marks.market === market);
}

/**
 * The analysis to draw for the market on screen: the latest one in the open
 * chat, else the latest in any other chat. `toRead` names a chat not read
 * yet whose summary says it marked this market, newest first: reading it
 * may find a newer analysis.
 */
export function marksFor(
  chats: readonly AiChat[],
  venue: string,
  market: string | undefined,
  openId: string | undefined,
): { marks?: AiChartMarks; chatId?: string; time?: number; toRead?: string } {
  if (!market) return {};
  const key = marketKey(venue, market);
  const open = chats.find((c) => c.id === openId && !c.partial);
  const own = open && marksIn(open, venue, market);
  if (open && own?.marks) return { marks: own.marks, chatId: open.id, time: own.time };
  let best: { marks: AiChartMarks; chatId: string; time: number } | undefined;
  let toRead: string | undefined;
  for (const c of [...chats].sort((a, b) => b.updated - a.updated)) {
    if (c.partial) {
      if (!toRead && (c.marked ?? []).includes(key) && (!best || c.updated > best.time)) {
        toRead = c.id;
      }
      continue;
    }
    const m = marksIn(c, venue, market);
    if (m?.marks && (!best || m.time > best.time)) {
      best = { marks: m.marks, chatId: c.id, time: m.time };
    }
  }
  return { ...best, toRead };
}

const VENUE_IDS: readonly string[] = ["hyperliquid", "aster", "bybit", "binance", "blofin"];

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
    sources: Array.isArray(m.sources)
      ? m.sources.flatMap((x) => parseSource(x) ?? []).slice(0, MAX_SOURCES)
      : undefined,
    took: typeof m.took === "number" && m.took >= 0 ? m.took : undefined,
    rounds: typeof m.rounds === "number" && m.rounds >= 0 ? m.rounds : undefined,
    rating: m.rating === "up" || m.rating === "down" ? m.rating : undefined,
    steps: Array.isArray(m.steps) ? stepsOf(m.steps) : undefined,
  };
}

const MAX_STEPS = 40;

/** Steps as kept, made safe: text only, bounded. */
export function stepsOf(value: readonly unknown[]): AiStep[] {
  const out: AiStep[] = [];
  for (const v of value.slice(0, MAX_STEPS)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    if (s.kind === "thought" && typeof s.text === "string") {
      out.push({ kind: "thought", text: s.text.slice(0, 2000) });
    } else if (s.kind === "tool" && typeof s.name === "string") {
      const detail = typeof s.detail === "string" ? s.detail.slice(0, 200) : "";
      out.push({ kind: "tool", name: s.name.slice(0, 40), detail });
    }
  }
  return out;
}

const SOURCE_KINDS: readonly string[] = ["post", "headline", "announcement"];

function parseSource(v: unknown): AiSource | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Partial<AiSource>;
  if (typeof s.n !== "number" || !Number.isInteger(s.n) || s.n < 1) return undefined;
  if (typeof s.kind !== "string" || !SOURCE_KINDS.includes(s.kind)) return undefined;
  const open =
    s.open &&
    typeof s.open === "object" &&
    (s.open.kind === "article" || s.open.kind === "wire" || s.open.kind === "link") &&
    typeof s.open.id === "string"
      ? { kind: s.open.kind, id: s.open.id }
      : null;
  return {
    n: s.n,
    kind: s.kind,
    publisher: typeof s.publisher === "string" ? s.publisher.slice(0, 60) : "",
    title: typeof s.title === "string" ? s.title.slice(0, 160) : "",
    time: typeof s.time === "number" ? s.time : 0,
    open,
  };
}

/** The highest source tag a chat's answers used, for the next answer to carry on from. */
export function sourceBase(chat: Pick<AiChat, "messages">): number {
  let max = 0;
  for (const m of chat.messages) for (const s of m.sources ?? []) max = Math.max(max, s.n);
  return max;
}

/** What was stored, made safe: malformed chats dropped, newest first. */
export function parseChats(raw: string | null): AiChat[] {
  try {
    return chatsOf(JSON.parse(raw ?? "[]"));
  } catch {
    return [];
  }
}

/** A chat id, as the cloud takes it (`cloud.rs`'s `is_chat_key`). */
export const isChatId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z0-9-]{1,64}$/.test(id);

function chatsOf(value: unknown): AiChat[] {
  if (!Array.isArray(value)) return [];
  const out: AiChat[] = [];
  for (const v of value) {
    const chat = chatOf(v);
    if (chat && !out.some((x) => x.id === chat.id)) out.push(chat);
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, MAX_CHATS);
}

function chatOf(v: unknown): AiChat | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Partial<AiChat>;
  if (!isChatId(c.id)) return undefined;
  if (typeof c.venue !== "string" || !VENUE_IDS.includes(c.venue)) return undefined;
  return {
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
    marked: Array.isArray(c.marked)
      ? c.marked
          .filter((k): k is string => typeof k === "string" && k.length <= 120)
          .slice(-MAX_MARKED)
      : undefined,
  };
}

/** What the cloud keeps as a chat's `meta`: everything but its messages and transcript. */
export function metaOf(chat: AiChat): Record<string, unknown> {
  return {
    title: chat.title,
    mode: chat.mode,
    provider: chat.provider,
    model: chat.model,
    venue: chat.venue,
    market: chat.market,
    interval: chat.interval,
    updated: chat.updated,
    marked: markedOf(chat),
  };
}

/** A chat in the cloud's list: its summary only, `partial` until opened. */
export function chatFromSummary(summary: AiChatSummary): AiChat | undefined {
  const meta = summary.meta && typeof summary.meta === "object" ? summary.meta : {};
  const chat = chatOf({ ...meta, id: summary.key, messages: [], transcript: null });
  return chat && { ...chat, partial: true };
}

/** A whole chat, as the cloud holds it. */
export function chatFromRecord(record: AiChatRecord): AiChat | undefined {
  const meta = record.meta && typeof record.meta === "object" ? record.meta : {};
  return chatOf({
    ...meta,
    id: record.key,
    messages: record.messages,
    transcript: record.transcript,
  });
}

/** The chat open in each view. */
export type OpenChats = Partial<Record<ChatMode, string>>;

/** What the old chats file held. */
export interface ChatStore {
  version: 1;
  chats: AiChat[];
  open: OpenChats;
}

/** The old chats file as read, made safe; empty for nothing or junk. */
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
