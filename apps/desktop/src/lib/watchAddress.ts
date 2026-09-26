const STORAGE_KEY = "pd.watchAddress";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): boolean {
  return ADDRESS.test(value);
}

// The watched address is public (it's on-chain), so browser storage is fine.
// Keys never go anywhere near here.
export function loadAddress(): string | undefined {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved && isAddress(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function saveAddress(address: string | undefined) {
  try {
    if (address) localStorage.setItem(STORAGE_KEY, address);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable; the address just won't survive a restart.
  }
}
