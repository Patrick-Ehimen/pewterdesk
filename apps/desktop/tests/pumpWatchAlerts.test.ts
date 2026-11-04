import { describe, expect, it } from "vitest";
import { coinTicker } from "../src/hooks/usePumpWatch";
import { setWatchAlerts, WATCH_ALERTS, watchAlerts } from "../src/lib/watchAlerts";

describe("the pump / dump watch", () => {
  it("knows a coin by its ticker on other exchanges", () => {
    expect(coinTicker("1000PEPE")).toBe("PEPE");
    expect(coinTicker("1000000MOG")).toBe("MOG");
    expect(coinTicker("10000SATS")).toBe("SATS");
    // A ticker that is a number, or starts with one, keeps it.
    expect(coinTicker("1INCH")).toBe("1INCH");
    expect(coinTicker("bmt")).toBe("BMT");
  });

  it("is off until turned on, and holds a choice without storage", () => {
    expect(watchAlerts()).toBe("off");
    setWatchAlerts("pump");
    expect(watchAlerts()).toBe("pump");
    setWatchAlerts("off");
    expect(WATCH_ALERTS).toEqual(["off", "pump", "dump", "all"]);
  });
});
