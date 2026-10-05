import type {
  ClosedTrade,
  Fill,
  FillEffect,
  FundingPayment,
  Order,
  Position,
  PositionProtection,
} from "@pewterdesk/core";
import { useState } from "react";
import { LuPencil, LuSquareArrowOutUpRight } from "react-icons/lu";
import { dateFormat, type MessageKey, t } from "../../i18n";
import { formatNumber, formatPercent, formatSigned, trendClass } from "../../lib/format";
import { toastError } from "../../lib/toasts";
import { EmptyState } from "../common/Status";
import { TpSlDialog, TrailingStopDialog } from "./ProtectionEditor";

/** Maps a `Market::id` to its display symbol; falls back to the id. */
export type SymbolFor = (marketId: string) => string;

const TIME: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

/**
 * An entry or liquidation price: two places from 1 up (86,372.16), and as
 * the venue sent it below that, where two places would lose the price
 * (0.0043032).
 */
const positionPrice = (price: string) =>
  Math.abs(Number(price)) >= 1 ? formatNumber(Number(price), 2) : formatNumber(price);

export function PositionsTable({
  positions,
  symbolFor,
  quoteFor,
  baseFor,
  tickFor,
  onProtect,
  onShare,
  onSelect,
}: {
  positions: Position[];
  symbolFor: SymbolFor;
  /** The coin a market's PnL and value are in, e.g. "USDT"; shown beside them. */
  quoteFor?: (marketId: string) => string;
  /** The coin a market's size is in, e.g. "BTC"; shown beside it. */
  baseFor?: (marketId: string) => string;
  /** A market's price tick, which the TP/SL and trailing stop steppers move by. */
  tickFor?: (marketId: string) => string;
  /** Opens the P&L share card for a position; unset hides the share button. */
  onShare?: (position: Position) => void;
  /** Opens a position's market (its chart); a click anywhere on the row but its buttons. */
  onSelect?: (position: Position) => void;
  /** Changes a position's TP, SL or trailing stop; unset where it can't be (no edit buttons then). */
  onProtect?: (position: Position, protection: PositionProtection) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ kind: "tpsl" | "trail"; position: Position }>();
  if (positions.length === 0) return <EmptyState>{t("positions.empty")}</EmptyState>;
  const coin = (market: string) => {
    const q = quoteFor?.(market);
    return q ? ` ${q}` : "";
  };
  return (
    <>
      <table className="pd-table pd-positions">
        <thead>
          <tr>
            <th>{t("col.market")}</th>
            <th>{t("col.side")}</th>
            <th className="pd-num">{t("col.size")}</th>
            <th className="pd-num">{t("col.value")}</th>
            <th className="pd-num">{t("col.entry")}</th>
            <th className="pd-num">{t("col.mark")}</th>
            <th className="pd-num">{t("col.liq")}</th>
            <th className="pd-num">{t("col.upnlRoi")}</th>
            <th className="pd-num">{t("col.rpnl")}</th>
            <th className="pd-num">{t("col.margin")}</th>
            <th className="pd-num">{t("col.tpsl")}</th>
            <th className="pd-num">{t("col.trailing")}</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const pnl = Number(p.unrealizedPnl);
            const margin = Number(p.margin);
            const realized = p.realizedPnl === undefined ? undefined : Number(p.realizedPnl);
            return (
              <tr
                key={`${p.market}:${p.side}`}
                className={onSelect ? "pd-position-row" : undefined}
                onClick={(e) => {
                  // The row's own controls (edit, share) keep to themselves.
                  if (!onSelect || (e.target as HTMLElement).closest("button, input, a, dialog")) {
                    return;
                  }
                  onSelect(p);
                }}
              >
                <td className="pd-strong">
                  {onSelect ? (
                    <button
                      type="button"
                      className="pd-row-button"
                      title={t("positions.openChart", { symbol: symbolFor(p.market) })}
                      onClick={() => onSelect(p)}
                    >
                      {symbolFor(p.market)}
                    </button>
                  ) : (
                    symbolFor(p.market)
                  )}
                  {/* Cross or isolated and the leverage, in the side's color. */}
                  {(p.marginMode || p.leverage) && (
                    <span className={`pd-position-mode ${p.side === "long" ? "pd-up" : "pd-down"}`}>
                      {[
                        p.marginMode &&
                          t(p.marginMode === "isolated" ? "ticket.isolated" : "ticket.cross"),
                        p.leverage && `${formatNumber(p.leverage, 2)}x`,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    </span>
                  )}
                </td>
                <td className={p.side === "long" ? "pd-up" : "pd-down"}>
                  {t(p.side === "long" ? "side.long" : "side.short")}
                </td>
                <td className={`pd-num ${p.side === "long" ? "pd-up" : "pd-down"}`}>
                  {formatNumber(p.size)}
                  {baseFor && ` ${baseFor(p.market)}`}
                </td>
                <td className="pd-num">
                  {formatNumber(Number(p.size) * Number(p.markPrice), 2)}
                  {coin(p.market)}
                </td>
                <td className="pd-num">{positionPrice(p.entryPrice)}</td>
                <td className="pd-num">{formatNumber(p.markPrice)}</td>
                <td className="pd-num pd-warn">
                  {p.liquidationPrice ? positionPrice(p.liquidationPrice) : "-"}
                </td>
                <PnlCell
                  pnl={pnl}
                  roi={margin > 0 ? (pnl / margin) * 100 : undefined}
                  coin={coin(p.market)}
                  share={
                    onShare && {
                      label: t("share.button", { symbol: symbolFor(p.market) }),
                      onClick: () => onShare(p),
                    }
                  }
                />
                <td className={`pd-num ${realized === undefined ? "" : trendClass(realized)}`}>
                  {realized === undefined ? "-" : `${formatSigned(realized)}${coin(p.market)}`}
                </td>
                <td className="pd-num">{formatNumber(margin, 2)}</td>
                <td className="pd-num pd-tpsl">
                  {/* TP over SL, in the market colors: what it would make, what it would lose. */}
                  <span className="pd-tpsl-pair">
                    <span className={p.takeProfit ? "pd-up" : undefined}>
                      {p.takeProfit ? formatNumber(p.takeProfit) : "-"}
                    </span>
                    <span className={p.stopLoss ? "pd-down" : undefined}>
                      {p.stopLoss ? formatNumber(p.stopLoss) : "-"}
                    </span>
                  </span>
                  {onProtect && (
                    <button
                      type="button"
                      className="pd-tpsl-edit"
                      aria-label={t("protect.edit", { symbol: symbolFor(p.market) })}
                      title={t("protect.edit", { symbol: symbolFor(p.market) })}
                      onClick={() => setEditing({ kind: "tpsl", position: p })}
                    >
                      <LuPencil size={13} aria-hidden />
                    </button>
                  )}
                </td>
                <td className="pd-num pd-tpsl">
                  <span>{p.trailingStop ? formatNumber(p.trailingStop) : "-"}</span>
                  {onProtect && (
                    <button
                      type="button"
                      className="pd-tpsl-edit"
                      aria-label={t("protect.editTrail", { symbol: symbolFor(p.market) })}
                      title={t("protect.editTrail", { symbol: symbolFor(p.market) })}
                      onClick={() => setEditing({ kind: "trail", position: p })}
                    >
                      <LuPencil size={13} aria-hidden />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing && onProtect && (
        <ProtectionDialog
          kind={editing.kind}
          position={editing.position}
          symbol={symbolFor(editing.position.market)}
          quote={quoteFor?.(editing.position.market) ?? ""}
          tick={tickFor?.(editing.position.market) ?? "0.01"}
          onSave={(protection) => onProtect(editing.position, protection)}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

/** Cancels one order, showing that it's on its way and, if it fails, why. */
function CancelButton({
  order,
  onCancel,
}: {
  order: Order;
  onCancel: (order: Order) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="pd-order-cancel"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onCancel(order);
        } catch (err) {
          toastError(t("toast.cancelFailed"), err, t("orders.cancelFailed"));
        } finally {
          setBusy(false);
        }
      }}
    >
      {t(busy ? "orders.cancelling" : "orders.cancel")}
    </button>
  );
}

export function OpenOrdersTable({
  orders,
  symbolFor,
  empty,
  onCancel,
}: {
  orders: Order[];
  symbolFor: SymbolFor;
  /** What an empty list says; defaults to "no open orders". */
  empty?: string;
  /** Cancels an order; unset where orders can't be cancelled (no column then). */
  onCancel?: (order: Order) => Promise<void>;
}) {
  if (orders.length === 0) return <EmptyState>{empty ?? t("orders.empty")}</EmptyState>;
  return (
    <table className="pd-table pd-positions">
      <thead>
        <tr>
          <th>{t("col.time")}</th>
          <th>{t("col.market")}</th>
          <th>{t("col.side")}</th>
          <th>{t("col.type")}</th>
          <th className="pd-num">{t("col.size")}</th>
          <th className="pd-num">{t("col.filled")}</th>
          <th className="pd-num">{t("col.price")}</th>
          <th className="pd-num">{t("col.trigger")}</th>
          <th>{t("col.reduceOnly")}</th>
          <th>{t("col.status")}</th>
          {onCancel && <th aria-label={t("orders.cancel")} />}
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td className="pd-muted">{dateFormat(TIME).format(o.createdAt)}</td>
            <td className="pd-strong">{symbolFor(o.market)}</td>
            <td className={o.side === "buy" ? "pd-up" : "pd-down"}>
              {t(o.side === "buy" ? "side.buy" : "side.sell")}
            </td>
            <td>{t(`orderType.${o.type}`)}</td>
            <td className="pd-num">{formatNumber(o.size)}</td>
            <td className="pd-num">{formatPercent(Number(o.filledSize) / Number(o.size), 0)}</td>
            <td className="pd-num">{o.price ? formatNumber(o.price) : t("orderType.market")}</td>
            <td className="pd-num">{o.triggerPrice ? formatNumber(o.triggerPrice) : "-"}</td>
            <td>{t(o.reduceOnly ? "common.yes" : "common.no")}</td>
            <td>{t(`orderStatus.${o.status}`)}</td>
            {onCancel && (
              <td className="pd-order-cancel-cell">
                <CancelButton order={o} onCancel={onCancel} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const EFFECT_LABEL: Record<Exclude<FillEffect, "other">, MessageKey> = {
  openLong: "effect.openLong",
  closeLong: "effect.closeLong",
  openShort: "effect.openShort",
  closeShort: "effect.closeShort",
  longToShort: "effect.longToShort",
  shortToLong: "effect.shortToLong",
};

/** Green for what adds to a long or closes a short (buys), red for the rest. */
const buying = (f: Fill) => f.side === "buy";

/** The account's fills, newest first: what each did, at what price, and what it cost or made. */
export function TradeHistoryTable({ fills, symbolFor }: { fills: Fill[]; symbolFor: SymbolFor }) {
  if (fills.length === 0) return <EmptyState>{t("history.fillsEmpty")}</EmptyState>;
  return (
    <table className="pd-table pd-positions">
      <thead>
        <tr>
          <th>{t("col.time")}</th>
          <th>{t("col.market")}</th>
          <th>{t("col.direction")}</th>
          <th className="pd-num">{t("col.price")}</th>
          <th className="pd-num">{t("col.size")}</th>
          <th className="pd-num">{t("col.value")}</th>
          <th className="pd-num">{t("col.fee")}</th>
          <th className="pd-num">{t("col.closedPnlRoi")}</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => {
          const pnl = Number(f.closedPnl);
          return (
            <tr key={f.id}>
              <td className="pd-muted">{dateFormat(TIME).format(f.time)}</td>
              <td className="pd-strong">{symbolFor(f.market)}</td>
              <td className={buying(f) ? "pd-up" : "pd-down"}>
                {f.effect === "other"
                  ? t(f.side === "buy" ? "side.buy" : "side.sell")
                  : t(EFFECT_LABEL[f.effect])}
              </td>
              <td className="pd-num">{formatNumber(f.price)}</td>
              <td className="pd-num">{formatNumber(f.size)}</td>
              <td className="pd-num">{formatNumber(Number(f.price) * Number(f.size), 2)}</td>
              <td className="pd-num pd-muted">
                {formatNumber(f.fee)} {f.feeAsset}
              </td>
              <td className={`pd-num ${pnl === 0 ? "pd-muted" : trendClass(pnl)}`}>
                {pnl === 0 ? "-" : formatSigned(pnl)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Funding paid or received on the account's positions, newest first. */
export function FundingHistoryTable({
  payments,
  symbolFor,
}: {
  payments: FundingPayment[];
  symbolFor: SymbolFor;
}) {
  if (payments.length === 0) return <EmptyState>{t("history.fundingEmpty")}</EmptyState>;
  return (
    <table className="pd-table pd-positions">
      <thead>
        <tr>
          <th>{t("col.time")}</th>
          <th>{t("col.market")}</th>
          <th>{t("col.side")}</th>
          <th className="pd-num">{t("col.size")}</th>
          <th className="pd-num">{t("col.rate")}</th>
          <th className="pd-num">{t("col.payment")}</th>
        </tr>
      </thead>
      <tbody>
        {payments.map((p) => {
          const size = Number(p.positionSize);
          const amount = Number(p.amount);
          return (
            <tr key={`${p.market}:${p.time}`}>
              <td className="pd-muted">{dateFormat(TIME).format(p.time)}</td>
              <td className="pd-strong">{symbolFor(p.market)}</td>
              <td className={size >= 0 ? "pd-up" : "pd-down"}>
                {t(size >= 0 ? "side.long" : "side.short")}
              </td>
              <td className="pd-num">{formatNumber(Math.abs(size))}</td>
              <td className="pd-num">{formatSigned(Number(p.rate) * 100, 4)}%</td>
              <td className={`pd-num ${trendClass(amount)}`}>{formatSigned(amount, 4)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The TP/SL or the trailing stop dialog. */
function ProtectionDialog({
  kind,
  ...props
}: { kind: "tpsl" | "trail" } & Parameters<typeof TpSlDialog>[0]) {
  return kind === "tpsl" ? <TpSlDialog {...props} /> : <TrailingStopDialog {...props} />;
}

/**
 * A PnL as the venue shows it: the amount and its coin over the ROI in
 * brackets, both in the result's colour, with the share button beside them.
 */
function PnlCell({
  pnl,
  roi,
  coin,
  share,
}: {
  pnl: number;
  roi?: number;
  coin: string;
  share?: { label: string; onClick: () => void };
}) {
  return (
    <td className={`pd-num ${trendClass(pnl)}`}>
      <span className="pd-pnl-with-share">
        <span className="pd-pnl-stack">
          <span>
            {formatNumber(pnl, 2)}
            {coin}
          </span>
          {roi !== undefined && <span>({formatNumber(roi, 2)}%)</span>}
        </span>
        {share && (
          <button
            type="button"
            className="pd-pnl-share"
            aria-label={share.label}
            title={share.label}
            onClick={share.onClick}
          >
            <LuSquareArrowOutUpRight size={15} aria-hidden />
          </button>
        )}
      </span>
    </td>
  );
}

/** ROI on a closed trade: its PnL against the margin it used (entry value over leverage). */
export function closedRoi(c: ClosedTrade): number | undefined {
  const margin = Number(c.entryValue) / (c.leverage ? Number(c.leverage) : 1);
  return margin > 0 ? (Number(c.closedPnl) / margin) * 100 : undefined;
}

/** The account's recently closed positions, each with what it made, and a share button. */
export function ClosedTradesTable({
  trades,
  symbolFor,
  quoteFor,
  baseFor,
  onShare,
}: {
  trades: ClosedTrade[];
  symbolFor: SymbolFor;
  quoteFor?: (marketId: string) => string;
  baseFor?: (marketId: string) => string;
  onShare?: (trade: ClosedTrade) => void;
}) {
  if (trades.length === 0) return <EmptyState>{t("closed.empty")}</EmptyState>;
  const coin = (fn: ((m: string) => string) | undefined, market: string) =>
    fn ? ` ${fn(market)}` : "";
  return (
    <table className="pd-table pd-positions">
      <thead>
        <tr>
          <th>{t("col.market")}</th>
          <th>{t("col.side")}</th>
          <th className="pd-num">{t("col.size")}</th>
          <th className="pd-num">{t("col.entry")}</th>
          <th className="pd-num">{t("col.exit")}</th>
          <th className="pd-num">{t("col.closedPnl")}</th>
          <th className="pd-num">{t("col.leverage")}</th>
          <th>{t("col.time")}</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((c) => {
          const pnl = Number(c.closedPnl);
          const roi = closedRoi(c);
          return (
            <tr key={`${c.market}:${c.time}:${c.size}:${c.exitPrice}`}>
              <td className="pd-strong">{symbolFor(c.market)}</td>
              <td className={c.side === "long" ? "pd-up" : "pd-down"}>
                {t(c.side === "long" ? "side.long" : "side.short")}
              </td>
              <td className="pd-num">
                {formatNumber(c.size)}
                {coin(baseFor, c.market)}
              </td>
              <td className="pd-num">{formatNumber(c.entryPrice)}</td>
              <td className="pd-num">{formatNumber(c.exitPrice)}</td>
              <PnlCell
                pnl={pnl}
                roi={roi}
                coin={coin(quoteFor, c.market)}
                share={
                  onShare && {
                    label: t("share.button", { symbol: symbolFor(c.market) }),
                    onClick: () => onShare(c),
                  }
                }
              />
              <td className="pd-num">{c.leverage ? `${formatNumber(c.leverage)}x` : "-"}</td>
              <td className="pd-muted">{dateFormat(TIME).format(c.time)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
