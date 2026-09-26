import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { LuChevronDown } from "react-icons/lu";
import { IconButton } from "./IconButton";

export interface MenuOption<V extends string> {
  value: V;
  label: string;
  /** One short line under the label. */
  description?: string;
  /** Shown before the label, e.g. a flag; replaces the check mark in grid menus. */
  icon?: ReactNode;
}

interface OptionsMenuProps<V extends string> {
  /** Accessible name for the trigger, e.g. "Order book options". */
  label: string;
  /** Heading above the choices, e.g. "View". */
  heading: string;
  options: readonly MenuOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Trigger icon; defaults to a vertical "⋮". */
  icon?: ReactNode;
  /** Extra class for the trigger button. */
  className?: string;
  /** Lay the choices out in this many columns instead of a list. */
  columns?: number;
  /** Extra class for the menu itself, e.g. to size a grid's cells. */
  menuClassName?: string;
  /**
   * A text trigger with a chevron ("Trade ▾") instead of an icon button.
   * `label` stays the accessible name.
   */
  triggerText?: ReactNode;
}

/** Gap between the trigger and the menu, and minimum distance from the viewport edge. */
const GAP = 6;

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="3.5" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path
        d="M3 7.5 5.8 10 11 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * An icon button ("⋮" unless told otherwise) that opens a single-choice menu
 * under it, right-aligned.
 * Arrow keys move between choices, Enter or Space picks, Escape or a click
 * outside closes; focus goes back to the button either way.
 */
export function OptionsMenu<V extends string>({
  label,
  heading,
  options,
  value,
  onChange,
  icon,
  className = "pd-kebab",
  columns,
  menuClassName,
  triggerText,
}: OptionsMenuProps<V>) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPosition(undefined);
    if (refocus) buttonRef.current?.focus();
  }, []);

  const alignLeft = triggerText !== undefined;

  // Place under the button, then focus the current choice.
  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!button || !menu) return;
    // Text triggers sit at the left of the header, so their menu aligns left;
    // icon triggers sit at the right and align right.
    const preferred = alignLeft ? button.left : button.right - menu.width;
    const left = Math.max(GAP, Math.min(preferred, window.innerWidth - menu.width - GAP));
    const below = button.bottom + GAP;
    const top =
      below + menu.height > window.innerHeight - GAP ? button.top - GAP - menu.height : below;
    setPosition({ top, left });
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open, alignLeft]);

  // Any click outside, a resize or a scroll closes it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    const onMove = () => close(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close]);

  const onMenuKeyDown = (e: KeyboardEvent) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    // In a grid, up/down move by a row and left/right by one; in a list,
    // only up/down move.
    const row = columns ?? 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(at + row);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(at - row);
        break;
      case "ArrowRight":
        if (!columns) break;
        e.preventDefault();
        focusAt(at + 1);
        break;
      case "ArrowLeft":
        if (!columns) break;
        e.preventDefault();
        focusAt(at - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(items.length - 1);
        break;
      case "Escape":
      case "Tab":
        e.preventDefault();
        close();
        break;
    }
  };

  return (
    <>
      {triggerText !== undefined ? (
        <button
          ref={buttonRef}
          type="button"
          className={`pd-menu-trigger ${className}`}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {triggerText}
          <LuChevronDown size={11} aria-hidden />
        </button>
      ) : (
        <IconButton
          ref={buttonRef}
          label={label}
          className={className}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {icon ?? <KebabIcon />}
        </IconButton>
      )}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className={`pd-menu ${menuClassName ?? ""}`}
            data-grid={columns ? true : undefined}
            data-visible={position !== undefined || undefined}
            style={{ top: position?.top ?? 0, left: position?.left ?? 0 }}
            onKeyDown={onMenuKeyDown}
          >
            <div className="pd-menu-heading" aria-hidden>
              {heading}
            </div>
            <div
              className="pd-menu-items"
              style={
                columns
                  ? { gridTemplateColumns: `repeat(${columns}, var(--pd-menu-cell))` }
                  : undefined
              }
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === value}
                  className="pd-menu-item"
                  // Grid cells truncate long text; the full label is on hover.
                  title={
                    columns
                      ? [option.label, option.description].filter(Boolean).join(" · ")
                      : undefined
                  }
                  tabIndex={-1}
                  onClick={() => {
                    onChange(option.value);
                    close();
                  }}
                >
                  {option.icon ?? (
                    <span className="pd-menu-check">{option.value === value && <CheckIcon />}</span>
                  )}
                  <span className="pd-menu-text">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
