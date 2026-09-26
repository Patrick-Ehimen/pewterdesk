import { useEffect, useState } from "react";

/**
 * A small UI preference kept in browser storage, e.g. a view mode. Only
 * values in `allowed` are read back; anything else falls back.
 */
export function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return allowed.find((a) => a === saved) ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage unavailable; the choice just won't survive a restart.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
