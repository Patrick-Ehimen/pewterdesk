import type { MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  type AiChat,
  chatFromRecord,
  chatFromSummary,
  cleanTitle,
  markedOf,
  marketPulse,
  marksFor,
  mergeChats,
  metaOf,
  parseChats,
  parseStore,
  snapshotOf,
  sourceBase,
  TITLE_MAX,
  titleFrom,
} from "../src/lib/aiChats";
import { answerOf, blocksOf, copyText, spansOf } from "../src/lib/aiText";

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

describe("cleanTitle", () => {
  it("keeps a typed title to one line within the limit, or nothing", () => {
    expect(cleanTitle("  SOL   breakout\nplan ")).toBe("SOL breakout plan");
    expect(cleanTitle("x".repeat(TITLE_MAX + 20))).toHaveLength(TITLE_MAX);
    expect(cleanTitle("   ")).toBeUndefined();
    expect(cleanTitle("")).toBeUndefined();
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
});

describe("chats in the cloud", () => {
  const whole = stored("a", 4);
  it("keeps a chat's summary as its meta, and reads it back partial", () => {
    const meta = metaOf(whole);
    expect(meta).not.toHaveProperty("messages");
    expect(meta).not.toHaveProperty("transcript");
    const back = chatFromSummary({ key: "a", meta, updatedAt: "x" });
    expect(back?.partial).toBe(true);
    expect(back?.title).toBe("a");
    expect(back?.messages).toEqual([]);
    const full = chatFromRecord({ key: "a", meta, messages: whole.messages, transcript: [] });
    expect(full?.partial).toBeUndefined();
    expect(full?.messages).toHaveLength(1);
    // A key the cloud wouldn't take isn't a chat.
    expect(chatFromSummary({ key: "Not OK", meta, updatedAt: "x" })).toBeUndefined();
  });

  it("keeps an answer's sources, checked, and carries their numbers on", () => {
    const chat = chatFromRecord({
      key: "a",
      meta: metaOf(whole),
      messages: [
        {
          role: "assistant",
          text: "x",
          time: 1,
          rating: "up",
          sources: [
            {
              n: 3,
              kind: "headline",
              publisher: "CoinDesk",
              title: "t",
              time: 1,
              open: { kind: "article", id: "x1" },
            },
            {
              n: 9,
              kind: "post",
              publisher: "p",
              title: "t",
              time: 1,
              open: { kind: "url", id: "https://x" },
            },
            { n: 0, kind: "post", publisher: "p", title: "t", time: 1, open: null },
            { n: 4, kind: "rumour", publisher: "p", title: "t", time: 1, open: null },
          ],
        },
      ],
      transcript: [],
    });
    const sources = chat?.messages[0]?.sources ?? [];
    expect(sources.map((s) => s.n)).toEqual([3, 9]);
    // Only the ways Rust opens a source; anything else can't open.
    expect(sources[0]?.open).toEqual({ kind: "article", id: "x1" });
    expect(sources[1]?.open).toBeNull();
    expect(chat?.messages[0]?.rating).toBe("up");
    expect(chat && sourceBase(chat)).toBe(9);
  });
});

describe("answers", () => {
  it("reads citations as numbers, never as links", () => {
    expect(spansOf("ETF outflows [s3] and [s12]; [x] [s] stay")).toEqual([
      { kind: "text", text: "ETF outflows" },
      { kind: "cite", n: 3 },
      { kind: "text", text: " and" },
      { kind: "cite", n: 12 },
      { kind: "text", text: "; [x] [s] stay" },
    ]);
  });

  it("lays out a TLDR, the deep dive and the bottom line", () => {
    const answer = answerOf(
      [
        "## TLDR",
        "A risk-off move [s1].",
        "1. Tech sold off.",
        "2. Longs were liquidated.",
        "## Deep dive",
        "### 1. The shock",
        "Nasdaq fell.",
        "**Bottom line:** macro-led, leverage the accelerant.",
      ].join("\n"),
    );
    expect(answer.tldr?.lead).toEqual([
      { kind: "text", text: "A risk-off move" },
      { kind: "cite", n: 1 },
      { kind: "text", text: "." },
    ]);
    expect(answer.tldr?.points).toHaveLength(2);
    expect(answer.body.map((b) => b.kind)).toEqual(["heading", "heading", "paragraph"]);
    expect(answer.bottom).toEqual([{ kind: "text", text: "macro-led, leverage the accelerant." }]);
    // Without the layout, it's all body.
    const plain = answerOf("BTC is 76,000.");
    expect(plain.tldr).toBeUndefined();
    expect(plain.body).toHaveLength(1);
  });

  it("copies an answer with its sources named, in the order it cites them", () => {
    const sources = [
      {
        n: 4,
        kind: "post" as const,
        publisher: "Lookonchain",
        title: "Liq $1.2B",
        time: 1,
        open: null,
      },
      {
        n: 2,
        kind: "headline" as const,
        publisher: "CoinDesk",
        title: "BTC falls",
        time: 1,
        open: null,
      },
    ];
    expect(copyText("Down [s2], liquidations [s4], again [s2], unknown [s9].", sources)).toBe(
      "Down [1], liquidations [2], again [1], unknown.\n\n[1] CoinDesk - BTC falls\n[2] Lookonchain - Liq $1.2B",
    );
    expect(copyText("No sources.")).toBe("No sources.");
  });
});

describe("a market's saved analysis", () => {
  const marks = (market: string) =>
    ({
      venue: "bybit",
      market,
      interval: "1h",
      bias: "bullish",
      summary: market,
      levels: [],
    }) as unknown as NonNullable<AiChat["messages"][number]["marks"]>;
  const chat = (id: string, updated: number, analysed: [string, number][]): AiChat => ({
    id,
    title: id,
    mode: "chart",
    provider: "claude",
    model: "claude-opus-5-5",
    venue: "bybit",
    messages: analysed.map(([m, time]) => ({ role: "assistant", text: "", time, marks: marks(m) })),
    transcript: [],
    updated: Math.max(0, ...analysed.map(([, t]) => t)),
  });

  it("finds a market's latest analysis after another market was analysed", () => {
    // ETH, then SOL, in the same chat: back on ETH, ETH's is still there.
    const one = chat("one", 2, [
      ["ETHUSDT", 1],
      ["SOLUSDT", 2],
    ]);
    expect(marksFor([one], "bybit", "ETHUSDT", "one").marks?.market).toBe("ETHUSDT");
    expect(marksFor([one], "bybit", "SOLUSDT", "one").marks?.market).toBe("SOLUSDT");
    expect(marksFor([one], "bybit", "BTCUSDT", "one").marks).toBeUndefined();
    expect(marksFor([one], "binance", "ETHUSDT", "one").marks).toBeUndefined();
  });

  it("looks in other chats, newest first, and names one it hasn't read yet", () => {
    const old = chat("old", 1, [["ETHUSDT", 1]]);
    const newer = chat("newer", 5, [["ETHUSDT", 5]]);
    const open = chat("open", 9, [["SOLUSDT", 9]]);
    const found = marksFor([old, newer, open], "bybit", "ETHUSDT", "open");
    expect(found.chatId).toBe("newer");
    // A chat only listed, whose summary says it marked ETH: read it to look.
    const listed = {
      ...chat("listed", 20, []),
      updated: 20,
      partial: true,
      marked: ["bybit:ETHUSDT"],
    };
    expect(marksFor([old, listed], "bybit", "ETHUSDT", undefined).toRead).toBe("listed");
    expect(markedOf(newer)).toEqual(["bybit:ETHUSDT"]);
    expect(metaOf(open).marked).toEqual(["bybit:SOLUSDT"]);
  });
});
