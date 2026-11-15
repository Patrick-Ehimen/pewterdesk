import { dateFormat, formatNumber, formatSigned, t } from "@pewterdesk/ui";
import { useState } from "react";
import type { RunResult, RunStats, Trade } from "../../lib/backtest";
import { EXIT, TradesTable } from "./BacktestOverview";
import { ruleText } from "./CustomRules";
import { CandleChart, type Level, type Marker } from "./charts";
import { Row } from "./NewBot";

type Outcome = "all" | "winners" | "losers";
type Sides = "both" | "long" | "short";
const stamp = () =>
  dateFormat({
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });

/** Candles from a time on, or the last index. */
const indexAt = (result: RunResult, time: number) => {
  const i = result.bars.findIndex((b) => b.time >= time);
  return i === -1 ? result.bars.length - 1 : i;
};

/** Every trade: on the chart, in a list, and the picked one explained step by step. */
export function BacktestTrades({ result, stats }: { result: RunResult; stats: RunStats }) {
  const { spec, trades } = result;
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [sides, setSides] = useState<Sides>("both");
  const biggest = [...trades].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))[0];
  const [picked, setPicked] = useState<number | undefined>(biggest?.n);
  const trade = trades.find((tr) => tr.n === picked) ?? biggest;
  const decimals = spec.startPrice >= 1000 ? 1 : spec.startPrice >= 10 ? 2 : 3;

  const shown = trades
    .filter((tr) => outcome === "all" || (outcome === "winners" ? tr.pnl > 0 : tr.pnl <= 0))
    .filter((tr) => sides === "both" || tr.side === sides)
    .reverse();

  // The chart shows the picked trade with some room either side, at most ~240 candles.
  const open = trade ? indexAt(result, trade.openTime) : result.bars.length - 1;
  const close = trade ? indexAt(result, trade.closeTime) : result.bars.length - 1;
  const from = Math.max(0, Math.min(open - 40, result.bars.length - 240));
  const to = Math.min(result.bars.length, Math.max(close + 40, from + 240));
  const bars = result.bars.slice(from, to);
  const markers: Marker[] = trades.flatMap((tr) => {
    const o = indexAt(result, tr.openTime) - from;
    const c = indexAt(result, tr.closeTime) - from;
    const out: Marker[] = [];
    if (o >= 0 && o < bars.length)
      out.push({ index: o, kind: tr.side === "long" ? "entryLong" : "entryShort" });
    if (c >= 0 && c < bars.length) out.push({ index: c, kind: "exit" });
    return out;
  });
  const levels: Level[] = trade
    ? [
        {
          price: trade.entry,
          tone: "entry",
          from: Math.max(0, open - from),
          label: `${t("bots.entry")} ${formatNumber(trade.entry, decimals)}`,
        },
        ...(trade.initialStop !== undefined
          ? [
              {
                price: trade.initialStop,
                tone: "stop" as const,
                from: Math.max(0, open - from),
                label: `${t("bots.level.stop")} ${formatNumber(trade.initialStop, decimals)}`,
              },
            ]
          : []),
      ]
    : [];
  const holdOut = result.holdOutFrom - from;
  const share = trade && stats.net !== 0 ? trade.pnl / stats.net : 0;

  return (
    <div className="bt-trades">
      <section className="bt-panel bt-trades-chart">
        <h2>
          {spec.market} · {spec.interval}
          {result.fastLine && (
            <>
              <span className="bt-legend bt-legend-fast">EMA {spec.ema?.fast}</span>
              <span className="bt-legend bt-legend-slow">EMA {spec.ema?.slow}</span>
            </>
          )}
          <span className="bt-muted">{t("bots.marksLegend")}</span>
        </h2>
        <div className="bt-chart-box">
          <CandleChart
            bars={bars}
            decimals={decimals}
            markers={markers}
            levels={levels}
            holdOutFrom={holdOut >= 0 && holdOut < bars.length ? holdOut : undefined}
            holdOutLabel={t("bots.outOfSampleArrow")}
            highlight={
              trade
                ? { from: Math.max(0, open - from), to: Math.min(bars.length - 1, close - from) }
                : undefined
            }
            lines={
              result.fastLine && result.slowLine
                ? [
                    { values: result.fastLine.slice(from, to), className: "bt-line-fast" },
                    { values: result.slowLine.slice(from, to), className: "bt-line-slow" },
                  ]
                : []
            }
          />
        </div>
      </section>

      {trade && (
        <aside className="bt-panel bt-trade-detail" aria-label={t("bots.tradeN", { n: trade.n })}>
          <h2>
            {t("bots.tradeN", { n: trade.n })}
            <span className="bt-badge" data-side={trade.side}>
              {t(trade.side === "long" ? "side.long" : "side.short")}
            </span>
            <span className="bt-muted">
              {t(trade.outOfSample ? "bots.sample.outLong" : "bots.sample.inLong")}
            </span>
          </h2>
          <p className="bt-big pd-num" data-trend={trade.pnl >= 0 ? "up" : "down"}>
            {formatSigned(trade.pnl)}
            <small>{`${formatSigned(trade.r)}R`}</small>
          </p>
          {share > 0.5 && stats.net > 0 && (
            <p className="bt-warn">
              {t("bots.tradeShare", { share: formatNumber(share * 100, 0) })}
            </p>
          )}
          <dl className="bt-rows bt-rows-2">
            <Row label={t("bots.entry")}>{formatNumber(trade.entry, decimals)}</Row>
            <Row label={t("bots.exitPrice")}>{formatNumber(trade.exit, decimals)}</Row>
            <Row label={t("bots.col.size")}>{`${formatNumber(trade.size, 2)} ${spec.market}`}</Row>
            <Row label={t("bots.notional")}>{formatNumber(trade.entry * trade.size, 0)}</Row>
            <Row label={t("bots.risk1R")}>{formatNumber(trade.risk, 2)}</Row>
            <Row label={t("bots.initialStop")}>
              {trade.initialStop === undefined ? "-" : formatNumber(trade.initialStop, decimals)}
            </Row>
            <Row label={t("bots.held")}>
              {t("bots.hoursShort", {
                hours: formatNumber((trade.closeTime - trade.openTime) / 3_600_000, 0),
              })}
            </Row>
            <Row label={t("bots.leverage")}>
              {`${formatNumber((trade.entry * trade.size) / spec.capital, 2)}×`}
            </Row>
            <Row label={t("bots.mfe")}>{formatSigned(trade.mfe)}</Row>
            <Row label={t("bots.mae")}>{formatSigned(trade.mae)}</Row>
            <Row label={t("bots.stat.fees")}>{formatSigned(trade.fees)}</Row>
            <Row label={t("bots.stat.funding")}>{formatSigned(trade.funding)}</Row>
          </dl>
          <h3>{t("bots.why")}</h3>
          <ol className="bt-timeline">
            {why(trade, result).map((step) => (
              <li key={step.title}>
                <strong>{step.title}</strong>
                <time className="pd-num">{step.time}</time>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </aside>
      )}

      <section className="bt-panel bt-trades-list">
        <h2>
          <span className="bt-seg" role="radiogroup" aria-label={t("bots.outcome")}>
            {(["all", "winners", "losers"] as const).map((o) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={outcome === o}
                onClick={() => setOutcome(o)}
              >
                {t(`bots.outcome.${o}`, {
                  count: o === "all" ? trades.length : o === "winners" ? stats.wins : stats.losses,
                })}
              </button>
            ))}
          </span>
          <span className="bt-seg" role="radiogroup" aria-label={t("bots.sides")}>
            {(["both", "long", "short"] as const).map((s) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={sides === s}
                onClick={() => setSides(s)}
              >
                {t(`bots.sides.${s}`)}
              </button>
            ))}
          </span>
          <span className="bt-spacer" />
          <span className="bt-muted">{t("bots.newestFirst")}</span>
        </h2>
        {trades.length === 0 && (
          <p className="bt-muted">
            {t(spec.template === "custom" ? "bots.noTradesCustom" : "bots.noTrades")}
          </p>
        )}
        <TradesTable
          trades={shown}
          decimals={decimals}
          selected={trade?.n}
          onSelect={setPicked}
          detailed
        />
      </section>
    </div>
  );
}

/** How a trade came about, as the engine will log it: signal, intent, gate, fill, hold, exit. */
function why(trade: Trade, result: RunResult) {
  const { spec } = result;
  const open = stamp().format(trade.openTime);
  const close = stamp().format(trade.closeTime);
  const decimals = spec.startPrice >= 10 ? 3 : 4;
  const hours = formatNumber((trade.closeTime - trade.openTime) / 3_600_000, 0);
  const signal =
    spec.template === "grid"
      ? t("bots.why.gridSignal", { price: formatNumber(trade.entry, decimals) })
      : spec.template === "custom"
        ? t("bots.why.customSignal", {
            rules: (spec.custom?.entry ?? []).map(ruleText).join(" · "),
          })
        : t(trade.side === "long" ? "bots.why.crossUp" : "bots.why.crossDown", {
            fast: spec.ema?.fast ?? 0,
            slow: spec.ema?.slow ?? 0,
          });
  return [
    { title: t("bots.why.signal"), time: open, text: signal },
    {
      title: t("bots.why.intent"),
      time: open,
      text: t("bots.why.intentText", {
        side: t(trade.side === "long" ? "side.long" : "side.short"),
        size: formatNumber(trade.size, 2),
        risk: formatNumber(trade.risk, 2),
      }),
    },
    {
      title: t("bots.why.gate"),
      time: open,
      text: t("bots.why.gateText", {
        leverage: formatNumber((trade.entry * trade.size) / spec.capital, 2),
        max: formatNumber(spec.custom ? spec.custom.size : (spec.ema?.maxLeverage ?? 1), 1),
      }),
    },
    {
      title: t("bots.why.filled"),
      time: open,
      text: t("bots.why.filledText", {
        price: formatNumber(trade.entry, decimals),
        bps: spec.slippageBps,
      }),
    },
    {
      title: t("bots.why.held"),
      time: t("bots.hoursShort", { hours }),
      text: t("bots.why.heldText", { funding: formatNumber(Math.abs(trade.funding), 2) }),
    },
    {
      title: t("bots.why.exit", { reason: t(EXIT[trade.exitReason]) }),
      time: close,
      text: t("bots.why.exitText", { price: formatNumber(trade.exit, decimals) }),
    },
  ];
}
