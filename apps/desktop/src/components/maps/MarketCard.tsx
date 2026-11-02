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
import { useEffect, useRef } from "react";
import { LuX } from "react-icons/lu";
import { findScanAlert, type ScanAlert } from "../../lib/scanAlerts";

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
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const rows: [string, string][] = read
    ? [
        [t("mapx.scan.change24h"), signedPct(read.change24h)],
        [t("mapx.scanner.regime"), read.regime ? t(`mapx.regime.${read.regime.kind}`) : "-"],
        [t("mapx.regime.adx"), read.regime ? formatNumber(read.regime.adx, 1) : "-"],
        [
          t("mapx.stretch.z"),
          read.stretch ? `${read.stretch.z > 0 ? "+" : ""}${formatNumber(read.stretch.z, 2)}` : "-",
        ],
        [t("mapx.volRank.rank"), read.vol ? `${formatNumber(read.vol.rank * 100, 0)}%` : "-"],
        [
          t("mapx.scanner.div"),
          read.divergence ? t(`mapx.divergence.${read.divergence.kind}`) : "-",
        ],
        [t("mapx.crowded.funding"), signedPct(read.fundingApr, 1)],
      ]
    : [];
  return (
    <dialog
      ref={ref}
      className="wallet-dialog map-card"
      aria-label={market.symbol}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="map-card-head">
        <TokenIcon market={market} size={22} />
        <h2>{market.symbol}</h2>
        {price !== undefined && (
          <span className="map-card-price pd-num">{formatNumber(price, decimals)}</span>
        )}
        <StarButton starred={starred} name={market.symbol} size={16} onToggle={onStar} />
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("maphelp.close")}
          onClick={onClose}
        >
          <LuX size={16} aria-hidden />
        </button>
      </header>
      {!read ? (
        <p className="map-card-note">{t("mapx.card.loading")}</p>
      ) : (
        <>
          <dl className="map-card-grid">
            {rows.map(([label, value]) => (
              <div key={label} className="map-card-row">
                <dt>{label}</dt>
                <dd className="pd-num">{value}</dd>
              </div>
            ))}
          </dl>
          <h3 className="map-card-title">{t("mapx.card.levels")}</h3>
          <dl className="map-card-grid">
            {read.levels?.levels.map((l) => (
              <div key={l.kind} className="map-card-row">
                <dt>{t(`mapx.levels.${l.kind}`)}</dt>
                <dd className="pd-num">
                  {formatNumber(l.price, decimals)}
                  <span className="map-card-away">{signedPct(l.distance)}</span>
                </dd>
              </div>
            ))}
            {read.poc !== undefined && (
              <div className="map-card-row">
                <dt>{t("mapx.card.poc")}</dt>
                <dd className="pd-num">{formatNumber(read.poc, decimals)}</dd>
              </div>
            )}
          </dl>
        </>
      )}
      <h3 className="map-card-title">{t("mapx.card.alerts")}</h3>
      <div className="map-card-rules">
        {SCAN_RULES.map((rule) => (
          <button
            key={rule}
            type="button"
            aria-pressed={findScanAlert(alerts, rule, venue, market.id) !== undefined}
            onClick={() => onAlert(rule)}
          >
            {t(`mapx.alert.rule.${rule}`)}
          </button>
        ))}
      </div>
      <footer className="map-card-foot">
        <button type="button" className="map-card-button" disabled={!read} onClick={onMark}>
          {t("mapx.card.mark")}
        </button>
        <button type="button" className="map-card-button" data-main onClick={onTrade}>
          {t("mapx.card.trade")}
        </button>
      </footer>
    </dialog>
  );
}
