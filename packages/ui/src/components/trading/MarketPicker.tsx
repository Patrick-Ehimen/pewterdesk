import type { Market, MarketSummary, VenueId } from "@pewterdesk/core";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { LuMenu, LuSearch } from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import { decimalsOf, formatCompact, formatNumber, formatSigned } from "../../lib/format";
import {
  PICKER_PRESETS,
  PICKER_TABS,
  type PickerPreset,
  type PickerSort,
  type PickerSortKey,
  type PickerTab,
  pickerRows,
  pickerTabs,
  pickerView,
  presetOf,
} from "../../lib/marketPicker";
import { IconButton } from "../common/IconButton";
import { StarButton } from "../common/StarButton";
import { ListedBy } from "./ListedBy";
import { TokenIcon } from "./TokenIcon";

const GAP = 6;
const TAB_KEY = "pd.picker.tab";

const TAB_LABEL: Record<PickerTab, MessageKey> = {
  favorites: "picker.favorites",
  perps: "picker.perps",
  hip3: "screener.filter.builder",
};
const PRESET_LABEL: Record<PickerPreset, MessageKey> = {
  top: "picker.top",
  gainers: "picker.gainers",
  losers: "picker.losers",
};

function storedTab(): PickerTab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return PICKER_TABS.find((tab) => tab === saved) ?? "perps";
  } catch {
    return "perps";
  }
}

interface MarketPickerProps {
  markets: Market[];
  /** `Market::id` of the current market. */
  selected?: string;
  onSelect: (market: Market) => void;
  /** Price, 24h change and volume per market; empty until they arrive. */
  summaries?: readonly MarketSummary[];
  starred: ReadonlySet<string>;
  onToggleStar: (market: Market) => void;
  /** Lets the app fetch `summaries` only while the picker is open. */
  onOpenChange?: (open: boolean) => void;
  /** Venue chips above the list, shown when there's more than one; `markets` are `venue`'s. */
  venues?: readonly { id: VenueId; label: string; logo?: string }[];
  venue?: VenueId;
  onVenueChange?: (venue: VenueId) => void;
  /** The market list is on its way: skeleton rows stand in. */
  loading?: boolean;
  /** What the opening button shows; a menu icon when unset. */
  trigger?: ReactNode;
  triggerClassName?: string;
}

/** Rows drawn while the market list loads. */
const SKELETON_ROWS = 8;
/** Bar widths for a skeleton row's value columns. */
const SKELETON_WIDTHS = [64, 52, 70, 56, 52] as const;

const Skel = ({ width, height = 10 }: { width: number; height?: number }) => (
  <span className="pd-skel pd-picker-skel" style={{ width, height }} aria-hidden />
);

/** A funding interval as hours, e.g. "8h". */
const intervalText = (secs: number) => `${Math.round(secs / 3600)}h`;

/**
 * A searchable market list in a popover, like an exchange's market selector:
 * venue chips; tabs for favorites, the venue's own perps and builder-deployed
 * (HIP-3) ones; Top / Gainers / Losers; sortable price, 24h change, funding,
 * volume and open interest; a star per market. Type to filter, arrows to
 * move, Enter to pick, Escape or a click outside to close.
 */
export function MarketPicker({
  markets,
  selected,
  onSelect,
  summaries,
  starred,
  onToggleStar,
  onOpenChange,
  venues,
  venue,
  onVenueChange,
  loading = false,
  trigger,
  triggerClassName,
}: MarketPickerProps) {
  const listId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTabState] = useState(storedTab);
  const [sort, setSort] = useState<PickerSort>(PICKER_PRESETS.top);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const setTab = (next: PickerTab) => {
    setTabState(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Storage unavailable; the tab just won't be remembered.
    }
  };

  const tabs = pickerTabs(markets);
  // A remembered HIP-3 tab falls back to Perps on a venue without one.
  const activeTab = tabs.includes(tab) ? tab : "perps";
  const rows = pickerView(pickerRows(markets, summaries), activeTab, starred, query, sort);
  // Prices not here yet: each value cell shimmers until they are.
  const pricesPending = summaries === undefined;
  const value = (content: ReactNode, missing: boolean, width: number) =>
    missing ? pricesPending ? <Skel width={width} /> : "-" : content;
  const shown = rows.map((r) => r.market);
  const preset = presetOf(sort);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    setPosition(undefined);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (market: Market) => {
    onSelect(market);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current?.getBoundingClientRect();
    const pop = popRef.current?.getBoundingClientRect();
    if (!button || !pop) return;
    setPosition({
      top: button.bottom + GAP,
      left: Math.max(GAP, Math.min(button.left, window.innerWidth - pop.width - GAP)),
    });
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `setOpen` only wraps state and a callback
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!popRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
        setQuery("");
        setPosition(undefined);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(popRef.current?.querySelectorAll<HTMLElement>("[data-market]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[Math.min(at + 1, items.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at <= 0) popRef.current?.querySelector<HTMLElement>("input")?.focus();
      else items[at - 1]?.focus();
    } else if (e.key === "Enter" && e.target instanceof HTMLInputElement && shown[0]) {
      // Enter in the search box picks the top match.
      e.preventDefault();
      pick(shown[0]);
    }
  };

  const header = (by: PickerSortKey, label: MessageKey) => {
    const active = sort.by === by;
    return (
      <button
        type="button"
        className="pd-sort"
        data-active={active || undefined}
        onClick={() =>
          setSort((s) => ({
            by,
            // A new column starts high-to-low (names A–Z); clicking again flips it.
            descending: s.by === by ? !s.descending : by !== "name",
          }))
        }
      >
        {t(label)}
        <span aria-hidden>{active ? (sort.descending ? "▼" : "▲") : ""}</span>
      </button>
    );
  };

  const empty =
    activeTab === "favorites" && starred.size === 0 && !query.trim()
      ? t("picker.noFavorites")
      : t("markets.noMatch", { query });

  return (
    <>
      {trigger === undefined ? (
        <IconButton
          ref={buttonRef}
          label={t("stats.chooseMarket")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <LuMenu size={18} aria-hidden />
        </IconButton>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className={triggerClassName}
          title={t("stats.chooseMarket")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {trigger}
        </button>
      )}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="pd-picker"
            role="dialog"
            aria-label={t("stats.chooseMarket")}
            data-visible={position !== undefined || undefined}
            style={{ top: position?.top ?? 0, left: position?.left ?? 0 }}
            onKeyDown={onKeyDown}
          >
            <label className="pd-search pd-picker-search">
              <LuSearch size={14} aria-hidden />
              <input
                type="search"
                placeholder={t("markets.search")}
                aria-label={t("markets.search")}
                aria-controls={listId}
                // biome-ignore lint/a11y/noAutofocus: the picker opens to be searched
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>

            {venues && venues.length > 1 && (
              <div className="pd-picker-venues" role="radiogroup" aria-label={t("picker.venues")}>
                {venues.map((v) => (
                  // biome-ignore lint/a11y/useSemanticElements: chip-style radio, like the other segmented controls
                  <button
                    key={v.id}
                    type="button"
                    role="radio"
                    aria-checked={v.id === venue}
                    className="pd-picker-venue"
                    onClick={() => onVenueChange?.(v.id)}
                  >
                    {v.logo && <img src={v.logo} alt="" width={18} height={18} />}
                    {v.label}
                  </button>
                ))}
              </div>
            )}

            <div className="pd-picker-tabs" role="tablist" aria-label={t("picker.categories")}>
              {tabs.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={id === activeTab}
                  className="pd-picker-tab"
                  onClick={() => setTab(id)}
                >
                  {t(TAB_LABEL[id])}
                </button>
              ))}
            </div>

            <div className="pd-picker-presets" role="radiogroup" aria-label={t("picker.sort")}>
              {(Object.keys(PICKER_PRESETS) as PickerPreset[]).map((p) => (
                // biome-ignore lint/a11y/useSemanticElements: chip-style radio, like the other segmented controls
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={p === preset}
                  className="pd-picker-preset"
                  onClick={() => setSort(PICKER_PRESETS[p])}
                >
                  {t(PRESET_LABEL[p])}
                </button>
              ))}
            </div>

            <div className="pd-picker-head">
              <span />
              {header("name", "picker.name")}
              {header("price", "col.price")}
              {header("change", "picker.change")}
              {header("funding", "picker.funding")}
              {header("volume", "picker.volume")}
              {header("oi", "screener.col.oi")}
            </div>

            <ul id={listId} className="pd-picker-list" aria-busy={loading || undefined}>
              {rows.map((r) => {
                const m = r.market;
                const change = r.change24h;
                const decimals = decimalsOf(r.rawPrice ?? "0");
                const trend = change === undefined ? undefined : change >= 0 ? "up" : "down";
                return (
                  <li
                    key={m.id}
                    className="pd-picker-row"
                    aria-current={m.id === selected || undefined}
                  >
                    <StarButton
                      starred={starred.has(m.id)}
                      name={m.symbol}
                      size={14}
                      className="pd-star-small"
                      onToggle={() => onToggleStar(m)}
                    />
                    <button type="button" data-market onClick={() => pick(m)}>
                      <span className="pd-picker-name">
                        <TokenIcon market={m} size={24} />
                        <span className="pd-picker-names">
                          <strong>{m.symbol}</strong>
                          <span className="pd-muted">
                            {m.maxLeverage}x
                            <ListedBy market={m} hint={false} />
                          </span>
                        </span>
                      </span>
                      <span className="pd-num">
                        {value(
                          r.price !== undefined && formatNumber(r.price, decimals),
                          r.price === undefined,
                          64,
                        )}
                      </span>
                      <span className="pd-num pd-picker-change" data-trend={trend}>
                        {value(
                          <>
                            <span>{formatSigned(r.changeAbs ?? 0, decimals)}</span>
                            <span>{formatSigned((change ?? 0) * 100)}%</span>
                          </>,
                          change === undefined,
                          52,
                        )}
                      </span>
                      <span className="pd-num pd-picker-funding">
                        {value(
                          <>
                            {formatSigned((r.funding ?? 0) * 100, 4)}%
                            <span className="pd-muted">
                              /{intervalText(r.fundingIntervalSecs ?? 3600)}
                            </span>
                          </>,
                          r.funding === undefined || r.fundingIntervalSecs === undefined,
                          70,
                        )}
                      </span>
                      <span className="pd-num">
                        {value(`$${formatCompact(r.volume ?? 0)}`, r.volume === undefined, 56)}
                      </span>
                      <span className="pd-num">
                        {value(
                          `$${formatCompact(r.openInterest ?? 0)}`,
                          r.openInterest === undefined,
                          52,
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
              {loading &&
                rows.length === 0 &&
                Array.from({ length: SKELETON_ROWS }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholders, never reordered
                  <li key={i} className="pd-picker-row pd-picker-row-skel" aria-hidden>
                    <span />
                    <span className="pd-picker-skel-cells">
                      <span className="pd-picker-name">
                        <Skel width={24} height={24} />
                        <span className="pd-picker-names">
                          <Skel width={78} height={12} />
                          <Skel width={28} />
                        </span>
                      </span>
                      {SKELETON_WIDTHS.map((w, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed columns
                        <Skel key={j} width={w} />
                      ))}
                    </span>
                  </li>
                ))}
            </ul>
            {rows.length === 0 && !loading && <p className="pd-picker-empty">{empty}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
