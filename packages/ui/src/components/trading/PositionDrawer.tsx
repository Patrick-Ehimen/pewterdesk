import type {
  Fill,
  FundingPayment,
  OrderRequest,
  Position,
  PositionProtection,
} from "@pewterdesk/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { LuPencil, LuShare2, LuTriangle, LuX } from "react-icons/lu";
import { dateFormat, t } from "../../i18n";
import { formatNumber, formatSigned, onTick, trendClass } from "../../lib/format";
import {
  closeOrder,
  feesPaid,
  heldParts,
  type PnlPoint,
  sparkPath,
} from "../../lib/positionDetail";
import { pnlAt } from "../../lib/tradeMarks";
import { TpSlDialog, TrailingStopDialog } from "./ProtectionEditor";

const SPARK_W = 360;
const SPARK_H = 110;
/** A close at market needs a second click within this long. */
const ARM_MS = 4000;
/** The funding payments listed. */
const FUNDING_SHOWN = 3;

const TIME: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};
const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

/**
 * One position in full, in a drawer from the right: its PnL and how it got
 * there, its numbers, its exits, the fills that built it and the funding it
 * has paid, and closing it (reduce-only, all of it).
 */
export function PositionDrawer({
  position,
  symbol,
  base,
  quote,
  tick,
  fills,
  openedAt,
  funding,
  pnlHistory,
  maxSlippage,
  onProtect,
  onPlace,
  onShare,
  onClose,
}: {
  /** The position as it stands, kept live by the caller. */
  position: Position;
  symbol: string;
  /** The coin its size is in, e.g. "BTC". */
  base: string;
  /** The coin its PnL is in, e.g. "USDT". */
  quote: string;
  /** The market's price tick. */
  tick: string;
  /** The fills that built it, oldest first; unset while loading. */
  fills?: Fill[];
  /** When it was opened, where the fills loaded reach back that far. */
  openedAt?: number;
  /** Its funding payments, newest first; unset while loading. */
  funding?: FundingPayment[];
  /** Its PnL over time; unset while loading. */
  pnlHistory?: PnlPoint[];
  /** A market close's bound, as a fraction (0.05 is 5%). */
  maxSlippage: number;
  /** Sets its TP, SL and trailing stop; unset where it can't be. */
  onProtect?: (protection: PositionProtection) => Promise<void>;
  /** Places an order; unset where the account can't trade (no close buttons then). */
  onPlace?: (request: OrderRequest) => Promise<void>;
  onShare?: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState<"tpsl" | "trail">();
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitPrice, setLimitPrice] = useState(() => onTick(Number(position.markPrice), tick));
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), ARM_MS);
    return () => clearTimeout(id);
  }, [armed]);

  const size = Number(position.size);
  const entry = Number(position.entryPrice);
  const mark = Number(position.markPrice);
  const margin = Number(position.margin);
  const pnl = Number(position.unrealizedPnl);
  const roe = margin > 0 ? (pnl / margin) * 100 : undefined;
  const long = position.side === "long";
  const fundingPaid = funding?.reduce((sum, p) => sum + Number(p.amount), 0);
  const fees = fills ? -feesPaid(fills) : undefined;
  const held = openedAt === undefined ? undefined : heldParts(Date.now() - openedAt);
  const coin = ` ${quote}`;

  const place = async (request: OrderRequest) => {
    if (!onPlace) return;
    setBusy(true);
    setStatus(undefined);
    try {
      await onPlace(request);
      setLimitOpen(false);
    } catch {
      // Whoever placed it says why not (a toast).
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };
  const closeMarket = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    const bps = Math.max(1, Math.round(maxSlippage * 10_000));
    void place(closeOrder(position, { type: "market", maxSlippageBps: bps }));
  };
  const closeLimit = () => {
    if (!(Number(limitPrice) > 0)) {
      setStatus({ ok: false, text: t("drawer.needPrice") });
      return;
    }
    void place(closeOrder(position, { type: "limit", price: limitPrice }));
  };

  const spark = pnlHistory ? sparkPath(pnlHistory, SPARK_W, SPARK_H) : null;
  const sparkUp = (pnlHistory?.at(-1)?.pnl ?? pnl) >= 0;
  const exitCard = (kind: "tp" | "sl") => {
    const price = kind === "tp" ? position.takeProfit : position.stopLoss;
    const at = price ? pnlAt(position, Number(price), size) : undefined;
    const move = price && entry > 0 ? ((Number(price) - entry) / entry) * 100 : undefined;
    const body = (
      <>
        <span className="pd-drawer-exit-label">{t(kind === "tp" ? "drawer.tp" : "drawer.sl")}</span>
        <span className="pd-drawer-exit-price">
          {price ? formatNumber(price) : t("drawer.notSet")}
        </span>
        {at !== undefined && move !== undefined && (
          <span className={`pd-drawer-exit-pnl ${trendClass(at)}`}>
            {formatSigned(at)} · {formatSigned(move)}%
          </span>
        )}
      </>
    );
    return onProtect ? (
      <button
        type="button"
        className="pd-drawer-exit"
        aria-label={t("protect.edit", { symbol })}
        onClick={() => setEditing("tpsl")}
      >
        {body}
        <LuPencil className="pd-drawer-exit-edit" size={13} aria-hidden />
      </button>
    ) : (
      <div className="pd-drawer-exit">{body}</div>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className="pd-drawer"
      aria-label={t("drawer.title", { symbol })}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && !editing && onClose()}
    >
      <div className="pd-drawer-panel">
        <header className="pd-drawer-head">
          <h3>{symbol}</h3>
          <span className="pd-drawer-side" data-side={position.side}>
            {t(long ? "side.long" : "side.short")}
          </span>
          {(position.marginMode || position.leverage) && (
            <span className="pd-drawer-lev">
              {[
                position.marginMode &&
                  t(position.marginMode === "isolated" ? "ticket.isolated" : "ticket.cross"),
                position.leverage && `${formatNumber(position.leverage, 0)}x`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          <span className="pd-drawer-head-actions">
            {onShare && (
              <button
                type="button"
                className="pd-icon-button"
                aria-label={t("share.button", { symbol })}
                title={t("share.button", { symbol })}
                onClick={onShare}
              >
                <LuShare2 size={16} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="pd-icon-button"
              aria-label={t("wallet.close")}
              onClick={onClose}
            >
              <LuX size={18} aria-hidden />
            </button>
          </span>
        </header>

        <div className="pd-drawer-body">
          <div className={`pd-drawer-pnl ${trendClass(pnl)}`}>
            <LuTriangle
              className="pd-drawer-pnl-arrow"
              data-down={pnl < 0 || undefined}
              size={18}
              aria-hidden
            />
            <span className="pd-drawer-pnl-value">
              {formatSigned(pnl)}
              <span className="pd-drawer-pnl-coin">{coin}</span>
            </span>
            {roe !== undefined && (
              <span className="pd-drawer-roe">
                {formatSigned(roe)}% {t("drawer.roe")}
              </span>
            )}
          </div>

          <figure className="pd-drawer-spark">
            {spark ? (
              <svg
                className="pd-drawer-chart"
                viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                preserveAspectRatio="none"
                data-trend={sparkUp ? "up" : "down"}
                role="img"
                aria-label={t("drawer.pnlSinceEntry")}
              >
                <line
                  x1="0"
                  x2={SPARK_W}
                  y1={spark.zero}
                  y2={spark.zero}
                  className="pd-drawer-zero"
                />
                <path d={spark.area} className="pd-drawer-area" />
                <path d={spark.line} className="pd-drawer-line" />
              </svg>
            ) : (
              <div className="pd-skel pd-drawer-spark-skel" />
            )}
            <figcaption>
              <span>{pnlHistory?.[0] ? dateFormat(TIME).format(pnlHistory[0].time) : ""}</span>
              <span>{t("drawer.pnlSinceEntry")}</span>
              <span>{t("drawer.now")}</span>
            </figcaption>
          </figure>

          <dl className="pd-drawer-grid">
            <Cell label={t("drawer.size")}>
              {formatNumber(position.size)} {base}
            </Cell>
            <Cell label={t("drawer.entry")}>{formatNumber(position.entryPrice)}</Cell>
            <Cell label={t("drawer.mark")}>{formatNumber(position.markPrice)}</Cell>
            <Cell label={t("drawer.liq")} className="pd-warn">
              {position.liquidationPrice ? formatNumber(position.liquidationPrice) : "-"}
            </Cell>
            <Cell label={t("drawer.margin")}>{formatNumber(margin, 2)}</Cell>
            <Cell label={t("drawer.notional")}>{formatNumber(size * mark, 2)}</Cell>
            <Cell
              label={t("drawer.funding")}
              className={fundingPaid === undefined ? undefined : trendClass(fundingPaid)}
            >
              {fundingPaid === undefined ? "-" : formatSigned(fundingPaid)}
            </Cell>
            <Cell label={t("drawer.fees")}>{fees === undefined ? "-" : formatSigned(fees)}</Cell>
            <Cell label={t("drawer.held")}>
              {held === undefined
                ? "-"
                : held.d > 0
                  ? t("drawer.heldDh", { d: held.d, h: held.h })
                  : held.h > 0
                    ? t("drawer.heldHm", { h: held.h, m: held.m })
                    : t("drawer.heldM", { m: held.m })}
            </Cell>
          </dl>

          <section className="pd-drawer-section">
            <h4>{t("drawer.tpsl")}</h4>
            <div className="pd-drawer-exits">
              {exitCard("tp")}
              {exitCard("sl")}
            </div>
            <div className="pd-drawer-row">
              <span>{t("drawer.trailing")}</span>
              <span className="pd-drawer-row-end">
                {position.trailingStop ? formatNumber(position.trailingStop) : t("drawer.notSet")}
                {onProtect && (
                  <button
                    type="button"
                    className="pd-tpsl-edit"
                    aria-label={t("protect.editTrail", { symbol })}
                    title={t("protect.editTrail", { symbol })}
                    onClick={() => setEditing("trail")}
                  >
                    <LuPencil size={13} aria-hidden />
                  </button>
                )}
              </span>
            </div>
            {onProtect && <p className="pd-drawer-tip">{t("drawer.tip")}</p>}
          </section>

          <section className="pd-drawer-section">
            <h4>{t("drawer.fills")}</h4>
            {fills === undefined ? (
              <div className="pd-skel pd-drawer-list-skel" />
            ) : fills.length === 0 ? (
              <p className="pd-drawer-none">{t("drawer.noFills")}</p>
            ) : (
              fills.map((f) => (
                <div key={f.id} className="pd-drawer-row">
                  <span>
                    {dateFormat(TIME).format(f.time)} ·{" "}
                    {t(f.side === "buy" ? "side.buy" : "side.sell")} {formatNumber(f.size)}
                  </span>
                  <span className="pd-drawer-row-end">{formatNumber(f.price)}</span>
                </div>
              ))
            )}
          </section>

          <section className="pd-drawer-section">
            <h4>{t("drawer.fundingLast", { count: FUNDING_SHOWN })}</h4>
            {funding === undefined ? (
              <div className="pd-skel pd-drawer-list-skel" />
            ) : funding.length === 0 ? (
              <p className="pd-drawer-none">{t("drawer.noFunding")}</p>
            ) : (
              funding.slice(0, FUNDING_SHOWN).map((p) => (
                <div key={`${p.time}:${p.amount}`} className="pd-drawer-row">
                  <span>
                    {dateFormat(CLOCK).format(p.time)} ·{" "}
                    {t("drawer.rate", { rate: `${formatNumber(Number(p.rate) * 100, 4)}%` })}
                  </span>
                  <span className={`pd-drawer-row-end ${trendClass(p.amount)}`}>
                    {formatSigned(p.amount)}
                  </span>
                </div>
              ))
            )}
          </section>
        </div>

        {onPlace && (
          <footer className="pd-drawer-foot">
            {limitOpen && (
              <div className="pd-drawer-limit">
                <label>
                  <span>{t("drawer.limitPrice")}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                    onKeyDown={(e) => e.key === "Enter" && closeLimit()}
                  />
                </label>
                <button
                  type="button"
                  className="pd-drawer-action"
                  disabled={busy}
                  onClick={closeLimit}
                >
                  {t("drawer.placeLimit")}
                </button>
              </div>
            )}
            {status && (
              <p className="pd-drawer-status" data-ok={status.ok || undefined} role="status">
                {status.text}
              </p>
            )}
            <div className="pd-drawer-actions">
              <button
                type="button"
                className="pd-drawer-action"
                aria-pressed={limitOpen}
                disabled={busy}
                onClick={() => setLimitOpen((open) => !open)}
              >
                {t("drawer.closeLimit")}
              </button>
              <button
                type="button"
                className="pd-drawer-action"
                data-danger
                data-armed={armed || undefined}
                disabled={busy}
                onClick={closeMarket}
              >
                {busy
                  ? t("drawer.closing")
                  : armed
                    ? t("drawer.confirmMarket")
                    : t("drawer.closeMarket")}
              </button>
            </div>
          </footer>
        )}
      </div>

      {editing === "tpsl" && onProtect && (
        <TpSlDialog
          position={position}
          symbol={symbol}
          quote={quote}
          tick={tick}
          onSave={onProtect}
          onClose={() => setEditing(undefined)}
        />
      )}
      {editing === "trail" && onProtect && (
        <TrailingStopDialog
          position={position}
          symbol={symbol}
          tick={tick}
          onSave={onProtect}
          onClose={() => setEditing(undefined)}
        />
      )}
    </dialog>
  );
}

function Cell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="pd-drawer-cell">
      <dt>{label}</dt>
      <dd className={className}>{children}</dd>
    </div>
  );
}
