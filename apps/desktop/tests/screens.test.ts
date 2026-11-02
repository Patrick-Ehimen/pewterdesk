import { SCREEN_PRESETS, type Screen } from "@pewterdesk/ui";
import { describe, expect, it } from "vitest";
import { keepCurrent, keepSaved, loadCurrent, loadSaved, MAX_SAVED } from "../src/lib/screens";

const memory = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

const mine: Screen = {
  id: "s1",
  name: "Mine",
  columns: ["price", "rsi1h"],
  filters: [{ column: "rsi1h", op: "below", value: 30 }],
  sort: { column: "rsi1h", desc: false },
  scope: "all",
};

describe("screen storage", () => {
  it("keeps saved screens and the current one", () => {
    const store = memory();
    keepSaved([mine], store);
    keepCurrent(mine, store);
    expect(loadSaved(store)).toEqual([mine]);
    expect(loadCurrent(store)).toEqual(mine);
  });

  it("starts on the first preset, with nothing saved", () => {
    const store = memory();
    expect(loadCurrent(store)).toEqual(SCREEN_PRESETS[0]);
    expect(loadSaved(store)).toEqual([]);
  });

  it("survives a corrupt store, and keeps at most its limit", () => {
    const store = memory();
    store.setItem("pd.screens", "{nope");
    expect(loadSaved(store)).toEqual([]);
    keepSaved(
      Array.from({ length: MAX_SAVED + 5 }, (_, i) => ({ ...mine, id: `s${i}` })),
      store,
    );
    expect(loadSaved(store)).toHaveLength(MAX_SAVED);
  });
});
