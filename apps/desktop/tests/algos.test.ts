import type { AlgoView, Market } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  chaserSpec,
  defaultSlices,
  formatDuration,
  parseDuration,
  previewSlices,
  progressOf,
  runsOnVenue,
  scaledSpec,
  slippageOf,
  sortAlgos,
  specProblem,
  timeLeft,
  twapSpec,
  withAlgo,
} from "../src/lib/algos";

const market: Market = {
  venue: "hyperliquid",
  id: "ETH",
  symbol: "ETH-USDC",
  base: "ETH",
  quote: "USDC",
  tickSize: "0.1",
  sizeStep: "0.01",
  minSize: "0.01",
  maxLeverage: 25,
};
const target = { venue: "hyperliquid" as const, account: "0xabc", maxSlippageBps: 500 };

const view = (over: Partial<AlgoView>): AlgoView => ({
  id: "a",
  spec: twapSpec({ side: "buy", market, size: "1", durationMs: 600_000 }, target),
  origin: "app",
  status: "running",
  runsOn: "local",
  filled: "0",
  openOrders: 0,
  startedAt: 1000,
  updatedAt: 1000,
  ...over,
});

describe("algo specs", () => {
  it("reads and writes durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("30")).toBeUndefined();
    expect(parseDuration("m")).toBeUndefined();
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("says where a TWAP runs, as the engine decides", () => {
    const twap = (durationMs: number, extra = {}) =>
      twapSpec({ side: "buy", market, size: "1", durationMs, ...extra }, target);
    expect(runsOnVenue(twap(3_600_000))).toBe(true);
    expect(runsOnVenue(twap(3_600_000, { native: false }))).toBe(false);
    expect(runsOnVenue(twap(3_600_000, { style: "chaser" }))).toBe(false);
    expect(runsOnVenue(twap(60_000))).toBe(false);
    expect(
      runsOnVenue(
        twapSpec(
          { side: "buy", market, size: "1", durationMs: 3_600_000 },
          { ...target, venue: "bybit" },
        ),
      ),
    ).toBe(false);
    expect(runsOnVenue(chaserSpec({ side: "buy", market, size: "1" }, target))).toBe(false);
  });

  it("builds each kind with the venue's bound and sensible defaults", () => {
    const chaser = chaserSpec({ side: "sell", market, size: "1", giveUpPct: 0.5 }, target);
    expect(chaser).toMatchObject({
      kind: "chaser",
      postOnly: true,
      giveUpBps: 50,
      maxSlippageBps: 500,
    });
    const twap = twapSpec({ side: "buy", market, size: "1", durationMs: 1_800_000 }, target);
    expect(twap).toMatchObject({ kind: "twap", slices: 30, style: "market", unfilled: "market" });
    expect(defaultSlices(10_000)).toBe(2);
    expect(defaultSlices(10 * 3_600_000)).toBe(60);
    const ladder = scaledSpec(
      { side: "buy", market, size: "1", from: "100", to: "95", count: 5 },
      target,
    );
    expect(ladder).toMatchObject({ kind: "scaled", distribution: "flat", count: 5 });
  });

  it("finds what's wrong before anything is sent", () => {
    const local = (size: string, slices: number) =>
      twapSpec({ side: "buy", market, size, durationMs: 60_000, slices }, target);
    expect(specProblem(local("1", 10), market)).toBeUndefined();
    expect(specProblem(local("0.05", 10), market)).toBe("sliceSize");
    expect(specProblem(local("0", 10), market)).toBe("size");
    expect(previewSlices(local("1", 3), market)).toEqual([0.33, 0.33, 0.34]);
  });
});

describe("algo views", () => {
  it("reads progress, time left and slippage", () => {
    const v = view({ filled: "0.25", endsAt: 61_000, startPrice: "100", avgPrice: "101" });
    expect(progressOf(v)).toBe(0.25);
    expect(timeLeft(v, 31_000)).toBe(30_000);
    expect(slippageOf(v)).toBeCloseTo(100);
    // On a sell, getting less is the worse way.
    const sell = view({
      spec: { ...v.spec, side: "sell" },
      startPrice: "100",
      avgPrice: "101",
    });
    expect(slippageOf(sell)).toBeCloseTo(-100);
  });

  it("lists live algos first, and replaces one by id", () => {
    const done = view({ id: "done", status: "finished", updatedAt: 5000 });
    const live = view({ id: "live", startedAt: 2000 });
    expect(sortAlgos([done, live]).map((v) => v.id)).toEqual(["live", "done"]);
    const moved = withAlgo([done, live], { ...live, filled: "0.5" });
    expect(moved).toHaveLength(2);
    expect(moved[0]?.filled).toBe("0.5");
  });
});
