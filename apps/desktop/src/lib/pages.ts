/** The app's pages, switched from the header's page menu. */
export const PAGES = [
  "trade",
  "charts",
  "maps",
  "portfolio",
  "rules",
  "venues",
  "news",
  "ai",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];

/** The pages the header's menu lists: Settings has its own button in the header. */
export const MENU_PAGES: readonly Page[] = PAGES.filter((page) => page !== "settings");
