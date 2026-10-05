import type { Order, OrderAmend, OrderCategory, PriceSource } from "@pewterdesk/core";
import { type FormEvent, useState } from "react";
import { LuCheck, LuPencil, LuPlus, LuX } from "react-icons/lu";
import { dateFormat, type MessageKey, t } from "../../i18n";
import { decimalsOf, formatNumber } from "../../lib/format";
import { EmptyState } from "../common/Status";
import type { SymbolFor } from "./PositionsTable";
import { OrderTpSlDialog } from "./ProtectionEditor";

type Segment = "regular" | "conditional" | "tpsl" | "trailing" | "mmr";

const SEGMENTS: { id: Segment; label: MessageKey; has: (c: OrderCategory) => boolean }[] = [
  { id: "regular", label: "orders.segRegular", has: (c) => c === "regular" },
  { id: "conditional", label: "orders.segConditional", has: (c) => c === "conditional" },
  { id: "tpsl", label: "orders.segTpsl", has: (c) => c === "takeProfit" || c === "stopLoss" },
  { id: "trailing", label: "orders.segTrailing", has: (c) => c === "trailingStop" },
  { id: "mmr", label: "orders.segMmr", has: (c) => c === "mmrClose" },
];

/** An amend that leaves the order's TP and SL as they are. */
const KEEP_EXITS = {
  takeProfit: { action: "keep" },
  stopLoss: { action: "keep" },
} as const satisfies Pick<OrderAmend, "takeProfit" | "stopLoss">;

const SOURCE: Record<PriceSource, MessageKey> = {
  last: "orders.byLast",
  mark: "orders.byMark",
  index: "orders.byIndex",
};

const TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

/** One row: an order, or a position's TP and SL shown (and cancelled) together. */
interface Row {
  key: string;
  orders: Order[];
}

/** TP before SL in a shared row. */
const rank = (o: Order) => (o.category === "takeProfit" ? 0 : 1);

/** A position's TP and SL on the same market and side share a row, TP first. */
function rowsOf(orders: Order[], segment: Segment): Row[] {
  if (segment !== "tpsl") return orders.map((o) => ({ key: o.id, orders: [o] }));
  const groups = new Map<string, Order[]>();
  for (const o of orders) {
    const key = `${o.market}:${o.side}:${o.size}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    orders: group.sort((a, b) => rank(a) - rank(b)),
  }));
}

/**
 * An order id as two short lines, as the venue shows it: the first and last
 * eight characters of a long id (the cell's tooltip has it whole).
 */
function OrderId({ id }: { id: string }) {
  const plain = id.replace(/-/g, "");
  if (plain.length <= 16) return <span className="pd-order-id-line">{id}</span>;
  return (
    <>
      <span className="pd-order-id-line">{plain.slice(0, 8)}</span>
      <span className="pd-order-id-line">{plain.slice(-8)}</span>
    </>
  );
}

/**
 * A value with a ✎ that turns it into a box, saved with ✓ (or Enter) and
 * dropped with ✕ (or Escape). Shows the venue's answer if it refuses.
 */
function EditableValue({
  value,
  shown,
  label,
  onSave,
}: {
  value: string;
  shown: string;
  label: string;
  onSave?: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!editing || !onSave) {
    return (
      <span className="pd-order-edit">
        {shown}
        {onSave && (
          <button
            type="button"
            className="pd-tpsl-edit"
            aria-label={t("orders.editWhat", { what: label })}
            title={t("orders.editWhat", { what: label })}
            onClick={() => {
              setText(value);
              setError(undefined);
              setEditing(true);
            }}
          >
            <LuPencil size={13} aria-hidden />
          </button>
        )}
      </span>
    );
  }
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!(Number(text) > 0)) return setError(t("protect.invalid"));
    if (Number(text) === Number(value)) return setEditing(false);
    setBusy(true);
    setError(undefined);
    try {
      await onSave(text.trim());
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("orders.amendFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pd-order-editing" onSubmit={save}>
      <input
        // biome-ignore lint/a11y/noAutofocus: editing starts by typing
        autoFocus
        inputMode="decimal"
        value={text}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
      />
      <button
        type="submit"
        className="pd-tpsl-edit"
        disabled={busy}
        aria-label={t("accounts.save")}
      >
        <LuCheck size={14} aria-hidden />
      </button>
      <button
        type="button"
        className="pd-tpsl-edit"
        aria-label={t("protect.cancel")}
        onClick={() => setEditing(false)}
      >
        <LuX size={14} aria-hidden />
      </button>
      {error && (
        <span className="pd-order-cancel-error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

/** Cancels every order in a row, showing that it's on its way and, if it fails, why. */
function CancelRow({
  orders,
  onCancel,
}: {
  orders: Order[];
  onCancel: (order: Order) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <button
        type="button"
        className="pd-order-cancel"
        disabled={busy}
        title={error}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            for (const o of orders) await onCancel(o);
          } catch (err) {
            setError(err instanceof Error ? err.message : t("orders.cancelFailed"));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t(busy ? "orders.cancelling" : "orders.cancel")}
      </button>
      {error && (
        <span className="pd-order-cancel-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * The account's open orders, split as the venue does: limit and market
 * orders, conditional orders, a position's TP/SL (one row for the pair),
 * trailing stops and MMR closes, each tab with its count.
 */
export function OpenOrdersPanel({
  orders,
  symbolFor,
  quoteFor,
  baseFor,
  onCancel,
  onAmend,
  tickFor,
}: {
  orders: Order[];
  symbolFor: SymbolFor;
  /** The coin a market's value is in, e.g. "USDT". */
  quoteFor?: (marketId: string) => string;
  /** The coin a market's size is in, e.g. "BTC". */
  baseFor?: (marketId: string) => string;
  /** Cancels an order; unset where orders can't be cancelled (no column then). */
  onCancel?: (order: Order) => Promise<void>;
  /** Changes an order's price, size or attached TP/SL; unset where it can't be. */
  onAmend?: (order: Order, amend: OrderAmend) => Promise<void>;
  /** A market's price tick, for the TP/SL dialog's steppers. */
  tickFor?: (marketId: string) => string;
}) {
  const [segment, setSegment] = useState<Segment>("regular");
  const [tpslFor, setTpslFor] = useState<Order>();
  // Counted in rows, as listed: a TP and SL pair is one.
  const counts = Object.fromEntries(
    SEGMENTS.map((s) => [
      s.id,
      rowsOf(
        orders.filter((o) => s.has(o.category)),
        s.id,
      ).length,
    ]),
  ) as Record<Segment, number>;
  const shown = SEGMENTS.find((s) => s.id === segment) ?? (SEGMENTS[0] as (typeof SEGMENTS)[0]);
  const rows = rowsOf(
    orders.filter((o) => shown.has(o.category)),
    segment,
  );
  const coin = (fn: ((m: string) => string) | undefined, market: string) =>
    fn ? ` ${fn(market)}` : "";

  return (
    <div className="pd-orders-panel">
      <div className="pd-order-segments" role="tablist" aria-label={t("tab.openOrders")}>
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === segment}
            onClick={() => setSegment(s.id)}
          >
            {t(s.label)}
            {counts[s.id] > 0 && ` (${counts[s.id]})`}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState>{t("orders.empty")}</EmptyState>
      ) : segment === "regular" ? (
        <table className="pd-table pd-positions">
          <thead>
            <tr>
              <th>{t("col.market")}</th>
              <th>{t("orders.instrument")}</th>
              <th>{t("orders.orderType")}</th>
              <th>{t("orders.direction")}</th>
              <th className="pd-num">{t("orders.orderPrice")}</th>
              <th className="pd-num">{t("orders.filledQty")}</th>
              <th className="pd-num">{t("orders.orderValue")}</th>
              <th>{t("col.tpsl")}</th>
              <th>{t("orders.tradeType")}</th>
              <th>{t("orders.orderTime")}</th>
              {onCancel && <th>{t("orders.action")}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, orders: [o] }) => {
              if (!o) return null;
              const buy = o.side === "buy";
              const price = o.price ? Number(o.price) : undefined;
              const value = price !== undefined ? price * Number(o.size) : undefined;
              const trade: MessageKey = o.reduceOnly
                ? buy
                  ? "orders.closeShort"
                  : "orders.closeLong"
                : buy
                  ? "orders.openLong"
                  : "orders.openShort";
              const quote = quoteFor?.(o.market) ?? "";
              return (
                <tr key={key}>
                  <td className="pd-strong">{symbolFor(o.market)}</td>
                  <td>{quote ? t("orders.perpetuals", { quote }) : "-"}</td>
                  <td>{t(`orderType.${o.type}`)}</td>
                  <td className={buy ? "pd-up" : "pd-down"}>{t(buy ? "side.buy" : "side.sell")}</td>
                  <td className="pd-num">
                    {o.price ? (
                      <EditableValue
                        value={o.price}
                        shown={formatNumber(o.price)}
                        label={t("orders.orderPrice")}
                        onSave={onAmend && ((next) => onAmend(o, { ...KEEP_EXITS, price: next }))}
                      />
                    ) : (
                      t("orderType.market")
                    )}
                  </td>
                  <td className="pd-num">
                    <EditableValue
                      value={o.size}
                      shown={`${formatNumber(o.filledSize, decimalsOf(o.size))}/${formatNumber(o.size)}${coin(baseFor, o.market)}`}
                      label={t("orders.orderQty")}
                      onSave={onAmend && ((next) => onAmend(o, { ...KEEP_EXITS, size: next }))}
                    />
                  </td>
                  <td className="pd-num">
                    {value === undefined
                      ? "--"
                      : `${formatNumber(value, 2)}${coin(quoteFor, o.market)}`}
                  </td>
                  <td>
                    {o.takeProfit || o.stopLoss ? (
                      <span className="pd-order-edit">
                        <span className="pd-tpsl-pair">
                          <span className={o.takeProfit ? "pd-up" : undefined}>
                            {o.takeProfit ? formatNumber(o.takeProfit) : "-"}
                          </span>
                          <span className={o.stopLoss ? "pd-down" : undefined}>
                            {o.stopLoss ? formatNumber(o.stopLoss) : "-"}
                          </span>
                        </span>
                        {onAmend && (
                          <button
                            type="button"
                            className="pd-tpsl-edit"
                            aria-label={t("orders.editWhat", { what: t("col.tpsl") })}
                            onClick={() => setTpslFor(o)}
                          >
                            <LuPencil size={13} aria-hidden />
                          </button>
                        )}
                      </span>
                    ) : onAmend ? (
                      <button type="button" className="pd-order-add" onClick={() => setTpslFor(o)}>
                        <LuPlus size={14} aria-hidden />
                        {t("orders.add")}
                      </button>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className={buy ? "pd-up" : "pd-down"}>{t(trade)}</td>
                  <td className="pd-muted">{dateFormat(TIME).format(o.createdAt)}</td>
                  {onCancel && (
                    <td className="pd-order-cancel-cell">
                      <CancelRow orders={[o]} onCancel={onCancel} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <table className="pd-table pd-positions">
          <thead>
            <tr>
              <th>{t("col.market")}</th>
              <th>{t("orders.direction")}</th>
              <th className="pd-num">{t("orders.triggerPrice")}</th>
              <th className="pd-num">{t("orders.orderPrice")}</th>
              <th className="pd-num">{t("orders.orderQty")}</th>
              <th className="pd-num">{t("orders.orderValue")}</th>
              <th>{t("orders.tradeType")}</th>
              <th>{t("orders.orderTime")}</th>
              <th>{t("orders.orderId")}</th>
              <th>{t("col.status")}</th>
              {onCancel && <th>{t("orders.action")}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, orders: group }) => {
              const o = group[0] as Order;
              const buy = o.side === "buy";
              // A whole-position exit carries no size of its own.
              const entire = Number(o.size) === 0 && o.category !== "regular";
              const price = o.price ? Number(o.price) : undefined;
              const value = price !== undefined && !entire ? price * Number(o.size) : undefined;
              const trade: MessageKey = o.reduceOnly
                ? buy
                  ? "orders.closeShort"
                  : "orders.closeLong"
                : buy
                  ? "orders.openLong"
                  : "orders.openShort";
              const status: MessageKey =
                o.status === "open" && o.category !== "regular"
                  ? "orders.untriggered"
                  : `orderStatus.${o.status}`;
              return (
                <tr key={key}>
                  <td className="pd-strong">{symbolFor(o.market)}</td>
                  <td className={buy ? "pd-up" : "pd-down"}>{t(buy ? "side.buy" : "side.sell")}</td>
                  <td className="pd-num pd-order-triggers">
                    {group.some((g) => g.triggerPrice)
                      ? group.map((g) => (
                          <span key={g.id} className="pd-order-trigger">
                            {g.category === "takeProfit" && `${t("orders.tp")} `}
                            {g.category === "stopLoss" && `${t("orders.sl")} `}
                            {g.triggerPrice ? formatNumber(g.triggerPrice) : "-"}
                            {g.triggerBy && ` (${t(SOURCE[g.triggerBy])})`}
                          </span>
                        ))
                      : "--"}
                  </td>
                  <td className="pd-num">
                    {price !== undefined ? formatNumber(o.price as string) : t("orderType.market")}
                  </td>
                  <td className="pd-num">
                    {entire
                      ? t("orders.entire")
                      : `${formatNumber(o.size)}${coin(baseFor, o.market)}`}
                  </td>
                  <td className="pd-num">
                    {value === undefined
                      ? "--"
                      : `${formatNumber(value, 2)}${coin(quoteFor, o.market)}`}
                  </td>
                  <td className={buy ? "pd-up" : "pd-down"}>{t(trade)}</td>
                  <td className="pd-muted">{dateFormat(TIME).format(o.createdAt)}</td>
                  <td className="pd-order-id pd-num" title={o.id}>
                    <OrderId id={o.id} />
                  </td>
                  <td>{t(status)}</td>
                  {onCancel && (
                    <td className="pd-order-cancel-cell">
                      <CancelRow orders={group} onCancel={onCancel} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {tpslFor && onAmend && (
        <OrderTpSlDialog
          order={tpslFor}
          symbol={symbolFor(tpslFor.market)}
          quote={quoteFor?.(tpslFor.market) ?? ""}
          tick={tickFor?.(tpslFor.market) ?? "0.01"}
          onSave={(amend) => onAmend(tpslFor, amend)}
          onClose={() => setTpslFor(undefined)}
        />
      )}
    </div>
  );
}
