import type { Market } from "@pewterdesk/core";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { LuSearch } from "react-icons/lu";
import { t } from "../../i18n";
import { matchesSearch } from "../../lib/screener";
import { TokenIcon } from "../trading/TokenIcon";

/** Matches listed at once; typing narrows them. */
const MAX_RESULTS = 40;

interface MarketSearchProps {
  /** Every market that can be picked, in the order to offer them (e.g. busiest first). */
  markets: readonly Market[];
  /** `Market::id` of the one chosen. */
  value?: string;
  onChange: (id: string) => void;
  /** Accessible name for the field. */
  label: string;
}

/**
 * Picking a market by typing: a search field showing the market chosen,
 * with the matches listed under it as you type (the busiest first when the
 * field is empty). Arrow keys move, Enter picks, Escape or a click outside
 * puts the chosen market back.
 */
export function MarketSearch({ markets, value, onChange, label }: MarketSearchProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const chosen = markets.find((m) => m.id === value);

  const needle = query.trim();
  const results = markets.filter((m) => matchesSearch(m, needle)).slice(0, MAX_RESULTS);
  const at = Math.min(active, Math.max(results.length - 1, 0));

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const pick = (market: Market | undefined) => {
    if (!market) return;
    onChange(market.id);
    close();
    inputRef.current?.blur();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  // Keeps the option the arrow keys are on in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the active option moves
  useEffect(() => {
    if (open)
      listRef.current?.querySelector("[data-active]")?.scrollIntoView?.({ block: "nearest" });
  }, [open, at]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((results.length + at + step) % Math.max(results.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[at]);
    } else if (e.key === "Escape") {
      close();
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={rootRef} className="pd-market-search">
      <label className="pd-search pd-market-search-field">
        {chosen && !open ? (
          <TokenIcon market={chosen} size={16} />
        ) : (
          <LuSearch size={14} aria-hidden />
        )}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[at] ? `${listId}-${at}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={chosen?.symbol ?? t("markets.search")}
          value={open ? query : (chosen?.symbol ?? "")}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {open && (
        <div ref={listRef} id={listId} className="pd-market-search-list" role="listbox">
          {results.length === 0 ? (
            <div className="pd-market-search-none">{t("markets.noMatch", { query: needle })}</div>
          ) : (
            results.map((m, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the field handles the keys; this is its listbox
              <div
                key={m.id}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={m.id === value}
                data-active={i === at || undefined}
                className="pd-market-search-option"
                onPointerEnter={() => setActive(i)}
                // Before the field loses focus, so the pick isn't lost to the blur.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pick(m)}
              >
                <TokenIcon market={m} size={16} />
                <span>{m.symbol}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
