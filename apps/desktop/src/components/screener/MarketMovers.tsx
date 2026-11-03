import { formatSigned, TokenIcon, t, trendClass } from "@pewterdesk/ui";
import { useState } from "react";
import { type Mover, topMovers, trendDistribution } from "../../lib/marketMovers";
import { RowsSkeleton, TrendSkeleton } from "./CardSkeletons";

// Two of the Screener's cards, after Bybit's Key Metrics: the day's top
// movers on the venue, and how many of its markets are up, down or flat.
// Both from the summaries the Screener already reads; a mover opens its
// token's details.

/** Movers shown on each side. */
const SHOWN = 4;

const pct = (v: number) => `${formatSigned(v * 100, 2)}%`;

export function TopMovers({
  changes,
  loading,
  onOpen,
}: {
  changes: readonly Mover[];
  /** The venue's markets or prices haven't come in yet. */
  loading: boolean;
  onOpen: (market: string) => void;
}) {
  const [side, setSide] = useState<"gainers" | "losers">("gainers");
  const movers = topMovers(changes, SHOWN)[side];
  return (
    <section className="sentiment movers" aria-label={t("screens.movers")}>
      <header className="sentiment-head">
        <h2>{t("screens.movers")}</h2>
        <fieldset className="movers-sides" aria-label={t("screens.movers")}>
          {(["gainers", "losers"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className="token-range"
              aria-pressed={s === side}
              onClick={() => setSide(s)}
            >
              {t(`screens.movers.${s}`)}
            </button>
          ))}
        </fieldset>
      </header>
      {loading ? (
        <RowsSkeleton rows={SHOWN} figures={1} dot />
      ) : movers.length > 0 ? (
        <ul className="movers-list">
          {movers.map(({ market, change }) => (
            <li key={market.id}>
              <button
                type="button"
                className="movers-row"
                title={t("screens.details")}
                onClick={() => onOpen(market.id)}
              >
                <TokenIcon market={market} size={16} />
                <span className="movers-symbol">{market.base}</span>
                <span className={`movers-change pd-num ${trendClass(change)}`}>{pct(change)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sentiment-empty pd-muted">{t("screens.movers.none")}</p>
      )}
      <span className="sentiment-source pd-muted">{t("screens.movers.source")}</span>
    </section>
  );
}

export function TrendDistribution({
  changes,
  loading,
}: {
  changes: readonly Mover[];
  /** The venue's markets or prices haven't come in yet. */
  loading: boolean;
}) {
  const { up, down, flat } = trendDistribution(changes);
  const total = up + down + flat;
  const share = (n: number) => `${total === 0 ? 0 : (n / total) * 100}%`;
  return (
    <section className="sentiment trend" aria-label={t("screens.trend")}>
      <header className="sentiment-head">
        <h2>{t("screens.trend")}</h2>
        <span className="sentiment-sub pd-muted">{t("screens.trendSub")}</span>
      </header>
      {loading ? (
        <TrendSkeleton />
      ) : total > 0 ? (
        <div className="trend-body">
          <div
            className="trend-bar"
            role="img"
            aria-label={t("screens.trendLabel", { down, flat, up })}
          >
            <span className="trend-seg" data-side="down" style={{ width: share(down) }} />
            <span className="trend-seg" data-side="flat" style={{ width: share(flat) }} />
            <span className="trend-seg" data-side="up" style={{ width: share(up) }} />
          </div>
          <dl className="trend-counts">
            <div className="trend-count" data-side="down">
              <dt className="trend-label">{t("screens.trendDown")}</dt>
              <dd className="trend-number pd-num">{down}</dd>
            </div>
            <div className="trend-count" data-side="flat">
              <dt className="trend-label">{t("screens.trendFlat")}</dt>
              <dd className="trend-number pd-num">{flat}</dd>
            </div>
            <div className="trend-count" data-side="up">
              <dt className="trend-label">{t("screens.trendUp")}</dt>
              <dd className="trend-number pd-num">{up}</dd>
            </div>
          </dl>
          <p className="trend-breadth pd-muted">
            {t("screens.trendBreadth", { share: Math.round((up / total) * 100) })}
          </p>
        </div>
      ) : (
        <p className="sentiment-empty pd-muted">{t("screens.movers.none")}</p>
      )}
    </section>
  );
}
