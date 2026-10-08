// Feeds that failed, collected for the connection banner: each panel keeps
// a calm placeholder, and the banner above the workspace says what went
// wrong once, in words, with a way to retry. Fed by FeedView (and the few
// panels that show errors themselves).

const errors = new Map<number, string>();
let snapshot: readonly string[] = [];
let next = 1;
const listeners = new Set<() => void>();

const publish = () => {
  snapshot = [...errors.values()];
  for (const l of listeners) l();
};

/** Records a failed feed's message; call the returned function once it recovers or goes. */
export function reportFeedError(message: string): () => void {
  const id = next++;
  errors.set(id, message);
  publish();
  return () => {
    if (errors.delete(id)) publish();
  };
}

/** The current failures' messages; the same array until one changes. */
export const getFeedErrors = () => snapshot;

export function subscribeFeedErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fired by the banner's retry button; every failed feed's `useRetry` answers it. */
export const RETRY_EVENT = "pd:retry";

/** Asks every failed feed to try again now rather than at its next turn. */
export function retryNow() {
  window.dispatchEvent(new Event(RETRY_EVENT));
}

export type ErrorKind = "offline" | "unreachable" | "timeout" | "rateLimited" | "venue";

/** Most telling first: the banner names the worst thing going on. */
const PRIORITY: readonly ErrorKind[] = [
  "offline",
  "unreachable",
  "timeout",
  "rateLimited",
  "venue",
];

/** What a venue error message amounts to, from the words the Rust side uses. */
export function errorKind(message: string): ErrorKind {
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "rateLimited";
  if (/sending request|connect|dns|resolve|unreachable|network|refused|reset|tls/i.test(message)) {
    return "unreachable";
  }
  return "venue";
}

/**
 * A refusal that's the account's own state, not a fault: a venue that shows
 * nothing until the account has deposited. The panel says so where the data
 * would be; a warning that retries forever would only alarm.
 */
export const isAccountState = (message: string) => /hasn't deposited/i.test(message);

/** The failures the banner is about: every one that's a fault. */
export const faults = (messages: readonly string[]) => messages.filter((m) => !isAccountState(m));

/**
 * What the banner says, if anything: offline when the system has no
 * network, else the worst of the failed feeds, else unreachable when the
 * venue has gone quiet (`lost`) without any feed failing outright.
 */
export function bannerKind(
  messages: readonly string[],
  online: boolean,
  lost: boolean,
): ErrorKind | undefined {
  if (!online) return "offline";
  const kinds = new Set(faults(messages).map(errorKind));
  const worst = PRIORITY.find((k) => kinds.has(k));
  return worst ?? (lost ? "unreachable" : undefined);
}

/** Forgets every failure; for tests. */
export function resetFeedErrors() {
  errors.clear();
  publish();
}
