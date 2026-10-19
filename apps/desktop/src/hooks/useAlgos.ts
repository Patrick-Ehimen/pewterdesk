import type { AlgoSpec, AlgoView, Origin, StopMode } from "@pewterdesk/core";
import { type MessageKey, t } from "@pewterdesk/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { venueClient } from "../api/venueClient";
import { sortAlgos, withAlgo } from "../lib/algos";
import { notifyEvent } from "../lib/notifications";

/** Why an algo paused, stopped or failed, in words. */
export const algoReason = (reason: string | undefined) =>
  reason ? t(`algo.reason.${reason}` as MessageKey) : "";

/** An algo's kind in words. */
export const algoKind = (view: Pick<AlgoView, "spec">) =>
  t(`algo.kind.${view.spec.kind}` as MessageKey);

/**
 * Says what changed about an algo, through `notifyEvent`: it finished,
 * stopped or failed, or paused on its own (stale data, a refusal) - not a
 * pause the trader asked for.
 */
function announce(before: AlgoView | undefined, now: AlgoView, symbol: string) {
  if (before?.status === now.status && before?.reason === now.reason) return;
  const what = `${algoKind(now)} · ${t(now.spec.side === "buy" ? "side.buy" : "side.sell")} ${symbol}`;
  const reason = algoReason(now.reason);
  const body = [what, reason, now.detail].filter(Boolean).join(" · ");
  const note = (title: MessageKey, tone: "neutral" | "warn", sound: "saved" | "error") =>
    notifyEvent({
      type: "order",
      title: t(title),
      body,
      tone,
      sound,
      venue: now.spec.venue,
      market: now.spec.market,
    });
  switch (now.status) {
    case "finished":
      note("algo.note.finished", "neutral", "saved");
      break;
    case "stopped":
      note("algo.note.stopped", "warn", "saved");
      break;
    case "failed":
      note("algo.note.failed", "warn", "error");
      break;
    case "paused":
      if (now.reason && now.reason !== "user") note("algo.note.paused", "warn", "error");
      break;
    default:
      break;
  }
}

/**
 * The engine's algos, kept up to date from its events, and what can be done
 * with them. One instance in the app: it's what raises their notifications.
 */
export function useAlgos(symbolFor: (market: string) => string) {
  const [algos, setAlgos] = useState<AlgoView[]>([]);
  const [history, setHistory] = useState<AlgoView[]>([]);
  const seen = useRef(new Map<string, AlgoView>());
  const symbolRef = useRef(symbolFor);
  symbolRef.current = symbolFor;

  useEffect(() => {
    let live = true;
    venueClient
      .algos()
      .then((list) => {
        if (!live) return;
        for (const view of list) seen.current.set(view.id, view);
        setAlgos(sortAlgos(list));
      })
      .catch(() => {});
    const stop = venueClient.onAlgo((view) => {
      const before = seen.current.get(view.id);
      seen.current.set(view.id, view);
      setAlgos((list) => withAlgo(list, view));
      announce(before, view, symbolRef.current(view.spec.market));
    });
    return () => {
      live = false;
      stop();
    };
  }, []);

  const loadHistory = useCallback(() => {
    venueClient
      .algoHistory(100)
      .then(setHistory)
      .catch(() => {});
  }, []);

  const start = useCallback(async (spec: AlgoSpec, origin: Origin) => {
    const view = await venueClient.startAlgo(spec, origin);
    seen.current.set(view.id, view);
    setAlgos((list) => withAlgo(list, view));
    return view;
  }, []);

  const halt = useCallback(async () => {
    const stopped = await venueClient.haltAlgos();
    notifyEvent({
      type: "order",
      title: t("algo.note.halted"),
      body: t("algo.haltedCount", { count: stopped }),
      tone: "warn",
      sound: "cancel",
    });
    return stopped;
  }, []);

  return {
    algos,
    history,
    loadHistory,
    start,
    halt,
    pause: (id: string) => venueClient.pauseAlgo(id),
    resume: (id: string) => venueClient.resumeAlgo(id),
    stop: (id: string, mode: StopMode) => venueClient.stopAlgo(id, mode),
  };
}
