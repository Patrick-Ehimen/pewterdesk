import { describe, expect, it } from "vitest";
import { randomStyle, SHARE_STYLES } from "../src/lib/shareCard";

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
