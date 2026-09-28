import { describe, expect, it } from "vitest";
import { isReloadKey } from "../src/lib/reload";

const press = (key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
});

describe("isReloadKey", () => {
  it("takes Ctrl+R and F5 off macOS", () => {
    expect(isReloadKey(press("r", { ctrl: true }), false)).toBe(true);
    expect(isReloadKey(press("R", { ctrl: true }), false)).toBe(true);
    expect(isReloadKey(press("F5"), false)).toBe(true);
  });

  it("ignores other keys and modifier combinations", () => {
    expect(isReloadKey(press("r"), false)).toBe(false);
    expect(isReloadKey(press("t", { ctrl: true }), false)).toBe(false);
    expect(isReloadKey(press("r", { ctrl: true, alt: true }), false)).toBe(false);
    expect(isReloadKey(press("F5", { ctrl: true }), false)).toBe(false);
  });

  it("leaves macOS to the View menu", () => {
    expect(isReloadKey(press("r", { meta: true }), true)).toBe(false);
    expect(isReloadKey(press("r", { ctrl: true }), true)).toBe(false);
    expect(isReloadKey(press("F5"), true)).toBe(false);
  });
});
