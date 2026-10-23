import { useSyncExternalStore } from "react";
import {
  type AiContext,
  AiError,
  type AiFailure,
  type AiProvider,
  aiClient,
} from "../api/venueClient";
import {
  type AiChat,
  type ChatMessage,
  type ChatMode,
  cleanTitle,
  LEGACY_KEY,
  mergeChats,
  newChatId,
  type OpenChats,
  parseChats,
  parseStore,
  storeToSave,
  titleFrom,
} from "../lib/aiChats";

// PewterDesk AI's chats, held outside the page: an answer that arrives
// after the trader has gone to another page still lands in its chat. They
// are kept in a file Rust writes (`load_ai_chats`, `save_ai_chats`), read
// once when first asked for and written whole after every change, one
// write at a time.

interface Failure {
  question: string;
  error: string;
  /** What Rust sorted it as, when it came from the provider or the setup. */
  ai?: AiFailure;
  /** When it failed, for a wait the provider asked for. */
  at: number;
}

interface AiChatsState {
  chats: AiChat[];
  /** The chat open in each view, kept with the chats. */
  open: OpenChats;
  /** The saved chats have been read (or there were none). */
  loaded: boolean;
  /** The saved chats couldn't be read: nothing is saved over them. */
  loadError?: string;
  /** The last save failed: what's on screen isn't kept yet. */
  saveError?: string;
  /** Chats waiting on an answer, by id. */
  pending: ReadonlySet<string>;
  /** The last question that failed, by chat. Not kept across restarts. */
  failed: Readonly<Record<string, Failure>>;
}

let state: AiChatsState | undefined;
const listeners = new Set<() => void>();

function current(): AiChatsState {
  if (!state) {
    state = { chats: [], open: {}, loaded: false, pending: new Set(), failed: {} };
    void load();
  }
  return state;
}

function update(next: Partial<AiChatsState>, persist = false) {
  state = { ...current(), ...next };
  for (const listener of listeners) listener();
  if (persist) void save();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Chats from before the file, still in the webview's storage. */
function legacyChats(): AiChat[] {
  try {
    return parseChats(localStorage.getItem(LEGACY_KEY));
  } catch {
    return [];
  }
}

async function load() {
  let raw: string | null;
  try {
    raw = await aiClient.loadChats();
  } catch (e) {
    update({ loaded: true, loadError: e instanceof Error ? e.message : String(e) });
    return;
  }
  const saved = parseStore(raw);
  const legacy = legacyChats();
  const now = current();
  // Chats started before the file was read are newer than it.
  const chats = mergeChats(mergeChats(now.chats, saved.chats), legacy);
  update({ chats, open: { ...saved.open, ...now.open }, loaded: true }, dirty || legacy.length > 0);
}

let saving = false;
/** A change arrived while a save was being written (or before the load). */
let dirty = false;

async function save() {
  const s = current();
  if (!s.loaded || s.loadError || saving) {
    dirty = true;
    return;
  }
  saving = true;
  try {
    do {
      dirty = false;
      const before = current().chats;
      const { store, dropped } = storeToSave(before, current().open);
      const kept = new Set(store.chats.map((c) => c.id));
      const gone = new Set(before.filter((c) => !kept.has(c.id)).map((c) => c.id));
      try {
        await aiClient.saveChats(store);
        try {
          localStorage.removeItem(LEGACY_KEY);
        } catch {
          // Storage is off: nothing to move.
        }
        // The oldest chats that didn't fit go from the screen too.
        update({
          saveError: undefined,
          ...(dropped > 0 ? { chats: current().chats.filter((c) => !gone.has(c.id)) } : {}),
        });
      } catch (e) {
        update({ saveError: e instanceof Error ? e.message : String(e) });
      }
    } while (dirty);
  } finally {
    saving = false;
  }
}

function withChat(id: string, change: (chat: AiChat) => AiChat): AiChat[] {
  return current().chats.map((c) => (c.id === id ? change(c) : c));
}

function withoutFailure(id: string) {
  const { [id]: _, ...rest } = current().failed;
  return rest;
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
  const now = Date.now();
  const asked: ChatMessage = { role: "user", text, time: now };
  const found = id ? s.chats.find((c) => c.id === id) : undefined;
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
  update(
    {
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
    },
    true,
  );
  aiClient.ask(chat.provider, chat.model, transcript, text, context).then(
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
      };
      update(
        {
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
        },
        true,
      );
    },
    (e: unknown) => {
      const pending = new Set(current().pending);
      pending.delete(chatId);
      // The question goes back to the trader to try again; the chat is as it was.
      update(
        {
          chats: withChat(chatId, (c) => ({
            ...c,
            messages: c.messages.filter((m) => m !== asked),
          })),
          pending,
          failed: {
            ...current().failed,
            [chatId]: {
              question: text,
              error: e instanceof Error ? e.message : String(e),
              ai: e instanceof AiError ? e.failure : undefined,
              at: Date.now(),
            },
          },
        },
        true,
      );
    },
  );
  return chatId;
}

function remove(id: string) {
  const open = { ...current().open };
  if (open.chat === id) delete open.chat;
  if (open.chart === id) delete open.chart;
  update(
    {
      chats: current().chats.filter((c) => c.id !== id),
      open,
      failed: withoutFailure(id),
    },
    true,
  );
}

/**
 * Gives chat `id` the trader's own title. A blank one changes nothing. Its
 * place in the list stays: a rename isn't news.
 */
function rename(id: string, title: string) {
  const name = cleanTitle(title);
  const chat = current().chats.find((c) => c.id === id);
  if (!name || !chat || chat.title === name) return;
  update({ chats: withChat(id, (c) => ({ ...c, title: name })) }, true);
}

/** Opens chat `id` in view `mode` (none: a new chat), and keeps it so. */
function setOpen(mode: ChatMode, id: string | undefined) {
  if (current().open[mode] === id) return;
  const open = { ...current().open };
  if (id) open[mode] = id;
  else delete open[mode];
  update({ open }, true);
}

function dismissFailure(id: string) {
  update({ failed: withoutFailure(id) });
}

/** The store without React, for tests. */
export const aiChatsStore = {
  state: current,
  subscribe,
  ask,
  remove,
  rename,
  setOpen,
  dismissFailure,
};

/** The chats, newest first, and what can be done with them. */
export function useAiChats() {
  const s = useSyncExternalStore(subscribe, current);
  return { ...s, ask, remove, rename, dismissFailure, setOpen };
}
