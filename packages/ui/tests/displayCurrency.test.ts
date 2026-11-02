import { afterEach, describe, expect, it } from "vitest";
import {
  formatDollars,
  formatMoney,
  formatSignedMoney,
  setDisplayCurrency,
} from "../src/lib/displayCurrency";

describe("display currency", () => {
  afterEach(() => setDisplayCurrency(undefined));

  it("leaves amounts as the venue has them by default", () => {
    expect(formatMoney(1234.5, " USDT")).toBe("1,234.50 USDT");
    expect(formatSignedMoney(5, " USDT")).toBe("+5.00 USDT");
    expect(formatSignedMoney(-5, " USDT")).toBe("-5.00 USDT");
    expect(formatDollars(-1234.5)).toBe("-$1,234.50");
    expect(formatDollars(5, true)).toBe("+$5.00");
  });

  it("converts to naira, marked as approximate", () => {
    setDisplayCurrency({ code: "NGN", rate: 1000 });
    expect(formatMoney(2.5, " USDT")).toBe("≈ ₦2,500.00");
    expect(formatSignedMoney(2.5, " USDT")).toBe("≈ +₦2,500.00");
    expect(formatSignedMoney(-2.5, " USDT")).toBe("≈ -₦2,500.00");
    expect(formatDollars(-2.5)).toBe("≈ -₦2,500.00");
  });

  it("says nothing false about a missing figure", () => {
    setDisplayCurrency({ code: "NGN", rate: 1000 });
    expect(formatMoney(Number.NaN)).toBe("-");
  });
});
