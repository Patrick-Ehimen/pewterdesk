import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LuChartLine, LuRotateCcw, LuX } from "react-icons/lu";
import { dateFormat, t } from "../../i18n";
import { lockTextSelection } from "../../lib/dragSelect";
import { formatNumber, formatSigned } from "../../lib/format";

export interface CardPosition {
  x: number;
  y: number;
}

const EDGE = 8;
const KEY_STEP = 10;
/** How small and how large the card can be made, as a multiple of its default. */
export const PNL_SCALE_MIN = 0.6;
export const PNL_SCALE_MAX = 2;
const SCALE_STEP = 0.1;

/** How long a first click on reset waits for the second. */
const RESET_ARM_MS = 3000;
/** The line's drawing size; it stretches to the card's width. */
const LINE_W = 300;
const LINE_H = 64;

/** The PnL line: an area from the samples, scaled to fit, with zero marked when it's crossed. */
function PnlLine({ points, trend }: { points: readonly [number, number][]; trend?: string }) {
  if (points.length < 2) return <p className="pd-pnl-line-empty">{t("pnl.lineEmpty")}</p>;
  const t0 = points[0]?.[0] ?? 0;
  const span = (points.at(-1)?.[0] ?? t0) - t0 || 1;
  const values = points.map((p) => p[1]);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const x = (time: number) => ((time - t0) / span) * LINE_W;
  const y = (v: number) => LINE_H - 3 - ((v - min) / range) * (LINE_H - 6);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`);
  return (
    <svg
      className="pd-pnl-line"
      data-trend={trend}
      viewBox={`0 0 ${LINE_W} ${LINE_H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path
        className="pd-pnl-line-area"
        d={`${line.join(" ")} L${LINE_W},${LINE_H} L0,${LINE_H} Z`}
      />
      {min < 0 && max > 0 && (
        <line className="pd-pnl-line-zero" x1={0} x2={LINE_W} y1={y(0)} y2={y(0)} />
      )}
      <path className="pd-pnl-line-edge" d={line.join(" ")} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const clampScale = (s: number) =>
  Math.round(Math.min(PNL_SCALE_MAX, Math.max(PNL_SCALE_MIN, s)) * 100) / 100;

function clamp(p: CardPosition, el: HTMLElement | null): CardPosition {
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  return {
    x: Math.min(Math.max(EDGE, p.x), Math.max(EDGE, window.innerWidth - w - EDGE)),
    y: Math.min(Math.max(EDGE, p.y), Math.max(EDGE, window.innerHeight - h - EDGE)),
  };
}

/**
 * The floating PnL card, after the design: the connected account's balance
 * and unrealized PnL on the current venue, over everything, dragged
 * anywhere by its body (or moved with the arrow keys once focused), and
 * sized by the grip in its corner (or + and - once focused): text and
 * spacing scale together. Without
 * a connected wallet it says so rather than showing zeros.
 */
export function PnlCard({
  venue,
  venueLogo,
  quote,
  balance,
  pnl,
  connected,
  connectText,
  onConnect,
  position,
  onMove,
  scale = 1,
  onResize,
  onClose,
  unit = "quote",
  onUnit,
  btcPrice,
  history,
  showChart = false,
  onToggleChart,
  onReset,
  since,
  breakdown,
}: {
  venue: string;
  venueLogo?: string;
  /** The asset balances are in, e.g. "USDC". */
  quote: string;
  balance?: number;
  pnl?: number;
  connected: boolean;
  /** The connect button's text, for a venue that connects some other way than a wallet. */
  connectText?: string;
  onConnect: () => void;
  position: CardPosition;
  onMove: (position: CardPosition) => void;
  /** Its size, as a multiple of the default (1). */
  scale?: number;
  onResize?: (scale: number) => void;
  onClose: () => void;
  /** Figures in the quote asset or in BTC (at `btcPrice`). */
  unit?: "quote" | "btc";
  onUnit?: (unit: "quote" | "btc") => void;
  /** BTC's price in the quote asset; without it, figures stay in the quote. */
  btcPrice?: number;
  /** The PnL over time, oldest first, in the quote asset. */
  history?: readonly [number, number][];
  showChart?: boolean;
  onToggleChart?: () => void;
  /** Starts the PnL over from zero; asked for with two clicks. */
  onReset?: () => void;
  /** When it was last reset: the PnL is since then. Unset: all time. */
  since?: number;
  /**
   * What the figure is made of: realised over the account's life (fees and
   * funding included) and open positions' PnL, in the quote asset.
   */
  breakdown?: { realized?: number; open: number };
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [pos, setPos] = useState(position);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [size, setSize] = useState(clampScale(scale));
  const resizing = useRef<{ x: number; width: number; scale: number } | null>(null);

  useEffect(() => {
    if (!resizing.current) setSize(clampScale(scale));
  }, [scale]);
  // A bigger card may now run off the screen: pull it back in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-clamped whenever the size changes
  useLayoutEffect(() => setPos((p) => clamp(p, cardRef.current)), [size]);

  // Dragging over the page would otherwise select its text.
  const unlock = useRef<() => void>(undefined);
  useEffect(() => () => unlock.current?.(), []);

  // The grip: the card grows with the pointer's travel, in proportion to its width.
  const onGripDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    unlock.current = lockTextSelection();
    resizing.current = { x: e.clientX, width: cardRef.current?.offsetWidth ?? 1, scale: size };
  };
  const onGripMove = (e: PointerEvent<HTMLElement>) => {
    const r = resizing.current;
    if (r) setSize(clampScale(r.scale * ((r.width + e.clientX - r.x) / r.width)));
  };
  const onGripUp = (e: PointerEvent<HTMLElement>) => {
    if (!resizing.current) return;
    resizing.current = null;
    unlock.current?.();
    e.currentTarget.releasePointerCapture(e.pointerId);
    onResize?.(size);
  };

  useEffect(() => {
    if (!drag.current) setPos(position);
  }, [position]);

  const reclamp = useCallback(() => setPos((p) => clamp(p, cardRef.current)), []);
  useLayoutEffect(reclamp, [reclamp]);
  useEffect(() => {
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [reclamp]);

  const onDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    unlock.current = lockTextSelection();
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d) setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, cardRef.current));
  };
  const onUp = (e: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    unlock.current?.();
    e.currentTarget.releasePointerCapture(e.pointerId);
    onMove(pos);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") return onClose();
    if ((e.key === "+" || e.key === "=" || e.key === "-") && e.target === e.currentTarget) {
      e.preventDefault();
      const next = clampScale(size + (e.key === "-" ? -SCALE_STEP : SCALE_STEP));
      setSize(next);
      onResize?.(next);
      return;
    }
    const step = e.shiftKey ? KEY_STEP * 10 : KEY_STEP;
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = move[e.key];
    if (!d || e.target !== e.currentTarget) return;
    e.preventDefault();
    const next = clamp({ x: pos.x + d[0], y: pos.y + d[1] }, cardRef.current);
    setPos(next);
    onMove(next);
  };

  // Reset takes two clicks: the first arms it for a few seconds.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), RESET_ARM_MS);
    return () => clearTimeout(id);
  }, [armed]);

  const inBtc = unit === "btc" && btcPrice !== undefined && btcPrice > 0;
  const shownIn = inBtc ? "BTC" : quote;
  const convert = (v: number) => (inBtc ? v / (btcPrice ?? 1) : v);
  const decimals = inBtc ? 6 : 2;
  const line = history?.map(([time, v]) => [time, convert(v)] as [number, number]);
  const trend = pnl === undefined || pnl === 0 ? undefined : pnl > 0 ? "up" : "down";
  const resetLabel = t(armed ? "pnl.resetConfirm" : "pnl.reset");
  const logo = venueLogo && <img src={venueLogo} alt="" width={28} height={28} />;

  return (
    <section
      ref={cardRef}
      className="pd-pnl-card"
      aria-label={t("pnl.title", { venue })}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the arrow keys can move it
      tabIndex={0}
      style={{ left: pos.x, top: pos.y, "--pnl-scale": size } as CSSProperties}
      onPointerDown={onDown}
      onPointerMove={onDrag}
      onPointerUp={onUp}
      onKeyDown={onKey}
    >
      <button type="button" className="pd-pnl-close" aria-label={t("pnl.close")} onClick={onClose}>
        <LuX size={14} aria-hidden />
      </button>
      {connected && (
        <div className="pd-pnl-tools">
          {onUnit && (
            <button
              type="button"
              className="pd-pnl-tool pd-pnl-unit"
              disabled={btcPrice === undefined}
              aria-label={t("pnl.unit", { unit: inBtc ? quote : "BTC" })}
              title={t("pnl.unit", { unit: inBtc ? quote : "BTC" })}
              onClick={() => onUnit(inBtc ? "quote" : "btc")}
            >
              {shownIn}
            </button>
          )}
          {onToggleChart && (
            <button
              type="button"
              className="pd-pnl-tool"
              aria-label={t("pnl.chart")}
              title={t("pnl.chart")}
              aria-pressed={showChart}
              onClick={onToggleChart}
            >
              <LuChartLine size={14} aria-hidden />
            </button>
          )}
          {onReset && (
            <button
              type="button"
              className="pd-pnl-tool"
              data-armed={armed || undefined}
              aria-label={resetLabel}
              title={resetLabel}
              onClick={() => {
                if (!armed) return setArmed(true);
                setArmed(false);
                onReset();
              }}
            >
              <LuRotateCcw size={14} aria-hidden />
            </button>
          )}
          {armed && <span className="pd-pnl-armed">{t("pnl.resetConfirm")}</span>}
        </div>
      )}
      <span
        className="pd-pnl-grip"
        title={t("pnl.resize")}
        aria-hidden
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
      />
      <div className="pd-pnl-cols">
        <div className="pd-pnl-col">
          <strong className="pd-pnl-value pd-num">
            {logo}
            {connected && balance !== undefined ? formatNumber(convert(balance), decimals) : "-"}
          </strong>
          <span className="pd-pnl-label">
            {t("pnl.balance")} · {shownIn}
          </span>
        </div>
        <div className="pd-pnl-col">
          <strong className="pd-pnl-value pd-num" data-trend={trend}>
            {logo}
            {connected && pnl !== undefined ? formatSigned(convert(pnl), decimals) : "-"}
          </strong>
          <span className="pd-pnl-label">
            {since
              ? t("pnl.since", { date: dateFormat({ dateStyle: "medium" }).format(since) })
              : t("pnl.allTime")}{" "}
            · {shownIn}
          </span>
        </div>
      </div>
      {connected && breakdown && (
        <p className="pd-pnl-breakdown pd-num">
          {!since && breakdown.realized !== undefined && (
            <>
              {t("pnl.closed")} {formatSigned(convert(breakdown.realized), decimals)}
              {" · "}
            </>
          )}
          {t("pnl.open")} {formatSigned(convert(breakdown.open), decimals)}
        </p>
      )}
      {connected && showChart && line && <PnlLine points={line} trend={trend} />}
      {connected ? (
        <p className="pd-pnl-venue">{venue}</p>
      ) : (
        <button type="button" className="pd-pnl-connect" onClick={onConnect}>
          {connectText ?? t("pnl.connect")}
        </button>
      )}
    </section>
  );
}
