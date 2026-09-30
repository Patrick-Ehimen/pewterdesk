import { useEffect, useState } from "react";

/** A failed feed is tried again after this long, and again after that. */
export const RETRY_MS = 10_000;

/**
 * A counter that goes up while `failed`: every `RETRY_MS`, and at once when
 * the system says the network is back. Put it in a feed's effect
 * dependencies and a failed feed resubscribes by itself.
 */
export function useRetry(failed: boolean): number {
  const [attempt, setAttempt] = useState(0);
  // `attempt` re-arms the timer after each try that failed again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!failed) return;
    const retry = () => setAttempt((n) => n + 1);
    const id = setTimeout(retry, RETRY_MS);
    window.addEventListener("online", retry);
    return () => {
      clearTimeout(id);
      window.removeEventListener("online", retry);
    };
  }, [failed, attempt]);
  return attempt;
}
