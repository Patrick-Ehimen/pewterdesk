import type { Market, MarketSummary } from "@pewterdesk/core";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
}

/**
 * A searchable market list in a popover, like an exchange's market selector:
 * tabs for favorites, the venue's own perps and builder-deployed (HIP-3)
 * ones; Top / Gainers / Losers; sortable price, 24h change and volume; a
 * star per market. Type to filter, arrows to move, Enter to pick, Escape or
 * a click outside to close.
 */
export function MarketPicker({
  markets,
  selected,
  onSelect,
  summaries,
  starred,
  onToggleStar,
  onOpenChange,
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

  const rows = pickerView(pickerRows(markets, summaries), tab, starred, query, sort);
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
    tab === "favorites" && starred.size === 0 && !query.trim()
      ? t("picker.noFavorites")
      : t("markets.noMatch", { query });

  return (
    <>
      <IconButton
        ref={buttonRef}
        label={t("stats.chooseMarket")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <LuMenu size={18} aria-hidden />
      </IconButton>
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

            <div className="pd-picker-tabs" role="tablist" aria-label={t("picker.categories")}>
              {PICKER_TABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={id === tab}
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
              {header("volume", "picker.volume")}
            </div>

            <ul id={listId} className="pd-picker-list">
              {rows.map((r) => {
                const m = r.market;
                const change = r.change24h;
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
                        {r.price === undefined
                          ? "-"
                          : formatNumber(r.price, decimalsOf(r.rawPrice ?? "0"))}
                      </span>
                      <span
                        className="pd-num"
                        data-trend={change === undefined ? undefined : change >= 0 ? "up" : "down"}
                      >
                        {change === undefined ? "-" : `${formatSigned(change * 100)}%`}
                      </span>
                      <span className="pd-num">
                        {r.volume === undefined ? "-" : `$${formatCompact(r.volume)}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {rows.length === 0 && <p className="pd-picker-empty">{empty}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
