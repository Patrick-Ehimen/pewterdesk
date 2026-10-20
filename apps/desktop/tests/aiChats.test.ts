import type { MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  type AiChat,
  marketPulse,
  mergeChats,
  parseChats,
  parseStore,
  snapshotOf,
  storeToSave,
  TITLE_MAX,
  titleFrom,
} from "../src/lib/aiChats";
import { blocksOf, spansOf } from "../src/lib/aiText";

const summary = (market: string, price: number, prev: number, volume: number, funding = 0) =>
  ({
    market,
    markPrice: String(price),
    prevDayPrice: String(prev),
    dayVolume: String(volume),
    openInterest: "0",
    fundingRate: String(funding),
  }) as MarketSummary;

describe("parseChats", () => {
  it("keeps well-formed chats newest first and drops the rest", () => {
    const raw = JSON.stringify([
      { id: "a", title: "old", venue: "aster", messages: [], transcript: [], updated: 1 },
      {
        id: "b",
        title: "new",
        venue: "bybit",
        mode: "chart",
        messages: [
          { role: "user", text: "hi", time: 2 },
          { role: "system", text: "no" },
        ],
        transcript: [{ role: "user", content: "hi" }],
        updated: 5,
      },
      { id: "c", venue: "nowhere", updated: 9 },
      { id: "a", venue: "aster", updated: 3 },
      "junk",
    ]);
    const chats = parseChats(raw);
    expect(chats.map((c) => c.id)).toEqual(["b", "a"]);
    expect(chats[0]?.mode).toBe("chart");
    expect(chats[0]?.messages).toHaveLength(1);
    expect(chats[1]?.mode).toBe("chat");
  });

  it("reads nothing from what isn't a list", () => {
    expect(parseChats("{}")).toEqual([]);
    expect(parseChats("not json")).toEqual([]);
    expect(parseChats(null)).toEqual([]);
  });
});

describe("titleFrom", () => {
  it("takes the question on one line, cut at a word", () => {
    expect(titleFrom("  what   is\nfunding? ")).toBe("what is funding?");
    const long = titleFrom("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(long.endsWith("word…")).toBe(true);
  });
});

describe("snapshotOf", () => {
  it("puts the market on screen first, then the busiest", () => {
    const rows = snapshotOf(
      [
        summary("A", 1, 1, 10),
        summary("B", 2, 1, 500),
        summary("C", 3, 0, 50),
        summary("D", 0, 1, 900),
      ],
      (id) => `${id}-USD`,
      "A",
      3,
    );
    expect(rows.map((r) => r.symbol)).toEqual(["A-USD", "B-USD", "C-USD"]);
    expect(rows[1]?.change).toBe(100);
    expect(rows[2]?.change).toBeNull();
  });
});

describe("marketPulse", () => {
  it("counts breadth, volume, weighted funding and movers", () => {
    const pulse = marketPulse(
      [
        summary("A", 110, 100, 100, 0.001),
        summary("B", 90, 100, 300, -0.001),
        summary("C", 101, 100, 0),
      ],
      1,
    );
    expect(pulse.breadth).toBeCloseTo(2 / 3);
    expect(pulse.volume).toBe(400);
    expect(pulse.funding).toBeCloseTo(-0.0005);
    expect(pulse.gainers[0]?.market).toBe("A");
    expect(pulse.losers[0]?.market).toBe("B");
  });
});

describe("blocksOf", () => {
  it("reads headings, paragraphs and lists, and nothing as markup", () => {
    const blocks = blocksOf(
      "## Setup\nPrice is **above** the range\nand holding.\n\n- one\n- two `x`\n1. first\n<b>raw</b>",
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "paragraph",
    ]);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      spans: [
        { kind: "text", text: "Price is " },
        { kind: "bold", text: "above" },
        { kind: "text", text: " the range and holding." },
      ],
    });
    expect(blocks[4]).toEqual({ kind: "paragraph", spans: [{ kind: "text", text: "<b>raw</b>" }] });
  });

  it("leaves an unmatched marker as text", () => {
    expect(spansOf("a ** b ` c")).toEqual([{ kind: "text", text: "a ** b ` c" }]);
  });
});

const stored = (id: string, updated: number, size = 0): AiChat => ({
  id,
  title: id,
  mode: "chat",
  provider: "claude",
  model: "claude-opus-5-5",
  venue: "aster",
  messages: [{ role: "assistant", text: "x".repeat(size), time: updated }],
  transcript: [],
  updated,
});

describe("the chats file", () => {
  it("reads chats and keeps only open ids that name one", () => {
    const store = parseStore(
      JSON.stringify({ version: 1, chats: [stored("a", 1)], open: { chat: "a", chart: "gone" } }),
    );
    expect(store.chats.map((c) => c.id)).toEqual(["a"]);
    expect(store.open).toEqual({ chat: "a" });
    expect(parseStore(null).chats).toEqual([]);
    expect(parseStore("[1,2]").chats).toEqual([]);
    expect(parseStore("nope").chats).toEqual([]);
  });

  it("merges by id, the first list's copy winning", () => {
    const mine = { ...stored("a", 5), title: "mine" };
    const merged = mergeChats([mine], [stored("a", 9), stored("b", 1)]);
    expect(merged.map((c) => `${c.id}:${c.title}`)).toEqual(["a:mine", "b:b"]);
  });

  it("drops the oldest chats until the file fits, and closes them", () => {
    const chats = [stored("old", 1, 500), stored("mid", 2, 500), stored("new", 3, 500)];
    const { store, dropped } = storeToSave(chats, { chat: "old", chart: "new" }, 1500);
    expect(store.chats.map((c) => c.id)).toEqual(["new", "mid"]);
    expect(dropped).toBe(1);
    expect(store.open).toEqual({ chart: "new" });
    // The newest is kept even when it alone is over.
    expect(storeToSave(chats, {}, 10).store.chats.map((c) => c.id)).toEqual(["new"]);
  });
});
