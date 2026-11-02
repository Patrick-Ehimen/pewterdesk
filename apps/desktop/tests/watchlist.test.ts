import { describe, expect, it } from "vitest";
import { parseWatchlist, starredRows, watchKey } from "../src/hooks/useWatchlist";

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
    expect(watchKey("hyperliquid", "BTC")).not.toBe(watchKey("aster", "BTC"));
  });
});

describe("starredRows", () => {
  const listed = { id: "BTCUSDT" };

  it("keeps a star whose market isn't listed, in its place", () => {
    expect(starredRows(new Set(["GONEUSDT", "BTCUSDT"]), [listed])).toEqual([
      { id: "GONEUSDT", market: undefined },
      { id: "BTCUSDT", market: listed },
    ]);
  });

  it("gives a row for every star, so the list matches its count", () => {
    const stars = new Set(["A", "B", "C"]);
    expect(starredRows(stars, [])).toHaveLength(stars.size);
  });
});
