/** The app's pages, switched from the header's page menu. */
export const PAGES = [
  "trade",
  "charts",
  "maps",
  "screener",
  "portfolio",
  "rules",
  "venues",
  "news",
  "ai",
  "plan",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];

/**
 * The pages the header's menu lists: Settings has its own button in the
 * header, and Portfolio opens from the account's picture.
 */
export const MENU_PAGES: readonly Page[] = PAGES.filter(
  (page) => page !== "settings" && page !== "portfolio",
);

/**
 * The pages Cmd+1 to Cmd+9 open, in their order from before Portfolio left
 * the menu, so the shortcuts stay where hands know them.
 */
export const SHORTCUT_PAGES: readonly Page[] = PAGES.filter((page) => page !== "settings");
