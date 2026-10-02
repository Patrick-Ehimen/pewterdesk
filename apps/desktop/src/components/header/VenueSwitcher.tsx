import { venueLogos } from "@pewterdesk/assets";
import type { VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { LuChevronsDown, LuLandmark, LuSearch } from "react-icons/lu";
import { useFeedAge } from "../../hooks/useFeedAge";
import { useVenueProbe } from "../../hooks/useVenueProbe";
import { VENUES } from "../../lib/venues";

/** A book lag above this isn't latency; the market-list load time shows instead. */
const MAX_LAG_MS = 10_000;

/**
 * The header's venue switcher: a chip per venue in the terminal (logo, name
 * and how fast it answers), the one on screen marked, and a menu with search
 * and a way to the Venues page. The time is the live order book's lag for
 * the venue on screen, else how long its market list took to load.
 */
export function VenueSwitcher({
  venue,
  venues,
  onChange,
  onSeeAll,
}: {
  venue: VenueId;
  /** The venues in the terminal, in order. */
  venues: readonly VenueId[];
  onChange: (venue: VenueId) => void;
  /** Opens the Venues page. */
  onSeeAll: () => void;
}) {
  const probes = useVenueProbe();
  const { feed } = useFeedAge("book", venue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  // The menu closes on Escape or a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const latency = (id: VenueId) => {
    // The live lag only while it's believable: a stalled feed or a drifting
    // clock can put it in the hours, and then the load time says more.
    const lag = id === venue ? feed?.lagMs : undefined;
    if (lag !== undefined && lag >= 0 && lag < MAX_LAG_MS) return `${Math.round(lag)}ms`;
    const probe = probes[id];
    if (probe.status === "up") return `${probe.ms}ms`;
    return probe.status === "down" ? t("venues.unreachable") : "…";
  };
  const pick = (id: VenueId) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  const q = query.trim().toLowerCase();
  const listed = venues.filter((id) => !q || VENUES[id].label.toLowerCase().includes(q));

  return (
    <div ref={wrap} className="venue-switch">
      <div className="venue-chips" role="radiogroup" aria-label={t("venues.switch")}>
        {venues.map((id) => (
          // biome-ignore lint/a11y/useSemanticElements: a chip-style radio, like the other segmented choices
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === venue}
            className="venue-chip"
            data-down={probes[id].status === "down" || undefined}
            onClick={() => id !== venue && onChange(id)}
          >
            <img className="venue-chip-logo" src={venueLogos[id]} alt="" />
            <span className="venue-chip-text">
              <strong>{VENUES[id].label}</strong>
              <span className="venue-chip-ms pd-num">{latency(id)}</span>
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="venue-more"
        aria-label={t("venues.switch")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <LuChevronsDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="venue-menu" role="menu" aria-label={t("venues.switch")}>
          <label className="venue-search">
            <LuSearch size={15} aria-hidden />
            <input
              // biome-ignore lint/a11y/noAutofocus: the menu opens to type into
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("venues.search")}
              aria-label={t("venues.search")}
            />
          </label>
          <div className="venue-menu-list">
            {listed.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={id === venue}
                className="venue-menu-item"
                onClick={() => pick(id)}
              >
                <img className="venue-menu-logo" src={venueLogos[id]} alt="" />
                <span>{VENUES[id].label}</span>
                <span className="venue-menu-ms pd-num">{latency(id)}</span>
              </button>
            ))}
            {listed.length === 0 && <p className="venue-menu-empty">{t("venues.noMatch")}</p>}
          </div>
          <button
            type="button"
            role="menuitem"
            className="venue-menu-all"
            onClick={() => {
              setOpen(false);
              onSeeAll();
            }}
          >
            <LuLandmark size={15} aria-hidden />
            {t("venues.seeAll")}
          </button>
        </div>
      )}
    </div>
  );
}
