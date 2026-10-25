import { t } from "@pewterdesk/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DemoState, demoSource } from "../lib/botDemo";
import { type BotSource, noEngine } from "../lib/botSource";
import { type BotDraft, type BotEvent, type BotView, type SavedRun, withBot } from "../lib/bots";
import { notifyEvent } from "../lib/notifications";

/** Events the Log tab keeps; older ones drop off. */
const MAX_EVENTS = 200;

/** Whether the demo source may be used: development builds only. */
export const DEMO_ALLOWED = import.meta.env.DEV;

/** Why a bot is paused, in words. */
export function botReason(bot: Pick<BotView, "reason" | "detail">): string {
  switch (bot.reason) {
    case "rule":
      return t("bots.reason.rule", { rule: bot.detail ?? "" });
    case "halt":
      return t("bots.reason.halt");
    case "stale":
      return t("bots.reason.stale");
    case "user":
      return t("bots.reason.user");
    default:
      return "";
  }
}

/**
 * Says what changed about a bot, through `notifyEvent`: it stopped, or it
 * paused on its own (a rule, stale data) - not a pause the trader asked for
 * or a halt, which says so itself.
 */
function announce(before: BotView | undefined, now: BotView, symbol: string) {
  if (!before || (before.status === now.status && before.reason === now.reason)) return;
  const body = [`${now.name} · ${symbol}`, botReason(now)].filter(Boolean).join(" · ");
  const venue = now.venue;
  const market = now.market;
  if (now.status === "stopped") {
    notifyEvent({ type: "order", title: t("bots.note.stopped"), body, venue, market });
  } else if (now.status === "paused" && (now.reason === "rule" || now.reason === "stale")) {
    notifyEvent({
      type: "order",
      title: t("bots.note.paused"),
      body,
      tone: "warn",
      sound: "error",
      venue,
      market,
    });
  }
}

export type BotBook = ReturnType<typeof useBots>;

/**
 * The bots, kept up to date from their source, and what can be done with
 * them. One instance in the app, shared by the panel and the page: it's what
 * raises their notifications.
 */
export function useBots(symbolFor: (market: string) => string) {
  const [demo, setDemo] = useState<DemoState>();
  const source: BotSource = useMemo(
    () => (demo && DEMO_ALLOWED ? demoSource(demo) : noEngine),
    [demo],
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [bots, setBots] = useState<BotView[]>([]);
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [link, setLink] = useState({ reachable: true, at: Date.now() });
  const [haltedAt, setHaltedAt] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  const seen = useRef(new Map<string, BotView>());
  const symbolRef = useRef(symbolFor);
  symbolRef.current = symbolFor;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again
  useEffect(() => {
    let live = true;
    seen.current.clear();
    setStatus("loading");
    setError(undefined);
    setBots([]);
    setEvents([]);
    setHaltedAt(undefined);
    setLink({ reachable: true, at: Date.now() });
    Promise.all([source.list(), source.events(MAX_EVENTS), source.runs()])
      .then(([list, log, saved]) => {
        if (!live) return;
        for (const bot of list) seen.current.set(bot.id, bot);
        setBots(list.reduce<BotView[]>((all, bot) => withBot(all, bot), []));
        setEvents(log);
        setRuns(saved);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
    const stop = source.subscribe({
      onBot: (bot) => {
        const before = seen.current.get(bot.id);
        seen.current.set(bot.id, bot);
        setBots((list) => withBot(list, bot));
        announce(before, bot, symbolRef.current(bot.market));
      },
      onEvent: (event) => setEvents((log) => [event, ...log].slice(0, MAX_EVENTS)),
      onLink: (reachable, at) => setLink({ reachable, at }),
    });
    return () => {
      live = false;
      stop();
    };
  }, [source, attempt]);

  const halt = useCallback(async () => {
    const paused = await source.halt();
    setHaltedAt(Date.now());
    notifyEvent({
      type: "order",
      title: t("bots.note.halted"),
      body: t("bots.haltedCount", { count: paused }),
      tone: "warn",
      sound: "cancel",
    });
    return paused;
  }, [source]);

  const resumeAll = useCallback(async () => {
    setHaltedAt(undefined);
    await Promise.all(
      bots
        .filter((b) => b.status === "paused" && b.reason === "halt")
        .map((b) => source.resume(b.id)),
    );
  }, [bots, source]);

  return {
    source,
    status,
    error,
    bots,
    events,
    runs,
    link,
    /** When every bot was halted, while any is still paused by it. */
    haltedAt: bots.some((b) => b.reason === "halt") ? haltedAt : undefined,
    demo,
    setDemo,
    retry: () => setAttempt((n) => n + 1),
    start: (draft: BotDraft) => source.start(draft),
    pause: (id: string) => source.pause(id),
    resume: (id: string) => source.resume(id),
    stop: (id: string, close: boolean) => source.stop(id, close),
    halt,
    resumeAll,
  };
}
