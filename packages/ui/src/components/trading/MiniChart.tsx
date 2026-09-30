import type { Candle } from "@pewterdesk/core";
import {
  CandlestickSeries,
  createChart,
  type IChartApi,
  LineSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { chartOptions, tokens } from "./chartTheme";

/**
 * A small price chart with no axes, for the bottom bar's ticker cards: a
 * line colored by whether the range ended up or down, or candles.
 */
export function MiniChart({
  candles,
  style,
  height = 170,
}: {
  candles: readonly Candle[];
  style: "line" | "candles";
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    const chart = createChart(host, {
      ...chartOptions(t),
      autoSize: true,
      handleScroll: false,
      handleScale: false,
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false },
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const host = hostRef.current;
    if (!chart || !host) return;
    const t = tokens(host);
    const time = (c: Candle) => Math.floor(c.openTime / 1000) as UTCTimestamp;
    const first = Number(candles[0]?.open ?? 0);
    const last = Number(candles.at(-1)?.close ?? 0);
    const color = last >= first ? t.buy : t.sell;
    const series =
      style === "line"
        ? chart.addSeries(LineSeries, {
            color,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          })
        : chart.addSeries(CandlestickSeries, {
            upColor: t.buy,
            downColor: t.sell,
            borderUpColor: t.buy,
            borderDownColor: t.sell,
            wickUpColor: t.buy,
            wickDownColor: t.sell,
            priceLineVisible: false,
            lastValueVisible: false,
          });
    series.setData(
      candles.map((c) =>
        style === "line"
          ? { time: time(c), value: Number(c.close) }
          : {
              time: time(c),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
            },
      ) as never,
    );
    chart.timeScale().fitContent();
    return () => {
      // The chart may already be gone (it's removed first when the card
      // unmounts); a removed chart can't remove a series.
      if (chartRef.current === chart) chart.removeSeries(series);
    };
  }, [candles, style]);

  return <div ref={hostRef} className="pd-mini-chart" style={{ height }} />;
}
