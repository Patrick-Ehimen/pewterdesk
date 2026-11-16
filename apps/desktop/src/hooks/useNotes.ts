import { useEffect, useSyncExternalStore } from "react";
import { CloudError, cloudClient } from "../api/cloudClient";
import { byRecent, mergeNotes, type Note, restoreNote } from "../lib/notes";

/** How long a note waits after a change before it's written to the cloud. */
const SAVE_MS = 800;
const KEY = "pd.notes";

export type NotesSync =
  /** Not signed in: kept on this machine only. */
  | { state: "local" }
  | { state: "syncing" }
  | { state: "synced" }
  | { state: "error"; error: string };

interface NotesState {
  notes: readonly Note[];
  sync: NotesSync;
}

/**
 * The notes panel's notes: one store for the session. Every change is kept
 * on this machine at once (`pd.notes`), so notes are there signed out and
 * after a restart; signed in to PewterDesk Cloud, each is written there a
 * moment after it changes, and the two copies are merged on sign-in (the
 * later change wins; a note deleted here stays deleted).
 */
let state: NotesState = { notes: [], sync: { state: "local" } };
/** Ids deleted here and not yet deleted in the cloud. */
let deleted = new Set<string>();
let signedIn = false;
let onSignedOut: (() => void) | undefined;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function set(next: Partial<NotesState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as {
      notes?: unknown[];
      deleted?: unknown[];
    };
    const notes = (raw.notes ?? []).flatMap((n) => {
      const id = (n as { id?: unknown })?.id;
      const note = restoreNote(id, n);
      return note ? [note] : [];
    });
    deleted = new Set((raw.deleted ?? []).filter((x): x is string => typeof x === "string"));
    state = { ...state, notes: notes.sort(byRecent) };
  } catch {
    // Unreadable: no notes yet.
  }
}

function keep() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ notes: state.notes, deleted: [...deleted] }));
  } catch {
    // Full or off: kept for this session.
  }
}

if (typeof window !== "undefined") load();

function failed(e: unknown): string {
  if (e instanceof CloudError && e.signedOut) {
    // The session ended: notes stay here, and go up again on the next sign-in.
    signedIn = false;
    set({ sync: { state: "local" } });
    onSignedOut?.();
  }
  return e instanceof Error ? e.message : String(e);
}

const upload = (n: Note) => {
  const { id, ...data } = n;
  return cloudClient.put("notes", { id, data });
};

function write(n: Note) {
  if (!signedIn) return;
  // An empty note isn't worth a row; it's dropped when the panel moves on.
  if (n.text.trim() === "") return;
  set({ sync: { state: "syncing" } });
  upload(n).then(
    () => set({ sync: { state: "synced" } }),
    (e) => set({ sync: { state: "error", error: failed(e) } }),
  );
}

async function signIn() {
  signedIn = true;
  set({ sync: { state: "syncing" } });
  try {
    const rows = await cloudClient.list<unknown>("notes");
    const cloud = rows.flatMap((r) => {
      const n = restoreNote(r.id, r.data);
      return n ? [n] : [];
    });
    const { notes, toPush } = mergeNotes(state.notes, cloud, deleted);
    set({ notes });
    keep();
    for (const id of [...deleted]) {
      if (cloud.some((n) => n.id === id)) await cloudClient.remove("notes", id);
      deleted.delete(id);
    }
    for (const n of toPush) if (n.text.trim() !== "") await upload(n);
    keep();
    set({ sync: { state: "synced" } });
  } catch (e) {
    set({ sync: { state: "error", error: failed(e) } });
  }
}

/** Puts `note` in (new or changed): kept here at once, written to the cloud shortly. */
export function saveNote(note: Note) {
  const others = state.notes.filter((n) => n.id !== note.id);
  set({ notes: [note, ...others].sort(byRecent) });
  keep();
  clearTimeout(timers.get(note.id));
  timers.set(
    note.id,
    setTimeout(() => {
      timers.delete(note.id);
      write(note);
    }, SAVE_MS),
  );
}

/** Deletes a note, here and (signed in) in the cloud. */
export function removeNote(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const had = state.notes.find((n) => n.id === id);
  set({ notes: state.notes.filter((n) => n.id !== id) });
  // An empty note never went up: nothing to delete there.
  if (!had || had.text.trim() === "") {
    keep();
    return;
  }
  deleted.add(id);
  keep();
  if (!signedIn) return;
  cloudClient.remove("notes", id).then(
    () => {
      deleted.delete(id);
      keep();
    },
    (e) => set({ sync: { state: "error", error: failed(e) } }),
  );
}

// Writes still waiting go out at once if the window is closing.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const [id, timer] of timers) {
      clearTimeout(timer);
      const n = state.notes.find((x) => x.id === id);
      if (n) write(n);
    }
    timers.clear();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => state;

/**
 * The notes, and whether they're in the cloud. `cloud` is whether the
 * trader is signed in to PewterDesk Cloud; `lost` is told when a call finds
 * the session gone.
 */
export function useNotes(cloud: boolean, lost?: () => void) {
  const current = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    if (lost) onSignedOut = lost;
  }, [lost]);
  useEffect(() => {
    if (cloud && !signedIn) void signIn();
    if (!cloud && signedIn) {
      signedIn = false;
      set({ sync: { state: "local" } });
    }
  }, [cloud]);
  return { notes: current.notes, sync: current.sync, save: saveNote, remove: removeNote };
}
