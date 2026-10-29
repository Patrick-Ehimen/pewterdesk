import { describe, expect, it } from "vitest";
import {
  formatCardDollars,
  formatCardPercent,
  formatCardPrice,
  randomStyle,
  SHARE_STYLES,
} from "../src/lib/shareCard";

describe("share card designs", () => {
  it("picks any design at random", () => {
    expect(randomStyle(undefined, () => 0)).toBe(SHARE_STYLES[0]);
    expect(randomStyle(undefined, () => 0.99)).toBe(SHARE_STYLES.at(-1));
  });

  it("always moves to another design when asked", () => {
    for (const style of SHARE_STYLES) {
      for (const r of [0, 0.5, 0.99]) expect(randomStyle(style, () => r)).not.toBe(style);
    }
  });
});

describe("the card's figures", () => {
  it("shows prices from 1 up with two decimals", () => {
    expect(formatCardPrice("68412.5")).toBe("68,412.50");
    expect(formatCardPrice("38.20000")).toBe("38.20");
    expect(formatCardPrice(1)).toBe("1.00");
  });

  it("shows a price under 1 to its first four figures, eight decimals at most, no zeros trailing", () => {
    expect(formatCardPrice("0.54321")).toBe("0.5432");
    expect(formatCardPrice("0.00009012000")).toBe("0.00009012");
    expect(formatCardPrice("0.00009")).toBe("0.00009");
    expect(formatCardPrice("0.000000123456")).toBe("0.00000012");
  });

  it("shows P&L in dollars and returns as percentages, signed", () => {
    expect(formatCardDollars(1204.5)).toBe("+$1,204.50");
    expect(formatCardDollars(-38.2)).toBe("-$38.20");
    expect(formatCardDollars(0)).toBe("$0.00");
    expect(formatCardPercent(14.166)).toBe("+14.17%");
    expect(formatCardPercent(-3.5)).toBe("-3.50%");
  });
});
