/** The app's pages, switched from the header's page menu. */
export const PAGES = [
  "trade",
  "portfolio",
  "charts",
  "rules",
  "venues",
  "news",
  "maps",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];

/** The pages the header's menu lists: Settings has its own button in the header. */
export const MENU_PAGES: readonly Page[] = PAGES.filter((page) => page !== "settings");
