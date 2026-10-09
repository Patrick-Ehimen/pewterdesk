import { EmptyState, t } from "@pewterdesk/ui";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { Cell, useVenueData } from "../components/pages/MultiChartPage";
import { popoutCell } from "../lib/multiChart";
import { VENUES } from "../lib/venues";

/**
 * One chart in a window of its own, popped out of the Multi-chart page
 * (`chart_window.rs`): the market its address names, with its own timeframe,
 * style, indicators and settings. A chart only - nothing here places an order.
 */
export function ChartWindow() {
  const [cell, setCell] = useState(() => popoutCell(location.hash));
  const data = useVenueData(cell?.venue ?? "bybit", cell !== undefined);
  const markets = data.markets ?? [];
  const symbol = markets.find((m) => m.id === cell?.market)?.symbol ?? cell?.market;
  const venue = cell && VENUES[cell.venue].label;
  const interval = cell?.interval;

  // The window is named after what it shows, to tell several apart.
  useEffect(() => {
    if (!symbol || !isTauri()) return;
    void getCurrentWindow()
      .setTitle(`${symbol} · ${interval} · ${venue}`)
      .catch(() => {});
  }, [symbol, interval, venue]);

  if (!cell) {
    return (
      <div className="chart-window">
        <EmptyState>{t("chart.empty")}</EmptyState>
      </div>
    );
  }
  const change = (next: Partial<typeof cell>) => setCell({ ...cell, ...next });
  return (
    <div className="chart-window">
      <Cell
        cell={cell}
        markets={markets}
        summary={data.summaries?.find((s) => s.market === cell.market)}
        onMarket={(market) => change({ market })}
        onInterval={(interval) => change({ interval })}
        onType={(type) => change({ type })}
        onIndicators={(indicators) => change({ indicators })}
        onSettings={(settings) => change({ settings })}
        markSize={56}
      />
    </div>
  );
}
