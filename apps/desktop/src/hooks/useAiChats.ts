import { useSyncExternalStore } from "react";
import { CloudError, cloudClient } from "../api/cloudClient";
import {
  type AiContext,
  AiError,
  type AiFailure,
  type AiProvider,
  type AiStep,
  aiClient,
} from "../api/venueClient";
import {
  type AiChat,
  type ChatMessage,
  type ChatMode,
  chatFromRecord,
  chatFromSummary,
  cleanTitle,
  LEGACY_KEY,
  mergeChats,
  metaOf,
  newChatId,
  type OpenChats,
  parseChats,
  parseStore,
  sourceBase,
  titleFrom,
} from "../lib/aiChats";

// PewterDesk AI's chats, held outside the page: an answer that arrives
// after the trader has gone to another page still lands in its chat.
//
// They are kept in PewterDesk Cloud (`cloudClient`'s AI chats), behind the
// same sign-in as the Plan page: the list reads each chat's summary, and a
// chat is read whole when it's opened. Each change writes back only what
// changed (a rename, the title alone), one write at a time. Signed out,
// chats live in memory only, and go up once the trader signs in. The first
// time they do, the chats this machine kept before the cloud (a file Rust
// wrote, and before that the webview's storage) are moved up, and the file
// deleted once every one is there.

interface Failure {
  question: string;
  error: string;
  /** What Rust sorted it as, when it came from the provider or the setup. */
  ai?: AiFailure;
  /** When it failed, for a wait the provider asked for. */
  at: number;
}

/** Where the chats are kept, as far as the store knows. */
export type ChatCloud = "unknown" | "signedIn" | "signedOut" | "off";

interface AiChatsState {
  chats: AiChat[];
  /** The chat open in each view, kept on this machine. */
  open: OpenChats;
  cloud: ChatCloud;
  /** The cloud's list has been read (or there's no cloud to read). */
  loaded: boolean;
  /** The cloud's list couldn't be read. */
  loadError?: string;
  /** The last write failed: what's on screen isn't kept yet. */
  saveError?: string;
  /** The session ended under a write: the page should ask to sign in again. */
  signedOut: boolean;
  /** Chats being read whole, by id. */
  opening: ReadonlySet<string>;
  /** Chats waiting on an answer, by id. */
  pending: ReadonlySet<string>;
  /** What each pending answer has thought and read so far, by chat. */
  live: Readonly<Record<string, readonly AiStep[]>>;
  /** The last question that failed, by chat. Not kept across restarts. */
  failed: Readonly<Record<string, Failure>>;
}

const OPEN_KEY = "pd.ai.open";

let state: AiChatsState | undefined;
const listeners = new Set<() => void>();

function readOpen(): OpenChats {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
    const out: OpenChats = {};
    if (v && typeof v === "object") {
      for (const mode of ["chat", "chart"] as const) {
        const id = (v as Record<string, unknown>)[mode];
        if (typeof id === "string") out[mode] = id;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function keepOpen(open: OpenChats) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(open));
  } catch {
    // Storage is off: the open chats are forgotten on restart.
  }
}

function current(): AiChatsState {
  if (!state) {
    state = {
      chats: [],
      open: readOpen(),
      cloud: "unknown",
      loaded: false,
      signedOut: false,
      opening: new Set(),
      pending: new Set(),
      live: {},
      failed: {},
    };
  }
  return state;
}

function update(next: Partial<AiChatsState>) {
  state = { ...current(), ...next };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// ---- writing to the cloud ---------------------------------------------------

/** What of each chat is waiting to be written; `meta` always goes with it. */
interface Dirty {
  messages: boolean;
  transcript: boolean;
}
const dirty = new Map<string, Dirty>();
const deleted = new Set<string>();
let flushing = false;

/** Marks what of chat `id` changed, and writes it when the cloud is there. */
function touch(id: string, parts: Partial<Dirty> = {}) {
  const was = dirty.get(id) ?? { messages: false, transcript: false };
  dirty.set(id, {
    messages: was.messages || !!parts.messages,
    transcript: was.transcript || !!parts.transcript,
  });
  void flush();
}

function failedWrite(e: unknown) {
  if (e instanceof CloudError && e.signedOut) {
    update({ cloud: "signedOut", signedOut: true });
  } else {
    update({ saveError: e instanceof Error ? e.message : String(e) });
  }
}

async function flush() {
  if (flushing || current().cloud !== "signedIn" || !current().loaded) return;
  flushing = true;
  try {
    while (current().cloud === "signedIn" && (deleted.size > 0 || dirty.size > 0)) {
      const [gone] = deleted;
      if (gone !== undefined) {
        try {
          await cloudClient.removeAiChat(gone);
          deleted.delete(gone);
        } catch (e) {
          failedWrite(e);
          return;
        }
        continue;
      }
      const [first] = dirty;
      if (!first) break;
      const [id, parts] = first;
      dirty.delete(id);
      const chat = current().chats.find((c) => c.id === id);
      // Gone, or not read yet: there's nothing of it here to write but its summary.
      if (!chat) continue;
      const whole = !chat.partial;
      try {
        await cloudClient.putAiChat(id, {
          meta: metaOf(chat),
          ...(whole && parts.messages ? { messages: chat.messages } : {}),
          ...(whole && parts.transcript ? { transcript: chat.transcript } : {}),
        });
        update({ saveError: undefined });
      } catch (e) {
        // Put back what didn't go, for the next change (or sign-in) to retry.
        const now = dirty.get(id);
        dirty.set(id, {
          messages: parts.messages || !!now?.messages,
          transcript: parts.transcript || !!now?.transcript,
        });
        failedWrite(e);
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

// ---- signing in and out ------------------------------------------------------

/** Chats from before the file, still in the webview's storage. */
function legacyChats(): AiChat[] {
  try {
    return parseChats(localStorage.getItem(LEGACY_KEY));
  } catch {
    return [];
  }
}

/**
 * The chats this machine kept before the cloud, moved up: each written
 * whole, then the file deleted (and the webview's copy) once all are there.
 * A chat the cloud already has isn't written over.
 */
async function moveLocalChats(inCloud: ReadonlySet<string>): Promise<AiChat[]> {
  const saved = parseStore(await aiClient.loadChats());
  const legacy = legacyChats();
  const local = mergeChats(saved.chats, legacy).filter((c) => !inCloud.has(c.id));
  for (const chat of local) {
    await cloudClient.putAiChat(chat.id, {
      meta: metaOf(chat),
      messages: chat.messages,
      transcript: chat.transcript,
    });
  }
  await aiClient.forgetChats();
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage is off: nothing kept there.
  }
  if (Object.keys(current().open).length === 0 && Object.keys(saved.open).length > 0) {
    update({ open: saved.open });
    keepOpen(saved.open);
  }
  return local;
}

let connecting = false;

async function connect() {
  if (connecting) return;
  connecting = true;
  try {
    let listed: AiChat[];
    try {
      const summaries = await cloudClient.aiChats();
      listed = summaries.flatMap((s) => chatFromSummary(s) ?? []);
    } catch (e) {
      if (e instanceof CloudError && e.signedOut) {
        update({ cloud: "signedOut", signedOut: true, loaded: true });
      } else {
        update({ loaded: true, loadError: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    let moved: AiChat[] = [];
    let moveError: string | undefined;
    try {
      moved = await moveLocalChats(new Set(listed.map((c) => c.id)));
    } catch (e) {
      // The file stays until every chat is up; the next sign-in tries again.
      moveError = e instanceof Error ? e.message : String(e);
    }
    // Chats started in this session (signed out, or before the list came) are newest.
    const here = current().chats;
    const chats = mergeChats(mergeChats(here, moved), listed);
    update({ chats, loaded: true, loadError: undefined, saveError: moveError });
    for (const chat of here)
      if (!chat.partial) touch(chat.id, { messages: true, transcript: true });
    void flush();
  } finally {
    connecting = false;
  }
}

/**
 * Tells the store where the cloud stands, as the page's sign-in reads it.
 * Signing in reads the chats; signing out puts them away (they were the
 * signed-in user's).
 */
function setCloud(cloud: ChatCloud) {
  const was = current().cloud;
  if (was === cloud) return;
  if (cloud === "signedIn") {
    update({ cloud, signedOut: false, loaded: false, loadError: undefined });
    void connect();
  } else if (cloud === "signedOut" && was === "signedIn") {
    dirty.clear();
    deleted.clear();
    update({
      cloud,
      chats: current().chats.filter((c) => current().pending.has(c.id)),
      loaded: true,
      saveError: undefined,
    });
  } else {
    update({ cloud, loaded: cloud !== "unknown" });
  }
}

// ---- reading a chat whole -----------------------------------------------------

const reading = new Map<string, Promise<void>>();

/** Reads chat `id` whole from the cloud, if only its summary is here. */
function ensure(id: string): Promise<void> {
  const chat = current().chats.find((c) => c.id === id);
  if (!chat?.partial) return Promise.resolve();
  const already = reading.get(id);
  if (already) return already;
  update({ opening: new Set([...current().opening, id]) });
  const done = cloudClient
    .aiChat(id)
    .then(
      (record) => {
        const whole = record ? chatFromRecord(record) : undefined;
        update({
          chats: whole
            ? current().chats.map((c) => (c.id === id ? whole : c))
            : // Deleted elsewhere.
              current().chats.filter((c) => c.id !== id),
        });
      },
      (e: unknown) => {
        if (e instanceof CloudError && e.signedOut) update({ cloud: "signedOut", signedOut: true });
        throw e;
      },
    )
    .finally(() => {
      reading.delete(id);
      const opening = new Set(current().opening);
      opening.delete(id);
      update({ opening });
    });
  reading.set(id, done);
  return done;
}

// ---- what the page does ---------------------------------------------------------

function withChat(id: string, change: (chat: AiChat) => AiChat): AiChat[] {
  return current().chats.map((c) => (c.id === id ? change(c) : c));
}

function withoutFailure(id: string) {
  const { [id]: _, ...rest } = current().failed;
  return rest;
}

function failQuestion(chatId: string, question: string, e: unknown) {
  update({
    failed: {
      ...current().failed,
      [chatId]: {
        question,
        error: e instanceof Error ? e.message : String(e),
        ai: e instanceof AiError ? e.failure : undefined,
        at: Date.now(),
      },
    },
  });
}

/**
 * Asks `question` in chat `id`, or in a new chat answered by `pick` when
 * `id` is undefined (an existing chat keeps the provider and model it began
 * with). Resolves to the chat's id as soon as the question is shown; the
 * answer arrives in the store.
 */
function ask(
  id: string | undefined,
  question: string,
  context: AiContext,
  mode: ChatMode,
  pick: { provider: AiProvider; model: string },
): string | undefined {
  const text = question.trim();
  if (!text) return id;
  const s = current();
  if (id && s.pending.has(id)) return id;
  const found = id ? s.chats.find((c) => c.id === id) : undefined;
  if (found?.partial) {
    // Its transcript is in the cloud: read it first, then ask.
    ensure(found.id).then(
      () => void ask(found.id, text, context, mode, pick),
      (e: unknown) => failQuestion(found.id, text, e),
    );
    return found.id;
  }
  const now = Date.now();
  const asked: ChatMessage = { role: "user", text, time: now };
  const chat: AiChat = found ?? {
    id: newChatId(),
    title: titleFrom(text),
    mode,
    provider: pick.provider,
    model: pick.model,
    venue: context.venue,
    market: context.market ?? undefined,
    interval: context.interval ?? undefined,
    messages: [],
    transcript: null,
    updated: now,
  };
  const chatId = chat.id;
  const transcript = chat.transcript;
  const chats = found ? s.chats : [chat, ...s.chats];
  update({
    chats: chats.map((c) =>
      c.id !== chatId
        ? c
        : {
            ...c,
            messages: [...c.messages, asked],
            market: context.market ?? c.market,
            interval: context.interval ?? c.interval,
            updated: now,
          },
    ),
    pending: new Set([...current().pending, chatId]),
    failed: withoutFailure(chatId),
  });
  touch(chatId, { messages: true, transcript: !found });
  const started = performance.now();
  update({ live: { ...current().live, [chatId]: [] } });
  // Each thought and tool as it happens, shown under the question.
  const onStep = (step: AiStep) => {
    const steps = current().live[chatId] ?? [];
    update({ live: { ...current().live, [chatId]: [...steps, step] } });
  };
  const endLive = () => {
    const { [chatId]: _, ...live } = current().live;
    return live;
  };
  aiClient
    .ask(
      chat.provider,
      chat.model,
      transcript,
      text,
      { ...context, sourceBase: sourceBase(chat) },
      onStep,
    )
    .then(
      (reply) => {
        const pending = new Set(current().pending);
        pending.delete(chatId);
        const answer: ChatMessage = {
          role: "assistant",
          text: reply.text,
          time: Date.now(),
          tools: reply.tools.length ? reply.tools : undefined,
          marks: reply.marks ?? undefined,
          note: reply.end === "done" ? undefined : reply.end,
          sources: reply.sources.length ? reply.sources : undefined,
          took: Math.round(performance.now() - started),
          rounds: reply.rounds,
          steps: reply.steps?.length ? reply.steps : undefined,
        };
        update({
          chats: withChat(chatId, (c) => ({
            ...c,
            messages: [...c.messages, answer],
            transcript: reply.transcript,
            // A chat follows the market its latest analysis marked.
            ...(reply.marks
              ? {
                  venue: reply.marks.venue,
                  market: reply.marks.market,
                  interval: reply.marks.interval,
                }
              : {}),
            updated: Date.now(),
          })),
          pending,
          live: endLive(),
        });
        touch(chatId, { messages: true, transcript: true });
      },
      (e: unknown) => {
        const pending = new Set(current().pending);
        pending.delete(chatId);
        // The question goes back to the trader to try again; the chat is as it was.
        update({
          chats: withChat(chatId, (c) => ({
            ...c,
            messages: c.messages.filter((m) => m !== asked),
          })),
          pending,
          live: endLive(),
        });
        failQuestion(chatId, text, e);
        touch(chatId, { messages: true });
      },
    );
  return chatId;
}

function remove(id: string) {
  const open = { ...current().open };
  if (open.chat === id) delete open.chat;
  if (open.chart === id) delete open.chart;
  dirty.delete(id);
  deleted.add(id);
  update({
    chats: current().chats.filter((c) => c.id !== id),
    open,
    failed: withoutFailure(id),
  });
  keepOpen(open);
  void flush();
}

/**
 * Gives chat `id` the trader's own title. A blank one changes nothing. Its
 * place in the list stays: a rename isn't news.
 */
function rename(id: string, title: string) {
  const name = cleanTitle(title);
  const chat = current().chats.find((c) => c.id === id);
  if (!name || !chat || chat.title === name) return;
  update({ chats: withChat(id, (c) => ({ ...c, title: name })) });
  touch(id);
}

/** The trader's thumbs on an answer (`time` names it); the same again takes it off. */
function rate(id: string, time: number, rating: "up" | "down") {
  const chat = current().chats.find((c) => c.id === id);
  if (!chat || chat.partial) return;
  update({
    chats: withChat(id, (c) => ({
      ...c,
      messages: c.messages.map((m) =>
        m.role === "assistant" && m.time === time
          ? { ...m, rating: m.rating === rating ? undefined : rating }
          : m,
      ),
    })),
  });
  touch(id, { messages: true });
}

/** Opens chat `id` in view `mode` (none: a new chat), and keeps it so. */
function setOpen(mode: ChatMode, id: string | undefined) {
  if (current().open[mode] === id) return;
  const open = { ...current().open };
  if (id) open[mode] = id;
  else delete open[mode];
  update({ open });
  keepOpen(open);
}

function dismissFailure(id: string) {
  update({ failed: withoutFailure(id) });
}

/** The page has asked the trader to sign in again. */
function clearSignedOut() {
  update({ signedOut: false });
}

/** The store without React, for tests. */
export const aiChatsStore = {
  state: current,
  subscribe,
  ask,
  remove,
  rename,
  rate,
  setOpen,
  setCloud,
  ensure,
  dismissFailure,
  clearSignedOut,
};

/** The chats, newest first, and what can be done with them. */
export function useAiChats() {
  const s = useSyncExternalStore(subscribe, current);
  return {
    ...s,
    ask,
    remove,
    rename,
    rate,
    dismissFailure,
    setOpen,
    setCloud,
    ensure,
    clearSignedOut,
  };
}
