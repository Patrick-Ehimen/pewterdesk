import { beforeAll, describe, expect, it } from "vitest";
import { tradePlan } from "../../../../../packages/ui/src/lib/openAlgoChart";
import { ENTRY_NOW, type Idea, newIdea } from "../../lib/ideas";
import { ideaAnalysis } from "./parts";

// The colours read the page's theme; without a page, a stand-in with none set.
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { documentElement: {} };
  g.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
});

const level = (id: string, price: number) => ({ id, name: id, price, color: 0, alert: true });

function idea(entry: string): Idea {
  return {
    ...newIdea("a", "bybit", "IPUSDT", "IP-USDT", 4),
    levels: [level("target", 5), level("entry", 4.2), level("stop", 3.8)],
    risk: { entry, stop: "stop", target: "target" },
  };
}

describe("ideaAnalysis", () => {
  it("gives the chart a trade box for an entry at a level", () => {
    expect(tradePlan(ideaAnalysis(idea("entry")).levels)?.side).toBe("long");
  });

  it("gives it one for an entry at the price now too", () => {
    const plan = tradePlan(ideaAnalysis(idea(ENTRY_NOW), 4.1).levels);
    expect(plan).toMatchObject({ side: "long", entry: 4.1, stop: 3.8 });
    // Without a price yet there's no entry to draw from.
    expect(tradePlan(ideaAnalysis(idea(ENTRY_NOW)).levels)).toBeUndefined();
  });

  it("draws a short the other way round", () => {
    const short: Idea = {
      ...idea("entry"),
      levels: [level("stop", 4.6), level("entry", 4.2), level("target", 3.5)],
    };
    expect(tradePlan(ideaAnalysis(short).levels)?.side).toBe("short");
  });
});
