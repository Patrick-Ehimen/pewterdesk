import type { AccountSnapshot, Market, OrderBook } from "@pewterdesk/core";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { LuArrowUpDown, LuChevronDown } from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import { decimalsOf, formatNumber } from "../../lib/format";
import {
  hasLimitPrice,
  hasTrigger,
  marketFill,
  PRO_TYPES,
  type ProType,
  positionLeverage,
  sizeFromPercent,
  slippageOf,
  type TicketSide,
  type TicketType,
} from "../../lib/ticket";
import { Hint } from "../common/ColumnHeader";
import { FloatingTip, Tooltip, useTipTrigger } from "../common/Tooltip";

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
/** Leverage assumed when there's no position to read it from. */
const DEFAULT_LEVERAGE = 10;

/** Digits and one decimal point only; a comma counts as the point. */
const numeric = (value: string) => {
  const next = value.replace(",", ".");
  return /^\d*\.?\d*$/.test(next) ? next : undefined;
};

function NumberField({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix?: ReactNode;
}) {
  return (
    <label className="pd-ticket-field">
      <span className="pd-ticket-field-label">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => {
          const next = numeric(e.target.value);
          if (next !== undefined) onChange(next);
        }}
      />
      {suffix}
    </label>
  );
}

interface OrderTicketProps {
  market?: Market;
  book?: OrderBook;
  /** The watched account; unset until one is connected. */
  account?: AccountSnapshot;
  /** Taker and maker fees as fractions; unset where the ticket can't know them. */
  fees?: { taker: number; maker: number };
  /** A market order won't fill further than this from the best price, as a fraction. */
  maxSlippage: number;
  onConnect: () => void;
  /**
   * Place the order. Unset while orders can't be placed: the button stays
   * visible but disabled, and says why.
   */
  onSubmit?: () => void;
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
}: OrderTicketProps) {
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
    (position && positionLeverage(position)) ??
    Math.min(DEFAULT_LEVERAGE, market?.maxLeverage ?? DEFAULT_LEVERAGE);
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
    return type === "market" || type === "twap" ? best : mid;
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
    v === undefined || !Number.isFinite(v) ? "—" : `${formatNumber(v, 2)} ${quote}`;
  const pct = (v: number) => `${formatNumber(v * 100, 2)}`;
  const isPro = type !== "market" && type !== "limit";
  const unavailable = !onSubmit;

  return (
    <div className="pd-ticket">
      <div className="pd-ticket-modes">
        {/* Changing either signs a venue action, so they wait for trading. */}
        <Tooltip content={t("quick.unavailable")} className="pd-ticket-chip">
          {t(market?.listedBy ? "ticket.isolated" : "ticket.cross")}
        </Tooltip>
        <Tooltip content={t("quick.unavailable")} className="pd-ticket-chip">
          {leverage}x
        </Tooltip>
      </div>

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
          <dd>{account ? money(available) : "—"}</dd>
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
        <NumberField label={t("ticket.triggerPrice")} value={trigger} onChange={setTrigger} />
      )}
      {hasLimitPrice(type) && (
        <NumberField label={t("ticket.price")} value={limitPrice} onChange={setLimitPrice} />
      )}
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

      <div className="pd-ticket-spacer" />

      {account ? (
        <>
          <button
            ref={submitRef}
            type="button"
            className="pd-ticket-submit"
            data-side={side}
            aria-disabled={unavailable || undefined}
            aria-describedby={unavailable ? reasonId : undefined}
            onClick={onSubmit}
            {...submitTip.handlers}
          >
            {t(side === "buy" ? "ticket.buy" : "ticket.sell")}
          </button>
          {unavailable && (
            <span id={reasonId} className="pd-visually-hidden">
              {t("quick.unavailable")}
            </span>
          )}
          {unavailable && submitTip.open && (
            <FloatingTip getAnchor={() => submitRef.current}>{t("quick.unavailable")}</FloatingTip>
          )}
        </>
      ) : (
        <button type="button" className="pd-ticket-submit" data-connect onClick={onConnect}>
          {t("ticket.connect")}
        </button>
      )}

      <dl className="pd-ticket-summary">
        <div className="pd-ticket-line">
          <dt>{t("ticket.liqPrice")}</dt>
          <dd>—</dd>
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
              : "—"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
