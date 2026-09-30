import {
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
import { formatNumber, formatSigned } from "../../lib/format";

export interface CardPosition {
  x: number;
  y: number;
}

const EDGE = 8;
const KEY_STEP = 10;

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
 * anywhere by its body (or moved with the arrow keys once focused). Without
 * a connected wallet it says so rather than showing zeros.
 */
export function PnlCard({
  venue,
  venueLogo,
  quote,
  balance,
  pnl,
  connected,
  onConnect,
  position,
  onMove,
  onClose,
}: {
  venue: string;
  venueLogo?: string;
  /** The asset balances are in, e.g. "USDC". */
  quote: string;
  balance?: number;
  pnl?: number;
  connected: boolean;
  onConnect: () => void;
  position: CardPosition;
  onMove: (position: CardPosition) => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [pos, setPos] = useState(position);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

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
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const onDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d) setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, cardRef.current));
  };
  const onUp = (e: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onMove(pos);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") return onClose();
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
  const logo = venueLogo && <img src={venueLogo} alt="" width={20} height={20} />;

  return (
    <section
      ref={cardRef}
      className="pd-pnl-card"
      aria-label={t("pnl.title", { venue })}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the arrow keys can move it
      tabIndex={0}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onDown}
      onPointerMove={onDrag}
      onPointerUp={onUp}
      onKeyDown={onKey}
    >
      <button type="button" className="pd-pnl-close" aria-label={t("pnl.close")} onClick={onClose}>
        <LuX size={14} aria-hidden />
      </button>
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
          <span className="pd-pnl-label">{t("pnl.pnl")}</span>
        </div>
      </div>
      {connected ? (
        <p className="pd-pnl-venue">{venue}</p>
      ) : (
        <button type="button" className="pd-pnl-connect" onClick={onConnect}>
          {t("pnl.connect")}
        </button>
      )}
    </section>
  );
}
