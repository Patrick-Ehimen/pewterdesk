import type { Market } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import type { WireItem } from "../src/api/venueClient";
import {
  DEFAULT_WIRE_VIEW,
  MAX_ITEMS,
  marketFor,
  mergeItems,
  visibleItems,
} from "../src/lib/newsWire";

const item = (id: string, time: number, over: Partial<WireItem> = {}): WireItem => ({
  id,
  source: "tree",
  kind: "tweet",
  author: "Someone",
  handle: "someone",
  text: "hello",
  coins: [],
  time,
  flag: null,
  important: false,
  linkHost: null,
  ...over,
});

const market = (base: string): Market => ({ id: `${base}-PERP`, base }) as unknown as Market;

describe("news wire", () => {
  it("merges items once each, newest first, up to the cap", () => {
    const held = [item("a", 3), item("b", 1)];
    const merged = mergeItems(held, [item("c", 2), item("a", 3, { text: "edited" })]);
    expect(merged.map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(merged[0]?.text).toBe("edited");
    const many = Array.from({ length: MAX_ITEMS + 10 }, (_, i) => item(`x${i}`, i));
    const capped = mergeItems([], many);
    expect(capped).toHaveLength(MAX_ITEMS);
    expect(capped[0]?.id).toBe(`x${MAX_ITEMS + 9}`);
  });

  it("finds a ticker's market, scaled bases too", () => {
    const markets = [market("BTC"), market("1000PEPE"), market("kBONK")];
    expect(marketFor("btc", markets)?.base).toBe("BTC");
    expect(marketFor("PEPE", markets)?.base).toBe("1000PEPE");
    expect(marketFor("BONK", markets)?.base).toBe("kBONK");
    expect(marketFor("SOL", markets)).toBeUndefined();
  });

  it("filters by kind, source, tradable and search", () => {
    const items = [
      item("t", 4, { coins: ["BTC"] }),
      item("n", 3, { kind: "news", author: "DECRYPT", text: "ETF approved" }),
      item("p", 2, { source: "phoenix", handle: "tier10k", coins: ["SOL"] }),
    ];
    const markets = [market("BTC")];
    const ids = (view = DEFAULT_WIRE_VIEW, q = "") =>
      visibleItems(items, view, q, markets).map((i) => i.id);
    expect(ids()).toEqual(["t", "n", "p"]);
    expect(ids({ ...DEFAULT_WIRE_VIEW, kind: "news" })).toEqual(["n"]);
    expect(ids({ ...DEFAULT_WIRE_VIEW, sources: ["phoenix"] })).toEqual(["p"]);
    expect(ids({ ...DEFAULT_WIRE_VIEW, tradable: true })).toEqual(["t"]);
    expect(ids(DEFAULT_WIRE_VIEW, "etf")).toEqual(["n"]);
    expect(ids(DEFAULT_WIRE_VIEW, "TIER10K")).toEqual(["p"]);
    expect(ids(DEFAULT_WIRE_VIEW, "sol")).toEqual(["p"]);
  });
});
