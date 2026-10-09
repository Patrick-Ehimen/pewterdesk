import type { Page } from "./pages";

/** How many pages back the trail reaches. */
const MAX = 50;

/**
 * The pages opened this session, in order, and which of them is on screen:
 * what the back and forward shortcuts walk, like a browser's.
 */
export interface PageHistory {
  entries: readonly Page[];
  index: number;
}

export const startHistory = (page: Page): PageHistory => ({ entries: [page], index: 0 });

/**
 * `history` with `page` on screen. Opening a page drops whatever was ahead
 * and adds it; arriving by back or forward (already there) changes nothing.
 */
export function visited(history: PageHistory, page: Page): PageHistory {
  if (history.entries[history.index] === page) return history;
  const entries = [...history.entries.slice(0, history.index + 1), page].slice(-MAX);
  return { entries, index: entries.length - 1 };
}

/** The page one step back (-1) or forward (1), if there is one. */
export const stepTo = (history: PageHistory, by: -1 | 1): Page | undefined =>
  history.entries[history.index + by];

/** `history` moved one step, where there's a page that way. */
export function stepped(history: PageHistory, by: -1 | 1): PageHistory {
  return stepTo(history, by) === undefined ? history : { ...history, index: history.index + by };
}
