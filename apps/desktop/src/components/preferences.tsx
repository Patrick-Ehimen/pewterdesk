// Choice lists shared by the header menus and the settings page. They're
// functions, not constants, because they call `t` — which must run after the
// interface language has loaded.

import { type Locale, languageName, type MenuOption, type RowMode, t } from "@pewterdesk/ui";
import { type MarketColors, THEMES, type Theme } from "../hooks/useAppearance";
import { LANGUAGES } from "../lib/language";
import { ThemeSwatch } from "./header/ThemeSwatch";

/** Each language in its own name, then in the current interface language. */
export const languageOptions = (): readonly MenuOption<Locale>[] =>
  LANGUAGES.map((l) => ({
    value: l.code,
    label: l.name,
    description: languageName(l.code),
    // Decorative: the language's name is the label.
    icon: <img className="pd-flag" src={l.flag} alt="" width={24} height={18} />,
  }));

/** Each theme as a live swatch, its name and one line about it. */
export const themeOptions = (): readonly MenuOption<Theme>[] =>
  THEMES.map((theme) => ({
    value: theme,
    label: t(`theme.${theme}.name`),
    description: t(`theme.${theme}.desc`),
    icon: <ThemeSwatch theme={theme} />,
  }));

export const marketColorOptions = (): readonly MenuOption<MarketColors>[] => [
  { value: "standard", label: t("colors.standard"), description: t("colors.standardDesc") },
  { value: "colorblind", label: t("colors.colorblind"), description: t("colors.colorblindDesc") },
];

export const ROW_MODES = ["table", "stacked"] as const;

export const rowModeOptions = (): readonly MenuOption<RowMode>[] => [
  { value: "table", label: t("view.table"), description: t("view.tableDesc") },
  { value: "stacked", label: t("view.stacked"), description: t("view.stackedDesc") },
];

/** Storage keys for the order book and trades views, shared by the panel and the settings page. */
export const VIEW_KEYS = { book: "pd.view.book", trades: "pd.view.trades" } as const;
