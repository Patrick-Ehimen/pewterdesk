import { describe, expect, it } from "vitest";
import { clearPatch, revertPatch } from "../src/lib/drawingRevert";

// How the chart applies a patch: merged, and an undefined key removed.
const apply = <T extends object>(now: T, patch: T) =>
  Object.fromEntries(
    Object.entries({ ...now, ...patch }).filter(([, value]) => value !== undefined),
  );

describe("revertPatch", () => {
  it("puts changed values back", () => {
    const now = { upColor: "#111111", rows: 9 };
    expect(apply(now, revertPatch({ upColor: "#222222", rows: 24 }, now))).toEqual({
      upColor: "#222222",
      rows: 24,
    });
  });

  it("clears what was set since", () => {
    const now: { rows: number; upColor?: string } = { rows: 24, upColor: "#111111" };
    expect(apply(now, revertPatch({ rows: 24 }, now))).toEqual({ rows: 24 });
  });

  it("clears everything when there was nothing before", () => {
    const now = { upColor: "#111111" };
    expect(apply(now, revertPatch(undefined, now))).toEqual({});
  });

  it("brings back what was removed since", () => {
    const now: { rows?: number } = {};
    expect(apply(now, revertPatch({ rows: 24 }, now))).toEqual({ rows: 24 });
  });
});

describe("clearPatch", () => {
  it("names every key, so each goes", () => {
    expect(clearPatch({ upColor: "#111111", opacity: 0.3 })).toEqual({
      upColor: undefined,
      opacity: undefined,
    });
    expect(clearPatch(undefined)).toEqual({});
  });
});
