import { describe, expect, it } from "vitest";
import { watchRead } from "../src/lib/pumpWatch";

const NOW = 1_793_700_000_000;
const HOUR = 3_600_000;
const base = { now: NOW, spike: 4 };

describe("the pump / dump watch", () => {
  it("calls a heavy rise with shorts paying a squeeze", () => {
    expect(
      watchRead({ ...base, change24h: 0.2, fundingPerHour: -0.0002, oiChange: -0.1 })?.state,
    ).toBe("squeeze");
  });

  it("tells leverage from spot buying by open interest", () => {
    expect(
      watchRead({ ...base, change24h: 0.2, fundingPerHour: 0.0001, oiChange: 0.4 })?.state,
    ).toBe("leverage");
    expect(
      watchRead({ ...base, change24h: 0.2, fundingPerHour: 0.00001, oiChange: 0 })?.state,
    ).toBe("spotLed");
    // +8% in contracts at +20% is +30% in dollars: building, but not ahead of the price.
    expect(
      watchRead({ ...base, change24h: 0.2, fundingPerHour: 0.00001, oiChange: 0.08 })?.state,
    ).toBe("pumpStarting");
  });

  it("names a heavy fall by who is closing", () => {
    expect(
      watchRead({ ...base, change24h: -0.2, fundingPerHour: 0.0002, oiChange: -0.3 })?.state,
    ).toBe("longUnwind");
    expect(
      watchRead({ ...base, change24h: -0.2, fundingPerHour: -0.0002, oiChange: 0.2 })?.state,
    ).toBe("shortPileOn");
    expect(watchRead({ ...base, change4h: -0.06 })?.state).toBe("dumpStarting");
  });

  it("needs volume: a move on usual volume isn't one to watch", () => {
    expect(
      watchRead({ now: NOW, spike: 1.2, change24h: 0.3, fundingPerHour: -0.001 }),
    ).toBeUndefined();
  });

  it("flags a week's pump rolling over as fade risk", () => {
    const read = watchRead({ now: NOW, spike: 1, change7d: 0.8, change24h: -0.07 });
    expect(read?.state).toBe("fadeRisk");
    expect(read?.side).toBe("dump");
  });

  it("flags fresh exchange news before the price moves, ranked under moves", () => {
    const listing = watchRead({ now: NOW, notice: { kind: "listing", time: NOW - 2 * HOUR } });
    expect(listing?.state).toBe("listingNews");
    expect(watchRead({ now: NOW, notice: { kind: "warning", time: NOW - HOUR } })?.state).toBe(
      "delistingNews",
    );
    expect(
      watchRead({ now: NOW, notice: { kind: "listing", time: NOW - 49 * HOUR } }),
    ).toBeUndefined();
    const move = watchRead({ ...base, change24h: 0.1 });
    expect((move?.strength ?? 0) > (listing?.strength ?? 0)).toBe(true);
  });
});
