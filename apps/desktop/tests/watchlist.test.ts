import { describe, expect, it } from "vitest";
import { parseWatchlist, watchKey } from "../src/hooks/useWatchlist";

describe("parseWatchlist", () => {
  it("reads a stored list", () => {
    expect(parseWatchlist('["hyperliquid:BTC","hyperliquid:HYPE"]')).toEqual([
      "hyperliquid:BTC",
      "hyperliquid:HYPE",
    ]);
  });

  it("drops duplicates, non-strings and junk", () => {
    const long = "x".repeat(200);
    expect(parseWatchlist(JSON.stringify(["a:B", "a:B", 3, null, "", long]))).toEqual(["a:B"]);
  });

  it("falls back to empty for anything that isn't a list", () => {
    expect(parseWatchlist(null)).toEqual([]);
    expect(parseWatchlist("not json")).toEqual([]);
    expect(parseWatchlist('{"BTC":true}')).toEqual([]);
  });
});

describe("watchKey", () => {
  it("keeps the same symbol on different venues apart", () => {
    expect(watchKey("hyperliquid", "BTC")).not.toBe(watchKey("drift", "BTC"));
  });
});
