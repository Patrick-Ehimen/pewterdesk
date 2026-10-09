import { describe, expect, it } from "vitest";
import { hotkeyFor, type KeyPress, keyLabel, pageRows, plainKey } from "../src/lib/hotkeys";
import { MENU_PAGES } from "../src/lib/pages";

const press = (key: string, held: Partial<KeyPress> = {}): KeyPress => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...held,
});

describe("hotkeys", () => {
  it("reads the app-wide shortcuts, Cmd or Ctrl alike", () => {
    expect(hotkeyFor(press("k", { metaKey: true }), false)).toEqual({ type: "palette" });
    expect(hotkeyFor(press("K", { ctrlKey: true }), false)).toEqual({ type: "palette" });
    expect(hotkeyFor(press(",", { metaKey: true }), false)).toEqual({ type: "settings" });
    expect(hotkeyFor(press("[", { metaKey: true }), false)).toEqual({ type: "back" });
    expect(hotkeyFor(press("]", { ctrlKey: true }), false)).toEqual({ type: "forward" });
    expect(hotkeyFor(press("ArrowLeft", { metaKey: true }), false)).toEqual({ type: "back" });
    expect(hotkeyFor(press("ArrowRight", { ctrlKey: true }), false)).toEqual({ type: "forward" });
    // Alt with an arrow is left to the system.
    expect(hotkeyFor(press("ArrowLeft", { altKey: true }), false)).toBeUndefined();
    expect(hotkeyFor(press("?", { shiftKey: true }), false)).toEqual({ type: "help" });
    expect(hotkeyFor(press("q"), false)).toEqual({ type: "quickTrade" });
    // Not shortcuts: another modifier with it, or an unbound key.
    expect(hotkeyFor(press("k", { metaKey: true, shiftKey: true }), false)).toBeUndefined();
    expect(hotkeyFor(press("k"), false)).toBeUndefined();
    expect(hotkeyFor(press("x", { metaKey: true }), false)).toBeUndefined();
  });

  it("goes to the menu's pages by number", () => {
    expect(hotkeyFor(press("1", { metaKey: true }), false)).toEqual({
      type: "page",
      page: MENU_PAGES[0],
    });
    const last = MENU_PAGES.length;
    expect(hotkeyFor(press(String(last), { ctrlKey: true }), false)).toEqual({
      type: "page",
      page: MENU_PAGES[last - 1],
    });
    // No page that far down the menu.
    expect(hotkeyFor(press("9", { metaKey: true }), false)).toBeUndefined();
    expect(pageRows().map((r) => r.page)).toEqual(MENU_PAGES);
    expect(pageRows()[0]?.keys).toEqual(["mod", "1"]);
  });

  it("leaves plain keys alone while typing, but not the Cmd ones", () => {
    expect(hotkeyFor(press("q"), true)).toBeUndefined();
    expect(hotkeyFor(press("?", { shiftKey: true }), true)).toBeUndefined();
    // Cmd with an arrow moves the caret in a field; the brackets still work there.
    expect(hotkeyFor(press("ArrowLeft", { metaKey: true }), true)).toBeUndefined();
    expect(hotkeyFor(press("[", { metaKey: true }), true)).toEqual({ type: "back" });
    expect(hotkeyFor(press("k", { metaKey: true }), true)).toEqual({ type: "palette" });
    expect(plainKey(press("V"), false)).toBe("v");
    expect(plainKey(press("v"), true)).toBeUndefined();
    expect(plainKey(press("v", { metaKey: true }), false)).toBeUndefined();
  });

  it("names keys for the machine", () => {
    expect(keyLabel("mod", true)).toBe("⌘");
    expect(keyLabel("mod", false)).toBe("Ctrl");
    expect(keyLabel("Alt", true)).toBe("⌥");
    expect(keyLabel("K", true)).toBe("K");
  });
});
