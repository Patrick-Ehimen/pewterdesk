import { type ButtonHTMLAttributes, forwardRef, type ReactNode, useRef } from "react";
import { FloatingTip, useTipTrigger } from "./Tooltip";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name, also shown as a tooltip on hover or keyboard focus. */
  label: string;
  /** For toggles: rendered as `aria-pressed`. */
  pressed?: boolean;
  children: ReactNode;
}

/** A square icon-only button with a tooltip naming what it does. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    pressed,
    children,
    className,
    onPointerEnter,
    onPointerLeave,
    onPointerDown,
    onFocus,
    onBlur,
    onKeyDown,
    ...rest
  },
  forwardedRef,
) {
  const ownRef = useRef<HTMLButtonElement>(null);
  const tip = useTipTrigger();
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
          tip.handlers.onPointerEnter();
          onPointerEnter?.(e);
        }}
        onPointerLeave={(e) => {
          tip.handlers.onPointerLeave();
          onPointerLeave?.(e);
        }}
        onPointerDown={(e) => {
          tip.handlers.onPointerDown();
          onPointerDown?.(e);
        }}
        onFocus={(e) => {
          tip.handlers.onFocus(e);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          tip.handlers.onBlur();
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          tip.handlers.onKeyDown(e);
          onKeyDown?.(e);
        }}
        {...rest}
      >
        {children}
      </button>
      {tip.open && (
        <FloatingTip getAnchor={() => ownRef.current} className="pd-tip-label">
          {label}
        </FloatingTip>
      )}
    </>
  );
});
