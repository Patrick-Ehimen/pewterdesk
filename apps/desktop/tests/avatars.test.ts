import { describe, expect, it } from "vitest";
import { AVATAR_MAX_CHARS, identicon, isAvatarUrl } from "../src/lib/avatars";

describe("account pictures", () => {
  it("takes back only raster data URLs this app could have drawn", () => {
    expect(isAvatarUrl("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(isAvatarUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isAvatarUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isAvatarUrl("https://example.com/a.png")).toBe(false);
    expect(isAvatarUrl("data:image/png;base64,<script>")).toBe(false);
    expect(isAvatarUrl(null)).toBe(false);
    expect(isAvatarUrl(`data:image/png;base64,${"A".repeat(AVATAR_MAX_CHARS)}`)).toBe(false);
  });

  it("draws the same mirrored, never-blank pattern for the same id", () => {
    const ids = ["bybit:24617703", `hyperliquid:0x${"a".repeat(40)}`, "", "x"];
    for (const id of ids) {
      const grid = identicon(id);
      expect(identicon(id)).toEqual(grid);
      expect(grid).toHaveLength(5);
      for (const row of grid) {
        expect(row).toHaveLength(5);
        expect(row).toEqual([...row].reverse());
        expect(row.every((c) => c === 0 || c === 1 || c === 2)).toBe(true);
      }
      expect(grid.flat().some((c) => c > 0)).toBe(true);
    }
    expect(identicon("bybit:1")).not.toEqual(identicon("bybit:2"));
  });
});
