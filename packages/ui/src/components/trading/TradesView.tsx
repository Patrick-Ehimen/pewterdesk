import type { Trade } from "@pewterdesk/core";
import { useRef } from "react";
import { dateFormat, t } from "../../i18n";
import { formatNumber } from "../../lib/format";
import { type Column, ColumnHeader, Hint, unitHint } from "../common/ColumnHeader";
import { EmptyState } from "../common/Status";
import { FloatingTip, TipRows, useHoveredRow } from "../common/Tooltip";
import type { RowMode } from "./OrderBookView";

const CLOCK: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

/** Full timestamp for the tooltip: date, and time to the millisecond. */
const STAMP: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
};

function TradeTip({ trade, base, quote }: { trade: Trade; base?: string; quote?: string }) {
  const unit = (text: string, asset?: string) => (asset ? `${text} ${asset}` : text);
  const buy = trade.side === "buy";
  return (
    <TipRows
      title={t(buy ? "tip.tradeBuy" : "tip.tradeSell")}
      side={buy ? "bid" : "ask"}
      rows={[
        [t("col.price"), unit(formatNumber(trade.price), quote)],
        [t("col.size"), unit(formatNumber(trade.size), base)],
        [t("tip.value"), unit(formatNumber(Number(trade.price) * Number(trade.size), 2), quote)],
        [t("col.time"), dateFormat(STAMP).format(trade.time)],
      ]}
    />
  );
}

interface TradesViewProps {
  /** Newest first. */
  trades: Trade[];
  /** Base asset, e.g. "HYPE", for the column hints. */
  base?: string;
  quote?: string;
  /** Defaults to "table". "stacked" drops the column header for two-line rows. */
  mode?: RowMode;
}

/** The public tape: every print, newest on top, colored by the aggressor's side. */
export function TradesView({ trades, base, quote, mode = "table" }: TradesViewProps) {
  // Rows present on first render don't flash; only prints that arrive later do.
  const initial = useRef<Set<string>>(undefined);
  initial.current ??= new Set(trades.map((trade) => trade.id));
  const hover = useHoveredRow<HTMLDivElement>();
  const hovered = trades.find((trade) => trade.id === hover.key);

  const columns: Column[] = [
    {
      label: t("col.price"),
      hint: (
        <Hint title={t("col.price")}>
          {t("hint.trades.price")}
          {unitHint(quote)}
        </Hint>
      ),
    },
    {
      label: t("col.size"),
      hint: (
        <Hint title={t("col.size")}>
          {t("hint.trades.size")}
          {unitHint(base)}
        </Hint>
      ),
    },
    {
      label: t("col.time"),
      hint: <Hint title={t("col.time")}>{t("hint.trades.time")}</Hint>,
    },
  ];

  return (
    <div className="pd-trades" data-mode={mode}>
      {mode === "table" && <ColumnHeader columns={columns} />}
      {trades.length === 0 ? (
        <EmptyState>{t("trades.empty")}</EmptyState>
      ) : (
        <div ref={hover.containerRef} className="pd-trades-list" {...hover.handlers}>
          {trades.map((trade) => (
            <div
              key={trade.id}
              className="pd-book-row pd-trade"
              data-side={trade.side === "buy" ? "bid" : "ask"}
              data-key={trade.id}
              data-fresh={!initial.current?.has(trade.id) || undefined}
            >
              {mode === "table" ? (
                <>
                  <span className="pd-book-price">{formatNumber(trade.price)}</span>
                  <span>{formatNumber(trade.size)}</span>
                  <span>{dateFormat(CLOCK).format(trade.time)}</span>
                </>
              ) : (
                <>
                  <span className="pd-row-line">
                    <span className="pd-book-price">{formatNumber(trade.price)}</span>
                    <span className="pd-row-time">{dateFormat(CLOCK).format(trade.time)}</span>
                  </span>
                  <span className="pd-row-sub">
                    {formatNumber(trade.size)}
                    {base && ` ${base}`} <span aria-hidden>·</span>{" "}
                    {t(trade.side === "buy" ? "side.buy" : "side.sell")}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {hovered && (
        <FloatingTip getAnchor={hover.anchor} axis="horizontal" className="pd-tip-row">
          <TradeTip trade={hovered} base={base} quote={quote} />
        </FloatingTip>
      )}
    </div>
  );
}
