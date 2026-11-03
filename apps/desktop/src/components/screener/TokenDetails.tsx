import type { Candle, CandleInterval, Market, MarketSummary, VenueId } from "@pewterdesk/core";
import {
  countVotes,
  dateFormat,
  decimalsOf,
  formatCompact,
  formatNumber,
  formatSigned,
  fundingApr,
  type Rating,
  ratingOf,
  StarButton,
  SummarySkeleton,
  type TechVotes,
  TokenIcon,
  t,
  techBreakdown,
  techScores,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LuArrowRight, LuChevronsDown, LuChevronsUp, LuX } from "react-icons/lu";
import { type Article, newsClient, venueClient } from "../../api/venueClient";
import { useCoinInfo, useNewsWire } from "../../hooks/useVenueFeeds";
import { gaugePoint } from "../../lib/fearGreed";
import { isAnotherCoin, isCryptoMarket } from "../../lib/marketIcons";
import {
  CHART_RANGES,
  type ChartRange,
  changeOver,
  HISTORY_CANDLES,
  HISTORY_DAYS,
  lowHigh,
  namesToken,
  RANGE_CANDLES,
} from "../../lib/tokenDetails";

// A token's details, opened from a Screener row, after Bybit's coin pages:
// its price over a range, how it has moved, CoinGecko's figures and about,
// a technical reading and the headlines that name it. It reads only; Trade
// takes the market to the Trade page.

/** Candles a details view asked for, kept a minute so ranges switch back at once. */
const KEPT_MS = 60_000;
const kept = new Map<string, { at: number; candles: Candle[] }>();
/** Descriptions longer than this start folded. */
const FOLD_AT = 320;
/** Headlines shown at most. */
const NEWS_MAX = 6;

function useCandles(venue: VenueId, market: string, interval: CandleInterval, count: number) {
  const key = `${venue}:${market}:${interval}:${count}`;
  const [state, setState] = useState<{ key: string; candles?: Candle[]; failed?: boolean }>({
    key,
  });
  useEffect(() => {
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < KEPT_MS) {
      setState({ key, candles: hit.candles });
      return;
    }
    let current = true;
    setState({ key });
    venueClient.candles(venue, market, interval, Date.now(), count).then(
      (candles) => {
        kept.set(key, { at: Date.now(), candles });
        if (current) setState({ key, candles });
      },
      () => current && setState({ key, failed: true }),
    );
    return () => {
      current = false;
    };
  }, [key, venue, market, interval, count]);
  return state.key === key ? state : { key };
}

const pct = (v: number | undefined, digits = 2) =>
  v === undefined ? "-" : `${formatSigned(v * 100, digits)}%`;

function PriceChart({
  candles,
  decimals,
  range,
}: {
  candles: readonly Candle[];
  decimals: number;
  range: ChartRange;
}) {
  const fill = useId();
  const [at, setAt] = useState<number>();
  const box = useRef<SVGSVGElement>(null);
  const closes = candles.map((c) => Number(c.close));
  const span = lowHigh(candles);
  if (closes.length < 2 || !span) {
    return <p className="token-chart-empty pd-muted">{t("token.chartEmpty")}</p>;
  }
  const W = 600;
  const H = 200;
  const top = span.high.price;
  const bottom = span.low.price;
  const height = top - bottom || 1;
  const x = (i: number) => (i / (closes.length - 1)) * W;
  const y = (v: number) => 8 + ((top - v) / height) * (H - 16);
  const line = closes.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const up = (closes.at(-1) ?? 0) >= (closes[0] ?? 0);
  const highAt = candles.findIndex((c) => c.openTime === span.high.time);
  const lowAt = candles.findIndex((c) => c.openTime === span.low.time);
  const time = dateFormat(
    range === "24h"
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", ...(range === "1y" ? { year: "2-digit" } : {}) },
  );
  const full = dateFormat({ dateStyle: "medium", timeStyle: "short" });
  const hovered = at === undefined ? undefined : candles[at];
  const ticks = [0, Math.floor((closes.length - 1) / 2), closes.length - 1];

  return (
    <div className="token-chart" data-up={up || undefined}>
      <svg
        ref={box}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("token.chart")}
        onPointerMove={(e) => {
          const r = box.current?.getBoundingClientRect();
          if (!r) return;
          const i = Math.round(((e.clientX - r.left) / r.width) * (closes.length - 1));
          setAt(Math.min(closes.length - 1, Math.max(0, i)));
        }}
        onPointerLeave={() => setAt(undefined)}
      >
        <defs>
          <linearGradient id={fill} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" className="token-chart-fill-top" />
            <stop offset="1" className="token-chart-fill-foot" />
          </linearGradient>
        </defs>
        <path
          className="token-chart-area"
          d={`${line.join(" ")} L${W},${H} L0,${H} Z`}
          fill={`url(#${fill})`}
        />
        <path className="token-chart-line" d={line.join(" ")} />
        {at !== undefined && (
          <line className="token-chart-cross" x1={x(at)} x2={x(at)} y1={0} y2={H} />
        )}
      </svg>
      {/* Markers in px, over the stretched chart, so they stay round. */}
      <span
        className="token-chart-mark"
        data-kind="high"
        style={{ left: `${(highAt / (closes.length - 1)) * 100}%`, top: `${(y(top) / H) * 100}%` }}
      >
        {t("token.high")}
      </span>
      <span
        className="token-chart-mark"
        data-kind="low"
        style={{
          left: `${(lowAt / (closes.length - 1)) * 100}%`,
          top: `${(y(bottom) / H) * 100}%`,
        }}
      >
        {t("token.low")}
      </span>
      {at !== undefined && hovered && (
        <>
          <span
            className="token-chart-dot"
            style={{
              left: `${(at / (closes.length - 1)) * 100}%`,
              top: `${(y(closes[at] as number) / H) * 100}%`,
            }}
          />
          <div
            className="token-chart-tip"
            data-flip={at > closes.length / 2 || undefined}
            style={{ left: `${(at / (closes.length - 1)) * 100}%` }}
          >
            <span className="pd-num">{formatNumber(Number(hovered.close), decimals)}</span>
            <span className="pd-muted">{full.format(hovered.openTime)}</span>
          </div>
        </>
      )}
      <div className="token-chart-times pd-muted pd-num">
        {ticks.map((i) => (
          <span key={i}>{time.format(candles[i]?.openTime ?? 0)}</span>
        ))}
      </div>
    </div>
  );
}

const RATING_SEGMENTS: readonly Rating[] = ["strongSell", "sell", "neutral", "buy", "strongBuy"];

/** The technical reading's timeframes; 1D first, as Bybit's coin pages show it. */
const TECH_INTERVALS = ["1h", "4h", "1d", "1w"] as const;
type TechInterval = (typeof TECH_INTERVALS)[number];
/** Candles the reading is taken on: the 200 averages', settled. */
const TECH_CANDLES = 400;
/** Fewer than this, and the longer averages have nothing to say. */
const TECH_MIN = 101;

/** One group's verdict and its votes, as a line under the dial. */
function GroupLine({ label, score, votes }: { label: string; score: number; votes: TechVotes }) {
  const rating = ratingOf(score);
  return (
    <div className="token-group" data-rating={rating}>
      <span className="token-group-name">{label}</span>
      <strong>{t(`screens.rating.${rating}`)}</strong>
      <span className="token-group-votes pd-num">
        <span data-side="sell">{votes.sell}</span>
        <span data-side="neutral">{votes.neutral}</span>
        <span data-side="buy">{votes.buy}</span>
      </span>
    </div>
  );
}

/** The technical reading on a half dial, Strong sell to Strong buy, as Bybit's. */
function RatingGauge({ score, votes }: { score: number; votes: TechVotes }) {
  const rating = ratingOf(score);
  const value = ((score + 1) / 2) * 100;
  const tip = gaugePoint(value, 60, 58, 34);
  return (
    <div className="token-rating" data-rating={rating}>
      <svg viewBox="0 0 120 66" role="img" aria-label={t(`screens.rating.${rating}`)}>
        {RATING_SEGMENTS.map((segment, i) => {
          const from = gaugePoint(i * 20 + 1.5, 60, 58, 46);
          const to = gaugePoint((i + 1) * 20 - 1.5, 60, 58, 46);
          return (
            <path
              key={segment}
              className="token-rating-seg"
              data-segment={segment}
              data-on={segment === rating || undefined}
              d={`M${from.x} ${from.y} A46 46 0 0 1 ${to.x} ${to.y}`}
            />
          );
        })}
        <line className="token-rating-needle" x1={60} y1={58} x2={tip.x} y2={tip.y} />
        <circle className="token-rating-hub" cx={60} cy={58} r={3.5} />
      </svg>
      <strong className="token-rating-name">{t(`screens.rating.${rating}`)}</strong>
      <dl className="token-rating-votes">
        {(["sell", "neutral", "buy"] as const).map((side) => (
          <div key={side} className="token-vote" data-side={side}>
            <dt>{t(`screens.rating.${side}`)}</dt>
            <dd className="pd-num">{votes[side]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Headline({ article }: { article: Article }) {
  const when = dateFormat({ dateStyle: "medium", timeStyle: "short" });
  return (
    <li>
      <button
        type="button"
        className="token-news-item"
        onClick={() => newsClient.open(article.id).catch(() => {})}
      >
        <span className="token-news-meta pd-muted pd-num">
          {when.format(article.time)} · {article.sourceName}
        </span>
        <span className="token-news-title">{article.title}</span>
      </button>
    </li>
  );
}

export function TokenDetails({
  market,
  venue,
  summary,
  starred,
  onStar,
  onTrade,
  onClose,
}: {
  market: Market;
  venue: VenueId;
  summary?: MarketSummary;
  starred: boolean;
  onStar: () => void;
  onTrade: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const [range, setRange] = useState<ChartRange>("24h");
  const [unfolded, setUnfolded] = useState(false);
  const decimals = decimalsOf(market.tickSize);

  const chart = useCandles(
    venue,
    market.id,
    RANGE_CANDLES[range].interval,
    RANGE_CANDLES[range].count,
  );
  const daily = useCandles(venue, market.id, "1d", HISTORY_CANDLES);
  const [techInterval, setTechInterval] = useState<TechInterval>("1d");
  const tech = useCandles(venue, market.id, techInterval, TECH_CANDLES);

  const mark = summary ? Number(summary.markPrice) : undefined;
  const prev = summary ? Number(summary.prevDayPrice) : undefined;
  const price = mark ?? Number(chart.candles?.at(-1)?.close);
  const change24h = mark !== undefined && prev ? mark / prev - 1 : undefined;

  const base = isCryptoMarket(market) ? market.base : undefined;
  const coin = useCoinInfo(base);
  const info =
    coin.status === "live" && coin.data && !isAnotherCoin(coin.data, market.base, price)
      ? coin.data
      : undefined;

  const breakdown =
    tech.candles && tech.candles.length >= TECH_MIN ? techBreakdown(tech.candles) : undefined;
  const scores = breakdown && techScores(breakdown);
  const maVotes = breakdown && countVotes(Object.values(breakdown.ma));
  const oscVotes = breakdown && countVotes(Object.values(breakdown.osc));
  const span = chart.candles && lowHigh(chart.candles);

  const news = useNewsWire(true);
  const headlines = useMemo(
    () =>
      news.status === "live"
        ? news.data
            .filter((a) => namesToken(`${a.title} ${a.summary}`, market.base, info?.name))
            .slice(0, NEWS_MAX)
        : [],
    [news, market.base, info?.name],
  );

  const usd = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v) ? "-" : `$${formatCompact(v)}`;
  const stats: [string, string][] = [
    [t("token.marketCap"), usd(info?.marketCap)],
    [t("token.volume"), usd(summary ? Number(summary.dayVolume) : undefined)],
    [
      t("token.oi"),
      usd(summary && mark !== undefined ? Number(summary.openInterest) * mark : undefined),
    ],
    [
      t("token.funding"),
      summary ? pct(fundingApr(Number(summary.fundingRate), summary.fundingIntervalSecs)) : "-",
    ],
    [t("token.circulating"), info?.circulatingSupply ? formatCompact(info.circulatingSupply) : "-"],
    [t("token.fdv"), usd(info?.fdv)],
    [t("token.maxLeverage"), market.maxLeverage > 0 ? `${market.maxLeverage}x` : "-"],
  ];
  const foldable = (info?.description.length ?? 0) > FOLD_AT;

  return (
    <dialog
      ref={ref}
      className="wallet-dialog token-details"
      aria-label={market.symbol}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="token-head">
        <TokenIcon market={market} size={30} />
        <div className="token-title">
          <h2>
            {info?.name ?? market.base}
            <span className="pd-muted">{market.symbol}</span>
            {market.maxLeverage > 0 && (
              <span className="screener-lev" title={t("token.maxLeverage")}>
                {market.maxLeverage}x
              </span>
            )}
          </h2>
          <p>
            <span className="token-price pd-num">
              {Number.isFinite(price) ? formatNumber(price, decimals) : "-"}
            </span>
            {change24h !== undefined && (
              <span className={`token-change pd-num ${trendClass(change24h)}`}>
                {pct(change24h)}
              </span>
            )}
          </p>
        </div>
        <span className="app-spacer" />
        <StarButton starred={starred} name={market.symbol} size={18} onToggle={onStar} />
        <button type="button" className="token-trade" title={t("screens.open")} onClick={onTrade}>
          {t("token.trade")}
          <LuArrowRight size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="token-close"
          aria-label={t("token.close")}
          title={t("token.close")}
          onClick={onClose}
        >
          <LuX size={18} aria-hidden />
        </button>
      </header>

      <div className="token-grid">
        <div className="token-main">
          <section className="token-card">
            <div className="token-chart-bar">
              <fieldset className="token-ranges" aria-label={t("token.ranges")}>
                {CHART_RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="token-range"
                    aria-pressed={r === range}
                    onClick={() => setRange(r)}
                  >
                    {t(`token.range.${r}`)}
                  </button>
                ))}
              </fieldset>
              {span && (
                <p className="token-span pd-num">
                  <span data-kind="low">{t("token.low")}</span>
                  {formatNumber(span.low.price, decimals)}
                  <span data-kind="high">{t("token.high")}</span>
                  {formatNumber(span.high.price, decimals)}
                </p>
              )}
            </div>
            {chart.candles ? (
              <PriceChart candles={chart.candles} decimals={decimals} range={range} />
            ) : chart.failed ? (
              <p className="token-chart-empty pd-muted">{t("token.chartEmpty")}</p>
            ) : (
              <div className="token-chart-empty">
                <SummarySkeleton rows={4} title={false} />
              </div>
            )}
          </section>

          <section className="token-card">
            <h3 className="token-h3">{t("token.stats")}</h3>
            <dl className="token-stats">
              {stats.map(([name, value]) => (
                <div key={name}>
                  <dt className="pd-muted">{name}</dt>
                  <dd className="pd-num">{value}</dd>
                </div>
              ))}
            </dl>
            {info && <p className="token-source pd-muted">{t("token.source")}</p>}
          </section>

          {info?.description && (
            <section className="token-card">
              <h3 className="token-h3">{t("coin.about", { symbol: info.symbol })}</h3>
              <p className="token-about" data-folded={(foldable && !unfolded) || undefined}>
                {info.description}
              </p>
              {foldable && (
                <button type="button" className="coin-more" onClick={() => setUnfolded((u) => !u)}>
                  {t(unfolded ? "coin.showLess" : "coin.showMore")}
                  {unfolded ? (
                    <LuChevronsUp size={15} aria-hidden />
                  ) : (
                    <LuChevronsDown size={15} aria-hidden />
                  )}
                </button>
              )}
            </section>
          )}

          <section className="token-card">
            <h3 className="token-h3">{t("token.news", { symbol: market.base })}</h3>
            {headlines.length > 0 ? (
              <ul className="token-news">
                {headlines.map((a) => (
                  <Headline key={a.id} article={a} />
                ))}
              </ul>
            ) : (
              <p className="pd-muted">{t("token.noNews", { symbol: market.base })}</p>
            )}
          </section>
        </div>

        <aside className="token-side">
          <section className="token-card">
            <h3 className="token-h3">{t("token.history")}</h3>
            <dl className="token-history">
              <div className="token-row">
                <dt>{t("token.today")}</dt>
                <dd className={`pd-num ${change24h === undefined ? "" : trendClass(change24h)}`}>
                  {pct(change24h)}
                </dd>
              </div>
              {HISTORY_DAYS.map((days) => {
                const change = daily.candles && changeOver(daily.candles, days, price);
                return (
                  <div key={days} className="token-row">
                    <dt>{t("token.days", { count: days })}</dt>
                    <dd className={`pd-num ${change === undefined ? "" : trendClass(change)}`}>
                      {pct(change)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>

          <section className="token-card">
            <h3 className="token-h3">{t("token.technical", { symbol: market.symbol })}</h3>
            <fieldset className="token-ranges" aria-label={t("token.timeframe")}>
              {TECH_INTERVALS.map((iv) => (
                <button
                  key={iv}
                  type="button"
                  className="token-range"
                  aria-pressed={iv === techInterval}
                  onClick={() => setTechInterval(iv)}
                >
                  {t(`token.tf.${iv}`)}
                </button>
              ))}
            </fieldset>
            {scores && maVotes && oscVotes ? (
              <>
                <RatingGauge
                  score={scores.all}
                  votes={{
                    sell: maVotes.sell + oscVotes.sell,
                    neutral: maVotes.neutral + oscVotes.neutral,
                    buy: maVotes.buy + oscVotes.buy,
                  }}
                />
                <div className="token-groups">
                  <GroupLine label={t("token.oscillators")} score={scores.osc} votes={oscVotes} />
                  <GroupLine label={t("token.averages")} score={scores.ma} votes={maVotes} />
                </div>
              </>
            ) : tech.failed || (tech.candles && tech.candles.length < TECH_MIN) ? (
              <p className="pd-muted">{t("token.technicalShort")}</p>
            ) : (
              <SummarySkeleton rows={3} title={false} />
            )}
            <p className="token-source pd-muted">{t("token.technicalNote")}</p>
          </section>
        </aside>
      </div>
    </dialog>
  );
}
