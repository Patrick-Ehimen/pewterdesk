import type { Candle, CandleInterval, Market, MarketSummary, VenueId } from "@pewterdesk/core";
import {
  decimalsOf,
  formatCompact,
  formatNumber,
  TICKER_RANGES,
  TickerCard,
  type TickerRange,
  TokenIcon,
  t,
} from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { venueClient } from "../../api/venueClient";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import { BarPopover } from "./BarPopover";

/** Each range's candles: enough to read its shape, few enough to fetch fast. */
const RANGE_CANDLES: Record<TickerRange, [CandleInterval, number]> = {
  "1H": ["1m", 60],
  "4H": ["5m", 48],
  "1D": ["15m", 96],
  "1W": ["1h", 168],
};
/** The card's chart refreshes this often while it's open. */
const REFRESH_MS = 30_000;
const STYLES = ["line", "candles"] as const;

/** "$83.8K", "$2,677.4", "$0.7069": short enough for the bar. */
function barPrice(summary: MarketSummary) {
  const n = Number(summary.markPrice);
  if (n >= 10_000) return `$${formatCompact(n)}`;
  // Under a dollar, two places isn't enough to see it move ($0.7069, not $0.71).
  const places = Math.min(n < 1 ? 4 : 2, decimalsOf(summary.markPrice));
  return `$${formatNumber(n, places)}`;
}

function TickerPanel({
  venue,
  market,
  summary,
  onOpen,
}: {
  venue: VenueId;
  market: Market;
  summary?: MarketSummary;
  onOpen: () => void;
}) {
  const [range, setRange] = useStoredChoice<TickerRange>("pd.ticker.range", TICKER_RANGES, "1D");
  const [style, setStyle] = useStoredChoice("pd.ticker.style", STYLES, "line");
  const [candles, setCandles] = useState<Candle[]>();
  useEffect(() => {
    let live = true;
    setCandles(undefined);
    const [interval, count] = RANGE_CANDLES[range];
    const load = () =>
      venueClient.candles(venue, market.id, interval, Date.now(), count).then(
        (c) => live && setCandles(c),
        () => live && setCandles([]),
      );
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [venue, market.id, range]);
  return (
    <TickerCard
      market={market}
      summary={summary}
      candles={candles}
      range={range}
      onRange={setRange}
      style={style}
      onStyle={setStyle}
      onOpen={onOpen}
    />
  );
}

/**
 * BTC, ETH, SOL, BNB, HYPE and ASTER's prices in the bottom bar, from the venue's market
 * summaries. Clicking one opens its card: chart, range, change, and a way
 * to put it on the main chart.
 */
export function Tickers({
  venue,
  ids,
  markets,
  summaries,
  onOpen,
}: {
  venue: VenueId;
  ids: readonly string[];
  markets: readonly Market[];
  summaries?: readonly MarketSummary[];
  onOpen: (market: Market) => void;
}) {
  return (
    <div className="app-bar-tickers">
      {ids.map((id) => {
        const market = markets.find((m) => m.id === id);
        if (!market) return null;
        const summary = summaries?.find((s) => s.market === id);
        const prev = summary ? Number(summary.prevDayPrice) : 0;
        const up = summary && prev > 0 ? Number(summary.markPrice) >= prev : undefined;
        return (
          <BarPopover
            key={id}
            label={t("ticker.show", { market: market.base })}
            className="app-bar-ticker"
            button={
              <>
                <TokenIcon market={market} size={14} />
                <span
                  className="pd-num"
                  data-trend={up === undefined ? undefined : up ? "up" : "down"}
                >
                  {summary ? barPrice(summary) : "-"}
                </span>
              </>
            }
          >
            {() => (
              <TickerPanel
                venue={venue}
                market={market}
                summary={summary}
                onOpen={() => onOpen(market)}
              />
            )}
          </BarPopover>
        );
      })}
    </div>
  );
}
