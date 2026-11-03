import type { HeatCoin, HeatGroup } from "@pewterdesk/ui";
import { describe, expect, it } from "vitest";
import { trendingSectors } from "../src/lib/sectorTrends";

const coin = (symbol: string, marketCap: number, change24h: number | null): HeatCoin => ({
  symbol,
  name: symbol,
  marketCap,
  price: 1,
  volume: 1,
  change24h,
});

describe("trending sectors", () => {
  const groups: HeatGroup[] = [
    { sector: "defi", coins: [coin("uni", 300, 0.01), coin("gmx", 100, 0.0376)] },
    { sector: "memes", coins: [coin("doge", 900, -0.02), coin("pepe", 100, 0.05)] },
    { sector: "ai", coins: [coin("fet", 100, null)] },
  ];

  it("weighs a sector's change by market cap and names its best coin", () => {
    const [defi] = trendingSectors(groups, 5);
    expect(defi?.sector).toBe("defi");
    expect(defi?.change).toBeCloseTo((300 * 0.01 + 100 * 0.0376) / 400);
    expect(defi?.leader).toEqual({ symbol: "GMX", change: 0.0376 });
  });

  it("leads with the best coin the venue lists, if it lists any", () => {
    const [defi] = trendingSectors(groups, 5, (symbol) => symbol === "UNI");
    expect(defi?.leader).toEqual({ symbol: "UNI", change: 0.01 });
    const [none] = trendingSectors(groups, 5, () => false);
    expect(none?.leader.symbol).toBe("GMX");
  });

  it("ranks best first, leaves out a sector with no changes, and keeps to the count", () => {
    expect(trendingSectors(groups, 5).map((s) => s.sector)).toEqual(["defi", "memes"]);
    expect(trendingSectors(groups, 1)).toHaveLength(1);
    expect(trendingSectors([], 4)).toEqual([]);
  });
});
