import type {
  AccountSnapshot,
  MarginMode,
  Market,
  OrderBook,
  OrderRequest,
  TradeSettings,
} from "@pewterdesk/core";
import { useEffect, useId, useRef, useState } from "react";
import { LuArrowUpDown, LuChevronDown, LuTriangleAlert } from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import { decimalsOf, formatNumber, onTick } from "../../lib/format";
import {
  hasLimitPrice,
  hasTrigger,
  marketFill,
  PRO_TYPES,
  type ProType,
  positionLeverage,
  sizeFromPercent,
  slippageOf,
  type TicketBlock,
  type TicketSide,
  type TicketType,
  ticketOrder,
} from "../../lib/ticket";
import {
  estLiquidation,
  positionAfter,
  type TicketCheck,
  ticketChecks,
} from "../../lib/ticketChecks";
import { Hint } from "../common/ColumnHeader";
import { FloatingTip, Tooltip, useTipTrigger } from "../common/Tooltip";
import { type ConfirmChange, type ConfirmRow, OrderConfirmDialog } from "./OrderConfirmDialog";
import { SizeCalculator } from "./SizeCalculator";
import { NumberField } from "./TicketField";
import { LeverageDialog, MarginModeDialog } from "./TradeSettingsDialogs";

/** What the button says when the order can't go yet. */
const BLOCKED: Record<TicketBlock, MessageKey> = {
  size: "ticket.needSize",
  price: "ticket.needPrice",
  trigger: "ticket.needTrigger",
  type: "ticket.typeSoon",
  tpsl: "ticket.tpslSoon",
};

const PRO_LABEL: Record<ProType, MessageKey> = {
  scale: "ticket.scale",
  stopLimit: "ticket.stopLimit",
  stopMarket: "ticket.stopMarket",
  takeLimit: "ticket.takeLimit",
  takeMarket: "ticket.takeMarket",
  twap: "ticket.twap",
};
/** The slider's marks, in percent of what's available. */
const MARKS = [0, 25, 50, 75, 100];
/** What the confirmation's checkbox stops asking under, in the quote coin. */
const SKIP_UNDER = 10_000;
/** Leverage assumed when there's no position to read it from. */
const DEFAULT_LEVERAGE = 10;

interface OrderTicketProps {
  market?: Market;
  book?: OrderBook;
  /** The connected account; unset until a wallet is connected. */
  account?: AccountSnapshot;
  /** Taker and maker fees as fractions; unset where the ticket can't know them. */
  fees?: { taker: number; maker: number };
  /** A market order won't fill further than this from the best price, as a fraction. */
  maxSlippage: number;
  onConnect: () => void;
  /**
   * Place the order; resolves once the venue has it, or rejects with why
   * not. Unset while orders can't be placed: the button stays visible but
   * disabled, and says why.
   */
  onSubmit?: (request: OrderRequest) => Promise<void>;
  /** A marker for the account the ticket trades, e.g. "Demo". */
  accountBadge?: string;
  /** Why orders can't be placed, where there's a better reason than "not yet". */
  unavailableReason?: string;
  /** The account's margin mode and leverage on this market, where the venue reports them. */
  settings?: TradeSettings;
  /** Changes the leverage; unset where it can't be (the chip is then inert). */
  onLeverage?: (leverage: number) => Promise<void>;
  /** Changes the margin mode; unset where it can't be. */
  onMarginMode?: (mode: MarginMode) => Promise<void>;
  /** A price to size against while the book has none (e.g. the mark). */
  fallbackPrice?: number;
  /** Shows a summary to confirm before an order is sent. */
  confirmOrders?: boolean;
  /** Orders worth less than this, in the quote coin, skip the confirmation. */
  confirmSkipUnder?: number;
  /** The confirmation's "don't confirm orders under…" was ticked, with that amount. */
  onConfirmSkipUnder?: (amount: number) => void;
}

/**
 * The order form, after the design: margin mode and leverage, Market /
 * Limit / Pro, buy or sell, size (in the coin or the quote) with a slider
 * over what's available, reduce-only and TP/SL, then what the order comes
 * to: value, margin, slippage against the visible book, and fees.
 */
export function OrderTicket({
  market,
  book,
  account,
  fees,
  maxSlippage,
  onConnect,
  onSubmit,
  accountBadge,
  unavailableReason,
  settings,
  onLeverage,
  onMarginMode,
  fallbackPrice,
  confirmOrders,
  confirmSkipUnder,
  onConfirmSkipUnder,
}: OrderTicketProps) {
  const [confirming, setConfirming] = useState<OrderRequest>();
  const [editing, setEditing] = useState<"leverage" | "margin">();
  const [type, setType] = useState<TicketType>("market");
  const [side, setSide] = useState<TicketSide>("buy");
  const [size, setSize] = useState("");
  const [unit, setUnit] = useState<"base" | "quote">("base");
  const [limitPrice, setLimitPrice] = useState("");
  const [trigger, setTrigger] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [count, setCount] = useState("5");
  const [minutes, setMinutes] = useState("30");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tpsl, setTpsl] = useState(false);
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [proOpen, setProOpen] = useState(false);
  const proRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const submitTip = useTipTrigger();
  const [sending, setSending] = useState(false);
  const reasonId = useId();

  // A new market starts a fresh order.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on the market's id only
  useEffect(() => {
    for (const reset of [setSize, setLimitPrice, setTrigger, setStart, setEnd, setTp, setSl]) {
      reset("");
    }
  }, [market?.id]);

  // The Pro menu closes on a click elsewhere.
  useEffect(() => {
    if (!proOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!proRef.current?.contains(e.target as Node)) setProOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [proOpen]);

  const base = market?.base ?? "";
  const quote = market?.quote ?? "USDC";
  const bestBid = Number(book?.bids[0]?.price ?? Number.NaN);
  const bestAsk = Number(book?.asks[0]?.price ?? Number.NaN);
  const mid = (bestBid + bestAsk) / 2;
  const best = side === "buy" ? bestAsk : bestBid;
  const sizeDecimals = decimalsOf(market?.sizeStep ?? "0");

  const position = market && account?.positions.find((p) => p.market === market.id);
  const leverage =
    (settings && Number(settings.leverage)) ||
    ((position && positionLeverage(position)) ??
      Math.min(DEFAULT_LEVERAGE, market?.maxLeverage ?? DEFAULT_LEVERAGE));
  const marginMode: MarginMode = settings?.marginMode ?? (market?.listedBy ? "isolated" : "cross");
  const available = account ? Number(account.availableMargin) : 0;

  // The price the order is valued at: the limit for limit types, the trigger
  // for triggered market orders, the average of the range for scale, else
  // the touch.
  const price = (() => {
    if (hasLimitPrice(type) && Number(limitPrice) > 0) return Number(limitPrice);
    if (hasTrigger(type) && Number(trigger) > 0) return Number(trigger);
    if (type === "scale" && Number(start) > 0 && Number(end) > 0) {
      return (Number(start) + Number(end)) / 2;
    }
    const touch = type === "market" || type === "twap" ? best : mid;
    // No book yet (loading, or stale): size against the fallback instead.
    return Number.isFinite(touch) && touch > 0 ? touch : (fallbackPrice ?? Number.NaN);
  })();
  const sizeBase =
    unit === "base" ? Number(size) || 0 : price > 0 ? (Number(size) || 0) / price : 0;

  // A market order walks the book, so value it at the average fill.
  const levels = (side === "buy" ? book?.asks : book?.bids)?.map((l) => ({
    price: Number(l.price),
    size: Number(l.size),
  }));
  const fill = type === "market" ? marketFill(levels ?? [], sizeBase) : undefined;
  const fillPrice = fill?.avgPrice ?? price;
  const orderValue = sizeBase > 0 && fillPrice > 0 ? sizeBase * fillPrice : undefined;
  const margin = orderValue === undefined ? undefined : orderValue / leverage;
  const percent =
    orderValue !== undefined && available > 0
      ? Math.min(100, (orderValue / (available * leverage)) * 100)
      : 0;

  const setPercent = (pct: number) => {
    const baseSize = sizeFromPercent(pct, available, leverage, price);
    setSize(
      baseSize > 0
        ? unit === "base"
          ? baseSize.toFixed(sizeDecimals)
          : (baseSize * price).toFixed(2)
        : "",
    );
  };
  const switchUnit = () => {
    // Keep the same amount, expressed in the other unit.
    if (sizeBase > 0 && price > 0) {
      setSize(unit === "base" ? (sizeBase * price).toFixed(2) : sizeBase.toFixed(sizeDecimals));
    }
    setUnit(unit === "base" ? "quote" : "base");
  };

  const money = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? "-" : `${formatNumber(v, 2)} ${quote}`;
  const pct = (v: number) => `${formatNumber(v * 100, 2)}`;
  const isPro = type !== "market" && type !== "limit";
  const built = market
    ? ticketOrder({
        market,
        type,
        side,
        sizeBase,
        limitPrice,
        trigger,
        reduceOnly,
        tpsl,
        maxSlippage,
      })
    : undefined;
  const blocked = built && "blocked" in built ? BLOCKED[built.blocked] : undefined;
  const checks = market
    ? ticketChecks({
        market,
        type,
        side,
        sizeBase,
        limitPrice,
        trigger,
        reduceOnly,
        bestBid,
        bestAsk,
        price,
        available: account ? available : undefined,
        leverage,
        position,
      })
    : [];
  const errors = checks.filter((c) => c.level === "error").length;
  const stateOf = (field: TicketCheck["field"]) => {
    const found = checks.filter((c) => c.field === field);
    return found.some((c) => c.level === "error") ? "error" : found.length > 0 ? "warn" : undefined;
  };
  const priceText = (v: number) => formatNumber(v, decimalsOf(market?.tickSize ?? "0"));
  const sizeText = (v: number) => formatNumber(v, sizeDecimals);
  /** A check as a line under its field, with a one-click fix where there is one. */
  const note = (c: TicketCheck) => {
    let text: string;
    let fix: { label: string; apply: () => void } | undefined;
    if (c.code === "tick") text = t("check.tick", { tick: c.tick });
    else if (c.code === "crosses") {
      text = t(side === "buy" ? "check.crossesBuy" : "check.crossesSell", {
        pct: formatNumber(c.past * 100, 2),
        price: priceText(Number(limitPrice)),
      });
      const midText = onTick(c.mid, market?.tickSize ?? "0");
      fix = {
        label: t("check.useMid", { price: formatNumber(midText) }),
        apply: () => setLimitPrice(midText),
      };
    } else if (c.code === "minSize") text = t("check.minSize", { min: c.min, base });
    else if (c.code === "step") {
      text = t("check.step", { step: c.step, size: sizeText(c.sends), base });
    } else {
      text = t("check.margin", {
        need: formatNumber(c.need, 2),
        quote,
        leverage: formatNumber(leverage, Number.isInteger(leverage) ? 0 : 2),
        have: formatNumber(c.have, 2),
      });
      const max = c.max;
      if (max > 0) {
        fix = {
          label: t("check.useMax", { size: sizeText(max) }),
          apply: () => {
            setUnit("base");
            setSize(max.toFixed(sizeDecimals));
          },
        };
      }
    }
    return (
      <p key={`${c.field}:${c.code}`} className="pd-ticket-note" data-level={c.level} role="alert">
        <LuTriangleAlert className="pd-ticket-note-icon" size={13} aria-hidden />
        <span>
          {text}{" "}
          {fix && (
            <button type="button" className="pd-ticket-fix" onClick={fix.apply}>
              {fix.label}
            </button>
          )}
        </span>
      </p>
    );
  };
  const notesFor = (field: TicketCheck["field"]) =>
    checks.filter((c) => c.field === field).map(note);
  const reason: MessageKey | undefined = !onSubmit
    ? "quick.unavailable"
    : !market
      ? "ticket.needSize"
      : (blocked ?? (errors > 0 ? "check.fix" : undefined));
  const unavailable = reason !== undefined || sending;
  const reasonText =
    reason === "quick.unavailable" && unavailableReason ? unavailableReason : reason && t(reason);

  const send = async (request: OrderRequest) => {
    if (!onSubmit || sending) return;
    setSending(true);
    try {
      await onSubmit(request);
      setSize("");
    } catch {
      // Whoever placed it says why not (a toast); the size stays to retry.
    } finally {
      setSending(false);
    }
  };
  const submit = () => {
    if (!onSubmit || !built || !("request" in built) || sending || errors > 0) return;
    const small =
      confirmSkipUnder !== undefined && orderValue !== undefined && orderValue < confirmSkipUnder;
    if (confirmOrders && !small) setConfirming(built.request);
    else void send(built.request);
  };

  // What the confirmation shows, from the ticket as it stands.
  const confirmRows = (): ConfirmRow[] => {
    const typeLabel = t(
      type === "market" ? "ticket.market" : type === "limit" ? "ticket.limit" : PRO_LABEL[type],
    );
    const fee = fees && (type === "limit" ? fees.maker : fees.taker);
    const rows: (ConfirmRow | false | undefined)[] = [
      { label: t("confirm.type"), value: typeLabel },
      hasTrigger(type) && { label: t("ticket.triggerPrice"), value: priceText(Number(trigger)) },
      hasLimitPrice(type) && {
        label: t("confirm.limitPrice"),
        value: priceText(Number(limitPrice)),
      },
      type === "market" &&
        fillPrice > 0 && { label: t("confirm.estPrice"), value: priceText(fillPrice) },
      { label: t("ticket.size"), value: `${sizeText(sizeBase)} ${base}` },
      { label: t("ticket.orderValue"), value: money(orderValue) },
      !reduceOnly && {
        label: t("confirm.margin", {
          mode: t(marginMode === "isolated" ? "ticket.isolated" : "ticket.cross"),
          leverage: formatNumber(leverage, Number.isInteger(leverage) ? 0 : 2),
        }),
        value: money(margin),
      },
      fee !== undefined &&
        orderValue !== undefined && {
          label: t("confirm.fee", {
            kind: t(type === "limit" ? "confirm.maker" : "confirm.taker"),
            rate: formatNumber(fee * 100, 4),
          }),
          value: money(orderValue * fee),
        },
      type === "market" && { label: t("confirm.maxSlippage"), value: `${pct(maxSlippage)}%` },
      reduceOnly && { label: t("confirm.flags"), value: t("ticket.reduceOnly") },
    ];
    return rows.filter((r): r is ConfirmRow => Boolean(r));
  };
  // The position the order leaves, and roughly where that would be liquidated.
  const after =
    fillPrice > 0 && sizeBase > 0
      ? positionAfter(position, side, sizeBase, fillPrice, reduceOnly)
      : undefined;
  const marginInfo = {
    mode: marginMode,
    leverage,
    equity: account ? Number(account.equity) : undefined,
  };
  const estLiq = after && estLiquidation(after.to, marginInfo);
  const confirmAfter = (): ConfirmChange[] | undefined => {
    if (!after) return undefined;
    const { from, to } = after;
    const liqFrom = position?.liquidationPrice ? priceText(Number(position.liquidationPrice)) : "-";
    const sized = (p: { size: number }) =>
      p.size === 0
        ? t("confirm.flat")
        : `${sizeText(Math.abs(p.size))} ${t(p.size > 0 ? "side.long" : "side.short")}`;
    const entry = (p: { entry?: number }) => (p.entry === undefined ? "-" : priceText(p.entry));
    return [
      {
        label: t("ticket.size"),
        from: sized(from),
        to: sized(to),
        tone: to.size > 0 ? "buy" : to.size < 0 ? "sell" : undefined,
      },
      { label: t("confirm.avgEntry"), from: entry(from), to: entry(to) },
      {
        label: t("confirm.estLiq"),
        from: liqFrom,
        to: estLiq === undefined ? "-" : priceText(estLiq),
        tone: estLiq === undefined ? undefined : "warn",
      },
    ];
  };

  return (
    <div className="pd-ticket">
      <div className="pd-ticket-modes">
        {accountBadge && <span className="pd-ticket-badge">{accountBadge}</span>}
        {/* Changing either signs a venue action: only where the account can trade. */}
        <Tooltip
          content={onMarginMode ? t("ticket.changeMargin") : t("quick.unavailable")}
          className={`pd-ticket-chip${onMarginMode ? " pd-ticket-chip-on" : ""}`}
          onClick={onMarginMode && (() => setEditing("margin"))}
        >
          {t(marginMode === "isolated" ? "ticket.isolated" : "ticket.cross")}
        </Tooltip>
        <Tooltip
          content={onLeverage ? t("ticket.changeLeverage") : t("quick.unavailable")}
          className={`pd-ticket-chip${onLeverage ? " pd-ticket-chip-on" : ""}`}
          onClick={onLeverage && (() => setEditing("leverage"))}
        >
          {formatNumber(leverage, Number.isInteger(leverage) ? 0 : 2)}x
        </Tooltip>
      </div>
      {editing === "margin" && onMarginMode && (
        <MarginModeDialog
          current={marginMode}
          accountWide={settings?.marginModeAccountWide ?? false}
          onSave={onMarginMode}
          onClose={() => setEditing(undefined)}
        />
      )}
      {editing === "leverage" && onLeverage && (
        <LeverageDialog
          symbol={market?.symbol ?? ""}
          current={leverage}
          max={Number(settings?.maxLeverage ?? market?.maxLeverage ?? leverage)}
          onSave={onLeverage}
          onClose={() => setEditing(undefined)}
        />
      )}

      <div className="pd-ticket-types" role="tablist" aria-label={t("ticket.orderType")}>
        {(["market", "limit"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={type === id}
            className="pd-ticket-type"
            onClick={() => setType(id)}
          >
            {t(id === "market" ? "ticket.market" : "ticket.limit")}
          </button>
        ))}
        <div ref={proRef} className="pd-ticket-pro">
          <button
            type="button"
            role="tab"
            aria-selected={isPro}
            aria-haspopup="menu"
            aria-expanded={proOpen}
            className="pd-ticket-type"
            onClick={() => setProOpen((o) => !o)}
            onKeyDown={(e) => e.key === "Escape" && setProOpen(false)}
          >
            {isPro ? t(PRO_LABEL[type]) : t("ticket.pro")}
            <LuChevronDown size={14} aria-hidden data-open={proOpen || undefined} />
          </button>
          {proOpen && (
            <div className="pd-ticket-menu" role="menu" aria-label={t("ticket.proTypes")}>
              {PRO_TYPES.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="menuitemradio"
                  aria-checked={type === p}
                  onClick={() => {
                    setType(p);
                    setProOpen(false);
                  }}
                >
                  {t(PRO_LABEL[p])}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="pd-ticket-sides" role="radiogroup" aria-label={t("ticket.side")}>
        {(["buy", "sell"] as const).map((s) => (
          // biome-ignore lint/a11y/useSemanticElements: two-way segmented switch, like the other segmented controls
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            data-side={s}
            onClick={() => setSide(s)}
          >
            {t(s === "buy" ? "ticket.buy" : "ticket.sell")}
          </button>
        ))}
      </div>

      <dl className="pd-ticket-info">
        <div className="pd-ticket-line">
          <dt>{t("ticket.available")}</dt>
          <dd>{account ? money(available) : "-"}</dd>
        </div>
        <div className="pd-ticket-line">
          <dt>{t("ticket.position")}</dt>
          <dd>
            {position
              ? `${position.side === "short" ? "-" : ""}${formatNumber(position.size)} ${base}`
              : `${formatNumber(0, sizeDecimals)} ${base}`}
          </dd>
        </div>
      </dl>

      {hasTrigger(type) && (
        <NumberField
          label={t("ticket.triggerPrice")}
          value={trigger}
          onChange={setTrigger}
          state={stateOf("trigger")}
        />
      )}
      {notesFor("trigger")}
      {hasLimitPrice(type) && (
        <NumberField
          label={t("ticket.price")}
          value={limitPrice}
          onChange={setLimitPrice}
          state={stateOf("price")}
        />
      )}
      {notesFor("price")}
      {type === "scale" && (
        <div className="pd-ticket-row">
          <NumberField label={t("ticket.startPrice")} value={start} onChange={setStart} />
          <NumberField label={t("ticket.endPrice")} value={end} onChange={setEnd} />
        </div>
      )}
      {type === "scale" && (
        <NumberField label={t("ticket.orders")} value={count} onChange={setCount} />
      )}
      {type === "twap" && (
        <NumberField label={t("ticket.minutes")} value={minutes} onChange={setMinutes} />
      )}

      <NumberField
        label={t("ticket.size")}
        value={size}
        onChange={setSize}
        state={stateOf("size")}
        suffix={
          <button
            type="button"
            className="pd-ticket-unit"
            aria-label={t("ticket.sizeUnit")}
            onClick={switchUnit}
          >
            {unit === "base" ? base : quote}
            <LuArrowUpDown size={12} aria-hidden />
          </button>
        }
      />

      {notesFor("size")}

      <div className="pd-ticket-slider">
        <div className="pd-ticket-track">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(percent)}
            disabled={!account}
            aria-label={t("ticket.percent")}
            style={{ ["--pd-fill" as string]: `${percent}%` }}
            onChange={(e) => setPercent(Number(e.target.value))}
          />
          <div className="pd-ticket-marks" aria-hidden>
            {MARKS.map((m) => (
              <span
                key={m}
                className="pd-ticket-mark"
                data-passed={percent >= m || undefined}
                style={{ left: `${m}%` }}
              />
            ))}
          </div>
        </div>
        <span className="pd-ticket-percent pd-num">{Math.round(percent)} %</span>
      </div>

      <label className="pd-ticket-check">
        <input
          type="checkbox"
          checked={reduceOnly}
          onChange={(e) => setReduceOnly(e.target.checked)}
        />
        {t("ticket.reduceOnly")}
      </label>
      <label className="pd-ticket-check">
        <input type="checkbox" checked={tpsl} onChange={(e) => setTpsl(e.target.checked)} />
        {t("ticket.tpsl")}
      </label>
      {tpsl && (
        <div className="pd-ticket-row">
          <NumberField label={t("ticket.tpPrice")} value={tp} onChange={setTp} />
          <NumberField label={t("ticket.slPrice")} value={sl} onChange={setSl} />
        </div>
      )}

      <SizeCalculator
        market={market}
        mid={mid}
        takerFee={fees?.taker}
        side={side}
        leverage={leverage}
        available={account ? available : undefined}
        onUse={(sizeText) => {
          setUnit("base");
          setSize(sizeText);
        }}
      />

      <div className="pd-ticket-spacer" />

      {account ? (
        <>
          {errors > 0 && onSubmit && <p className="pd-ticket-blocked">{t("check.fix")}</p>}
          <button
            ref={submitRef}
            type="button"
            className="pd-ticket-submit"
            data-side={side}
            aria-disabled={unavailable || undefined}
            aria-describedby={reason ? reasonId : undefined}
            onClick={submit}
            {...submitTip.handlers}
          >
            {sending ? t("ticket.sending") : t(side === "buy" ? "ticket.buy" : "ticket.sell")}
          </button>
          {reason && (
            <span id={reasonId} className="pd-visually-hidden">
              {reasonText}
            </span>
          )}
          {reason && submitTip.open && (
            <FloatingTip getAnchor={() => submitRef.current}>{reasonText}</FloatingTip>
          )}
        </>
      ) : (
        <button type="button" className="pd-ticket-submit" data-connect onClick={onConnect}>
          {t("ticket.connect")}
        </button>
      )}

      {confirming && (
        <OrderConfirmDialog
          side={confirming.side}
          symbol={market?.symbol ?? ""}
          rows={confirmRows()}
          after={confirmAfter()}
          skipLabel={
            onConfirmSkipUnder && t("confirm.skip", { amount: formatNumber(SKIP_UNDER, 0), quote })
          }
          onConfirm={(skip) => {
            if (skip) onConfirmSkipUnder?.(SKIP_UNDER);
            const request = confirming;
            setConfirming(undefined);
            void send(request);
          }}
          onCancel={() => setConfirming(undefined)}
        />
      )}

      <dl className="pd-ticket-summary">
        <div className="pd-ticket-line">
          <dt>{t("ticket.liqPrice")}</dt>
          <dd className={estLiq === undefined ? undefined : "pd-warn"}>
            {estLiq === undefined ? "-" : `≈ ${priceText(estLiq)}`}
          </dd>
        </div>
        <div className="pd-ticket-line">
          <dt>{t("ticket.orderValue")}</dt>
          <dd>{money(orderValue)}</dd>
        </div>
        <div className="pd-ticket-line">
          <dt>{t("ticket.margin")}</dt>
          <dd>{money(margin)}</dd>
        </div>
        <div className="pd-ticket-line">
          <dt>
            <Tooltip
              className="pd-ticket-hint"
              content={<Hint title={t("ticket.slippage")}>{t("ticket.slippageHint")}</Hint>}
            >
              {t("ticket.slippage")}
            </Tooltip>
          </dt>
          <dd className="pd-ticket-accent">
            {t("ticket.slippageValue", {
              est: fill ? pct(slippageOf(fill.avgPrice, best)) : pct(0),
              max: pct(maxSlippage),
            })}
          </dd>
        </div>
        <div className="pd-ticket-line">
          <dt>
            <Tooltip
              className="pd-ticket-hint"
              content={<Hint title={t("ticket.fees")}>{t("ticket.feesHint")}</Hint>}
            >
              {t("ticket.fees")}
            </Tooltip>
          </dt>
          <dd>
            {fees
              ? `${formatNumber(fees.taker * 100, 4)}% / ${formatNumber(fees.maker * 100, 4)}%`
              : "-"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
