// The Portfolio page's "start over": when the trader last reset an
// account's history in this app. Closes before then aren't shown or counted
// on the page; the venue's own history is never touched. Kept per account in
// browser storage; nothing leaves the machine.

const STORAGE_PREFIX = "pd.portfolio.resetAt.";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** When `account`'s history was last reset (ms); undefined if never. */
export function loadHistoryReset(
  account: string,
  from: Storage | undefined = storage(),
): number | undefined {
  try {
    const at = Number(from?.getItem(STORAGE_PREFIX + account) ?? Number.NaN);
    return Number.isFinite(at) && at > 0 ? at : undefined;
  } catch {
    return undefined;
  }
}

/** Resets `account`'s history at `at`, or with undefined shows all of it again. */
export function saveHistoryReset(
  account: string,
  at: number | undefined,
  to: Storage | undefined = storage(),
) {
  try {
    if (at === undefined) to?.removeItem(STORAGE_PREFIX + account);
    else to?.setItem(STORAGE_PREFIX + account, String(at));
  } catch {
    // Storage full or blocked: the reset lasts this session only.
  }
}

/** The closes after a reset at `resetAt`; all of them without one. */
export function sinceReset<T extends { time: number }>(
  trades: readonly T[],
  resetAt?: number,
): T[] {
  return resetAt === undefined ? [...trades] : trades.filter((c) => c.time > resetAt);
}
