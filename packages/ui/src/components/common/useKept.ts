import { type Dispatch, type SetStateAction, useCallback, useState } from "react";

// What a form holds, kept for the session outside the component: a page
// switch unmounts the Trade page, and what was typed in its ticket and
// calculator should be there on coming back. In memory only, so a reload
// starts fresh - nothing typed is written to storage.

const kept = new Map<string, unknown>();

/**
 * `useState`, but the value outlives the component: the next one mounted
 * with the same `key` starts from it. For a form's fields, until the page
 * is reloaded.
 */
export function useKept<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : initial));
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setValue((prev) => {
        const value = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        kept.set(key, value);
        return value;
      }),
    [key],
  );
  return [value, set];
}

/** Forgets every kept value: for tests. */
export function forgetKept() {
  kept.clear();
}
