import { useEffect, useSyncExternalStore } from "react";
import { CloudError, cloudClient } from "../api/cloudClient";
import { type Idea, restoreIdea } from "../lib/ideas";

/** How long an idea waits after a change before it's written. */
const SAVE_MS = 700;

export type IdeasLoad =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; error: string };

interface IdeasState {
  ideas: readonly Idea[];
  load: IdeasLoad;
  saveError?: string;
}

/**
 * The signed-in trader's ideas, from PewterDesk Cloud (`ideas`): one store
 * for the session, so the Ideas page, the Trade chart's overlay, the Ideas
 * panel and the level alerts all see the same ideas, and a change on one
 * reaches the others at once. A change shows at once and is written a
 * moment later, whole; a write that fails says so, and the next tries again.
 */
let state: IdeasState = { ideas: [], load: { state: "idle" } };
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** The latest copy of each idea still waiting to be written. */
const waiting = new Map<string, Idea>();
let onSignedOut: (() => void) | undefined;

function set(next: Partial<IdeasState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function failed(e: unknown): string {
  if (e instanceof CloudError && e.signedOut) {
    // Signed out: nothing of theirs stays on screen, and the next sign-in reads afresh.
    set({ ideas: [], load: { state: "idle" } });
    onSignedOut?.();
  }
  return e instanceof Error ? e.message : String(e);
}

function read() {
  set({ load: { state: "loading" } });
  cloudClient.list<unknown>("ideas").then(
    (rows) =>
      set({
        ideas: rows.flatMap((r) => {
          const idea = r.id ? restoreIdea(r.id, r.data) : undefined;
          return idea ? [idea] : [];
        }),
        load: { state: "ready" },
      }),
    (e) => set({ load: { state: "error", error: failed(e) } }),
  );
}

function write(idea: Idea) {
  waiting.delete(idea.id);
  const { id, ...data } = idea;
  cloudClient.put("ideas", { id, data }).then(
    () => set({ saveError: undefined }),
    (e) => set({ saveError: failed(e) }),
  );
}

/** Puts `idea` in (new or changed); written shortly, or at once with `now`. */
export function saveIdea(idea: Idea, now = false) {
  const at = state.ideas.findIndex((i) => i.id === idea.id);
  set({
    ideas:
      at === -1 ? [idea, ...state.ideas] : state.ideas.map((i) => (i.id === idea.id ? idea : i)),
  });
  clearTimeout(timers.get(idea.id));
  waiting.set(idea.id, idea);
  if (now) {
    timers.delete(idea.id);
    write(idea);
    return;
  }
  timers.set(
    idea.id,
    setTimeout(() => {
      timers.delete(idea.id);
      write(idea);
    }, SAVE_MS),
  );
}

/** Deletes an idea and its screenshots. */
export async function removeIdea(idea: Idea) {
  clearTimeout(timers.get(idea.id));
  timers.delete(idea.id);
  waiting.delete(idea.id);
  try {
    await cloudClient.remove("ideas", idea.id);
  } catch (e) {
    throw new Error(failed(e));
  }
  set({ ideas: state.ideas.filter((i) => i.id !== idea.id) });
  for (const shot of idea.shots) void cloudClient.removeAttachment(shot).catch(() => {});
}

// Writes still waiting go out at once if the window is closing.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const idea of [...waiting.values()]) write(idea);
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => state;

/**
 * The ideas, read from the cloud the first time anything asks while signed
 * in; signed out, none. `lost` is told when a call finds the session gone.
 */
export function useIdeas(signedIn: boolean, lost?: () => void) {
  const current = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    if (lost) onSignedOut = lost;
  }, [lost]);
  useEffect(() => {
    // A page that thinks it's signed out doesn't empty the store another
    // page filled: only a call that finds the session gone does (`forget`).
    if (!signedIn) return;
    if (state.load.state === "idle" || state.load.state === "error") read();
  }, [signedIn]);
  return {
    ideas: current.ideas,
    load: current.load.state === "idle" ? ({ state: "loading" } as const) : current.load,
    saveError: current.saveError,
    save: saveIdea,
    remove: removeIdea,
  };
}
