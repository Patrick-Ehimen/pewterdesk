import { useEffect, useState } from "react";
import { type FeedState, type WireItem, type WireSource, wireClient } from "../api/venueClient";
import { mergeItems } from "../lib/newsWire";
import { RETRY_MS } from "./useRetry";

export interface LiveNews {
  /** Newest first. */
  items: WireItem[];
  /** Each source's connection, once it's said. */
  states: Partial<Record<WireSource, FeedState>>;
  /** The subscription itself failed (it's tried again). */
  error?: string;
}

/**
 * The news wire while mounted: Tree's recent items, then both sources live.
 * Keys are read when it connects, so one saved in Settings is used once the
 * panel is back on screen.
 */
export function useLiveNews(): LiveNews {
  const [items, setItems] = useState<WireItem[]>([]);
  const [states, setStates] = useState<LiveNews["states"]>({});
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` connects again
  useEffect(() => {
    setError(undefined);
    setStates({});
    let retry: ReturnType<typeof setTimeout> | undefined;
    const stop = wireClient.subscribe({
      onUpdate: (event) => {
        if (event.type === "items") setItems((held) => mergeItems(held, event.items));
        else setStates((now) => ({ ...now, [event.source]: event.state }));
      },
      // The stream only ends when Rust drops it; start another.
      onClosed: () => {
        retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
      },
      onError: (message) => {
        setError(message);
        retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
      },
    });
    return () => {
      clearTimeout(retry);
      stop();
    };
  }, [attempt]);

  return { items, states, error };
}
