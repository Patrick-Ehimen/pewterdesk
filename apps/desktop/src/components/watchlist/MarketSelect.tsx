import type { Market } from "@pewterdesk/core";
import { TokenIcon, t } from "@pewterdesk/ui";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { LuCheck, LuChevronDown, LuSearch } from "react-icons/lu";

/** Results listed at once; a narrower search finds the rest. */
const SHOWN = 120;
/** The list's height at most, and the room it wants before opening upward. */
const LIST_MAX = 300;

interface MarketSelectProps {
  markets: readonly Market[];
  /** The market picked, if any. */
  value?: string;
  onPick: (market: Market) => void;
  /** Accessible name. */
  label: string;
  /** What the trigger says before anything is picked, or always (`fixed`). */
  placeholder: ReactNode;
  /** The trigger always shows `placeholder` (an "Add a market" button). */
  fixed?: boolean;
  /** Markets left out of the list (already in it). */
  exclude?: ReadonlySet<string>;
  className?: string;
}

/**
 * A market dropdown in the app's own style, with a search: a venue lists
 * hundreds of markets. The list is placed against the window, so a column
 * that scrolls can't cut it off, and opens upward when there's no room
 * below. Arrow keys move, Enter picks, Escape or a click outside closes.
 */
export function MarketSelect({
  markets,
  value,
  onPick,
  label,
  placeholder,
  fixed = false,
  exclude,
  className,
}: MarketSelectProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  }>();

  const q = query.trim().toUpperCase();
  const found = markets
    .filter((m) => !exclude?.has(m.id))
    .filter(
      (m) =>
        !q ||
        m.symbol.toUpperCase().includes(q) ||
        m.base.toUpperCase().includes(q) ||
        m.id.toUpperCase().includes(q),
    )
    // Those whose coin starts with what's typed first.
    .sort(
      (a, b) =>
        Number(!a.base.toUpperCase().startsWith(q)) - Number(!b.base.toUpperCase().startsWith(q)),
    )
    .slice(0, SHOWN);
  const picked = markets.find((m) => m.id === value);

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.max(rect.width, 220);
      const left = Math.min(rect.left, window.innerWidth - width - 8);
      const below = window.innerHeight - rect.bottom;
      setPlace(
        below < LIST_MAX + 16 && rect.top > below
          ? { left, width, bottom: window.innerHeight - rect.top + 4 }
          : { left, width, top: rect.bottom + 4 },
      );
    }
    setQuery("");
    setActive(0);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (market: Market | undefined) => {
    if (market) onPick(market);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Placed against the window: anything that moves the trigger closes it.
    const onMove = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onMove);
    document.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the active option moves
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector("[data-active]")?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const onSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, found.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(found[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div ref={rootRef} className={`pd-select wl-market-select ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className="pd-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (["ArrowDown", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="wl-market-select-text">
          {fixed || !picked ? (
            placeholder
          ) : (
            <>
              <TokenIcon market={picked} size={16} />
              {picked.symbol}
            </>
          )}
        </span>
        <LuChevronDown size={13} className="pd-select-chevron" aria-hidden />
      </button>
      {open && place && (
        <div className="wl-market-menu" style={{ position: "fixed", ...place }}>
          <label className="wl-market-search">
            <LuSearch size={13} aria-hidden />
            <input
              aria-label={t("wl.searchMarkets")}
              placeholder={t("wl.searchMarkets")}
              value={query}
              // biome-ignore lint/a11y/noAutofocus: the menu opens to type into it
              autoFocus
              aria-controls={listId}
              aria-activedescendant={found[active] ? `${listId}-${active}` : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
          </label>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            className="wl-market-list"
          >
            {found.length === 0 ? (
              <p className="wl-market-none">{t("wl.noMatch")}</p>
            ) : (
              found.map((m, i) => (
                <div
                  key={m.id}
                  id={`${listId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={m.id === value}
                  data-active={i === active || undefined}
                  className="pd-select-option"
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(m)}
                  onKeyDown={() => {}}
                >
                  <span className="pd-select-check">
                    {m.id === value && <LuCheck size={12} aria-hidden />}
                  </span>
                  <TokenIcon market={m} size={16} />
                  {m.symbol}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
