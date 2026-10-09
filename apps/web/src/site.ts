// What every page shares: where things live, the version, the masthead and
// the footer. The site is static and multi-page - each page has its own
// index.html (see vite.config.ts), so every URL is a real file on any host.
import desktop from "../../desktop/package.json";

export const REPO_URL = "https://github.com/Patrick-Ehimen/pewterdesk";
// The releases page rather than a file: releases are published by hand, so a
// link built from the version could point at an installer that isn't up yet.
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ADR_URL = `${REPO_URL}/blob/main/docs/adr/0001-venues-in-rust.md`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const VERSION = desktop.version;

// Vite's `base`, so the links still work if the site is served from a folder.
const base = import.meta.env.BASE_URL;

export type PageId = "home" | "features" | "security" | "download";

export const paths = {
  home: base,
  features: `${base}features/`,
  security: `${base}security/`,
  download: `${base}download/`,
  venues: `${base}#venues`,
} as const;

export function currentPage(): PageId {
  const first = window.location.pathname.slice(base.length).split("/")[0];
  return first === "features" || first === "security" || first === "download" ? first : "home";
}

export const nav: readonly { href: string; label: string; page?: PageId }[] = [
  { href: paths.features, label: "Features", page: "features" },
  { href: paths.security, label: "Security", page: "security" },
  { href: paths.venues, label: "Venues" },
  { href: paths.download, label: "Download", page: "download" },
];

export const masthead = [
  "Desktop terminal for crypto perps",
  "Open source · MIT",
  `v${VERSION} · pre-release`,
] as const;

export const ISSUES_URL = `${REPO_URL}/issues`;

// The bar across the top of every page. The project isn't finished, and no
// page should read as if it were.
export const notice = {
  label: "In development",
  text: "Pewterdesk is pre-release software. Features are still landing and things can break.",
  link: "See what works today",
  href: `${base}#status`,
};

export const footer = {
  groups: [
    {
      title: "Desk",
      links: [
        { href: paths.features, label: "Features" },
        { href: paths.security, label: "Security" },
        { href: paths.venues, label: "Venues" },
        { href: paths.download, label: "Download" },
      ],
    },
    {
      title: "Source",
      links: [
        { href: REPO_URL, label: "GitHub" },
        { href: RELEASES_URL, label: "Releases" },
        { href: LICENSE_URL, label: "MIT license" },
      ],
    },
  ],
  note: "Not affiliated with any venue listed. Trading crypto perpetuals carries risk of loss.",
};

export const closing = {
  lines: ["Run your", "own desk."],
  download: `Download v${VERSION}`,
  source: "View source",
};
