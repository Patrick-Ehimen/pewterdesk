import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChat } from "../src/lib/aiChats";

// The chats store against a stand-in for Rust's chats file: read once,
// written whole after each change, never over a file it couldn't read.

const loadChats = vi.fn<() => Promise<string | null>>();
const saveChats = vi.fn<(store: unknown) => Promise<void>>();
const ask = vi.fn();
vi.mock("../src/api/venueClient", () => ({
  aiClient: {
    loadChats: () => loadChats(),
    saveChats: (store: unknown) => saveChats(store),
    ask: (...a: unknown[]) => ask(...a),
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

const pick = { provider: "gemini" as const, model: "gemini-3.8-flash" };
const context = {
  venue: "bybit" as const,
  market: "BTCUSDT",
  interval: "1h" as const,
  snapshot: [],
  accounts: [],
  deep: false,
};

async function freshStore() {
  vi.resetModules();
  const { aiChatsStore } = await import("../src/hooks/useAiChats");
  aiChatsStore.state();
  await vi.waitFor(() => expect(aiChatsStore.state().loaded).toBe(true));
  return aiChatsStore;
}

const lastSaved = () => saveChats.mock.calls.at(-1)?.[0] as { chats: AiChat[]; open: object };

beforeEach(() => {
  storage.clear();
  loadChats.mockReset();
  saveChats.mockReset().mockResolvedValue(undefined);
  ask.mockReset();
});

describe("the AI chats store", () => {
  it("reads the saved chats and the one open in each view", async () => {
    loadChats.mockResolvedValue(
      JSON.stringify({ version: 1, chats: [chat("a", 1), chat("b", 2)], open: { chart: "a" } }),
    );
    const store = await freshStore();
    expect(store.state().chats.map((c) => c.id)).toEqual(["b", "a"]);
    expect(store.state().open).toEqual({ chart: "a" });
    expect(saveChats).not.toHaveBeenCalled();
  });

  it("saves a question and its answer, with the analysis", async () => {
    loadChats.mockResolvedValue(null);
    const marks = {
      venue: "bybit",
      market: "SOLUSDT",
      interval: "4h",
      bias: "bullish",
      summary: "Higher lows.",
      levels: [{ price: 140, kind: "support", label: "Range low" }],
    };
    ask.mockResolvedValue({
      transcript: [
        { role: "user", content: "x" },
        { role: "assistant", content: [] },
      ],
      text: "SOL holds the range.",
      marks,
      tools: ["get_candles", "mark_chart"],
      end: "done",
    });
    const store = await freshStore();
    const id = store.ask(undefined, "Analyze sol-usdt", context, "chart", pick);
    store.setOpen("chart", id);
    await vi.waitFor(() => expect(lastSaved()?.chats[0]?.messages).toHaveLength(2));
    const saved = lastSaved();
    expect(saved.open).toEqual({ chart: id });
    expect(saved.chats[0]?.messages[1]?.marks).toEqual(marks);
    // A new chat is answered by the model picked, and keeps it.
    expect(saved.chats[0]?.provider).toBe("gemini");
    expect(saved.chats[0]?.model).toBe("gemini-3.8-flash");
    expect(ask.mock.calls[0]?.slice(0, 2)).toEqual(["gemini", "gemini-3.8-flash"]);
    // The chat follows the market it marked.
    expect(saved.chats[0]?.market).toBe("SOLUSDT");
    expect(saved.chats[0]?.interval).toBe("4h");
  });

  it("writes one save at a time, the last one with every change", async () => {
    loadChats.mockResolvedValue(null);
    let release: () => void = () => {};
    saveChats.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const store = await freshStore();
    store.setOpen("chat", undefined);
    store.setOpen("chart", undefined);
    ask.mockReturnValue(new Promise(() => {}));
    store.ask(undefined, "one", context, "chat", pick);
    store.ask(undefined, "two", context, "chat", pick);
    expect(saveChats).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(saveChats).toHaveBeenCalledTimes(2));
    expect(
      lastSaved()
        .chats.map((c) => c.title)
        .sort(),
    ).toEqual(["one", "two"]);
  });

  it("moves chats left in the webview's storage into the file", async () => {
    storage.set("pd.ai.chats", JSON.stringify([chat("old", 1)]));
    loadChats.mockResolvedValue(JSON.stringify({ version: 1, chats: [chat("new", 2)], open: {} }));
    await freshStore();
    await vi.waitFor(() => expect(storage.has("pd.ai.chats")).toBe(false));
    expect(lastSaved().chats.map((c) => c.id)).toEqual(["new", "old"]);
  });

  it("never saves over a file it couldn't read, and says so", async () => {
    loadChats.mockRejectedValue(new Error("permission denied"));
    ask.mockReturnValue(new Promise(() => {}));
    const store = await freshStore();
    expect(store.state().loadError).toBe("permission denied");
    store.ask(undefined, "hello", context, "chat", pick);
    await new Promise((r) => setTimeout(r, 10));
    expect(saveChats).not.toHaveBeenCalled();
  });

  it("shows a failed save instead of losing it quietly", async () => {
    loadChats.mockResolvedValue(null);
    saveChats.mockRejectedValue(new Error("disk full"));
    ask.mockReturnValue(new Promise(() => {}));
    const store = await freshStore();
    store.ask(undefined, "hello", context, "chat", pick);
    await vi.waitFor(() => expect(store.state().saveError).toBe("disk full"));
    expect(store.state().chats).toHaveLength(1);
  });
});
