import { describe, expect, it } from "vitest";
import { DEFAULT_ONBOARDING, parseOnboarding } from "../src/lib/onboarding";
import { VENUE_IDS } from "../src/lib/venues";

describe("onboarding state", () => {
  it("starts not done, with every venue, on mainnet", () => {
    expect(parseOnboarding(null)).toEqual(DEFAULT_ONBOARDING);
    expect(DEFAULT_ONBOARDING.venues).toEqual(VENUE_IDS);
  });

  it("keeps known venues in the chips' order", () => {
    const s = parseOnboarding(JSON.stringify({ done: true, venues: ["aster", "gmx", "bybit"] }));
    expect(s.done).toBe(true);
    expect(s.venues).toEqual(["bybit", "aster"]);
  });

  it("never ends up with no venues, or garbage", () => {
    expect(parseOnboarding(JSON.stringify({ venues: [] })).venues).toEqual(VENUE_IDS);
    expect(parseOnboarding("{not json")).toEqual(DEFAULT_ONBOARDING);
    expect(parseOnboarding(JSON.stringify({ network: "moon" })).network).toBe("mainnet");
  });
});
