/** The app's pages, switched from the header's page menu. */
export const PAGES = [
  "trade",
  "portfolio",
  "charts",
  "venues",
  "journal",
  "news",
  "maps",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];

/**
 * The pages the header's menu lists. Settings has its own button in the
 * header, and the Journal isn't built yet; both still exist as pages.
 */
export const MENU_PAGES: readonly Page[] = PAGES.filter(
  (page) => page !== "journal" && page !== "settings",
);
