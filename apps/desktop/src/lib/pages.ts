/** The app's pages, switched from the header's page menu. */
export const PAGES = [
  "trade",
  "portfolio",
  "venues",
  "journal",
  "news",
  "maps",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];
