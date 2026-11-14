import { useCallback, useEffect, useRef, useState } from "react";
import { CloudError, cloudClient } from "../api/cloudClient";
import { type Idea, restoreIdea } from "../lib/ideas";

/** How long an idea waits after a change before it's written. */
const SAVE_MS = 700;

export type IdeasLoad =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; error: string };

/**
 * The signed-in trader's ideas, from PewterDesk Cloud (`ideas`). A change
 * shows at once and is written a moment later, whole; a write that fails
 * says so, and the next change tries again.
 */
export function useIdeas(signedIn: boolean, onSignedOut: () => void) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [load, setLoad] = useState<IdeasLoad>({ state: "loading" });
  const [saveError, setSaveError] = useState<string>();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** The latest copy of each idea still waiting to be written. */
  const waiting = useRef(new Map<string, Idea>());
  const lost = useRef(onSignedOut);
  lost.current = onSignedOut;

  const failed = useCallback((e: unknown) => {
    if (e instanceof CloudError && e.signedOut) lost.current();
    return e instanceof Error ? e.message : String(e);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setLoad({ state: "loading" });
    cloudClient.list<unknown>("ideas").then(
      (rows) => {
        if (!live) return;
        setIdeas(
          rows.flatMap((r) => {
            const idea = r.id ? restoreIdea(r.id, r.data) : undefined;
            return idea ? [idea] : [];
          }),
        );
        setLoad({ state: "ready" });
      },
      (e) => live && setLoad({ state: "error", error: failed(e) }),
    );
    return () => {
      live = false;
    };
  }, [signedIn, failed]);

  const write = useCallback(
    (idea: Idea) => {
      waiting.current.delete(idea.id);
      const { id, ...data } = idea;
      cloudClient.put("ideas", { id, data }).then(
        () => setSaveError(undefined),
        (e) => setSaveError(failed(e)),
      );
    },
    [failed],
  );

  // Writes still waiting go out at once when the page closes.
  const flush = useRef(write);
  flush.current = write;
  useEffect(() => {
    const pending = timers.current;
    const ideasLeft = waiting.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const idea of [...ideasLeft.values()]) flush.current(idea);
    };
  }, []);

  /** Puts `idea` in (new or changed); written shortly, or at once with `now`. */
  const save = useCallback(
    (idea: Idea, now = false) => {
      setIdeas((all) => {
        const at = all.findIndex((i) => i.id === idea.id);
        return at === -1 ? [idea, ...all] : all.map((i) => (i.id === idea.id ? idea : i));
      });
      clearTimeout(timers.current.get(idea.id));
      waiting.current.set(idea.id, idea);
      if (now) {
        timers.current.delete(idea.id);
        write(idea);
        return;
      }
      timers.current.set(
        idea.id,
        setTimeout(() => {
          timers.current.delete(idea.id);
          write(idea);
        }, SAVE_MS),
      );
    },
    [write],
  );

  /** Deletes an idea and its screenshots. */
  const remove = useCallback(
    async (idea: Idea) => {
      clearTimeout(timers.current.get(idea.id));
      timers.current.delete(idea.id);
      waiting.current.delete(idea.id);
      try {
        await cloudClient.remove("ideas", idea.id);
      } catch (e) {
        throw new Error(failed(e));
      }
      setIdeas((all) => all.filter((i) => i.id !== idea.id));
      for (const shot of idea.shots) void cloudClient.removeAttachment(shot).catch(() => {});
    },
    [failed],
  );

  return { ideas, load, saveError, save, remove };
}
