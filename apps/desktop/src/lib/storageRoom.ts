// Room in the webview's storage for what matters. Its quota is about 5 MB
// per origin, and caches of public market data (logos, candles, the tray's
// last read, RSI) can fill it; once full, every write that grows it is
// refused. Those caches all come back from the venues, so they make way:
// cleared when a write that must land (the paper account) is refused, and at
// start when storage is near full. Open interest samples and liquidations
// are kept: the app collects them itself, and no venue gives them back.

/** Caches that are fetched again when missing: what makes way. */
export const REBUILDABLE = ["pd.icons.", "pd.cache.", "pd.candles.", "pd.rsi."] as const;

/** Clear the rebuildable caches above this many characters at start (the quota is ~2.5M). */
export const TRIM_AT_CHARS = 1_800_000;

type Store = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

function store(): Store | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

function keys(s: Store): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null) out.push(k);
  }
  return out;
}

/** Characters stored, keys and values. */
export function storedChars(s: Store | undefined = store()): number {
  if (!s) return 0;
  return keys(s).reduce((n, k) => n + k.length + (s.getItem(k)?.length ?? 0), 0);
}

/** Clears the rebuildable caches; returns how many characters that freed. */
export function makeRoom(s: Store | undefined = store()): number {
  if (!s) return 0;
  let freed = 0;
  for (const k of keys(s)) {
    if (!REBUILDABLE.some((p) => k.startsWith(p))) continue;
    freed += k.length + (s.getItem(k)?.length ?? 0);
    try {
      s.removeItem(k);
    } catch {
      // Nothing to do: it stays.
    }
  }
  return freed;
}

/**
 * Writes `value` and says whether it landed: if storage is full, the caches
 * make way and it's written again. A write that still fails is reported, not
 * swallowed, so nothing believes it saved what it didn't.
 */
export function writeSurely(key: string, value: string, s: Store | undefined = store()): boolean {
  if (!s) return false;
  const attempt = () => {
    try {
      s.setItem(key, value);
      return s.getItem(key) === value;
    } catch {
      return false;
    }
  };
  if (attempt()) return true;
  makeRoom(s);
  return attempt();
}

/** At start: clears the caches when storage is near full, before anything needs room. */
export function trimStorage(s: Store | undefined = store()): void {
  if (s && storedChars(s) > TRIM_AT_CHARS) makeRoom(s);
}
