import type { VenueId } from "@pewterdesk/core";
import { newPaperState, type PaperState, parsePaperState } from "./paper";

// The replay account: one balance, kept on this machine and carried from
// session to session and venue to venue. Nothing is open between sessions, so
// it's only money and records. Apart from the paper accounts, and from any
// real one.

const KEY = "pd.replay";

const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let cached: { raw: string | null; venue: VenueId; state: PaperState } | undefined;

/** The account, trading on `venue` for now; the same object until it changes. */
export function replayAccount(venue: VenueId): PaperState {
  const raw = read();
  if (cached && cached.raw === raw && cached.venue === venue) return cached.state;
  let state: PaperState | undefined;
  try {
    const was = raw ? (JSON.parse(raw) as { venue?: VenueId }).venue : undefined;
    state = was ? parsePaperState(raw, was) : undefined;
  } catch {
    state = undefined;
  }
  const next = { ...(state ?? newPaperState(venue)), venue };
  cached = { raw, venue, state: next };
  return next;
}

export function saveReplayAccount(state: PaperState) {
  const raw = JSON.stringify(state);
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // Storage unavailable: it lasts for this session only.
  }
  cached = { raw: read() ?? raw, venue: state.venue, state };
  for (const l of listeners) l();
}

export function subscribeReplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
