import { describe, expect, it } from "vitest";
import { FX_CURRENCIES, monthDates, rateLine } from "../src/lib/fxRates";

const at = (year: number, month: number, day = 1) => Date.UTC(year, month - 1, day) / 1000;

describe("exchange rates", () => {
  it("offers naira", () => {
    expect(FX_CURRENCIES).toContain("NGN");
  });

  it("reads a date a month, from the exports' first", () => {
    expect(monthDates(at(2025, 1, 15), at(2025, 3, 20))).toEqual([
      "2025-01-01",
      "2025-02-01",
      "2025-03-01",
    ]);
    expect(monthDates(at(2020, 1), at(2024, 5, 2))).toEqual(["2024-04-01", "2024-05-01"]);
  });

  it("never asks for more dates than Rust takes", () => {
    expect(monthDates(at(2024, 4), at(2099, 1)).length).toBeLessThanOrEqual(60);
  });

  it("draws a line between rates, level beyond them", () => {
    const rate = rateLine([
      { time: 200, rate: 2000 },
      { time: 100, rate: 1000 },
    ]);
    expect(rate(150)).toBe(1500);
    expect(rate(50)).toBe(1000);
    expect(rate(300)).toBe(2000);
  });
});
