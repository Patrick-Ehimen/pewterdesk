import type { Market } from "@pewterdesk/core";
import { formatSigned, t, trendClass } from "@pewterdesk/ui";
import { useMemo } from "react";
import { useCoinSectors } from "../../hooks/useCoinSectors";
import { marketForCoin } from "../../lib/marketMovers";
import { trendingSectors } from "../../lib/sectorTrends";
import { RowsSkeleton } from "./CardSkeletons";

// Beside the market sentiment card, after Bybit's Key Metrics: the sectors
// that moved most over the day, each with its best coin. CoinGecko's sectors,
// as the Maps page's market heatmap reads them. A leader the venue lists
// opens its token's details.

/** Sectors shown. */
const SHOWN = 4;

const pct = (v: number) => `${formatSigned(v * 100, 2)}%`;

export function TrendingSectors({
  markets,
  onOpen,
}: {
  /** The venue's markets, to find a leader's own. */
  markets: readonly Market[];
  onOpen: (market: string) => void;
}) {
  const { groups, done, total, error } = useCoinSectors(true);
  const trends = useMemo(
    () => trendingSectors(groups, SHOWN, (symbol) => marketForCoin(markets, symbol) !== undefined),
    [groups, markets],
  );
  return (
    <section className="sentiment sectors" aria-label={t("screens.sectors")}>
      <header className="sentiment-head">
        <h2>{t("screens.sectors")}</h2>
        <span className="sentiment-sub pd-muted">{t("screens.sectorsSub")}</span>
      </header>
      {trends.length > 0 ? (
        <div className="sectors-body">
          <table className="sectors-table">
            <tbody>
              {trends.map(({ sector, change, leader }) => {
                const market = marketForCoin(markets, leader.symbol);
                const text = (
                  <>
                    {leader.symbol}{" "}
                    <span className={trendClass(leader.change)}>{pct(leader.change)}</span>
                  </>
                );
                return (
                  <tr key={sector}>
                    <th scope="row">{t(`heat.sector.${sector}`)}</th>
                    <td className={`pd-num ${trendClass(change)}`}>{pct(change)}</td>
                    <td className="sectors-leader pd-num">
                      {market ? (
                        <button
                          type="button"
                          className="sectors-open"
                          title={t("screens.details")}
                          onClick={() => onOpen(market.id)}
                        >
                          {text}
                        </button>
                      ) : (
                        text
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Sectors still coming in, one at a time: their places hold. */}
          {done < total && trends.length < SHOWN && (
            <RowsSkeleton rows={SHOWN - trends.length} figures={2} />
          )}
        </div>
      ) : error && done >= total ? (
        <p className="sentiment-empty pd-muted">{t("screens.sectorsUnavailable")}</p>
      ) : (
        <RowsSkeleton rows={SHOWN} figures={2} />
      )}
      <span className="sentiment-source pd-muted">{t("screens.sectorsSource")}</span>
    </section>
  );
}
