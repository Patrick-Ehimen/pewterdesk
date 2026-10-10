import { MENU_PAGES, PAGES, type Page } from "./pages";

const STORAGE_KEY = "pd.tabs";
/** The key the one page used to be kept under, before there were tabs. */
const OLD_PAGE_KEY = "pd.page";
/** The most tabs open at once: two, one beside the other. */
export const MAX_TABS = 2;

/** One tab: the page it shows. */
export interface Tab {
  id: number;
  page: Page;
}

/**
 * The header's tabs: each holds a page of its own (Trade in one, Multi-chart
 * in another), and one of them is on screen. There's always at least one.
 */
export interface TabsState {
  tabs: Tab[];
  /** The `id` of the tab on screen. */
  active: number;
}

const isPage = (v: unknown): v is Page => PAGES.some((p) => p === v);

export const initialTabs = (page: Page = "trade"): TabsState => ({
  tabs: [{ id: 1, page }],
  active: 1,
});

/** The page on screen: the active tab's. */
export const activePage = (state: TabsState): Page =>
  state.tabs.find((tab) => tab.id === state.active)?.page ?? state.tabs[0]?.page ?? "trade";

/** `state` with the tab on screen showing `page`. */
export function withPage(state: TabsState, page: Page): TabsState {
  if (activePage(state) === page) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === state.active ? { ...tab, page } : tab)),
  };
}

/** `state` with `id` on screen, if it's one of the tabs. */
export function selected(state: TabsState, id: number): TabsState {
  return state.active !== id && state.tabs.some((tab) => tab.id === id)
    ? { ...state, active: id }
    : state;
}

/**
 * `state` with one more tab, on screen: on the first page of the menu that
 * no tab shows yet, so a second tab opens somewhere new. Nothing is added
 * past `MAX_TABS`.
 */
export function opened(state: TabsState): TabsState {
  if (state.tabs.length >= MAX_TABS) return state;
  const shown = new Set(state.tabs.map((tab) => tab.page));
  const page = MENU_PAGES.find((p) => !shown.has(p)) ?? "trade";
  const id = Math.max(0, ...state.tabs.map((tab) => tab.id)) + 1;
  return { tabs: [...state.tabs, { id, page }], active: id };
}

/**
 * `state` without tab `id`. The last tab stays; closing the one on screen
 * shows its neighbour (the one after, else the one before).
 */
export function closed(state: TabsState, id: number): TabsState {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at === -1 || state.tabs.length === 1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const next = tabs[Math.min(at, tabs.length - 1)];
  return { tabs, active: state.active === id && next ? next.id : state.active };
}

/** The tab `by` places along from the one on screen, wrapping round. */
export function stepped(state: TabsState, by: -1 | 1): TabsState {
  const at = state.tabs.findIndex((tab) => tab.id === state.active);
  const next = state.tabs[(at + by + state.tabs.length) % state.tabs.length];
  return next ? selected(state, next.id) : state;
}

/** Saved tabs, as far as they read; one tab on `fallback` otherwise. */
export function restoreTabs(saved: unknown, fallback: Page = "trade"): TabsState {
  const raw = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : [])
    .flatMap((tab: unknown, i): Tab[] => {
      const t = (typeof tab === "object" && tab !== null ? tab : {}) as Record<string, unknown>;
      // Numbered again in order, so ids stay one of a kind.
      return isPage(t.page) ? [{ id: i + 1, page: t.page }] : [];
    })
    .slice(0, MAX_TABS);
  if (tabs.length === 0) return initialTabs(fallback);
  const index = typeof raw.activeIndex === "number" ? raw.activeIndex : 0;
  return { tabs, active: (tabs[index] ?? tabs[0] ?? { id: 1 }).id };
}

export function loadTabs(): TabsState {
  try {
    // The page that was open before tabs existed becomes the first tab's.
    const old = localStorage.getItem(OLD_PAGE_KEY);
    return restoreTabs(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"),
      isPage(old) ? old : "trade",
    );
  } catch {
    return initialTabs();
  }
}

export function saveTabs(state: TabsState) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tabs: state.tabs.map((tab) => ({ page: tab.page })),
        activeIndex: Math.max(
          0,
          state.tabs.findIndex((tab) => tab.id === state.active),
        ),
      }),
    );
  } catch {
    // Storage unavailable; the tabs just won't survive a restart.
  }
}
