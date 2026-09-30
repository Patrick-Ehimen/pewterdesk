import { useEffect, useState } from "react";
import type { Connection } from "../components/StatusBar";

/** No update for this long: the link is unstable, show Connecting. */
export const STALE_MS = 10_000;
/** No update for this long: treat it as lost, show Offline. */
export const LOST_MS = 30_000;

export interface ConnectionInput {
  /** The system says there's a network (`navigator.onLine`). */
  network: boolean;
  /** A feed failed outright (the market list, or the book stream ended). */
  failed: boolean;
  /** When data last arrived from the venue, in ms; unset before the first. */
  lastUpdate?: number;
  now: number;
}

/**
 * The bottom bar's status from what's actually arriving. The venue crates
 * reconnect by themselves, so a dropped network doesn't end a stream: it
 * just goes quiet. Quiet for a while reads as unstable, then as lost.
 */
export function connectionState({ network, failed, lastUpdate, now }: ConnectionInput): Connection {
  if (!network || failed) return "offline";
  if (lastUpdate === undefined) return "connecting";
  const quiet = now - lastUpdate;
  if (quiet > LOST_MS) return "offline";
  if (quiet > STALE_MS) return "connecting";
  return "online";
}

/**
 * `connectionState`, kept current. `book` and `stats` are the latest data
 * from those feeds (undefined until it arrives): either changing counts as
 * the venue being there, since a quiet market's book can sit still while
 * its stats still tick. Re-checked every second, so silence is noticed
 * without an update.
 */
export function useConnection(book: unknown, stats: unknown, failed: boolean): Connection {
  const [network, setNetwork] = useState(() => navigator.onLine);
  const [lastUpdate, setLastUpdate] = useState<number>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const on = () => setNetwork(true);
    const off = () => setNetwork(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (book !== undefined || stats !== undefined) setLastUpdate(Date.now());
  }, [book, stats]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return connectionState({ network, failed, lastUpdate, now });
}
