import type { Order, Position } from "@pewterdesk/core";
import { dateFormat, t } from "../../i18n";
import { formatNumber, formatPercent, formatSigned, trendClass } from "../../lib/format";
import { EmptyState } from "../common/Status";

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

export function PositionsTable({
  positions,
  symbolFor,
}: {
  positions: Position[];
  symbolFor: SymbolFor;
}) {
  if (positions.length === 0) return <EmptyState>{t("positions.empty")}</EmptyState>;
  return (
    <table className="pd-table">
      <thead>
        <tr>
          <th>{t("col.market")}</th>
          <th>{t("col.side")}</th>
          <th className="pd-num">{t("col.size")}</th>
          <th className="pd-num">{t("col.entry")}</th>
          <th className="pd-num">{t("col.mark")}</th>
          <th className="pd-num">{t("col.liq")}</th>
          <th className="pd-num">{t("col.upnl")}</th>
          <th className="pd-num">{t("col.margin")}</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const pnl = Number(p.unrealizedPnl);
          const margin = Number(p.margin);
          return (
            <tr key={`${p.market}:${p.side}`}>
              <td className="pd-strong">{symbolFor(p.market)}</td>
              <td className={p.side === "long" ? "pd-up" : "pd-down"}>
                {t(p.side === "long" ? "side.long" : "side.short")}
              </td>
              <td className="pd-num">{formatNumber(p.size)}</td>
              <td className="pd-num">{formatNumber(p.entryPrice)}</td>
              <td className="pd-num">{formatNumber(p.markPrice)}</td>
              <td className="pd-num pd-warn">
                {p.liquidationPrice ? formatNumber(p.liquidationPrice) : "—"}
              </td>
              <td className={`pd-num ${trendClass(pnl)}`}>
                {formatSigned(pnl)}
                {margin > 0 && ` (${formatSigned((pnl / margin) * 100)}%)`}
              </td>
              <td className="pd-num">{formatNumber(margin, 2)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function OpenOrdersTable({ orders, symbolFor }: { orders: Order[]; symbolFor: SymbolFor }) {
  if (orders.length === 0) return <EmptyState>{t("orders.empty")}</EmptyState>;
  return (
    <table className="pd-table">
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
            <td className="pd-num">{o.triggerPrice ? formatNumber(o.triggerPrice) : "—"}</td>
            <td>{t(o.reduceOnly ? "common.yes" : "common.no")}</td>
            <td>{t(`orderStatus.${o.status}`)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
