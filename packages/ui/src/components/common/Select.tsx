import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { LuCheck, LuChevronDown } from "react-icons/lu";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
}

interface SelectProps<V extends string> {
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  /** Accessible name, when no visible label points at the trigger by `id`. */
  label?: string;
  /** For a visible `<label htmlFor>`. */
  id?: string;
  className?: string;
}

/**
 * A single-choice dropdown in the app's own style, in place of a native
 * `<select>`. The list opens under the trigger, inline rather than in a
 * portal, so it works inside popovers that close on an outside click.
 * Arrow keys move, Enter or Space picks, Escape or a click outside closes.
 */
export function Select<V extends string>({
  value,
  options,
  onChange,
  label,
  id,
  className,
}: SelectProps<V>) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    options.findIndex((o) => o.value === value),
    0,
  );
  const [active, setActive] = useState(selectedIndex);

  const show = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (i: number) => {
    const option = options[i];
    if (option) onChange(option.value);
    close();
  };

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onButtonKeyDown = (e: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      show();
    }
  };
  const onListKeyDown = (e: KeyboardEvent) => {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        pick(active);
        break;
      case "Escape":
        // Closes the list only, not a popover it sits in.
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className={`pd-select ${className ?? ""}`}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className="pd-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={onButtonKeyDown}
      >
        <span>{options[selectedIndex]?.label}</span>
        <LuChevronDown size={13} className="pd-select-chevron" aria-hidden />
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          className="pd-select-list"
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKeyDown}
        >
          {options.map((o, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys
            <div
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              // Focus stays on the list, which points at the active option.
              tabIndex={-1}
              aria-selected={o.value === value}
              data-active={i === active || undefined}
              className="pd-select-option"
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="pd-select-check">
                {o.value === value && <LuCheck size={13} aria-hidden />}
              </span>
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
