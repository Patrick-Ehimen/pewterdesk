import { describe, expect, it } from "vitest";
import {
  byCloseness,
  distinctColors,
  ENTRY_NOW,
  type Idea,
  type IdeaLevel,
  matches,
  nearest,
  newIdea,
  nextColor,
  oddsTotal,
  pricesIn,
  restoreIdea,
  rewardRisk,
} from "./ideas";

const level = (price: number, color: number, name = ""): IdeaLevel => ({
  id: `l${price}`,
  name,
  price,
  color,
});

const idea = (over: Partial<Idea> = {}): Idea => ({
  ...newIdea("a", "hyperliquid", "SOL", "SOL-USDC", 180),
  levels: [level(210, 0, "Weekly high"), level(188, 1, "Supply"), level(172, 2, "Support")],
  ...over,
});

describe("restoreIdea", () => {
  it("keeps what reads and drops what doesn't", () => {
    const back = restoreIdea("id", {
      venue: "bybit",
      market: "SOLUSDT",
      bias: "sideways",
      conviction: 9,
      levels: [{ name: "Supply", price: 200, color: 3 }, { price: -1 }, { price: "x" }],
      thoughts: [
        { at: 1, text: "  " },
        { at: 2, text: "held" },
      ],
      shots: ["u/a.png", 3],
    });
    expect(back).toMatchObject({ venue: "bybit", bias: "bullish", conviction: 5 });
    expect(back?.levels).toEqual([
      { id: expect.any(String), name: "Supply", price: 200, color: 3 },
    ]);
    expect(back?.thoughts.map((t) => t.text)).toEqual(["held"]);
    expect(back?.shots).toEqual(["u/a.png"]);
  });

  it("names a level from before names by its note, else its old kind, and gives it a colour", () => {
    const back = restoreIdea("id", {
      venue: "bybit",
      market: "SOLUSDT",
      levels: [
        { kind: "target", note: "Weekly high", price: 210 },
        { kind: "invalidation", note: "", price: 170 },
      ],
    });
    expect(back?.levels.map((l) => [l.name, l.color])).toEqual([
      ["Weekly high", 0],
      ["Invalidation", 1],
    ]);
  });

  it("refuses an idea with no market", () => {
    expect(restoreIdea("id", { venue: "bybit" })).toBeUndefined();
    expect(restoreIdea("id", { venue: "nowhere", market: "X" })).toBeUndefined();
  });
});

describe("colours", () => {
  it("gives a new level the first colour no level has", () => {
    expect(nextColor([level(1, 0), level(2, 2)])).toBe(1);
    expect(nextColor([])).toBe(0);
  });
  it("never lets two levels share one", () => {
    const fixed = distinctColors([level(1, 4), level(2, 4), level(3, 99)]);
    const colors = fixed.map((l) => l.color);
    expect(colors[0]).toBe(4);
    expect(new Set(colors).size).toBe(3);
  });
});

describe("nearest and byCloseness", () => {
  it("finds the level closest to the price", () => {
    const near = nearest(idea(), 185);
    expect(near?.level.name).toBe("Supply");
    expect(near?.share).toBeCloseTo(3 / 185);
    expect(nearest(idea(), undefined)).toBeUndefined();
    expect(nearest(idea({ levels: [] }), 180)).toBeUndefined();
  });
  it("puts the idea nearest one of its levels first", () => {
    const far = idea({ id: "far" });
    const near = idea({ id: "near" });
    const sorted = byCloseness([far, near], (i) => (i.id === "near" ? 187.5 : 150));
    expect(sorted.map((i) => i.id)).toEqual(["near", "far"]);
  });
});

describe("matches and pricesIn", () => {
  it("searches the market, thesis and tags", () => {
    expect(matches(idea({ tags: ["breakout"] }), "break")).toBe(true);
    expect(matches(idea(), "doge")).toBe(false);
  });
  it("finds the prices a thesis names", () => {
    expect(pricesIn("range under 187.77, weekly high 201.5 and 97,840")).toEqual([
      187.77, 201.5, 97840,
    ]);
  });
});

describe("rewardRisk", () => {
  const levels = [level(210, 0, "Target"), level(188, 1, "Entry"), level(172, 2, "Stop")];
  it("reads the target's distance from the entry over the stop's", () => {
    const rr = rewardRisk({ levels, risk: { entry: "l188", stop: "l172", target: "l210" } }, 180);
    // 22 up against 16 down.
    expect(rr?.ratio).toBeCloseTo(22 / 16);
    expect(rr?.reward).toBeCloseTo(22 / 188);
  });
  it("can be measured from the price now", () => {
    const rr = rewardRisk(
      { levels, risk: { entry: ENTRY_NOW, stop: "l172", target: "l210" } },
      180,
    );
    expect(rr?.ratio).toBeCloseTo(30 / 8);
    expect(
      rewardRisk({ levels, risk: { entry: ENTRY_NOW, stop: "l172", target: "l210" } }, undefined),
    ).toBeUndefined();
  });
  it("needs all three, on either side of the entry", () => {
    expect(rewardRisk({ levels, risk: { entry: "l188", target: "l210" } }, 180)).toBeUndefined();
    // Target and stop both above: no trade reads that way.
    expect(
      rewardRisk({ levels, risk: { entry: "l172", stop: "l188", target: "l210" } }, 180),
    ).toBeUndefined();
  });
  it("forgets a pick whose level is gone", () => {
    const back = restoreIdea("id", {
      venue: "bybit",
      market: "SOLUSDT",
      levels: [{ id: "a", name: "Stop", price: 170 }],
      risk: { entry: "now", stop: "a", target: "gone" },
    });
    expect(back?.risk).toEqual({ entry: "now", stop: "a" });
  });
});

describe("scenarios", () => {
  it("keeps titled ones, odds between 0 and 100, and adds them up", () => {
    const back = restoreIdea("id", {
      venue: "bybit",
      market: "SOLUSDT",
      scenarios: [
        { title: "Breaks and holds", odds: 55, text: "to T1" },
        { title: "Fake-out", odds: 140 },
        { title: "  ", odds: 10 },
      ],
    });
    expect(back?.scenarios.map((sc) => [sc.title, sc.odds])).toEqual([
      ["Breaks and holds", 55],
      ["Fake-out", 100],
    ]);
    expect(oddsTotal(back?.scenarios ?? [])).toBe(155);
  });
});
