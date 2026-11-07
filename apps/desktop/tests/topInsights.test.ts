import { describe, expect, it } from "vitest";
import type { TraderHolding, TraderSwept } from "../src/api/venueClient";
import { avatarHue } from "../src/components/traders/TraderAvatar";
import { shortShare, topInsights } from "../src/lib/topInsights";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const h = (
  market: string,
  side: "long" | "short",
  value: number,
  openedAt: number | null = null,
): TraderHolding => ({
  market,
  side,
  size: value / 100,
  entry: 100,
  mark: 100,
  value,
  leverage: 5,
  unrealized: 0,
  liquidation: null,
  openedAt,
});

const swept = (
  id: string,
  holdings: TraderHolding[],
  newSince: TraderSwept["newSince"] = [],
  source: TraderSwept["source"] = "hyperliquid",
): TraderSwept => ({ source, id, holdings, at: NOW, newSince, stats: null });

describe("the leaderboard's insight cards", () => {
  it("weighs BTC by value, and ranks markets by how many hold them", () => {
    const all = [
      swept("a", [h("BTC", "short", 900), h("ETH", "long", 50)]),
      swept("b", [h("BTC", "long", 300), h("ETH", "short", 10)]),
      swept("c", [h("BTC", "short", 100), h("SOL", "long", 5)]),
    ];
    const out = topInsights(all, NOW);
    expect(out.read).toBe(3);
    expect(out.btc).toMatchObject({ long: 1, short: 2, longValue: 300, shortValue: 1000 });
    expect(shortShare(out.btc!)).toBeCloseTo(1000 / 1300);
    expect(out.mostHeld.map((a) => a.market)).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("finds the biggest position opened in the last hour, and only then", () => {
    const all = [
      // Hyperliquid: a first sighting 20 minutes ago, and an old one.
      swept(
        "a",
        [h("ETH", "long", 1_020_000), h("BTC", "short", 5_000_000)],
        [
          ["ETH", "long", NOW - 20 * MIN],
          ["BTC", "short", NOW - 90 * MIN],
        ],
      ),
      // OKX: opening times of its own, two sub-positions of one market added up.
      swept(
        "B9F25A5FBE6CFF912",
        [h("SOL", "short", 400_000, NOW - 5 * MIN), h("SOL", "short", 300_000, NOW - 50 * MIN)],
        [],
        "okx",
      ),
    ];
    const out = topInsights(all, NOW);
    expect(out.biggestNew).toMatchObject({
      key: "hyperliquid:a",
      market: "ETH",
      side: "long",
      value: 1_020_000,
    });
    // Without the ETH, the OKX trader's SOL (both sub-positions) is the biggest.
    const rest = topInsights([swept("a", [h("ETH", "long", 1)]), all[1] as TraderSwept], NOW);
    expect(rest.biggestNew).toMatchObject({ key: "okx:B9F25A5FBE6CFF912", value: 700_000 });
    // Nothing in the last hour: nothing new.
    expect(topInsights([swept("x", [h("BTC", "long", 1)])], NOW).biggestNew).toBeUndefined();
  });

  it("has nothing to say about BTC when no one holds it", () => {
    const out = topInsights([swept("a", [h("ETH", "long", 1)])], NOW);
    expect(out.btc).toBeUndefined();
    expect(topInsights([], NOW)).toEqual({
      read: 0,
      btc: undefined,
      mostHeld: [],
      biggestNew: undefined,
    });
  });
});

describe("avatar hues", () => {
  it("come from the tag palette (never green, red or orange) and stay the same per trader", () => {
    const palette = [205, 235, 265, 295, 325, 355, 95, 185];
    for (const key of ["hyperliquid:0xabc", "okx:9F25A5FBE6CFF912", "x"]) {
      expect(palette).toContain(avatarHue(key));
      expect(avatarHue(key)).toBe(avatarHue(key));
    }
  });
});
