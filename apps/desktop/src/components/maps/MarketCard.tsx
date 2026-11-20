import type { Market, VenueId } from "@pewterdesk/core";
import {
  formatNumber,
  type MarketReadings,
  SCAN_RULES,
  type ScanRule,
  StarButton,
  signedPct,
  TokenIcon,
  t,
} from "@pewterdesk/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { LuArrowUpRight, LuBell, LuBellRing, LuChartLine, LuX } from "react-icons/lu";
import { findScanAlert, type ScanAlert } from "../../lib/scanAlerts";

/** Up, down or neither: market data only, so green and red are allowed here. */
type Tone = "up" | "down" | undefined;
const toneOf = (n: number | undefined): Tone =>
  n === undefined || !Number.isFinite(n) || n === 0 ? undefined : n > 0 ? "up" : "down";

/** A level on the ladder, or the price now between them. */
type Rung =
  | { kind: "level"; key: string; name: string; price: number; distance?: number }
  | { kind: "now"; key: "now"; price: number };

/**
 * One market's readings together, from any scan: what it's doing, its levels,
 * and ways on from here. It reads and notifies; it places nothing.
 */
export function MarketCard({
  market,
  venue,
  price,
  decimals,
  read,
  starred,
  alerts,
  onStar,
  onAlert,
  onMark,
  onTrade,
  onClose,
}: {
  market: Market;
  venue: VenueId;
  price?: number;
  decimals: number;
  read?: MarketReadings;
  starred: boolean;
  alerts: readonly ScanAlert[];
  onStar: () => void;
  onAlert: (rule: ScanRule) => void;
  onMark: () => void;
  onTrade: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // showModal focuses the first button (the star), ringed as if tabbed to:
    // the card itself takes focus instead, and Tab still walks its buttons.
    dialog.focus();
  }, []);

  const tiles: { label: string; value: ReactNode; tone?: Tone; meter?: number }[] = read
    ? [
        {
          label: t("mapx.scanner.regime"),
          value: read.regime ? t(`mapx.regime.${read.regime.kind}`) : "-",
          tone:
            read.regime?.kind === "trendUp"
              ? "up"
              : read.regime?.kind === "trendDown"
                ? "down"
                : undefined,
        },
        {
          label: t("mapx.regime.adx"),
          value: read.regime ? formatNumber(read.regime.adx, 1) : "-",
          meter: read.regime ? Math.min(1, read.regime.adx / 50) : undefined,
        },
        {
          label: t("mapx.card.volRank"),
          value: read.vol ? `${formatNumber(read.vol.rank * 100, 0)}%` : "-",
          meter: read.vol?.rank,
        },
        {
          label: t("mapx.card.stretch"),
          value: read.stretch
            ? `${read.stretch.z > 0 ? "+" : ""}${formatNumber(read.stretch.z, 2)}σ`
            : "-",
        },
        {
          label: t("mapx.scanner.div"),
          value: read.divergence ? t(`mapx.divergence.${read.divergence.kind}`) : "-",
          tone: read.divergence ? (read.divergence.kind === "bullish" ? "up" : "down") : undefined,
        },
        {
          label: t("mapx.crowded.funding"),
          value: signedPct(read.fundingApr, 1),
        },
      ]
    : [];

  // The levels high to low, with the price now slotted in where it sits.
  const rungs: Rung[] = [];
  if (read) {
    for (const l of read.levels?.levels ?? []) {
      rungs.push({
        kind: "level",
        key: l.kind,
        name: t(`mapx.levels.${l.kind}`),
        price: l.price,
        distance: l.distance,
      });
    }
    if (read.poc !== undefined) {
      rungs.push({
        kind: "level",
        key: "poc",
        name: t("mapx.card.poc"),
        price: read.poc,
        distance: price ? read.poc / price - 1 : undefined,
      });
    }
    rungs.sort((a, b) => b.price - a.price);
    if (price !== undefined && rungs.length > 0) {
      const at = rungs.findIndex((r) => r.price < price);
      rungs.splice(at === -1 ? rungs.length : at, 0, { kind: "now", key: "now", price });
    }
  }

  const change = read?.change24h;
  return (
    <dialog
      ref={ref}
      className="wallet-dialog map-card"
      aria-label={market.symbol}
      tabIndex={-1}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="map-card-head">
        <span className="map-card-icon">
          <TokenIcon market={market} size={32} />
        </span>
        <div className="map-card-name">
          <h2>{market.symbol}</h2>
          {(price !== undefined || change !== undefined) && (
            <div className="map-card-quote">
              {price !== undefined && (
                <span className="map-card-price pd-num">{formatNumber(price, decimals)}</span>
              )}
              {change !== undefined && (
                <span className="map-card-chip pd-num" data-tone={toneOf(change)}>
                  {signedPct(change)}
                  <small>{t("mapx.scan.change24h")}</small>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="map-card-tools">
          <StarButton starred={starred} name={market.symbol} size={16} onToggle={onStar} />
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("maphelp.close")}
            onClick={onClose}
          >
            <LuX size={16} aria-hidden />
          </button>
        </div>
      </header>

      <div className="map-card-body">
        {!read ? (
          <div className="map-card-loading" role="status">
            <span className="pd-skel" />
            <span className="pd-skel" />
            <span className="pd-skel" />
            <p>{t("mapx.card.loading")}</p>
          </div>
        ) : (
          <>
            <section>
              <h3 className="map-card-title">{t("mapx.card.snapshot")}</h3>
              <div className="map-card-tiles">
                {tiles.map((tile) => (
                  <div key={tile.label} className="map-card-tile">
                    <span>{tile.label}</span>
                    <b className="pd-num" data-tone={tile.tone}>
                      {tile.value}
                    </b>
                    {tile.meter !== undefined && (
                      <i className="map-card-meter">
                        <i style={{ width: `${Math.max(0, Math.min(1, tile.meter)) * 100}%` }} />
                      </i>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {rungs.length > 0 && (
              <section>
                <h3 className="map-card-title">{t("mapx.card.levels")}</h3>
                <ol className="map-card-ladder">
                  {rungs.map((r) =>
                    r.kind === "now" ? (
                      <li key={r.key} className="map-card-now">
                        <span>{t("mapx.card.now")}</span>
                        <b className="pd-num">{formatNumber(r.price, decimals)}</b>
                      </li>
                    ) : (
                      <li
                        key={r.key}
                        data-side={price !== undefined && r.price >= price ? "above" : "below"}
                      >
                        <span>{r.name}</span>
                        <b className="pd-num">{formatNumber(r.price, decimals)}</b>
                        <em className="pd-num">{signedPct(r.distance)}</em>
                      </li>
                    ),
                  )}
                </ol>
              </section>
            )}
          </>
        )}

        <section>
          <h3 className="map-card-title">{t("mapx.card.alerts")}</h3>
          <div className="map-card-rules">
            {SCAN_RULES.map((rule) => {
              const on = findScanAlert(alerts, rule, venue, market.id) !== undefined;
              return (
                <button key={rule} type="button" aria-pressed={on} onClick={() => onAlert(rule)}>
                  {on ? <LuBellRing size={13} aria-hidden /> : <LuBell size={13} aria-hidden />}
                  {t(`mapx.alert.rule.${rule}`)}
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <footer className="map-card-foot">
        <button type="button" className="map-card-button" disabled={!read} onClick={onMark}>
          <LuChartLine size={15} aria-hidden />
          {t("mapx.card.mark")}
        </button>
        <button type="button" className="map-card-button" data-main onClick={onTrade}>
          {t("mapx.card.trade")}
          <LuArrowUpRight size={15} aria-hidden />
        </button>
      </footer>
    </dialog>
  );
}
