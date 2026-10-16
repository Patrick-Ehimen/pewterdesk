import { describe, expect, it } from "vitest";
import { parseSaved, type SavedMapView, withoutSaved, withSaved } from "../src/lib/mapViews";

const view = (id: string, name: string, extra: Partial<SavedMapView> = {}): SavedMapView => ({
  id,
  name,
  view: "funding",
  settings: { fundingUnit: "apr" },
  ...extra,
});

describe("saved map views", () => {
  it("reads back what was stored, dropping what's malformed", () => {
    const raw = JSON.stringify([
      view("a", "  Funding   gaps "),
      { id: "b", view: "oi" },
      {
        id: "c",
        name: "Book",
        view: "book",
        settings: { bookSpan: "1", bad: 3 },
        market: "BTC",
        venue: "hyperliquid",
      },
      view("a", "Duplicate id"),
      "nonsense",
    ]);
    const list = parseSaved(raw);
    expect(list.map((v) => v.name)).toEqual(["Funding gaps", "Book"]);
    expect(list[1]?.settings).toEqual({ bookSpan: "1" });
    expect(list[1]?.market).toBe("BTC");
    expect(parseSaved("{")).toEqual([]);
    expect(parseSaved(null)).toEqual([]);
  });

  it("replaces a view of the same name and keeps its id", () => {
    let list = withSaved([], view("a", "Gaps"));
    list = withSaved(list, view("b", "gaps", { settings: { fundingUnit: "8h" } }));
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("a");
    expect(list[0]?.settings.fundingUnit).toBe("8h");
    list = withSaved(list, view("c", "Other"));
    expect(list.map((v) => v.id)).toEqual(["a", "c"]);
    expect(withSaved(list, view("d", "   "))).toEqual(list);
    expect(withoutSaved(list, "a").map((v) => v.id)).toEqual(["c"]);
  });

  it("stops at 30", () => {
    let list: SavedMapView[] = [];
    for (let i = 0; i < 35; i++) list = withSaved(list, view(String(i), `View ${i}`));
    expect(list).toHaveLength(30);
  });
});
