import { describe, expect, it } from "vitest";
import tokens from "../../../.claude/brand/pewterdesk-tokens.css?raw";
import boot from "../public/boot.js?raw";
import { isLightTheme, THEMES } from "../src/hooks/useAppearance";

describe("themes", () => {
  it("boot.js knows every non-default theme, so none flashes on startup", () => {
    // boot.js runs before any module loads, so it keeps its own copy of the list.
    const list = boot.match(/\[([^\]]*)\]\.includes\(theme\)/)?.[1] ?? "";
    const bootThemes = [...list.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(bootThemes.sort()).toEqual(THEMES.filter((t) => t !== "dark").sort());
  });

  it("every theme has tokens in the brand file", () => {
    for (const theme of THEMES) expect(tokens, theme).toContain(`[data-theme="${theme}"]`);
  });

  it("only the light-background themes take the light logo", () => {
    expect(THEMES.filter(isLightTheme)).toEqual(["parchment"]);
  });
});
