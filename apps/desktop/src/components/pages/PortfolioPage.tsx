import type { AccountSnapshot, Market } from "@pewterdesk/core";
import {
  EmptyState,
  formatNumber,
  formatPercent,
  formatSigned,
  t,
  trendClass,
} from "@pewterdesk/ui";
import type { Feed } from "../../hooks/useVenueFeeds";
import { portfolioSummary } from "../../lib/portfolio";

interface PortfolioPageProps {
  account: Feed<AccountSnapshot>;
  markets: Market[];
  /** The venue's display name, e.g. "Hyperliquid". */
  venue: string;
  onConnect: () => void;
}

function Card({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <div className="page-card">
      <span className="page-card-label">{label}</span>
      <strong className={`page-card-value ${tone ?? ""}`}>{value}</strong>
      <span className="page-card-note">{note}</span>
    </div>
  );
}

/**
 * The watched account across venues, after the design's portfolio screen.
 * One venue so far, so "by venue" is Hyperliquid alone; funding history isn't
 * wired up yet, so the design's funding panel is left out rather than faked.
 */
export function PortfolioPage({ account, markets, venue, onConnect }: PortfolioPageProps) {
  const quote = markets[0]?.quote ?? "USDC";
  const baseOf = (id: string) => markets.find((m) => m.id === id)?.base ?? id;

  const body = (() => {
    switch (account.status) {
      case "idle":
        return (
          <div className="page-empty">
            <p>{t("portfolio.empty")}</p>
            <button type="button" className="settings-button" data-primary onClick={onConnect}>
              {t("wallet.connect")}
            </button>
          </div>
        );
      case "loading":
        return <EmptyState>{t("feed.loading")}</EmptyState>;
      case "error":
        return <EmptyState error>{account.message}</EmptyState>;
      default: {
        const s = portfolioSummary(account.data);
        const bias =
          Math.abs(s.net) < 0.005
            ? t("portfolio.netFlat")
            : t(s.net > 0 ? "portfolio.netLong" : "portfolio.netShort");
        return (
          <>
            {account.status === "closed" && (
              <p className="pd-stale" role="status">
                {t("feed.closed")}
              </p>
            )}
            <div className="page-cards">
              <Card
                label={t("account.equity")}
                value={formatNumber(s.equity, 2)}
                note={t("portfolio.equityNote", { quote, venue })}
              />
              <Card
                label={t("account.upnl")}
                value={formatSigned(s.unrealizedPnl)}
                tone={trendClass(s.unrealizedPnl)}
                note={t("portfolio.positionsNote", { count: s.positions })}
              />
              <Card
                label={t("account.marginUsed")}
                value={formatNumber(s.marginUsed, 2)}
                note={t("portfolio.marginNote", { percent: formatPercent(s.marginRatio) })}
              />
              <Card
                label={t("portfolio.gross")}
                value={formatNumber(s.gross, 2)}
                note={t("portfolio.grossNote", { ratio: formatNumber(s.grossRatio, 2) })}
              />
              <Card label={t("portfolio.net")} value={formatSigned(s.net)} note={bias} />
            </div>

            <div className="page-columns">
              <section className="page-panel" aria-labelledby="portfolio-assets">
                <header className="page-panel-head">
                  <h2 id="portfolio-assets">{t("portfolio.byAsset")}</h2>
                  <span>{t("portfolio.byAssetNote")}</span>
                </header>
                {s.byAsset.length === 0 ? (
                  <EmptyState>{t("positions.empty")}</EmptyState>
                ) : (
                  <table className="pd-table">
                    <thead>
                      <tr>
                        <th>{t("portfolio.col.asset")}</th>
                        <th>{t("portfolio.col.venue")}</th>
                        <th className="pd-num">{t("portfolio.col.netSize")}</th>
                        <th className="pd-num">{t("portfolio.col.netNotional")}</th>
                        <th className="pd-num">{t("portfolio.col.share")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.byAsset.map((a) => (
                        <tr key={`${a.venue}:${a.market}`}>
                          <td className="pd-strong pd-num page-asset">{baseOf(a.market)}</td>
                          <td className="pd-muted">{venue}</td>
                          <td className={`pd-num ${trendClass(a.netSize)}`}>
                            {formatSigned(a.netSize, 4).replace(/\.?0+$/, "")}
                          </td>
                          <td className="pd-num">{formatNumber(a.netNotional, 2)}</td>
                          <td className="pd-num">{formatPercent(a.share, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="page-panel" aria-labelledby="portfolio-venues">
                <header className="page-panel-head">
                  <h2 id="portfolio-venues">{t("portfolio.byVenue")}</h2>
                </header>
                <div className="page-venues">
                  <div className="page-venue">
                    <div className="page-venue-row">
                      <span className="page-venue-name">
                        <span className="page-venue-badge" aria-hidden>
                          HL
                        </span>
                        {venue}
                      </span>
                      <span className="pd-num">{formatNumber(s.equity, 2)}</span>
                    </div>
                    <div className="page-meter" aria-hidden>
                      <div data-accent style={{ width: "100%" }} />
                    </div>
                    <div className="page-venue-row pd-muted">
                      <span>{t("account.marginUsed")}</span>
                      <span className="pd-num">{formatPercent(s.marginRatio, 1)}</span>
                    </div>
                    <div className="page-meter" aria-hidden>
                      <div style={{ width: `${Math.min(s.marginRatio, 1) * 100}%` }} />
                    </div>
                  </div>
                  <p className="page-note">{t("portfolio.byVenueNote")}</p>
                </div>
              </section>
            </div>
          </>
        );
      }
    }
  })();

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("nav.portfolio")}</h1>
        <span>{t("portfolio.subtitle")}</span>
      </header>
      {body}
    </div>
  );
}
