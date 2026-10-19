import type { BotView } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { botReason, engineHere } from "../lib/botEngine";
import { notifyEvent } from "../lib/notifications";

/**
 * Says when a bot stops on its own - one of its limits, its strategy, or
 * something going wrong - through `notifyEvent`; not a stop or pause the
 * trader asked for. Mounted once, in the app, so it's heard on any page.
 */
export function useBotNotices(symbolFor: (market: string) => string) {
  const seen = useRef(new Map<string, BotView>());
  const symbolRef = useRef(symbolFor);
  symbolRef.current = symbolFor;

  useEffect(() => {
    if (!engineHere()) return;
    let live = true;
    const off = listen<BotView>("bot", ({ payload: now }) => {
      if (!live) return;
      const before = seen.current.get(now.id);
      seen.current.set(now.id, now);
      if (before?.status === now.status && before?.reason === now.reason) return;
      if (now.status !== "limit" && now.status !== "failed") return;
      const mode = t(now.mode === "live" ? "bots.mode.live" : "bots.mode.paper");
      notifyEvent({
        type: "order",
        title: t(now.status === "limit" ? "bots.note.limit" : "bots.note.failed"),
        body: [now.spec.name ?? symbolRef.current(now.spec.market), mode, botReason(now.reason)]
          .filter(Boolean)
          .join(" · "),
        tone: "warn",
        sound: "error",
        venue: now.spec.venue,
        market: now.spec.market,
      });
    });
    return () => {
      live = false;
      void off.then((stop) => stop());
    };
  }, []);
}
