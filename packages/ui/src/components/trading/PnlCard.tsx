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
import { LuX } from "react-icons/lu";
import { t } from "../../i18n";
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

  const trend = pnl === undefined || pnl === 0 ? undefined : pnl > 0 ? "up" : "down";
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
            {connected && balance !== undefined ? formatNumber(balance, 2) : "-"}
          </strong>
          <span className="pd-pnl-label">
            {t("pnl.balance")} · {quote}
          </span>
        </div>
        <div className="pd-pnl-col">
          <strong className="pd-pnl-value pd-num" data-trend={trend}>
            {logo}
            {connected && pnl !== undefined ? formatSigned(pnl, 2) : "-"}
          </strong>
          <span className="pd-pnl-label">
            {t("pnl.pnl")} · {quote}
          </span>
        </div>
      </div>
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
