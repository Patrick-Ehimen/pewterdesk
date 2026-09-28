const STORAGE_KEY = "pd.market";

// A market id (e.g. "HYPE", "xyz:TSLA") is public, so browser storage is fine.
// An id the venue no longer lists just falls back to the default market.
export function loadMarket(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function saveMarket(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage unavailable; the market just won't survive a restart.
  }
}
