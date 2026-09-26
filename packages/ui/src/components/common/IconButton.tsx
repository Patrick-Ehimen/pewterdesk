import { type ButtonHTMLAttributes, forwardRef, type ReactNode, useRef, useState } from "react";
import { FloatingTip } from "./Tooltip";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name, also shown as a tooltip on hover or focus. */
  label: string;
  /** For toggles: rendered as `aria-pressed`. */
  pressed?: boolean;
  children: ReactNode;
}

/** A square icon-only button with a tooltip naming what it does. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, pressed, children, className, onPointerEnter, onPointerLeave, onFocus, onBlur, ...rest },
  forwardedRef,
) {
  const ownRef = useRef<HTMLButtonElement>(null);
  const [tip, setTip] = useState(false);
  const setRefs = (el: HTMLButtonElement | null) => {
    ownRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };
  return (
    <>
      <button
        ref={setRefs}
        type="button"
        className={`pd-icon-button ${className ?? ""}`}
        aria-label={label}
        aria-pressed={pressed}
        onPointerEnter={(e) => {
          setTip(true);
          onPointerEnter?.(e);
        }}
        onPointerLeave={(e) => {
          setTip(false);
          onPointerLeave?.(e);
        }}
        onFocus={(e) => {
          setTip(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setTip(false);
          onBlur?.(e);
        }}
        {...rest}
      >
        {children}
      </button>
      {tip && (
        <FloatingTip getAnchor={() => ownRef.current} className="pd-tip-label">
          {label}
        </FloatingTip>
      )}
    </>
  );
});
