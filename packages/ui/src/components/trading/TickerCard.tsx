import type { Candle, Market, MarketSummary } from "@pewterdesk/core";
import { LuChartCandlestick, LuChartLine, LuExternalLink } from "react-icons/lu";
import { t } from "../../i18n";
import { decimalsOf, formatNumber, formatSigned } from "../../lib/format";
import { MiniChart } from "./MiniChart";
import { TokenIcon } from "./TokenIcon";

/** The card's ranges, each drawn with enough candles to read its shape. */
export const TICKER_RANGES = ["1H", "4H", "1D", "1W"] as const;
export type TickerRange = (typeof TICKER_RANGES)[number];

/**
 * A market at a glance, from the bottom bar's ticker: its chart over a
 * range, the range's high and low, the day's change and the price, and a
 * way to open it in the main chart. After the design's ticker popover.
 */
export function TickerCard({
  market,
  summary,
  candles,
  range,
  onRange,
  style,
  onStyle,
  onOpen,
}: {
  market: Market;
  summary?: MarketSummary;
  /** Unset while they load. */
  candles?: readonly Candle[];
  range: TickerRange;
  onRange: (range: TickerRange) => void;
  style: "line" | "candles";
  onStyle: (style: "line" | "candles") => void;
  onOpen: () => void;
}) {
  const price = summary ? Number(summary.markPrice) : undefined;
  const prev = summary ? Number(summary.prevDayPrice) : undefined;
  const change = price !== undefined && prev ? (price - prev) / prev : undefined;
  const decimals = summary ? decimalsOf(summary.markPrice) : 2;
  const highs = candles?.map((c) => Number(c.high)) ?? [];
  const lows = candles?.map((c) => Number(c.low)) ?? [];
  const high = highs.length ? Math.max(...highs) : undefined;
  const low = lows.length ? Math.min(...lows) : undefined;
  const trend = change === undefined ? undefined : change >= 0 ? "up" : "down";
  const money = (v: number | undefined) =>
    v === undefined ? "-" : `$${formatNumber(v, decimals)}`;

  return (
    <div className="pd-ticker-card">
      <div className="pd-ticker-head">
        <span className="pd-ticker-name">
          <TokenIcon market={market} size={16} />
          {market.base}
        </span>
        <span className="pd-ticker-tools">
          <span className="pd-ticker-seg" role="radiogroup" aria-label={t("ticker.style")}>
            {(["line", "candles"] as const).map((s) => (
              // biome-ignore lint/a11y/useSemanticElements: compact segmented control
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={s === style}
                aria-label={t(s === "line" ? "ticker.line" : "ticker.candles")}
                onClick={() => onStyle(s)}
              >
                {s === "line" ? (
                  <LuChartLine size={13} aria-hidden />
                ) : (
                  <LuChartCandlestick size={13} aria-hidden />
                )}
              </button>
            ))}
          </span>
          <span className="pd-ticker-seg" role="radiogroup" aria-label={t("ticker.range")}>
            {TICKER_RANGES.map((r) => (
              // biome-ignore lint/a11y/useSemanticElements: compact segmented control
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={r === range}
                onClick={() => onRange(r)}
              >
                {r}
              </button>
            ))}
          </span>
        </span>
      </div>

      <div className="pd-ticker-chart">
        {candles && candles.length > 1 ? (
          <MiniChart candles={candles} style={style} height={110} />
        ) : (
          <span className="pd-skel pd-ticker-chart-skel" aria-hidden />
        )}
      </div>

      <div className="pd-ticker-range">
        <div className="pd-ticker-stat">
          <span className="pd-ticker-label">{t("ticker.high")}</span>
          <strong className="pd-num">{money(high)}</strong>
        </div>
        <div className="pd-ticker-stat">
          <span className="pd-ticker-label">{t("ticker.low")}</span>
          <strong className="pd-num">{money(low)}</strong>
        </div>
      </div>

      <div className="pd-ticker-foot">
        <span className="pd-ticker-change">
          {t("ticker.change")}{" "}
          <span className="pd-num" data-trend={trend}>
            {change === undefined ? "-" : `${formatSigned(change * 100)}%`}
          </span>
        </span>
        <strong className="pd-ticker-price pd-num" data-trend={trend}>
          {money(price)}
        </strong>
      </div>

      <button type="button" className="pd-ticker-open" onClick={onOpen}>
        <LuExternalLink size={13} aria-hidden />
        {t("ticker.open")}
      </button>
    </div>
  );
}
