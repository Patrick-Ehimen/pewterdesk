import type { VenueId } from "@pewterdesk/core";

// Each connected account's picture: one the user chose, kept as a small
// square image (a `data:` URL, re-drawn at `AVATAR_SIZE` when picked), or
// none - then the account shows its identicon, a pattern drawn from its id.
// Kept apart from the account list so a picture doesn't ride along with
// every change to it.

const PREFIX = "pd.avatar:";

/** Pictures are re-drawn to this many pixels square. */
export const AVATAR_SIZE = 128;
/** A stored picture this long or longer is ignored (~45 KB of image). */
export const AVATAR_MAX_CHARS = 60_000;

const keyFor = (venue: VenueId, id: string) => `${PREFIX}${venue}:${id}`;

/** Only images this app drew are taken back: raster `data:` URLs, not too big. */
export function isAvatarUrl(value: string | null): value is string {
  return (
    value !== null &&
    value.length < AVATAR_MAX_CHARS &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)
  );
}

/** The account's chosen picture, if it has one. */
export function avatarFor(venue: VenueId, id: string): string | undefined {
  try {
    const value = localStorage.getItem(keyFor(venue, id));
    return isAvatarUrl(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

/** Stores a picture `drawAvatar` made. Fails (and keeps the old one) if storage is full. */
export function setAvatar(venue: VenueId, id: string, url: string): boolean {
  if (!isAvatarUrl(url)) return false;
  try {
    localStorage.setItem(keyFor(venue, id), url);
  } catch {
    return false;
  }
  notify();
  return true;
}

/** Back to the identicon. */
export function removeAvatar(venue: VenueId, id: string) {
  try {
    localStorage.removeItem(keyFor(venue, id));
  } catch {
    // Storage unavailable: there's nothing stored to remove.
  }
  notify();
}

/** For useSyncExternalStore. Other windows (the tray) hear it via `storage`. */
export function subscribeAvatars(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key?.startsWith(PREFIX) && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** FNV-1a: a small, stable hash, so the same id always draws the same pattern. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The identicon for an id: a 5x5 grid mirrored left to right, each cell
 * empty (0), dim (1) or bright (2). Never blank: an id whose pattern would
 * be empty gets its middle column filled.
 */
export function identicon(id: string): number[][] {
  let bits = hash(id);
  const more = hash(`${id}:shade`);
  const rows: number[][] = [];
  let filled = 0;
  for (let r = 0; r < 5; r++) {
    const half: number[] = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const on = (bits & 1) === 1;
      bits >>>= 1;
      const cell = on ? ((more >>> i) & 1) + 1 : 0;
      if (cell) filled++;
      half.push(cell);
    }
    rows.push([half[0], half[1], half[2], half[1], half[0]] as number[]);
  }
  if (filled === 0) for (const row of rows) row[2] = 2;
  return rows;
}
