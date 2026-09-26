import { afterEach, describe, expect, it } from "vitest";
import { currentLocale, isLocale, LOCALES, loadLocale, t } from "../src/i18n";
import { en } from "../src/i18n/locales/en";

afterEach(() => loadLocale("en"));

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("t", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(t("star.add", { name: "HYPE-USD" })).toBe("Add HYPE-USD to watchlist");
    expect(t("star.add")).toBe("Add {name} to watchlist");
  });

  it("switches catalogue after loadLocale", async () => {
    await loadLocale("ja");
    expect(currentLocale()).toBe("ja");
    expect(t("col.price")).toBe("価格");
  });
});

describe("locales", () => {
  it.each(LOCALES.filter((l) => l !== "en"))("%s keeps every key and placeholder", async (code) => {
    const { messages } = await import(`../src/i18n/locales/${code}.ts`);
    for (const [key, text] of Object.entries(en)) {
      const translated: string = messages[key];
      expect(translated, key).toBeTruthy();
      expect(placeholders(translated), key).toEqual(placeholders(text));
    }
  });

  it("recognises supported codes only", () => {
    expect(isLocale("fr")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});
