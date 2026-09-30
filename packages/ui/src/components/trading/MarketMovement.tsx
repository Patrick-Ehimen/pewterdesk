import type { Market, MarketSummary, VenueId } from "@pewterdesk/core";
import { useState } from "react";
import { t } from "../../i18n";
import { formatCompact, formatSigned } from "../../lib/format";
import { topMovers, venueMovement } from "../../lib/movement";

export interface MovementVenue {
  id: VenueId;
  label: string;
  logo?: string;
  /** Unset while they load. */
  summaries?: readonly MarketSummary[];
  /** For movers' names; ids show until it arrives. */
  markets: readonly Market[];
}

/** Markets trading less than this a day don't lead the movers. */
const MOVER_MIN_VOLUME = 1_000_000;
const MOVERS = 3;

const pct = (fraction: number) => `${formatSigned(fraction * 100)}%`;
const trendOf = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : undefined);

/**
 * The bottom bar's market movement, after the design's popover: each venue's
 * 24h volume and open interest (Volume), and which way its markets moved
 * and the biggest movers (Activity). From the venues' market summaries.
 */
export function MarketMovement({
  venues,
  onOpenMarket,
}: {
  venues: readonly MovementVenue[];
  onOpenMarket: (venue: VenueId, market: string) => void;
}) {
  const [tab, setTab] = useState<"volume" | "activity">("volume");
  const loaded = venues.filter((v) => v.summaries);
  const totals = loaded.map((v) => ({ venue: v, m: venueMovement(v.summaries ?? []) }));
  const totalVolume = totals.reduce((sum, x) => sum + x.m.volume, 0);
  const totalOi = totals.reduce((sum, x) => sum + x.m.openInterest, 0);
  const maxVolume = Math.max(1, ...totals.map((x) => x.m.volume));
  const maxOi = Math.max(1, ...totals.map((x) => x.m.openInterest));
  const movers = topMovers(
    loaded.map((v) => ({ venue: v, summaries: v.summaries ?? [] })),
    MOVERS,
    MOVER_MIN_VOLUME,
  );
  const symbolOf = (v: MovementVenue, id: string) =>
    v.markets.find((m) => m.id === id)?.symbol ?? id;
  const waiting = loaded.length === 0;

  const bars = (value: (m: (typeof totals)[number]["m"]) => number, max: number) =>
    venues.map((v) => {
      const row = totals.find((x) => x.venue.id === v.id);
      return (
        <li key={v.id} className="pd-move-row">
          {v.logo ? <img src={v.logo} alt="" width={16} height={16} /> : <span />}
          <span className="pd-visually-hidden">{v.label}</span>
          <span className="pd-move-track">
            {row ? (
              <span
                className="pd-move-bar"
                data-venue={v.id}
                style={{ width: `${Math.max(2, (value(row.m) / max) * 100)}%` }}
              />
            ) : (
              <span className="pd-skel pd-move-bar-skel" />
            )}
          </span>
          <span className="pd-num">{row ? `$${formatCompact(value(row.m))}` : "-"}</span>
        </li>
      );
    });

  const moverList = (list: typeof movers.up) =>
    list.map((m) => (
      <li key={`${m.venue.id}:${m.market}`}>
        <button type="button" onClick={() => onOpenMarket(m.venue.id, m.market)}>
          {m.venue.logo && <img src={m.venue.logo} alt="" width={14} height={14} />}
          <span className="pd-move-mover-name">{symbolOf(m.venue, m.market)}</span>
          <span className="pd-num" data-trend={trendOf(m.change)}>
            {pct(m.change)}
          </span>
        </button>
      </li>
    ));

  return (
    <div className="pd-move">
      <div className="pd-move-head">
        <span className="pd-move-title">
          <span className="pd-move-dot" data-live={!waiting || undefined} aria-hidden />
          {t("movement.title")}
        </span>
        <span className="pd-move-window">24H</span>
      </div>
      <div className="pd-move-tabs" role="tablist">
        {(["volume", "activity"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === tab}
            onClick={() => setTab(id)}
          >
            {t(id === "volume" ? "movement.volume" : "movement.activity")}
          </button>
        ))}
      </div>

      {tab === "volume" ? (
        <>
          <div className="pd-move-total">
            <span>{t("movement.totalVolume")}</span>
            <strong className="pd-num">{waiting ? "-" : `$${formatCompact(totalVolume)}`}</strong>
          </div>
          <ul className="pd-move-rows">{bars((m) => m.volume, maxVolume)}</ul>
          <div className="pd-move-total">
            <span>{t("movement.openInterest")}</span>
            <strong className="pd-num">{waiting ? "-" : `$${formatCompact(totalOi)}`}</strong>
          </div>
          <ul className="pd-move-rows">{bars((m) => m.openInterest, maxOi)}</ul>
        </>
      ) : (
        <>
          <p className="pd-move-sub">{t("movement.breadth")}</p>
          <ul className="pd-move-breadth">
            {venues.map((v) => {
              const row = totals.find((x) => x.venue.id === v.id);
              const all = row ? row.m.up + row.m.down + row.m.flat : 0;
              return (
                <li key={v.id}>
                  <span className="pd-move-venue">
                    {v.logo && <img src={v.logo} alt="" width={16} height={16} />}
                    {v.label}
                  </span>
                  {row && all > 0 ? (
                    <>
                      <span className="pd-move-split" aria-hidden>
                        <span
                          className="pd-move-seg"
                          data-trend="up"
                          style={{ flexGrow: row.m.up }}
                        />
                        <span
                          className="pd-move-seg"
                          data-trend="down"
                          style={{ flexGrow: row.m.down }}
                        />
                      </span>
                      <span className="pd-num pd-move-counts">
                        <span data-trend="up">{row.m.up}</span> /{" "}
                        <span data-trend="down">{row.m.down}</span>
                      </span>
                      <span className="pd-num" data-trend={trendOf(row.m.change)}>
                        {pct(row.m.change)}
                      </span>
                    </>
                  ) : (
                    <span className="pd-skel pd-move-bar-skel" />
                  )}
                </li>
              );
            })}
          </ul>
          <p className="pd-move-sub">{t("movement.movers")}</p>
          <div className="pd-move-movers">
            <ul>{moverList(movers.up)}</ul>
            <ul>{moverList(movers.down)}</ul>
          </div>
        </>
      )}
      <p className="pd-move-note">{t("movement.note")}</p>
    </div>
  );
}
