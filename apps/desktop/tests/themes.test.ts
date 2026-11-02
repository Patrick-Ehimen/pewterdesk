import { describe, expect, it } from "vitest";
import tokens from "../../../.claude/brand/pewterdesk-tokens.css?raw";
import boot from "../public/boot.js?raw";
import { DEFAULT_THEME, isLightTheme, THEMES } from "../src/hooks/useAppearance";

describe("themes", () => {
  it("boot.js knows every theme but Pewter (bare :root), so none flashes on startup", () => {
    // boot.js runs before any module loads, so it keeps its own copy of the list.
    const list = boot.match(/\[([^\]]*)\]\.includes\(theme\)/)?.[1] ?? "";
    const bootThemes = [...list.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(bootThemes.sort()).toEqual(THEMES.filter((t) => t !== "dark").sort());
  });

  it("boot.js starts on the same default theme as the app", () => {
    expect(boot).toContain(`localStorage.getItem("pd.theme") ?? "${DEFAULT_THEME}"`);
    expect(THEMES[0]).toBe(DEFAULT_THEME);
  });

  it("every theme has tokens in the brand file", () => {
    for (const theme of THEMES) expect(tokens, theme).toContain(`[data-theme="${theme}"]`);
  });

  it("tells high-impact news from medium in every theme", () => {
    const colour = (theme: string, token: string) => {
      const block = tokens.split(`[data-theme="${theme}"]`)[1]?.split("}")[0] ?? "";
      const hex = new RegExp(`--pd-${token}: #([0-9a-f]{6})`).exec(block)?.[1] ?? "";
      return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    };
    for (const theme of THEMES.filter((t) => t !== "dark")) {
      const high = colour(theme, "warning");
      const medium = colour(theme, "info");
      const apart = Math.hypot(...high.map((v, i) => v - (medium[i] ?? 0)));
      expect(apart, theme).toBeGreaterThan(60);
    }
  });

  it("only the light-background themes take the light logo", () => {
    expect(THEMES.filter(isLightTheme)).toEqual(["parchment", "white"]);
  });
});
