import type { ExitChange, Order, OrderAmend, Position, PositionProtection } from "@pewterdesk/core";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { LuCircleHelp, LuMinus, LuPlus, LuX } from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import { decimalsOf, formatNumber, formatSigned, trendClass } from "../../lib/format";

/** What both dialogs need about the position and its market. */
interface DialogProps {
  position: Position;
  /** The market's display symbol. */
  symbol: string;
  /** The coin PnL is in, e.g. "USDT". */
  quote: string;
  /** The market's price tick, e.g. "0.1": what the steppers move by. */
  tick: string;
  onSave: (protection: PositionProtection) => Promise<void>;
  onClose: () => void;
}

const KEEP: ExitChange = { action: "keep" };

/** `value` on the tick grid, as text with the tick's decimals. */
function onTick(value: number, tick: string): string {
  const step = Number(tick);
  const snapped = step > 0 ? Math.round(value / step) * step : value;
  return snapped.toFixed(decimalsOf(tick));
}

/** The change that turns `current` into what's typed: kept if equal, removed if cleared. */
function changeTo(typed: string, current: string | undefined): ExitChange {
  const v = typed.trim();
  if (v === "") return current ? { action: "remove" } : KEEP;
  if (current !== undefined && Number(v) === Number(current)) return KEEP;
  return { action: "set", price: v };
}

/** The dialog frame: title, close, the position's figures, the form, and Confirm / Cancel. */
function Shell({
  title,
  stats,
  busy,
  error,
  onSubmit,
  onClose,
  extra,
  children,
}: {
  title: string;
  stats: { label: MessageKey; value: string; warn?: boolean }[];
  busy: boolean;
  error?: string;
  onSubmit: () => void;
  onClose: () => void;
  /** Under Confirm / Cancel, e.g. a remove button. */
  extra?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="pd-protect"
      aria-label={title}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <header className="pd-protect-head">
          <h3>{title}</h3>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("wallet.close")}
            onClick={onClose}
          >
            <LuX size={18} aria-hidden />
          </button>
        </header>
        <dl className="pd-protect-stats">
          {stats.map((s) => (
            <div key={s.label}>
              <dt>{t(s.label)}</dt>
              <dd className="pd-num" data-warn={s.warn || undefined}>
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
        {children}
        {error && (
          <p className="pd-protect-error" role="alert">
            {error}
          </p>
        )}
        <footer className="pd-protect-foot">
          <button type="submit" className="pd-protect-confirm" disabled={busy}>
            {t(busy ? "protect.saving" : "protect.confirm")}
          </button>
          <button type="button" className="pd-protect-cancel" onClick={onClose}>
            {t("protect.cancel")}
          </button>
        </footer>
        {extra}
      </form>
    </dialog>
  );
}

/** A price box with − / + steppers that move it by `step`, from `from` when empty. */
function Stepper({
  value,
  onChange,
  step,
  from,
  placeholder,
  label,
  suffix,
}: {
  value: string;
  onChange: (v: string) => void;
  step: string;
  /** Where the first step starts from when the box is empty. */
  from: number;
  placeholder: string;
  label: string;
  suffix?: ReactNode;
}) {
  const nudge = (dir: 1 | -1) => {
    const base = Number(value) > 0 ? Number(value) : from;
    const next = base + dir * Number(step);
    if (next > 0) onChange(onTick(next, step));
  };
  return (
    <div className="pd-protect-stepper">
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
      <button
        type="button"
        aria-label={t("protect.less", { what: label })}
        onClick={() => nudge(-1)}
      >
        <LuMinus size={15} aria-hidden />
      </button>
      <span className="pd-protect-bar" aria-hidden />
      <button
        type="button"
        aria-label={t("protect.more", { what: label })}
        onClick={() => nudge(1)}
      >
        <LuPlus size={15} aria-hidden />
      </button>
      {suffix && <span className="pd-protect-suffix">{suffix}</span>}
    </div>
  );
}

/** A 0..max% slider with four stops, as in the reference. */
function RoiSlider({
  value,
  max,
  onChange,
  label,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const shown = Math.min(max, Math.max(0, value));
  return (
    <div className="pd-protect-slider">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={shown}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        style={{ "--fill": `${(shown / max) * 100}%` } as CSSProperties}
      />
      <div className="pd-protect-marks" aria-hidden>
        <span>0</span>
        <span>{max}%</span>
      </div>
    </div>
  );
}

const fmt = (v: string | undefined) => (v ? formatNumber(v) : "-");

/**
 * Take-profit and stop-loss for the whole position, after the venue's own
 * "Add TP/SL": each by trigger price or by ROI (kept in step), with a slider,
 * and what it would make or lose. Saving leaves the trailing stop as it is;
 * clearing a box removes that exit.
 */
export function TpSlDialog({ position, symbol, quote, tick, onSave, onClose }: DialogProps) {
  const [tp, setTp] = useState(position.takeProfit ?? "");
  const [sl, setSl] = useState(position.stopLoss ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const entry = Number(position.entryPrice);
  const mark = Number(position.markPrice);
  const size = Number(position.size);
  const margin = Number(position.margin);
  const dir = position.side === "long" ? 1 : -1;
  /** PnL if the position closed at `price`, ignoring fees. */
  const pnlAt = (price: number) => (price - entry) * size * dir;
  /** ROI at `price` against the position's margin, as the venue shows it. */
  const roiAt = (price: number) => (margin > 0 ? (pnlAt(price) / margin) * 100 : 0);
  /** The price at which the position makes (gain) or loses (!gain) `roi`% of its margin. */
  const priceAt = (roi: number, gain: boolean) =>
    entry + ((gain ? 1 : -1) * dir * (roi / 100) * margin) / size;

  const tpRoi = Number(tp) > 0 ? roiAt(Number(tp)) : 0;
  const slRoi = Number(sl) > 0 ? -roiAt(Number(sl)) : 0;
  const setTpRoi = (roi: number) => setTp(roi > 0 ? onTick(priceAt(roi, true), tick) : "");
  const setSlRoi = (roi: number) => setSl(roi > 0 ? onTick(priceAt(roi, false), tick) : "");

  const estimate = (text: string) => {
    const price = Number(text);
    if (!(price > 0)) return null;
    const pnl = pnlAt(price);
    return (
      <p className="pd-protect-est">
        {t("protect.estPnl")}{" "}
        <span className={`pd-num ${trendClass(pnl)}`}>
          {formatSigned(pnl, 2)} {quote}
        </span>
      </p>
    );
  };

  const submit = async () => {
    for (const v of [tp, sl]) {
      if (v.trim() !== "" && !(Number(v) > 0)) return setError(t("protect.invalid"));
    }
    // TP on the winning side of the price, SL on the losing side.
    if (Number(tp) > 0 && (Number(tp) - mark) * dir <= 0) return setError(t("protect.tpSide"));
    if (Number(sl) > 0 && (Number(sl) - mark) * dir >= 0) return setError(t("protect.slSide"));
    const change: PositionProtection = {
      takeProfit: changeTo(tp, position.takeProfit),
      stopLoss: changeTo(sl, position.stopLoss),
      trailingStop: KEEP,
    };
    if (change.takeProfit?.action === "keep" && change.stopLoss?.action === "keep") {
      return onClose();
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSave(change);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("protect.failed"));
      setBusy(false);
    }
  };

  const roiBox = (roi: number, set: (roi: number) => void, label: string) => (
    <div className="pd-protect-roi">
      <input
        inputMode="decimal"
        value={roi > 0 ? roi.toFixed(2).replace(/\.?0+$/, "") : ""}
        onChange={(e) => set(Number(e.target.value) || 0)}
        placeholder={t("protect.roi")}
        aria-label={label}
      />
      <span className="pd-protect-suffix">%</span>
    </div>
  );

  return (
    <Shell
      title={t("protect.tpslTitle", { symbol })}
      stats={[
        { label: "protect.entry", value: fmt(position.entryPrice) },
        { label: "protect.quantity", value: fmt(position.size) },
        { label: "protect.markPrice", value: fmt(position.markPrice) },
        { label: "protect.liq", value: fmt(position.liquidationPrice), warn: true },
      ]}
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div className="pd-protect-tabs" role="tablist" aria-label={t("protect.scope")}>
        <button type="button" role="tab" aria-selected="true">
          {t("protect.entire")}
        </button>
        <button type="button" role="tab" aria-selected="false" disabled title={t("wallet.soon")}>
          {t("protect.partial")}
        </button>
        <span className="pd-protect-help" title={t("protect.entireHint")}>
          <LuCircleHelp size={16} aria-hidden />
        </span>
      </div>

      <section className="pd-protect-section">
        <h4>{t("protect.tpByRoi")}</h4>
        <div className="pd-protect-row">
          <Stepper
            value={tp}
            onChange={setTp}
            step={tick}
            from={mark}
            placeholder={t("protect.trigger")}
            label={t("protect.tp")}
            suffix={t("protect.last")}
          />
          {roiBox(tpRoi, setTpRoi, t("protect.tpRoi"))}
        </div>
        <RoiSlider value={tpRoi} max={150} onChange={setTpRoi} label={t("protect.tpRoi")} />
        {estimate(tp)}
      </section>

      <section className="pd-protect-section">
        <h4>{t("protect.slByRoi")}</h4>
        <div className="pd-protect-row">
          <Stepper
            value={sl}
            onChange={setSl}
            step={tick}
            from={mark}
            placeholder={t("protect.trigger")}
            label={t("protect.sl")}
            suffix={t("protect.last")}
          />
          {roiBox(slRoi, setSlRoi, t("protect.slRoi"))}
        </div>
        <RoiSlider value={slRoi} max={75} onChange={setSlRoi} label={t("protect.slRoi")} />
        {estimate(sl)}
      </section>
    </Shell>
  );
}

/**
 * The trailing stop, after the venue's own "Set Trailing Stop": a retracement
 * by distance (or by percent of the price, turned into a distance), and an
 * optional activation price. Saving leaves the TP and SL as they are.
 */
export function TrailingStopDialog({
  position,
  symbol,
  tick,
  onSave,
  onClose,
}: Omit<DialogProps, "quote">) {
  const [mode, setMode] = useState<"distance" | "percent">("distance");
  const [amount, setAmount] = useState(position.trailingStop ?? "");
  const [activate, setActivate] = useState(false);
  const [activation, setActivation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mark = Number(position.markPrice);

  /** The retracement as a price distance, on the tick; undefined until valid. */
  const distance = (() => {
    const v = Number(amount);
    if (!(v > 0)) return undefined;
    const d = mode === "distance" ? v : (mark * v) / 100;
    const text = onTick(d, tick);
    return Number(text) > 0 ? text : undefined;
  })();

  const send = async (change: PositionProtection) => {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(change);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("protect.failed"));
      setBusy(false);
    }
  };
  const submit = () => {
    if (!distance) return setError(t("protect.needDistance"));
    if (activate && !(Number(activation) > 0)) return setError(t("protect.invalid"));
    void send({
      takeProfit: KEEP,
      stopLoss: KEEP,
      trailingStop: { action: "set", price: distance },
      ...(activate && { trailingActivation: activation.trim() }),
    });
  };

  return (
    <Shell
      title={t("protect.trailTitle", { symbol })}
      stats={[
        { label: "protect.entry", value: fmt(position.entryPrice) },
        { label: "protect.marketPrice", value: fmt(position.markPrice) },
        { label: "protect.liq", value: fmt(position.liquidationPrice), warn: true },
      ]}
      busy={busy}
      error={error}
      onSubmit={submit}
      onClose={onClose}
      extra={
        position.trailingStop && (
          <button
            type="button"
            className="pd-protect-remove"
            disabled={busy}
            onClick={() =>
              void send({ takeProfit: KEEP, stopLoss: KEEP, trailingStop: { action: "remove" } })
            }
          >
            {t("protect.removeTrail")}
          </button>
        )
      }
    >
      <div className="pd-protect-labelrow">
        <span className="pd-protect-label">
          {t("protect.retracement")}
          <span title={t("protect.retracementHint")}>
            <LuCircleHelp size={16} aria-hidden />
          </span>
        </span>
        <select
          className="pd-protect-mode"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as "distance" | "percent");
            setAmount("");
          }}
          aria-label={t("protect.retracement")}
        >
          <option value="distance">{t("protect.byDistance")}</option>
          <option value="percent">{t("protect.byPercent")}</option>
        </select>
      </div>
      <Stepper
        value={amount}
        onChange={setAmount}
        step={mode === "distance" ? tick : "0.1"}
        from={0}
        placeholder=""
        label={t("protect.retracement")}
        suffix={mode === "percent" ? "%" : undefined}
      />

      <label className="pd-protect-check">
        <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
        {t("protect.activation")}
        <span title={t("protect.activationHint")}>
          <LuCircleHelp size={16} aria-hidden />
        </span>
      </label>
      {activate && (
        <Stepper
          value={activation}
          onChange={setActivation}
          step={tick}
          from={mark}
          placeholder={t("protect.activationPrice")}
          label={t("protect.activationPrice")}
        />
      )}

      <p className="pd-protect-explain">
        {t("protect.trailExplain", { distance: distance ? formatNumber(distance) : "--" })}
      </p>
    </Shell>
  );
}

/**
 * A take-profit and stop-loss attached to an open order, set on the position
 * it opens once it fills. What each would make or lose is reckoned from the
 * order's own price and size. Clearing a box removes that one.
 */
export function OrderTpSlDialog({
  order,
  symbol,
  quote,
  tick,
  onSave,
  onClose,
}: {
  order: Order;
  symbol: string;
  quote: string;
  tick: string;
  onSave: (amend: OrderAmend) => Promise<void>;
  onClose: () => void;
}) {
  const [tp, setTp] = useState(order.takeProfit ?? "");
  const [sl, setSl] = useState(order.stopLoss ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const entry = Number(order.price ?? 0);
  const size = Number(order.size);
  const dir = order.side === "buy" ? 1 : -1;

  const estimate = (text: string) => {
    const price = Number(text);
    if (!(price > 0) || !(entry > 0)) return null;
    const pnl = (price - entry) * size * dir;
    return (
      <p className="pd-protect-est">
        {t("protect.estPnl")}{" "}
        <span className={`pd-num ${trendClass(pnl)}`}>
          {formatSigned(pnl, 2)} {quote}
        </span>
      </p>
    );
  };

  const submit = async () => {
    for (const v of [tp, sl]) {
      if (v.trim() !== "" && !(Number(v) > 0)) return setError(t("protect.invalid"));
    }
    if (entry > 0 && Number(tp) > 0 && (Number(tp) - entry) * dir <= 0) {
      return setError(t("protect.tpOrderSide"));
    }
    if (entry > 0 && Number(sl) > 0 && (Number(sl) - entry) * dir >= 0) {
      return setError(t("protect.slOrderSide"));
    }
    const amend: OrderAmend = {
      takeProfit: changeTo(tp, order.takeProfit),
      stopLoss: changeTo(sl, order.stopLoss),
    };
    if (amend.takeProfit?.action === "keep" && amend.stopLoss?.action === "keep") return onClose();
    setBusy(true);
    setError(undefined);
    try {
      await onSave(amend);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("protect.failed"));
      setBusy(false);
    }
  };

  return (
    <Shell
      title={t("protect.orderTitle", { symbol })}
      stats={[
        { label: "orders.orderPrice", value: fmt(order.price) },
        { label: "protect.quantity", value: fmt(order.size) },
        {
          label: "orders.direction",
          value: t(order.side === "buy" ? "side.buy" : "side.sell"),
        },
      ]}
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <p className="pd-protect-explain">{t("protect.orderLead")}</p>
      <section className="pd-protect-section">
        <h4>{t("protect.tp")}</h4>
        <Stepper
          value={tp}
          onChange={setTp}
          step={tick}
          from={entry}
          placeholder={t("protect.trigger")}
          label={t("protect.tp")}
          suffix={t("protect.last")}
        />
        {estimate(tp)}
      </section>
      <section className="pd-protect-section">
        <h4>{t("protect.sl")}</h4>
        <Stepper
          value={sl}
          onChange={setSl}
          step={tick}
          from={entry}
          placeholder={t("protect.trigger")}
          label={t("protect.sl")}
          suffix={t("protect.last")}
        />
        {estimate(sl)}
      </section>
    </Shell>
  );
}
