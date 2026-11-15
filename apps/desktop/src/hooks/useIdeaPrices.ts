import type { VenueId } from "@pewterdesk/core";
import type { Idea } from "../lib/ideas";
import { useMarketSummaries } from "./useVenueFeeds";

/**
 * Each venue's mark prices, read only for the venues some idea is on (the
 * summaries every page shares, so nothing more is fetched). Returns a lookup
 * by idea; undefined until its venue has answered.
 */
export function useIdeaPrices(used: ReadonlySet<VenueId>) {
  const feeds = {
    hyperliquid: useMarketSummaries("hyperliquid", used.has("hyperliquid")),
    aster: useMarketSummaries("aster", used.has("aster")),
    bybit: useMarketSummaries("bybit", used.has("bybit")),
    binance: useMarketSummaries("binance", used.has("binance")),
    blofin: useMarketSummaries("blofin", used.has("blofin")),
  };
  return (idea: Pick<Idea, "venue" | "market">): number | undefined => {
    const feed = feeds[idea.venue];
    if (feed.status !== "live" && feed.status !== "closed") return undefined;
    const mark = Number(feed.data.find((s) => s.market === idea.market)?.markPrice);
    return mark > 0 ? mark : undefined;
  };
}
