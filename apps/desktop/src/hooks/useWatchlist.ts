import type { VenueId } from "@pewterdesk/core";
import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "pd.watchlist";
/** Entries are "<venue>:<market id>"; ids are symbols ("BTC") or addresses (GMX). */
const MAX_ENTRIES = 500;
const MAX_ID_LENGTH = 80;

/** Market ids only mean something within a venue, so entries carry both. */
export const watchKey = (venue: VenueId, marketId: string) => `${venue}:${marketId}`;

/** Reads a stored watchlist, keeping only unique, plausible entries. */
export function parseWatchlist(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter(
      (id): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH,
    );
    return [...new Set(ids)].slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function load(): string[] {
  try {
    return parseWatchlist(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * Starred markets, remembered between sessions. `starred` holds the
 * `Market::id`s starred on `venue`; `toggle` takes one of those ids.
 */
export function useWatchlist(venue: VenueId) {
  const [ids, setIds] = useState(load);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // Storage unavailable; the watchlist just won't survive a restart.
    }
  }, [ids]);

  const toggle = useCallback(
    (marketId: string) => {
      const key = watchKey(venue, marketId);
      setIds((current) =>
        current.includes(key) ? current.filter((x) => x !== key) : [...current, key],
      );
    },
    [venue],
  );
  const starred = useMemo(() => {
    const prefix = watchKey(venue, "");
    return new Set(ids.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  }, [ids, venue]);
  /** Unstars everything on this venue; other venues' entries stay. */
  const clear = useCallback(() => {
    const prefix = watchKey(venue, "");
    setIds((current) => current.filter((k) => !k.startsWith(prefix)));
  }, [venue]);
  return { starred, toggle, clear };
}
