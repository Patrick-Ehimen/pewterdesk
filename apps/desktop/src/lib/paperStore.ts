import type { VenueId } from "@pewterdesk/core";
import { isPaperVenue, newPaperState, type PaperState, parsePaperState } from "./paper";
import { writeSurely } from "./storageRoom";

// Which venues are in paper mode, and each one's paper account: kept on this
// machine (no key, nothing a venue sees). The switch is read by every window,
// so the floating window - which trades through the venue directly - knows
// to stand down while the main one is paper trading.

const MODE_KEY = "pd.paper.mode";
const accountKey = (venue: VenueId) => `pd.paper.${venue}`;

type Modes = Partial<Record<VenueId, boolean>>;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: it lasts for this session only.
  }
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

let modesRaw: string | null | undefined;
let modes: Modes = {};
function currentModes(): Modes {
  const raw = read(MODE_KEY);
  if (raw !== modesRaw) {
    modesRaw = raw;
    try {
      const value = JSON.parse(raw ?? "{}") as Modes;
      modes = {};
      for (const [venue, on] of Object.entries(value)) {
        if (on === true && isPaperVenue(venue as VenueId)) modes[venue as VenueId] = true;
      }
    } catch {
      modes = {};
    }
  }
  return modes;
}

/** Whether `venue` is in paper mode: only ever a venue that has paper trading. */
export const isPaperMode = (venue: VenueId) =>
  isPaperVenue(venue) && currentModes()[venue] === true;

/** Every venue's mode; the same object until it changes. */
export const paperModes = () => currentModes();

export function setPaperMode(venue: VenueId, on: boolean) {
  if (!isPaperVenue(venue)) return;
  const next = { ...currentModes(), [venue]: on };
  if (!on) delete next[venue];
  write(MODE_KEY, JSON.stringify(next));
  notify();
}

const accounts = new Map<VenueId, { raw: string | null; state: PaperState }>();

/** The venue's paper account, new if it has none yet; the same object until it changes. */
export function paperAccount(venue: VenueId): PaperState {
  const raw = read(accountKey(venue));
  const cached = accounts.get(venue);
  if (cached && cached.raw === raw) return cached.state;
  const state = parsePaperState(raw, venue) ?? newPaperState(venue);
  accounts.set(venue, { raw, state });
  return state;
}

/**
 * Saves the paper account, or throws: a write storage refuses (it's full) is
 * never taken as saved. What's held here changes only once it has landed, so
 * the screen shows what a reload would bring back, never a close that wasn't kept.
 */
export function savePaperAccount(state: PaperState) {
  const raw = JSON.stringify(state);
  if (!writeSurely(accountKey(state.venue), raw)) throw new PaperNotSaved();
  accounts.set(state.venue, { raw, state });
  notify();
}

/** The paper account couldn't be saved: storage refused it even after the caches made way. */
export class PaperNotSaved extends Error {
  constructor() {
    super("paper account not saved");
    this.name = "PaperNotSaved";
  }
}

/** Starts the venue's paper account again, with `start` in it. */
export function resetPaperAccount(venue: VenueId, start: number) {
  savePaperAccount(newPaperState(venue, start));
}

/** For useSyncExternalStore. Other windows hear it through `storage`. */
export function subscribePaper(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) =>
    (e.key === MODE_KEY || e.key?.startsWith("pd.paper.")) && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
