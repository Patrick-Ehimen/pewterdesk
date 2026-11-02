// The chart merges a change into a drawing's settings, and a key set to
// undefined goes. So a drawing is put back by naming what it held, and
// clearing whatever it has gained since.

/** The patch that takes `now` back to `before`. */
export function revertPatch<T extends object>(before: T | undefined, now: T | undefined): T {
  const cleared = Object.fromEntries(Object.keys(now ?? {}).map((key) => [key, undefined]));
  return { ...cleared, ...before } as T;
}

/** The patch that clears every key of `now`, back to the tool's own defaults. */
export const clearPatch = <T extends object>(now: T | undefined) => revertPatch<T>(undefined, now);
