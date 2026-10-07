import { describe, expect, it } from "vitest";
import { rsiNowAndBefore, rsiZone } from "../src/lib/marketMaps";

describe("market maps", () => {
  it("puts RSI into coinglass's bands", () => {
    expect([75, 70, 65, 50, 40, 35, 30, 12].map(rsiZone)).toEqual([
      "overbought",
      "overbought",
      "strong",
      "neutral",
      "weak",
      "weak",
      "oversold",
      "oversold",
    ]);
  });

  it("reads RSI now and one candle earlier", () => {
    const rising = Array.from({ length: 50 }, (_, i) => 100 + i + (i % 3 === 0 ? -2 : 0));
    const out = rsiNowAndBefore(rising);
    expect(out?.value).toBeGreaterThan(50);
    expect(out?.previous).toBeGreaterThan(50);
    expect(rsiNowAndBefore([1, 2, 3])).toBeUndefined();
  });
});
