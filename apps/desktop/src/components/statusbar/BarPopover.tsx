import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Space between the button and its panel, and the panel and the window's edge. */
const GAP = 8;

/**
 * A bottom-bar button whose panel opens above it: closes on Escape or a
 * click outside. The panel is rendered at the page's top level and placed
 * against the window, so the bar's scrolling and edge fade can't clip it,
 * and it follows its button when the bar slides.
 * `children` renders only while open, so whatever it loads only loads then.
 */
export function BarPopover({
  label,
  button,
  className = "",
  align = "left",
  children,
}: {
  /** Accessible name, when the button's content doesn't say it. */
  label?: string;
  button: ReactNode;
  className?: string;
  align?: "left" | "right";
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; bottom: number }>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Above the button, lined up with its left or right edge, kept on screen.
  const placeIt = useCallback(() => {
    const b = buttonRef.current?.getBoundingClientRect();
    const width = popRef.current?.offsetWidth ?? 0;
    if (!b) return;
    const wanted = align === "right" ? b.right - width : b.left;
    setPlace({
      left: Math.max(GAP, Math.min(wanted, window.innerWidth - width - GAP)),
      bottom: window.innerHeight - b.top + GAP,
    });
  }, [align]);
  useLayoutEffect(() => {
    if (open) placeIt();
    else setPlace(undefined);
  }, [open, placeIt]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !popRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // Follow the button when the bar under it slides (or the window resizes);
    // other scrolling in the app (the book, the tape) doesn't move it.
    const onScroll = (e: Event) => {
      const target = e.target as Node;
      if (target instanceof Element && wrapRef.current && target.contains(wrapRef.current)) {
        placeIt();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", placeIt);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", placeIt);
    };
  }, [open, placeIt]);
  return (
    <div ref={wrapRef} className="app-bar-item">
      <button
        ref={buttonRef}
        type="button"
        className={`app-bar-button ${className}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          // A button half under the bar's edge slides fully into view first.
          if (!open) e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
          setOpen((o) => !o);
        }}
      >
        {button}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="app-bar-pop"
            role="dialog"
            aria-label={label}
            data-placed={place !== undefined || undefined}
            style={{ left: place?.left ?? 0, bottom: place?.bottom ?? 0 }}
          >
            {children()}
          </div>,
          document.body,
        )}
    </div>
  );
}
