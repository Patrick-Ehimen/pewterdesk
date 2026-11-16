import type { RunResult } from "@pewterdesk/core";
import { useEffect, useRef, useState } from "react";
import { type LabStrategy, runBacktest } from "../lib/backtestLab";

export interface Preview {
  /** What it was run on, to tell whether it's still the draft's. */
  key: string;
  run: RunResult;
}

/** What a preview depends on: the strategy and the candles it reads. */
export const previewKey = (s: LabStrategy) =>
  JSON.stringify([
    s.venue,
    s.market,
    s.interval,
    s.period,
    s.from,
    s.to,
    s.holdOutDays,
    s.capital,
    s.slippageBps,
    s.strategy,
  ]);

/**
 * The builder's draft, run on its first market a moment after it last
 * changed (and again only when it changes), for the counts and charts
 * beside the settings. The candles come from this machine after the first
 * run, so it's quick; nothing is kept.
 */
export function useBacktestPreview(draft: LabStrategy, enabled: boolean) {
  const [preview, setPreview] = useState<Preview>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const key = previewKey(draft);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const timer = setTimeout(() => {
      setRunning(true);
      const s = { ...latest.current, extra: [], account: undefined };
      runBacktest(s).then(
        (parts) => {
          if (!live) return;
          const run = parts[0]?.run;
          if (run) setPreview({ key, run });
          setError(undefined);
          setRunning(false);
        },
        (e: unknown) => {
          if (!live) return;
          setError(e instanceof Error ? e.message : String(e));
          setRunning(false);
        },
      );
    }, 700);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, enabled]);
  return { preview, current: preview?.key === key, running, error };
}
