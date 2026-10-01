import { afterEach, describe, expect, it } from "vitest";
import {
  bannerKind,
  errorKind,
  getFeedErrors,
  reportFeedError,
  resetFeedErrors,
  subscribeFeedErrors,
} from "../src/lib/feedErrors";

afterEach(resetFeedErrors);

describe("feed errors", () => {
  it("collects failures until each clears", () => {
    let calls = 0;
    const stop = subscribeFeedErrors(() => calls++);
    const clearA = reportFeedError("Network error: connection timed out");
    const clearB = reportFeedError("Network error: error sending request");
    expect(getFeedErrors()).toHaveLength(2);
    const before = getFeedErrors();
    clearA();
    clearA(); // twice is harmless
    expect(getFeedErrors()).toEqual(["Network error: error sending request"]);
    expect(getFeedErrors()).not.toBe(before);
    clearB();
    expect(getFeedErrors()).toEqual([]);
    expect(calls).toBe(4);
    stop();
  });

  it("reads what kind of failure a message is", () => {
    expect(errorKind("Network error: connection timed out")).toBe("timeout");
    expect(errorKind("Network error: error sending request")).toBe("unreachable");
    expect(errorKind("HTTP 429 Too Many Requests")).toBe("rateLimited");
    expect(errorKind("Unknown market: FOO")).toBe("venue");
  });

  it("names the worst thing going on", () => {
    const timeout = "Network error: connection timed out";
    const sending = "Network error: error sending request";
    expect(bannerKind([timeout, sending], true, false)).toBe("unreachable");
    expect(bannerKind([timeout], false, false)).toBe("offline");
    expect(bannerKind([], true, true)).toBe("unreachable");
    expect(bannerKind([], true, false)).toBeUndefined();
  });
});
