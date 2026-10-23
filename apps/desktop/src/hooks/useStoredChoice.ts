import { useEffect, useState } from "react";

/**
 * The choices made while the app runs, by key. Read before browser storage,
 * so a choice holds when its page comes back even if storage couldn't keep
 * it (the market caches fill it); storage carries it across restarts.
 */
const remembered = new Map<string, string>();

/**
 * A small UI preference kept in browser storage, e.g. a view mode. Only
 * values in `allowed` are read back; anything else falls back.
 */
export function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    const read = (saved: string | null | undefined) => allowed.find((a) => a === saved);
    try {
      return read(remembered.get(key)) ?? read(localStorage.getItem(key)) ?? fallback;
    } catch {
      return read(remembered.get(key)) ?? fallback;
    }
  });
  useEffect(() => {
    remembered.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage unavailable or full: it holds for this session, not a restart.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
