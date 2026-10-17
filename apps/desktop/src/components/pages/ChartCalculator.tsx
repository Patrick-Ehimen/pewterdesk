import type { Market, VenueId } from "@pewterdesk/core";
import { SizeCalculator, t } from "@pewterdesk/ui";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { LuCalculator, LuX } from "react-icons/lu";
import { VENUES } from "../../lib/venues";

// The Multi-chart page's calculator: the order ticket's (PnL, target, liquidation,
// max open), floating over the charts, set to the chart picked. It sends nothing.

const KEY = "pd.multichart.calcAt";
/** How much of the panel stays on screen when it's dragged to an edge. */
const KEEP_PX = 48;

interface At {
  x: number;
  y: number;
}

function loadAt(): At | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<At> | null;
    return typeof raw?.x === "number" && typeof raw?.y === "number"
      ? { x: raw.x, y: raw.y }
      : undefined;
  } catch {
    return undefined;
  }
}

function saveAt(at: At) {
  try {
    localStorage.setItem(KEY, JSON.stringify(at));
  } catch {
    // Kept for this session only.
  }
}

/** `at` moved so some of a `width`-wide panel stays in the window. */
const clamp = (at: At, width: number): At => ({
  x: Math.min(Math.max(at.x, KEEP_PX - width), window.innerWidth - KEEP_PX),
  y: Math.min(Math.max(at.y, 0), window.innerHeight - KEEP_PX),
});

/** A calculator over the charts, for `market` on `venue`; dragged by its title. */
export function ChartCalculator({
  venue,
  market,
  price,
  available,
  onClose,
}: {
  venue: VenueId;
  market: Market;
  /** The market's mark: the entry when none is typed. */
  price: number;
  /** The connected account's free margin on this venue, if it's that venue's. */
  available?: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<At | undefined>(loadAt);
  const drag = useRef<{ dx: number; dy: number }>(undefined);

  // Opens at the right of the window the first time, and stays in it.
  useEffect(() => {
    const width = ref.current?.offsetWidth ?? 320;
    setAt((now) => clamp(now ?? { x: window.innerWidth - width - 24, y: 120 }, width));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const start = (e: PointerEvent<HTMLElement>) => {
    if (!at || (e.target as HTMLElement).closest("button")) return;
    drag.current = { dx: e.clientX - at.x, dy: e.clientY - at.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    setAt(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, ref.current?.offsetWidth ?? 320));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = undefined;
    if (at) saveAt(at);
  };

  // Builder-deployed markets set their own fees; they're left out there, as on the ticket.
  const fees = market.listedBy ? undefined : VENUES[venue].fees;
  const leverage = Math.min(10, market.maxLeverage || 10);

  return (
    <div
      ref={ref}
      className="mc-calc"
      role="dialog"
      aria-label={t("multichart.calcFor", { market: market.symbol })}
      style={at ? { left: at.x, top: at.y } : { visibility: "hidden" }}
    >
      <header
        className="mc-calc-head"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <LuCalculator size={14} aria-hidden />
        <strong className="mc-calc-market">{market.symbol}</strong>
        <span className="pd-muted">{VENUES[venue].label}</span>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("multichart.calcClose")}
          title={t("multichart.calcClose")}
          onClick={onClose}
        >
          <LuX size={15} aria-hidden />
        </button>
      </header>
      <p className="mc-calc-hint pd-muted">{t("multichart.calcHint")}</p>
      <SizeCalculator
        folded={false}
        market={market}
        mid={price}
        takerFee={fees?.taker}
        side="buy"
        leverage={leverage}
        available={available}
      />
    </div>
  );
}
