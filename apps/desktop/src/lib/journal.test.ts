import { describe, expect, it } from "vitest";
import {
  ALL_MARKETS,
  allOf,
  clearedTrade,
  detectedBreaks,
  disciplineScore,
  excursions,
  expandMarkets,
  gradeOf,
  inSession,
  isBlankDay,
  levelsText,
  marketIn,
  newDay,
  newNote,
  newPlan,
  newPlaybook,
  normalizeDay,
  normalizeNote,
  normalizePlan,
  normalizePlaybook,
  rOf,
  type TradeFigures,
  type TradeNote,
  tradeKey,
  utcDay,
} from "./journal";
import {
  byEntryHour,
  cumulativeR,
  daySummaries,
  edgeDecay,
  followedVsSkipped,
  journalStreak,
  processOutcome,
} from "./journalStats";

const NOV4_1312 = Date.UTC(2026, 10, 4, 13, 12);
const NOV4_1951 = Date.UTC(2026, 10, 4, 19, 51);

const figures = (over: Partial<TradeFigures> = {}): TradeFigures => ({
  venue: "hyperliquid",
  market: "BTC",
  side: "long",
  size: 0.78,
  entryPrice: 81_540,
  exitPrice: 82_240,
  pnl: 524.53,
  entryValue: 63_601.2,
  openedAt: NOV4_1312,
  closedAt: NOV4_1951,
  ...over,
});

const note = (over: Partial<TradeNote> = {}, trade: Partial<TradeFigures> = {}): TradeNote => ({
  ...newNote(figures(trade)),
  playbookId: "pb1",
  plannedStop: 81_270,
  ...over,
});

describe("trades in R", () => {
  it("counts R from the planned stop", () => {
    // 270 a coin of risk on 0.78 coins is 210.6; 524.53 / 210.6 = 2.49R.
    expect(rOf(note())).toBeCloseTo(2.49, 2);
  });

  it("falls back to the risk written down, and has none without either", () => {
    expect(rOf(note({ plannedStop: undefined, riskAmount: 250 }))).toBeCloseTo(2.098, 3);
    expect(rOf(note({ plannedStop: undefined }))).toBeUndefined();
  });

  it("measures excursions on the trade's side", () => {
    const { mfe, mae } = excursions(note({}, { best: 82_262, worst: 81_310 }));
    expect(mfe).toBeCloseTo((722 * 0.78) / 210.6, 3);
    expect(mae).toBeCloseTo((-230 * 0.78) / 210.6, 3);
    const short = excursions(
      note({ plannedStop: 81_810 }, { side: "short", best: 81_000, worst: 81_700 }),
    );
    expect(short.mfe).toBeGreaterThan(0);
    expect(short.mae).toBeLessThan(0);
  });
});

describe("process", () => {
  it("grades the process, not the result", () => {
    expect(gradeOf(note())).toBe("A");
    const skipped = note({
      checklist: [{ id: "a", text: "news", required: true, checked: false }],
    });
    expect(gradeOf(skipped)).toBe("B");
    expect(gradeOf(note({ breaks: ["outsideSession"] }))).toBe("C");
    expect(gradeOf(note({ playbookId: undefined, breaks: ["noPlaybook"] }))).toBe("D");
  });

  it("scores the day from 100", () => {
    const skipped = note({
      checklist: [{ id: "a", text: "news", required: true, checked: false }],
    });
    const day = { ...newDay(), review: { ...newDay().review, savedAt: 1 } };
    expect(disciplineScore(day, [skipped])).toBe(92);
    expect(disciplineScore(undefined, [skipped])).toBe(82);
    expect(disciplineScore(day, [note({ breaks: ["pastMaxTrades"] })])).toBe(88);
  });

  it("sees breaks against the plan", () => {
    const plan = { ...newPlan(), markets: ["BTC", "ETH"], maxTradesPerDay: 4 };
    // Wednesday 13:12 UTC, inside 12:00-16:00.
    expect(inSession(plan, NOV4_1312)).toBe(true);
    expect(inSession(plan, NOV4_1951)).toBe(false);
    expect(detectedBreaks(note(), plan, 1)).toEqual([]);
    expect(detectedBreaks(note({}, { market: "SOL" }), plan, 5)).toEqual([
      "offPlanMarket",
      "pastMaxTrades",
    ]);
    expect(detectedBreaks(note({ playbookId: undefined }), undefined, 1)).toEqual(["noPlaybook"]);
  });

  it("handles a session past midnight", () => {
    const plan = {
      ...newPlan(),
      sessions: { days: Array(7).fill(true), start: "22:00", end: "02:00" },
    };
    expect(inSession(plan, Date.UTC(2026, 10, 4, 23))).toBe(true);
    expect(inSession(plan, Date.UTC(2026, 10, 4, 1))).toBe(true);
    expect(inSession(plan, Date.UTC(2026, 10, 4, 12))).toBe(false);
  });
});

describe("reading records back", () => {
  it("fills in what a record lacks and drops what doesn't fit", () => {
    const plan = normalizePlan({
      riskPct: "lots",
      markets: ["BTC", 3],
      sessions: { start: "25:00" },
    });
    expect(plan.riskPct).toBe(0.5);
    expect(plan.markets).toEqual(["BTC"]);
    expect(plan.sessions.start).toBe("12:00");
    const day = normalizeDay({
      checkin: { moods: ["calm", "nope"], sleep: 30 },
      markets: { BTC: { bias: "up" } },
    });
    expect(day.checkin.moods).toEqual(["calm"]);
    expect(day.checkin.sleep).toBeUndefined();
    expect(day.markets.BTC?.bias).toBe("neutral");
  });

  it("refuses a note with no trade, and keeps a whole one", () => {
    expect(normalizeNote({ notes: "x" })).toBeUndefined();
    const back = normalizeNote(JSON.parse(JSON.stringify(note({ tags: ["News"] }))));
    expect(back?.tags).toEqual(["News"]);
    expect(back?.trade.closedAt).toBe(NOV4_1951);
  });

  it("keys trades by market, side and times", () => {
    expect(tradeKey({ market: "xyz:TSLA", side: "short", openedAt: 1, time: 2 })).toBe(
      "xyz:TSLA:short:1:2",
    );
    expect(utcDay(NOV4_1951)).toBe("2026-11-04");
  });
});

describe("analytics", () => {
  const win = (at: number, extra: Partial<TradeNote> = {}) =>
    note(extra, { closedAt: at, openedAt: at - 3_600_000 });
  const loss = (at: number, extra: Partial<TradeNote> = {}) =>
    note(extra, { closedAt: at, openedAt: at - 3_600_000, pnl: -210.6, exitPrice: 81_270 });
  const day = (d: number, h = 14) => Date.UTC(2026, 10, d, h);
  const skip = { checklist: [{ id: "a", text: "news", required: true, checked: false }] };

  it("draws cumulative R marked by how each was taken", () => {
    const points = cumulativeR([
      loss(day(3)),
      win(day(2), skip),
      win(day(4), { breaks: ["outsideSession"] }),
    ]);
    expect(points.map((p) => p.kind)).toEqual(["skipped", "followed", "break"]);
    expect(points[1]?.r).toBeCloseTo(2.49 - 1, 2);
  });

  it("splits followed, skipped and no playbook", () => {
    const split = followedVsSkipped([
      win(day(2)),
      loss(day(2), skip),
      win(day(3), { playbookId: undefined }),
    ]);
    expect([split.followed.trades, split.skipped.trades, split.none.trades]).toEqual([1, 1, 1]);
    expect(split.skipped.totalR).toBeCloseTo(-1, 6);
  });

  it("puts trades in process / outcome cells", () => {
    const cells = processOutcome([
      win(day(2)),
      loss(day(2)),
      win(day(3), skip),
      loss(day(3), skip),
    ]);
    expect([
      cells.earned.trades,
      cells.goodLoss.trades,
      cells.lucky.trades,
      cells.paid.trades,
    ]).toEqual([1, 1, 1, 1]);
  });

  it("groups by entry hour", () => {
    const hours = byEntryHour([win(day(2, 14)), win(day(3, 14)), loss(day(3, 17))]);
    expect(hours.map((h) => [h.hour, h.group.trades])).toEqual([
      [13, 2],
      [16, 1],
    ]);
  });

  it("compares a playbook's last trades to all of them", () => {
    const list = [win(day(1)), win(day(2)), loss(day(3)), loss(day(4))];
    const [decay] = edgeDecay(list, 2);
    expect(decay?.change).toBeCloseTo(-1 - (2.49 * 2 - 2) / 4, 2);
  });

  it("counts the journal streak back from today", () => {
    const reviewed = { ...newDay(), review: { ...newDay().review, savedAt: 1 } };
    const days = new Map([
      ["2026-11-03", reviewed],
      ["2026-11-02", reviewed],
    ]);
    const notes = [win(day(4)), win(day(3)), win(day(2)), win(day(1))];
    const summaries = daySummaries(notes, days);
    // Today (the 4th) isn't written yet; the 3rd and 2nd are; the 1st isn't.
    expect(journalStreak(summaries, days, "2026-11-04")).toBe(2);
  });
});

describe("clearing days", () => {
  const day = "2026-11-04";
  const at = Date.parse(`${day}T15:00:00Z`);
  const days = new Map([[day, { data: { ...newDay(), clearedAt: at } }]]);

  it("hides the day's trades closed by the time it was cleared, and only those", () => {
    expect(clearedTrade(days, at - 60_000)).toBe(true);
    expect(clearedTrade(days, at)).toBe(true);
    expect(clearedTrade(days, at + 60_000)).toBe(false);
    expect(clearedTrade(days, Date.parse("2026-11-03T12:00:00Z"))).toBe(false);
  });

  it("keeps the clear across a save and load", () => {
    expect(normalizeDay(JSON.parse(JSON.stringify({ ...newDay(), clearedAt: at }))).clearedAt).toBe(
      at,
    );
  });

  it("lists a cleared day again once something is written in it", () => {
    const blank = { ...newDay(), clearedAt: at };
    expect(isBlankDay(blank)).toBe(true);
    expect(isBlankDay({ ...blank, plan: "Only longs" })).toBe(false);
    expect(isBlankDay(newDay())).toBe(false);
  });
});

describe("a watched market's levels", () => {
  it("keeps up to 12, each checked, and an unknown kind as a plain level", () => {
    const day = normalizeDay({
      markets: {
        BTC: {
          bias: "long",
          note: "",
          levels: "",
          addedAt: 1_700_000_000_000,
          levelList: [
            { kind: "support", price: "81450", note: "daily low" },
            { kind: "moon", price: "90000", note: "" },
            ...Array.from({ length: 20 }, () => ({ kind: "target", price: "1", note: "" })),
          ],
        },
      },
    });
    const btc = day.markets.BTC;
    expect(btc?.addedAt).toBe(1_700_000_000_000);
    expect(btc?.levelList).toHaveLength(12);
    expect(btc?.levelList?.[1]?.kind).toBe("level");
  });

  it("writes the one line the rest of the journal reads, leaving out levels with no price", () => {
    const label = (k: string) => k[0]?.toUpperCase() + k.slice(1);
    expect(
      levelsText(
        [
          { kind: "support", price: " 81,450 ", note: "" },
          { kind: "target", price: "84,000", note: "prior high" },
          { kind: "stop", price: " ", note: "unset" },
          { kind: "level", label: "Weekly open", price: "79,900", note: "" },
        ],
        label,
      ),
    ).toBe("Support 81,450 · Target 84,000 (prior high) · Weekly open 79,900");
  });
});

describe("market rules in a plan", () => {
  const venue = [
    { id: "BTCUSDT", quote: "USDT" },
    { id: "ETHUSDT", quote: "USDT" },
    { id: "BTCPERP", quote: "USDC" },
  ];

  it("takes in every market of its quote, and keeps markets named one by one", () => {
    expect(expandMarkets([allOf("USDT")], venue)).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(expandMarkets([ALL_MARKETS], venue)).toHaveLength(3);
    expect(expandMarkets([allOf("USDT"), "BTCPERP"], venue)).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "BTCPERP",
    ]);
    expect(expandMarkets(["ETHUSDT"], venue)).toEqual(["ETHUSDT"]);
  });

  it("knows a market is in the plan by its quote, without the venue's list", () => {
    expect(marketIn([allOf("USDT")], { venue: "bybit", market: "SOLUSDT" })).toBe(true);
    expect(marketIn([allOf("USDT")], { venue: "hyperliquid", market: "SOL" })).toBe(false);
    expect(marketIn([allOf("USDC")], { venue: "hyperliquid", market: "SOL" })).toBe(true);
    expect(marketIn([ALL_MARKETS], { venue: "aster", market: "XYZ" })).toBe(true);
    expect(marketIn(["ETHUSDT"], { venue: "bybit", market: "SOLUSDT" })).toBe(false);
  });

  it("keeps a long list whole when it's read back", () => {
    const many = Array.from({ length: 819 }, (_, i) => `M${i}USDT`);
    expect(normalizePlan({ ...newPlan(), markets: many }).markets).toHaveLength(819);
  });
});

describe("a list cut before market rules", () => {
  it("is all markets when it's exactly the old cap, all one quote, or a quote's rule", () => {
    const cut = Array.from({ length: 50 }, (_, i) => `M${i}USDT`);
    expect(normalizePlaybook({ ...newPlaybook(), markets: cut }).markets).toEqual([ALL_MARKETS]);
    const hl = Array.from({ length: 100 }, (_, i) => `C${i}`);
    expect(normalizePlan({ ...newPlan(), markets: hl }).markets).toEqual([ALL_MARKETS]);
    expect(normalizePlaybook({ ...newPlaybook(), markets: [allOf("USDT")] }).markets).toEqual([
      ALL_MARKETS,
    ]);
  });

  it("is left alone otherwise", () => {
    const some = Array.from({ length: 49 }, (_, i) => `M${i}USDT`);
    expect(normalizePlaybook({ ...newPlaybook(), markets: some }).markets).toHaveLength(49);
    const mixed = [...Array.from({ length: 49 }, (_, i) => `M${i}USDT`), "BTCPERP"];
    expect(normalizePlaybook({ ...newPlaybook(), markets: mixed }).markets).toHaveLength(50);
  });
});
