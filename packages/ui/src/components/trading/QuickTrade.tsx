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
import { lockTextSelection } from "../../lib/dragSelect";
import { formatNumber } from "../../lib/format";
import { FloatingTip, useTipTrigger } from "../common/Tooltip";

export interface QuickTradePosition {
  /** Left edge, in viewport pixels. */
  x: number;
  /** Top edge, in viewport pixels. */
  y: number;
}

/** Room kept between the bar and the edge of what it's kept inside. */
const EDGE = 8;
/** Pixels moved per arrow-key press on the grip (Shift: ten times that). */
const KEY_STEP = 10;

interface QuickTradeProps {
  /** The market's coin, for the quantity's label, e.g. "HYPE". */
  base?: string;
  /** The coin the order's value is in, e.g. "USDT". */
  quote?: string;
  /** Best bid and ask; unset until the book arrives. */
  bid?: number;
  ask?: number;
  decimals: number;
  qty: string;
  onQty: (qty: string) => void;
  /**
   * Place a market order; resolves once the venue has it, or rejects with
   * why not. Unset while orders can't be placed: the buttons stay visible
   * but disabled, and say why.
   */
  onLong?: () => Promise<void>;
  onShort?: () => Promise<void>;
  /** Why orders can't be placed, where there's a better reason than "not yet". */
  unavailableReason?: string;
  position: QuickTradePosition;
  /**
   * What the bar is kept inside, e.g. the chart: it can't be dragged out of
   * it, and follows it as it moves or resizes. Unset, or while it's not on
   * screen, the bar is kept inside the window.
   */
  within?: () => Element | null;
  /** Called once a drag (or arrow-key move) ends, with where the bar landed. */
  onMove: (position: QuickTradePosition) => void;
  onClose: () => void;
}

/**
 * Keeps the bar fully inside `box` (viewport pixels), or the window where
 * there's no box or the bar wouldn't fit in it.
 */
function clamp(
  p: QuickTradePosition,
  el: HTMLElement | null,
  box?: DOMRect | null,
): QuickTradePosition {
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  const fits = box && box.width >= w + 2 * EDGE && box.height >= h + 2 * EDGE;
  const left = fits ? box.left : 0;
  const top = fits ? box.top : 0;
  const right = fits ? box.right : window.innerWidth;
  const bottom = fits ? box.bottom : window.innerHeight;
  return {
    x: Math.round(Math.min(Math.max(left + EDGE, p.x), Math.max(left + EDGE, right - w - EDGE))),
    y: Math.round(Math.min(Math.max(top + EDGE, p.y), Math.max(top + EDGE, bottom - h - EDGE))),
  };
}

/**
 * A floating one-click bar: market long at the best ask, a quantity, market
 * short at the best bid. Drag it by the grip; it stays inside `within`
 * (the chart), or the window.
 */
export function QuickTrade({
  base,
  quote,
  bid,
  ask,
  decimals,
  qty,
  onQty,
  onLong,
  onShort,
  unavailableReason,
  position,
  within,
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
  const [sending, setSending] = useState(false);
  const send = async (act: () => Promise<void>) => {
    if (sending) return;
    setSending(true);
    try {
      await act();
      // Placed: the bar starts over, so a second click can't repeat it.
      onQty("");
    } catch {
      // Whoever placed it says why not (a toast).
    } finally {
      setSending(false);
    }
  };
  // What the quantity comes to, at the middle of the book.
  const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : (ask ?? bid);
  const value = Number(qty) > 0 && mid !== undefined && mid > 0 ? Number(qty) * mid : undefined;

  // Follow outside changes (e.g. a restored position) unless mid-drag.
  useEffect(() => {
    if (!drag.current) setPos(position);
  }, [position]);

  // `within` is rebuilt every render; the latest is what's asked.
  const withinRef = useRef(within);
  withinRef.current = within;
  const box = () => withinRef.current?.()?.getBoundingClientRect();
  // Pull back inside once measured, and whenever what it's inside moves:
  // the window or the chart resizing, a panel scrolling, the layout changing.
  const reclamp = useCallback(
    () =>
      setPos((p) => {
        const next = clamp(p, barRef.current, withinRef.current?.()?.getBoundingClientRect());
        return next.x === p.x && next.y === p.y ? p : next;
      }),
    [],
  );
  useLayoutEffect(reclamp);
  useEffect(() => {
    window.addEventListener("resize", reclamp);
    window.addEventListener("scroll", reclamp, true);
    const observer = new ResizeObserver(reclamp);
    observer.observe(document.body);
    const inside = withinRef.current?.();
    if (inside) observer.observe(inside);
    return () => {
      window.removeEventListener("resize", reclamp);
      window.removeEventListener("scroll", reclamp, true);
      observer.disconnect();
    };
  }, [reclamp]);

  // Dragging over the page would otherwise select its text.
  const unlock = useRef<() => void>(undefined);
  useEffect(() => () => unlock.current?.(), []);

  const onGripDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    unlock.current = lockTextSelection();
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onGripMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, barRef.current, box()));
  };
  const onGripUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    drag.current = null;
    unlock.current?.();
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
    const next = clamp({ x: pos.x + move[0], y: pos.y + move[1] }, barRef.current, box());
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
      "aria-disabled": act && !sending ? undefined : true,
      "aria-describedby": act ? undefined : reasonId,
      onClick: act && (() => void send(act)),
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

      <div className="pd-quick-size">
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
        {value !== undefined && (
          <span className="pd-quick-value">
            ≈ {formatNumber(value, 2)}
            {quote ? ` ${quote}` : ""}
          </span>
        )}
      </div>

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
          {unavailableReason ?? t("quick.unavailable")}
        </span>
      )}
      {unavailable && tipFor && (
        <FloatingTip getAnchor={() => (tipFor === "long" ? longRef : shortRef).current}>
          {unavailableReason ?? t("quick.unavailable")}
        </FloatingTip>
      )}
    </section>
  );
}
