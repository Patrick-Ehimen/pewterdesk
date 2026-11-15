import { describe, expect, it } from "vitest";
import { findings, moveOf, share, trackRecord } from "./ideaStats";
import { type Idea, newIdea, withStatus } from "./ideas";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15);

function idea(over: Partial<Idea> = {}): Idea {
  return {
    ...newIdea(crypto.randomUUID(), "bybit", "SOLUSDT", "SOL-USDT", 100),
    notedAt: NOW - 5 * DAY,
    status: "playedOut",
    resolvedAt: NOW - DAY,
    resolvedPrice: 110,
    ...over,
  };
}

describe("moveOf", () => {
  it("measures the move in the idea's own direction", () => {
    expect(moveOf(idea())).toBeCloseTo(0.1);
    expect(moveOf(idea({ bias: "bearish", resolvedPrice: 90 }))).toBeCloseTo(0.1);
    expect(moveOf(idea({ bias: "range", resolvedPrice: 95 }))).toBeCloseTo(0.05);
    expect(moveOf(idea({ notedPrice: undefined }))).toBeUndefined();
  });
});

describe("withStatus", () => {
  it("notes when and where an idea left Watching, and forgets it on return", () => {
    const watching = idea({ status: "watching", resolvedAt: undefined, resolvedPrice: undefined });
    const done = withStatus(watching, "wrong", 95);
    expect(done).toMatchObject({ status: "wrong", resolvedPrice: 95 });
    expect(done.resolvedAt).toBeGreaterThan(0);
    // Moving between closed lists keeps when it closed.
    expect(withStatus(done, "archived", 120).resolvedPrice).toBe(95);
    const back = withStatus(done, "watching", 100);
    expect(back.resolvedAt).toBeUndefined();
    expect(back.resolvedPrice).toBeUndefined();
  });
});

describe("trackRecord", () => {
  const ideas = [
    idea({ conviction: 4 }),
    idea({ status: "wrong", resolvedPrice: 94, conviction: 4 }),
    idea({ status: "archived", resolvedPrice: 100 }),
    idea({ status: "watching", resolvedAt: undefined }),
    // Closed two months ago: outside 30 days.
    idea({ resolvedAt: NOW - 60 * DAY, notedAt: NOW - 70 * DAY }),
  ];

  it("grades only played out and wrong, in the period", () => {
    const r = trackRecord(ideas, "30d", NOW);
    expect([r.playedOut, r.wrong, r.letGo, r.watching]).toEqual([1, 1, 1, 1]);
    expect(r.closed).toHaveLength(3);
    expect(share(r.byBias.bullish)).toBeCloseTo(0.5);
    expect(r.byConviction[3]).toEqual({ graded: 2, playedOut: 1 });
    expect(r.avgWin).toBeCloseTo(0.1);
    expect(r.avgLoss).toBeCloseTo(-0.06);
    expect(r.medianHeld).toBe(4 * DAY);
    expect(trackRecord(ideas, "all", NOW).playedOut).toBe(2);
  });

  it("says which bias does worst once there's enough to say", () => {
    const many = [
      ...[1, 2, 3].map(() => idea({ bias: "bearish", status: "wrong" })),
      ...[1, 2, 3].map(() => idea({ bias: "bullish" })),
    ];
    const said = findings(trackRecord(many, "all", NOW));
    expect(said[0]).toMatchObject({ kind: "weakBias", bias: "bearish", playedOut: 0, graded: 3 });
    expect(said[1]).toMatchObject({ kind: "strongBias", bias: "bullish" });
    expect(findings(trackRecord([idea()], "all", NOW))).toEqual([]);
  });
});
