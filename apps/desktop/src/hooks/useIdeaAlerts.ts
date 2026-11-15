import { t } from "@pewterdesk/ui";
import { useEffect, useMemo, useRef } from "react";
import { price as priceText } from "../components/ideas/parts";
import { crossed, type Idea, LEVEL_QUIET_MS } from "../lib/ideas";
import { notifyEvent } from "../lib/notifications";
import { VENUES } from "../lib/venues";
import { useIdeaPrices } from "./useIdeaPrices";

/**
 * The Ideas page's level alerts, all session: each watched idea's price
 * against its levels with the bell on, and a notification (`idea`, with
 * its own sound) when the price goes through one. A level that rang stays
 * quiet a while. The first read only notes where each price is; nothing
 * rings for where it already was. It reads prices and places nothing.
 */
export function useIdeaAlerts(ideas: readonly Idea[]) {
  const watched = useMemo(
    () => ideas.filter((i) => i.status === "watching" && i.levels.some((l) => l.alert)),
    [ideas],
  );
  const used = useMemo(() => new Set(watched.map((i) => i.venue)), [watched]);
  const priceOf = useIdeaPrices(used);
  const last = useRef(new Map<string, number>());
  const rang = useRef(new Map<string, number>());

  // A string of the prices, so the check runs when one moves, not on every render.
  const prices = watched.map((i) => `${i.id}:${priceOf(i) ?? ""}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `prices` stands for `priceOf`
  useEffect(() => {
    const now = Date.now();
    for (const idea of watched) {
      const price = priceOf(idea);
      if (price === undefined) continue;
      const before = last.current.get(idea.id);
      last.current.set(idea.id, price);
      if (before === undefined) continue;
      for (const level of idea.levels) {
        if (!level.alert) continue;
        const way = crossed(before, price, level.price);
        if (!way) continue;
        const key = `${idea.id}:${level.id}`;
        if (now - (rang.current.get(key) ?? 0) < LEVEL_QUIET_MS) continue;
        rang.current.set(key, now);
        const name = level.name || t("ideas.unnamed");
        notifyEvent({
          type: "idea",
          title: t("ideas.note.reached", { symbol: idea.symbol, name }),
          body: t("ideas.note.reachedBody", {
            price: priceText(price),
            venue: VENUES[idea.venue].label,
            direction: t(way === "up" ? "ideas.note.above" : "ideas.note.below"),
            level: priceText(level.price),
          }),
          tone: "neutral",
          sound: "alert",
          venue: idea.venue,
          market: idea.market,
        });
      }
    }
  }, [prices, watched]);
}
