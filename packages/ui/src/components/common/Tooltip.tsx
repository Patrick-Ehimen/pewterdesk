import {
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 120;
/** Gap between anchor and tooltip, and minimum distance from the viewport edge. */
const GAP = 8;

type Placement = "top" | "bottom" | "left" | "right";

interface Position {
  top: number;
  left: number;
  /** Where the arrow sits along the tooltip's edge, so it still points at the anchor after clamping. */
  arrow: number;
  placement: Placement;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(max, min));

/**
 * `vertical` prefers below the anchor and flips above; `horizontal` prefers
 * the left and flips right. Either way it's clamped into the viewport.
 */
function place(anchor: DOMRect, tip: DOMRect, axis: "vertical" | "horizontal"): Position {
  if (axis === "vertical") {
    const center = anchor.left + anchor.width / 2;
    const left = clamp(center - tip.width / 2, GAP, window.innerWidth - tip.width - GAP);
    const below = anchor.bottom + GAP;
    const fitsBelow = below + tip.height <= window.innerHeight - GAP;
    return {
      top: fitsBelow ? below : anchor.top - GAP - tip.height,
      left,
      arrow: center - left,
      placement: fitsBelow ? "bottom" : "top",
    };
  }
  const middle = anchor.top + anchor.height / 2;
  const top = clamp(middle - tip.height / 2, GAP, window.innerHeight - tip.height - GAP);
  const leftOf = anchor.left - GAP - tip.width;
  const fitsLeft = leftOf >= GAP;
  return {
    top,
    left: fitsLeft ? leftOf : anchor.right + GAP,
    arrow: middle - top,
    placement: fitsLeft ? "left" : "right",
  };
}

const samePosition = (a: Position | undefined, b: Position) =>
  a !== undefined &&
  a.placement === b.placement &&
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.left - b.left) < 0.5 &&
  Math.abs(a.arrow - b.arrow) < 0.5;

interface FloatingTipProps {
  /** Looked up after every render, so the tip follows an anchor that moves. */
  getAnchor: () => Element | null | undefined;
  axis?: "vertical" | "horizontal";
  id?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A positioned tooltip card, rendered into `document.body` with fixed
 * positioning so panels with `overflow: hidden` can't clip it. Mount it to
 * show it; it fades in once it has been measured and placed.
 */
export function FloatingTip({
  getAnchor,
  axis = "vertical",
  id,
  className,
  children,
}: FloatingTipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>();

  // No deps: re-measure after every render (live data can move the anchor
  // or resize the card). Only a real change sets state, so this settles.
  useLayoutEffect(() => {
    const anchor = getAnchor()?.getBoundingClientRect();
    const tip = ref.current?.getBoundingClientRect();
    if (!anchor || !tip) return;
    const next = place(anchor, tip, axis);
    setPosition((prev) => (samePosition(prev, next) ? prev : next));
  });

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`pd-tip ${className ?? ""}`}
      data-placement={position?.placement}
      data-visible={position !== undefined || undefined}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        ["--pd-tip-arrow" as string]: `${position?.arrow ?? 0}px`,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

interface TooltipProps {
  /** What the tooltip says. */
  content: ReactNode;
  /** The trigger's content; wrapped in a button so keyboard focus shows the tooltip too. */
  children: ReactNode;
  className?: string;
}

/** Hover or focus to show; Escape or leaving hides. */
export function Tooltip({ content, children, className }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`pd-tip-trigger ${className ?? ""}`}
        aria-describedby={open ? id : undefined}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => e.key === "Escape" && hide()}
      >
        {children}
      </button>
      {open && (
        <FloatingTip id={id} getAnchor={() => triggerRef.current}>
          {content}
        </FloatingTip>
      )}
    </>
  );
}

/**
 * Tracks which `[data-key]` row inside a list the pointer is over, for a
 * single shared row tooltip instead of one per row. Spread `handlers` on the
 * list's container; `anchor` finds the hovered row's element again.
 */
export function useHoveredRow<T extends HTMLElement>() {
  const containerRef = useRef<T>(null);
  const [key, setKey] = useState<string>();
  const handlers = {
    onPointerOver: (e: PointerEvent) => {
      const row = (e.target as Element).closest("[data-key]");
      setKey(row?.getAttribute("data-key") ?? undefined);
    },
    onPointerLeave: () => setKey(undefined),
    // The anchored row would slide away from its tip.
    onScroll: () => setKey(undefined),
  };
  const anchor = () =>
    key === undefined
      ? null
      : containerRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`);
  return { containerRef, key, handlers, anchor };
}

/** Tooltip body for a row: a title and label/value pairs. */
export function TipRows({
  title,
  side,
  rows,
}: {
  title: ReactNode;
  /** Colors the title's dot; omit for none. */
  side?: "bid" | "ask";
  rows: [label: string, value: ReactNode][];
}) {
  return (
    <>
      <strong className="pd-tip-title">
        {side && <span className="pd-tip-dot" data-side={side} aria-hidden />}
        {title}
      </strong>
      <dl className="pd-tip-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
