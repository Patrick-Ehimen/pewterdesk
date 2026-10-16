import type { Market } from "@pewterdesk/core";
import { dateFormat, EmptyState, type MessageKey, Switch, t, toastError } from "@pewterdesk/ui";
import { useMemo, useRef, useState } from "react";
import { LuArrowUp, LuExternalLink } from "react-icons/lu";
import { type FeedState, type WireItem, type WireSource, wireClient } from "../../api/venueClient";
import { useLiveNews } from "../../hooks/useLiveNews";
import {
  loadWireView,
  marketFor,
  saveWireView,
  visibleItems,
  type WireKindFilter,
  type WireView,
} from "../../lib/newsWire";

// The live news wire as a workspace panel, after Tealstreet's news feed:
// posts from X and headlines from Tree News and Phoenix News as they come.
// Rust holds the connections (`news_wire.rs`); this gets text only, and
// opens a link by its id. A ticker in an item shows its market on the
// venue on screen; nothing here places an order.

const SOURCES: readonly WireSource[] = ["tree", "phoenix"];
const KINDS: readonly WireKindFilter[] = ["all", "tweet", "news"];
const CLOCK: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};
const DAY_CLOCK: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};
/** Scrolled this far down, the list holds still and counts what's new. */
const HOLD_AT_PX = 40;

function when(time: number) {
  const today = new Date().toDateString() === new Date(time).toDateString();
  return dateFormat(today ? CLOCK : DAY_CLOCK).format(time);
}

function stateLabel(state: FeedState | undefined): string {
  if (!state || state.state === "connecting") return t("wire.state.connecting");
  if (state.state === "live") return state.delayed ? t("wire.state.delayed") : t("wire.state.live");
  return t(`wire.state.${state.state}` as MessageKey);
}

function Item({
  item,
  fresh,
  markets,
  onMarket,
}: {
  item: WireItem;
  fresh: boolean;
  markets: readonly Market[];
  onMarket: (marketId: string) => void;
}) {
  const open = () => wireClient.open(item.id).catch((e) => toastError(t("wire.openFailed"), e));
  return (
    <li
      className="wire-item"
      data-kind={item.kind}
      data-important={item.important || undefined}
      data-fresh={fresh || undefined}
    >
      <div className="wire-head">
        <span className="wire-time pd-num">{when(item.time)}</span>
        <span
          className="wire-source"
          data-source={item.source}
          title={t(`wire.source.${item.source}`)}
        >
          {t(`wire.sourceShort.${item.source}`)}
        </span>
        <span className="wire-author">{item.author}</span>
        {item.handle && <span className="wire-handle">@{item.handle}</span>}
        {item.flag && <span className="wire-flag">{t(`wire.flag.${item.flag}`)}</span>}
        {item.important && <span className="wire-important">{t("wire.important")}</span>}
      </div>
      <p className="wire-text">{item.text}</p>
      {(item.coins.length > 0 || item.linkHost) && (
        <div className="wire-foot">
          {item.coins.map((coin) => {
            const market = marketFor(coin, markets);
            return market ? (
              <button
                key={coin}
                type="button"
                className="wire-coin"
                title={t("wire.showMarket", { market: market.symbol })}
                onClick={() => onMarket(market.id)}
              >
                {coin}
              </button>
            ) : (
              <span key={coin} className="wire-coin" data-off>
                {coin}
              </span>
            );
          })}
          {item.linkHost && (
            <button
              type="button"
              className="wire-link"
              title={t("wire.open", { host: item.linkHost })}
              onClick={open}
            >
              {item.linkHost}
              <LuExternalLink size={11} aria-hidden />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** The News feed panel: the wire, newest first, filtered as the trader likes. */
export function NewsWirePanel({
  markets,
  onMarket,
  onAddKey,
}: {
  /** The venue on screen's markets: a ticker in an item links to its market. */
  markets: readonly Market[];
  onMarket: (marketId: string) => void;
  /** Opens where the sources' API keys are kept. */
  onAddKey: () => void;
}) {
  const news = useLiveNews();
  const [view, setView] = useState<WireView>(loadWireView);
  const [query, setQuery] = useState("");
  const change = (next: WireView) => {
    setView(next);
    saveWireView(next);
  };

  // Scrolled down, the list holds what it shows; what's new waits above.
  const listRef = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<WireItem[] | null>(null);
  const items = held ?? news.items;
  const waiting = held ? news.items.length - held.length : 0;
  const onScroll = () => {
    const down = (listRef.current?.scrollTop ?? 0) > HOLD_AT_PX;
    if (down && !held) setHeld(news.items);
    if (!down && held) setHeld(null);
  };
  const toTop = () => {
    listRef.current?.scrollTo({ top: 0 });
    setHeld(null);
  };

  // What arrives after the first items is marked; the mark fades (CSS).
  const seen = useRef<Set<string> | null>(null);
  const fresh = useMemo(() => {
    const out = new Set<string>();
    if (seen.current === null) {
      if (news.items.length > 0) seen.current = new Set(news.items.map((i) => i.id));
      return out;
    }
    for (const item of news.items) {
      if (!seen.current.has(item.id)) {
        out.add(item.id);
        seen.current.add(item.id);
      }
    }
    return out;
  }, [news.items]);

  const shown = visibleItems(items, view, query, markets);
  const toggleSource = (source: WireSource) => {
    const on = view.sources.length === 0 ? [...SOURCES] : [...view.sources];
    const next = on.includes(source) ? on.filter((s) => s !== source) : [...on, source];
    change({ ...view, sources: next.length === SOURCES.length || next.length === 0 ? [] : next });
  };
  const sourceOn = (source: WireSource) =>
    view.sources.length === 0 || view.sources.includes(source);

  return (
    <div className="wire-panel">
      <div className="wire-bar">
        <div className="pd-segmented" role="radiogroup" aria-label={t("wire.kind")}>
          {KINDS.map((kind) => (
            <label key={kind} data-checked={view.kind === kind || undefined}>
              <input
                type="radio"
                name="wire-kind"
                checked={view.kind === kind}
                onChange={() => change({ ...view, kind })}
              />
              {t(`wire.kind.${kind}`)}
            </label>
          ))}
        </div>
        <input
          className="pd-input wire-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("wire.search")}
          aria-label={t("wire.search")}
        />
        <span className="wire-tradable">
          <Switch
            checked={view.tradable}
            onChange={(tradable) => change({ ...view, tradable })}
            label={t("wire.tradable")}
          />
          {t("wire.tradable")}
        </span>
      </div>
      <ul className="wire-sources" aria-label={t("wire.sources")}>
        {SOURCES.map((source) => {
          const state = news.states[source];
          return (
            <li key={source} data-state={state?.state ?? "connecting"}>
              <button
                type="button"
                className="wire-source-toggle"
                aria-pressed={sourceOn(source)}
                onClick={() => toggleSource(source)}
              >
                <span className="wire-dot" aria-hidden />
                {t(`wire.source.${source}`)}
              </button>
              <span className="wire-state">{stateLabel(state)}</span>
              {(state?.state === "needsKey" || (state?.state === "live" && state.delayed)) && (
                <button type="button" className="wire-addkey" onClick={onAddKey}>
                  {t(state.state === "needsKey" ? "wire.addKey" : "wire.removeDelay")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="wire-list app-scroll" ref={listRef} onScroll={onScroll}>
        {waiting > 0 && (
          <button type="button" className="wire-waiting" onClick={toTop}>
            <LuArrowUp size={13} aria-hidden />
            {t("wire.waiting", { count: waiting })}
          </button>
        )}
        {shown.length === 0 ? (
          <EmptyState>
            {news.error ?? (news.items.length === 0 ? t("wire.loading") : t("wire.empty"))}
          </EmptyState>
        ) : (
          <ul>
            {shown.map((item) => (
              <Item
                key={item.id}
                item={item}
                fresh={fresh.has(item.id)}
                markets={markets}
                onMarket={onMarket}
              />
            ))}
          </ul>
        )}
      </div>
      <p className="wire-note pd-muted">{t("wire.note")}</p>
    </div>
  );
}
