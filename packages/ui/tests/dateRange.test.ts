import { describe, expect, it } from "vitest";
import { fromDay, monthGrid, pickDay, toDay } from "../src/components/common/DateRangePicker";

describe("date range picker", () => {
  it("reads and writes local days", () => {
    expect(toDay(new Date(2026, 9, 5))).toBe("2026-10-05");
    expect(fromDay("2026-10-05")?.getTime()).toBe(new Date(2026, 9, 5).getTime());
    expect(fromDay("")).toBeUndefined();
  });

  it("lays a month out in whole weeks, Monday first", () => {
    // October 2026 starts on a Thursday.
    const grid = monthGrid(2026, 9);
    expect(grid.length % 7).toBe(0);
    expect(grid.slice(0, 4)).toEqual([null, null, null, "2026-10-01"]);
    expect(grid.filter(Boolean)).toHaveLength(31);
  });

  it("starts a range, then ends it either way round", () => {
    expect(pickDay("", "", "2026-10-12")).toEqual({ from: "2026-10-12", to: "" });
    expect(pickDay("2026-10-12", "", "2026-10-19")).toEqual({
      from: "2026-10-12",
      to: "2026-10-19",
    });
    expect(pickDay("2026-10-12", "", "2026-10-02")).toEqual({
      from: "2026-10-02",
      to: "2026-10-12",
    });
    // A whole range starts over.
    expect(pickDay("2026-10-12", "2026-10-19", "2026-10-15")).toEqual({
      from: "2026-10-15",
      to: "",
    });
  });
});
