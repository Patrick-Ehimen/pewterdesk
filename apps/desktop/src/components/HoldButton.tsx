import { t } from "@pewterdesk/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { HOLD_MS } from "../lib/float";

/**
 * A button that acts only after being held for `HOLD_MS`, filling as it
 * goes; letting go early cancels. So a stray click on a window that floats
 * over everything can't place an order.
 */
export function HoldButton({
  className,
  disabled,
  label,
  onDone,
  children,
}: {
  className: string;
  disabled?: boolean;
  /** For screen readers, and the tooltip. */
  label: string;
  onDone: () => void;
  children: ReactNode;
}) {
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;
  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    setProgress(0);
  }, []);
  useEffect(() => stop, [stop]);
  const start = () => {
    if (disabled) return;
    const began = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - began) / HOLD_MS);
      setProgress(p);
      if (p < 1) {
        frame.current = requestAnimationFrame(tick);
      } else {
        setProgress(0);
        done.current();
      }
    };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(tick);
  };
  return (
    <button
      type="button"
      className={`float-hold ${className}`}
      aria-disabled={disabled || undefined}
      aria-label={label}
      title={disabled ? undefined : t("float.holdHint")}
      data-holding={progress > 0 || undefined}
      style={{ ["--hold" as string]: progress }}
      onPointerDown={(e) => e.button === 0 && start()}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !e.repeat && start()}
      onKeyUp={stop}
      onBlur={stop}
    >
      {children}
    </button>
  );
}
