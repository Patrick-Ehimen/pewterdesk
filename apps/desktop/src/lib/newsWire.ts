import type { Market } from "@pewterdesk/core";
import type { WireItem, WireSource } from "../api/venueClient";

// The News feed panel's plain logic: the items kept, which of them show,
// and which market a ticker in one of them is on the venue on screen.

/** Items kept, newest first; older ones fall off. */
export const MAX_ITEMS = 400;

/** `incoming` merged into `held`: once each, newest first, at most `MAX_ITEMS`. */
export function mergeItems(held: readonly WireItem[], incoming: readonly WireItem[]): WireItem[] {
  if (incoming.length === 0) return held as WireItem[];
  const byId = new Map<string, WireItem>();
  for (const item of held) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.time - a.time).slice(0, MAX_ITEMS);
}

export type WireKindFilter = "all" | "tweet" | "news";

export interface WireView {
  kind: WireKindFilter;
  /** Sources shown; an empty list shows both. */
  sources: WireSource[];
  /** Only items naming one of the venue's markets. */
  tradable: boolean;
}

export const DEFAULT_WIRE_VIEW: WireView = { kind: "all", sources: [], tradable: false };

const KEY = "pd.newsWire";

/** The ticker as the venue lists its market: "PEPE" matches "1000PEPE" and "kPEPE". */
export function marketFor(coin: string, markets: readonly Market[]): Market | undefined {
  const want = coin.toUpperCase();
  const bare = (base: string) => base.toUpperCase().replace(/^(1000+|K)(?=[A-Z])/, "");
  return (
    markets.find((m) => m.base.toUpperCase() === want) ?? markets.find((m) => bare(m.base) === want)
  );
}

/** The items the view shows, in the order held. `query` matches text, author or handle. */
export function visibleItems(
  items: readonly WireItem[],
  view: WireView,
  query: string,
  markets: readonly Market[],
): WireItem[] {
  const q = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (view.kind === "all" || item.kind === view.kind) &&
      (view.sources.length === 0 || view.sources.includes(item.source)) &&
      (!view.tradable || item.coins.some((c) => marketFor(c, markets))) &&
      (!q ||
        item.text.toLowerCase().includes(q) ||
        item.author.toLowerCase().includes(q) ||
        (item.handle?.toLowerCase().includes(q) ?? false) ||
        item.coins.some((c) => c.toLowerCase() === q)),
  );
}

export function loadWireView(): WireView {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<WireView> | null;
    const kind = raw?.kind;
    const sources = Array.isArray(raw?.sources)
      ? raw.sources.filter((s): s is WireSource => s === "tree" || s === "phoenix")
      : [];
    return {
      kind: kind === "tweet" || kind === "news" || kind === "all" ? kind : DEFAULT_WIRE_VIEW.kind,
      sources,
      tradable: raw?.tradable === true,
    };
  } catch {
    return DEFAULT_WIRE_VIEW;
  }
}

export function saveWireView(view: WireView) {
  try {
    localStorage.setItem(KEY, JSON.stringify(view));
  } catch {
    // Kept for this session only.
  }
}
