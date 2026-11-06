import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChat } from "../src/lib/aiChats";

// The chats store against stand-ins for PewterDesk Cloud and Rust's old
// chats file: the list read on sign-in (summaries only), a chat read whole
// when it's opened, only what changed written back, and the old file moved
// up then deleted.

const loadChats = vi.fn<() => Promise<string | null>>();
const forgetChats = vi.fn<() => Promise<void>>();
const ask = vi.fn();
vi.mock("../src/api/venueClient", () => ({
  aiClient: {
    loadChats: () => loadChats(),
    forgetChats: () => forgetChats(),
    ask: (...a: unknown[]) => ask(...a),
  },
  AiError: class AiError extends Error {},
}));

const aiChats = vi.fn();
const aiChat = vi.fn();
const putAiChat = vi.fn();
const removeAiChat = vi.fn();
vi.mock("../src/api/cloudClient", () => ({
  CloudError: class CloudError extends Error {
    constructor(
      message: string,
      readonly signedOut = false,
    ) {
      super(message);
    }
  },
  cloudClient: {
    aiChats: () => aiChats(),
    aiChat: (key: string) => aiChat(key),
    putAiChat: (key: string, parts: unknown) => putAiChat(key, parts),
    removeAiChat: (key: string) => removeAiChat(key),
  },
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

const chat = (id: string, updated: number, over: Partial<AiChat> = {}): AiChat => ({
  id,
  title: id,
  mode: "chart",
  provider: "claude",
  model: "claude-opus-5-5",
  venue: "bybit",
  market: "BTCUSDT",
  interval: "1h",
  messages: [{ role: "user", text: "hi", time: updated }],
  transcript: [{ role: "user", content: "hi" }],
  updated,
  ...over,
});

const summaryOf = (c: AiChat) => ({
  key: c.id,
  meta: {
    title: c.title,
    mode: c.mode,
    provider: c.provider,
    model: c.model,
    venue: c.venue,
    updated: c.updated,
  },
  updatedAt: "2026-11-06T00:00:00Z",
});

const pick = { provider: "gemini" as const, model: "gemini-3.8-flash" };
const context = {
  venue: "bybit" as const,
  market: "BTCUSDT",
  interval: "1h" as const,
  snapshot: [],
  accounts: [],
  deep: false,
};

async function freshStore(signIn = true) {
  vi.resetModules();
  const { aiChatsStore } = await import("../src/hooks/useAiChats");
  if (signIn) {
    aiChatsStore.setCloud("signedIn");
    await vi.waitFor(() => expect(aiChatsStore.state().loaded).toBe(true));
  }
  return aiChatsStore;
}

/** What the last write of chat `key` sent. */
const lastPut = (key: string) =>
  putAiChat.mock.calls.filter(([k]) => k === key).at(-1)?.[1] as
    | { meta: Record<string, unknown>; messages?: unknown[]; transcript?: unknown }
    | undefined;

beforeEach(() => {
  storage.clear();
  loadChats.mockReset().mockResolvedValue(null);
  forgetChats.mockReset().mockResolvedValue(undefined);
  ask.mockReset();
  aiChats.mockReset().mockResolvedValue([]);
  aiChat.mockReset().mockResolvedValue(null);
  putAiChat.mockReset().mockResolvedValue(undefined);
  removeAiChat.mockReset().mockResolvedValue(undefined);
});

describe("the AI chats store", () => {
  it("lists the cloud's chats by summary, and reads one whole when it's opened", async () => {
    aiChats.mockResolvedValue([summaryOf(chat("b", 2)), summaryOf(chat("a", 1))]);
    const store = await freshStore();
    expect(store.state().chats.map((c) => c.id)).toEqual(["b", "a"]);
    expect(store.state().chats.every((c) => c.partial)).toBe(true);
    aiChat.mockResolvedValue({
      key: "a",
      meta: summaryOf(chat("a", 1)).meta,
      messages: [{ role: "user", text: "hi", time: 1 }],
      transcript: [{ role: "user", content: "hi" }],
    });
    await store.ensure("a");
    const a = store.state().chats.find((c) => c.id === "a");
    expect(a?.partial).toBeUndefined();
    expect(a?.messages).toHaveLength(1);
    // Reading isn't writing.
    expect(putAiChat).not.toHaveBeenCalled();
  });

  it("moves this machine's old chats up, then deletes the file", async () => {
    storage.set("pd.ai.chats", JSON.stringify([chat("old", 1)]));
    loadChats.mockResolvedValue(
      JSON.stringify({ version: 1, chats: [chat("new", 2), chat("there", 3)], open: {} }),
    );
    // One is already in the cloud: it isn't written over.
    aiChats.mockResolvedValue([summaryOf(chat("there", 3))]);
    const store = await freshStore();
    expect(putAiChat.mock.calls.map(([k]) => k)).toEqual(["new", "old"]);
    expect(lastPut("new")?.transcript).toEqual([{ role: "user", content: "hi" }]);
    expect(forgetChats).toHaveBeenCalledTimes(1);
    expect(storage.has("pd.ai.chats")).toBe(false);
    expect(store.state().chats.map((c) => c.id)).toEqual(["there", "new", "old"]);
  });

  it("keeps the old file when a chat couldn't go up, and says so", async () => {
    loadChats.mockResolvedValue(JSON.stringify({ version: 1, chats: [chat("a", 1)], open: {} }));
    putAiChat.mockRejectedValueOnce(new Error("offline"));
    const store = await freshStore();
    expect(forgetChats).not.toHaveBeenCalled();
    expect(store.state().saveError).toBe("offline");
  });

  it("writes a question and its answer, with its sources and how long it took", async () => {
    const marks = {
      venue: "bybit",
      market: "SOLUSDT",
      interval: "4h",
      bias: "bullish",
      summary: "Higher lows.",
      levels: [{ price: 140, kind: "support", label: "Range low" }],
    };
    const sources = [
      { n: 1, kind: "headline", publisher: "CoinDesk", title: "SOL up", time: 5, open: null },
    ];
    ask.mockResolvedValue({
      transcript: [
        { role: "user", content: "x" },
        { role: "assistant", content: [] },
      ],
      text: "SOL holds the range [s1].",
      marks,
      tools: ["get_candles", "mark_chart"],
      end: "done",
      sources,
      rounds: 3,
    });
    const store = await freshStore();
    const id = store.ask(undefined, "Analyze sol-usdt", context, "chart", pick) ?? "";
    await vi.waitFor(() => expect(lastPut(id)?.messages).toHaveLength(2));
    const put = lastPut(id);
    const answer = put?.messages?.[1] as Record<string, unknown>;
    expect(answer.marks).toEqual(marks);
    expect(answer.sources).toEqual(sources);
    expect(answer.rounds).toBe(3);
    expect(typeof answer.took).toBe("number");
    expect(put?.transcript).toHaveLength(2);
    // A new chat is answered by the model picked, and keeps it.
    expect(put?.meta.provider).toBe("gemini");
    expect(put?.meta.model).toBe("gemini-3.8-flash");
    expect(ask.mock.calls[0]?.slice(0, 2)).toEqual(["gemini", "gemini-3.8-flash"]);
    // The chat follows the market it marked.
    expect(put?.meta.market).toBe("SOLUSDT");
    expect(put?.meta.interval).toBe("4h");
  });

  it("numbers a follow-up's sources on from the chat's earlier ones", async () => {
    ask.mockReturnValue(new Promise(() => {}));
    loadChats.mockResolvedValue(
      JSON.stringify({
        version: 1,
        chats: [
          chat("a", 1, {
            messages: [
              { role: "user", text: "q", time: 1 },
              {
                role: "assistant",
                text: "x [s7]",
                time: 2,
                sources: [{ n: 7, kind: "post", publisher: "p", title: "t", time: 1, open: null }],
              },
            ],
          }),
        ],
        open: {},
      }),
    );
    const store = await freshStore();
    store.ask("a", "and then?", context, "chat", pick);
    expect(ask.mock.calls[0]?.[4]).toMatchObject({ sourceBase: 7 });
  });

  it("reads a chat whole before asking in it", async () => {
    aiChats.mockResolvedValue([summaryOf(chat("a", 1))]);
    aiChat.mockResolvedValue({
      key: "a",
      meta: summaryOf(chat("a", 1)).meta,
      messages: [{ role: "user", text: "hi", time: 1 }],
      transcript: [{ role: "user", content: "hi" }],
    });
    ask.mockReturnValue(new Promise(() => {}));
    const store = await freshStore();
    store.ask("a", "and now?", context, "chat", pick);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    // Its own transcript, read from the cloud, and its own model.
    expect(ask.mock.calls[0]?.slice(0, 3)).toEqual([
      "claude",
      "claude-opus-5-5",
      [{ role: "user", content: "hi" }],
    ]);
  });

  it("sends a rename as the title alone", async () => {
    aiChats.mockResolvedValue([summaryOf(chat("a", 5)), summaryOf(chat("b", 1))]);
    const store = await freshStore();
    store.rename("b", "  My   SOL plan ");
    await vi.waitFor(() => expect(lastPut("b")?.meta.title).toBe("My SOL plan"));
    expect(lastPut("b")).not.toHaveProperty("messages");
    expect(lastPut("b")).not.toHaveProperty("transcript");
    // Its place stays: a rename doesn't bring it to the top.
    expect(store.state().chats.map((c) => c.id)).toEqual(["a", "b"]);
    const writes = putAiChat.mock.calls.length;
    store.rename("b", "   ");
    store.rename("gone", "x");
    await new Promise((r) => setTimeout(r, 10));
    expect(putAiChat.mock.calls.length).toBe(writes);
  });

  it("keeps the thumbs on an answer, and takes them off when pressed again", async () => {
    loadChats.mockResolvedValue(
      JSON.stringify({
        version: 1,
        chats: [chat("a", 1, { messages: [{ role: "assistant", text: "x", time: 9 }] })],
        open: {},
      }),
    );
    const store = await freshStore();
    store.rate("a", 9, "up");
    const rating = () => (lastPut("a")?.messages?.[0] as { rating?: string } | undefined)?.rating;
    await vi.waitFor(() => expect(rating()).toBe("up"));
    store.rate("a", 9, "up");
    await vi.waitFor(() => expect(rating()).toBeUndefined());
  });

  it("deletes a chat from the cloud", async () => {
    aiChats.mockResolvedValue([summaryOf(chat("a", 1))]);
    const store = await freshStore();
    store.remove("a");
    await vi.waitFor(() => expect(removeAiChat).toHaveBeenCalledWith("a"));
    expect(store.state().chats).toEqual([]);
  });

  it("signed out, keeps chats in memory and sends them up once signed in", async () => {
    ask.mockReturnValue(new Promise(() => {}));
    const store = await freshStore(false);
    store.setCloud("signedOut");
    const id = store.ask(undefined, "hello", context, "chat", pick) ?? "";
    await new Promise((r) => setTimeout(r, 10));
    expect(putAiChat).not.toHaveBeenCalled();
    store.setCloud("signedIn");
    await vi.waitFor(() => expect(lastPut(id)?.messages).toHaveLength(1));
    expect(store.state().chats.map((c) => c.id)).toEqual([id]);
  });

  it("shows a failed write instead of losing it quietly, and retries it", async () => {
    putAiChat.mockRejectedValueOnce(new Error("too large"));
    ask.mockReturnValue(new Promise(() => {}));
    const store = await freshStore();
    const id = store.ask(undefined, "hello", context, "chat", pick) ?? "";
    await vi.waitFor(() => expect(store.state().saveError).toBe("too large"));
    expect(store.state().chats).toHaveLength(1);
    store.rename(id, "renamed");
    await vi.waitFor(() => expect(lastPut(id)?.messages).toHaveLength(1));
    expect(store.state().saveError).toBeUndefined();
  });

  it("asks to sign in again when the session ended under a write", async () => {
    const { CloudError } = await import("../src/api/cloudClient");
    putAiChat.mockRejectedValue(new CloudError("signed out", true));
    ask.mockReturnValue(new Promise(() => {}));
    const store = await freshStore();
    store.ask(undefined, "hello", context, "chat", pick);
    await vi.waitFor(() => expect(store.state().signedOut).toBe(true));
    expect(store.state().cloud).toBe("signedOut");
  });
});
