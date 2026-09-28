import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LuGripVertical, LuX } from "react-icons/lu";
import { t } from "../../i18n";
import { formatNumber } from "../../lib/format";
import { FloatingTip, useTipTrigger } from "../common/Tooltip";

export interface QuickTradePosition {
  /** Left edge, in viewport pixels. */
  x: number;
  /** Top edge, in viewport pixels. */
  y: number;
}

/** Room kept between the bar and the window's edge. */
const EDGE = 8;
/** Pixels moved per arrow-key press on the grip (Shift: ten times that). */
const KEY_STEP = 10;

interface QuickTradeProps {
  /** The market's coin, for the quantity's label, e.g. "HYPE". */
  base?: string;
  /** Best bid and ask; unset until the book arrives. */
  bid?: number;
  ask?: number;
  decimals: number;
  qty: string;
  onQty: (qty: string) => void;
  /**
   * Place a market order. Unset while orders can't be placed: the buttons
   * stay visible but disabled, and say why.
   */
  onLong?: () => void;
  onShort?: () => void;
  position: QuickTradePosition;
  /** Called once a drag (or arrow-key move) ends, with where the bar landed. */
  onMove: (position: QuickTradePosition) => void;
  onClose: () => void;
}

/** Keeps the bar fully inside the window. */
function clamp(p: QuickTradePosition, el: HTMLElement | null): QuickTradePosition {
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  return {
    x: Math.round(Math.min(Math.max(EDGE, p.x), Math.max(EDGE, window.innerWidth - w - EDGE))),
    y: Math.round(Math.min(Math.max(EDGE, p.y), Math.max(EDGE, window.innerHeight - h - EDGE))),
  };
}

/**
 * A floating one-click bar: market long at the best ask, a quantity, market
 * short at the best bid. Drag it by the grip; it stays inside the window.
 */
export function QuickTrade({
  base,
  bid,
  ask,
  decimals,
  qty,
  onQty,
  onLong,
  onShort,
  position,
  onMove,
  onClose,
}: QuickTradeProps) {
  const barRef = useRef<HTMLElement>(null);
  const longRef = useRef<HTMLButtonElement>(null);
  const shortRef = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const [pos, setPos] = useState(position);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const longTip = useTipTrigger();
  const shortTip = useTipTrigger();
  const tipFor = longTip.open ? "long" : shortTip.open ? "short" : undefined;

  // Follow outside changes (e.g. a restored position) unless mid-drag.
  useEffect(() => {
    if (!drag.current) setPos(position);
  }, [position]);

  // Pull back inside after the window shrinks, and once measured.
  const reclamp = useCallback(() => setPos((p) => clamp(p, barRef.current)), []);
  useLayoutEffect(reclamp, [reclamp]);
  useEffect(() => {
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [reclamp]);

  const onGripDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onGripMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, barRef.current));
  };
  const onGripUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onMove(pos);
  };
  const onGripKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? KEY_STEP * 10 : KEY_STEP;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[e.key];
    if (!move) return;
    e.preventDefault();
    const next = clamp({ x: pos.x + move[0], y: pos.y + move[1] }, barRef.current);
    setPos(next);
    onMove(next);
  };

  const price = (v: number | undefined) => (v === undefined ? "-" : formatNumber(v, decimals));
  const side = (which: "long" | "short") => {
    const act = which === "long" ? onLong : onShort;
    return {
      ref: which === "long" ? longRef : shortRef,
      type: "button" as const,
      className: "pd-quick-side",
      "data-side": which === "long" ? "buy" : "sell",
      // aria-disabled, not disabled, so it can still be hovered and focused
      // to read why.
      "aria-disabled": act ? undefined : true,
      "aria-describedby": act ? undefined : reasonId,
      onClick: act,
      ...(which === "long" ? longTip : shortTip).handlers,
    };
  };
  const unavailable = !onLong || !onShort;

  return (
    <section
      ref={barRef}
      className="pd-quick"
      aria-label={t("quick.title")}
      style={{ left: pos.x, top: pos.y }}
    >
      <button
        type="button"
        className="pd-quick-grip"
        aria-label={t("quick.drag")}
        title={t("quick.drag")}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onKeyDown={onGripKey}
      >
        <LuGripVertical size={14} aria-hidden />
      </button>

      <button {...side("long")}>
        <span className="pd-quick-label">{t("quick.long")}</span>
        <span className="pd-quick-price">{price(ask)}</span>
      </button>

      <input
        className="pd-quick-qty"
        inputMode="decimal"
        placeholder={t("quick.qty")}
        aria-label={t("quick.qtyLabel", { base: base ?? "" })}
        value={qty}
        onChange={(e) => {
          // Digits and one decimal point only.
          const next = e.target.value.replace(",", ".");
          if (/^\d*\.?\d*$/.test(next)) onQty(next);
        }}
      />

      <button {...side("short")}>
        <span className="pd-quick-label">{t("quick.short")}</span>
        <span className="pd-quick-price">{price(bid)}</span>
      </button>

      <button
        type="button"
        className="pd-quick-close"
        aria-label={t("quick.close")}
        title={t("quick.close")}
        onClick={onClose}
      >
        <LuX size={14} aria-hidden />
      </button>

      {unavailable && (
        <span id={reasonId} className="pd-visually-hidden">
          {t("quick.unavailable")}
        </span>
      )}
      {unavailable && tipFor && (
        <FloatingTip getAnchor={() => (tipFor === "long" ? longRef : shortRef).current}>
          {t("quick.unavailable")}
        </FloatingTip>
      )}
    </section>
  );
}
