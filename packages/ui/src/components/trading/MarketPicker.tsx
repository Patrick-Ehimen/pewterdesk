import type { Market } from "@pewterdesk/core";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuMenu } from "react-icons/lu";
import { t } from "../../i18n";
import { IconButton } from "../common/IconButton";

const GAP = 6;

interface MarketPickerProps {
  markets: Market[];
  /** `Market::id` of the current market. */
  selected?: string;
  onSelect: (market: Market) => void;
}

/**
 * A searchable market list in a popover. Type to filter, arrows to move,
 * Enter to pick, Escape or a click outside to close.
 */
export function MarketPicker({ markets, selected, onSelect }: MarketPickerProps) {
  const listId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<{ top: number; left: number }>();

  const needle = query.trim().toUpperCase();
  const shown = needle ? markets.filter((m) => m.symbol.toUpperCase().includes(needle)) : markets;

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
    } else if (e.key === "Enter" && at === -1 && shown[0]) {
      // Enter in the search box picks the top match.
      e.preventDefault();
      pick(shown[0]);
    }
  };

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
            <input
              className="pd-input"
              type="search"
              placeholder={t("markets.search")}
              aria-label={t("markets.search")}
              aria-controls={listId}
              // biome-ignore lint/a11y/noAutofocus: the picker opens to be searched
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul id={listId} className="pd-picker-list">
              {shown.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    data-market
                    aria-current={m.id === selected || undefined}
                    onClick={() => pick(m)}
                  >
                    <span className="pd-num">{m.symbol}</span>
                    <span className="pd-muted">{m.maxLeverage}x</span>
                  </button>
                </li>
              ))}
            </ul>
            {shown.length === 0 && (
              <p className="pd-picker-empty">{t("markets.noMatch", { query })}</p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
