import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuChevronRight, LuCornerDownLeft } from "react-icons/lu";
import { t } from "../../i18n";

export interface PaletteItem {
  id: string;
  icon?: ReactNode;
  label: ReactNode;
  /** At the row's right edge: a price, "2h ago", what Enter does. */
  meta?: ReactNode;
  /** Why it can't be run; the row is shown but skipped. */
  disabled?: string;
  /** Run on Enter or a click. Returning `false` keeps the palette open. */
  onRun: () => boolean | undefined;
}

export interface PaletteSection {
  id: string;
  title: string;
  items: PaletteItem[];
}

/** What a typed command was understood as, above the list. */
export interface PalettePreview {
  badge: string;
  tone: "buy" | "sell" | "plain";
  title: string;
  detail?: string;
  /** At its right edge, e.g. "review" or "press Enter again". */
  hint?: string;
  /** Waiting on a second Enter. */
  armed?: boolean;
}

interface CommandPaletteProps {
  open: boolean;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
  placeholder: string;
  preview?: PalettePreview;
  sections: PaletteSection[];
  /** Under the list: examples to try. */
  tips: string;
  /** In place of the list when there's nothing to show. */
  empty: string;
}

/**
 * The command palette: one line to type into, what it was understood as,
 * and the things it could mean, run with the keyboard. It only presents;
 * the app decides what each row does.
 */
export function CommandPalette({
  open,
  query,
  onQuery,
  onClose,
  placeholder,
  preview,
  sections,
  tips,
  empty,
}: CommandPaletteProps) {
  const runnable = useMemo(
    () => sections.flatMap((s) => s.items).filter((i) => !i.disabled),
    [sections],
  );
  const [activeId, setActiveId] = useState<string>();
  const active = runnable.find((i) => i.id === activeId) ?? runnable[0];
  const listRef = useRef<HTMLDivElement>(null);

  // The row the keyboard is on stays in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the row changes
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);

  if (!open) return null;

  const run = (item: PaletteItem) => {
    if (item.onRun() !== false) onClose();
  };
  const move = (by: number) => {
    if (runnable.length === 0) return;
    const at = Math.max(0, active ? runnable.indexOf(active) : 0);
    setActiveId(runnable[(at + by + runnable.length) % runnable.length]?.id);
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: a click outside closes it, as Escape does
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it (see the input)
    <div className="pd-cmd-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pd-cmd" role="dialog" aria-modal="true" aria-label={t("cmd.open")}>
        <div className="pd-cmd-input">
          <LuChevronRight size={18} aria-hidden />
          <input
            // biome-ignore lint/a11y/noAutofocus: it opens to be typed into
            autoFocus
            type="text"
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setActiveId(undefined);
              onQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") move(1);
              else if (e.key === "ArrowUp") move(-1);
              else if (e.key === "Enter" && active) run(active);
              else if (e.key === "Escape") onClose();
              else return;
              e.preventDefault();
            }}
          />
          <kbd>esc</kbd>
        </div>

        {preview && (
          <div className="pd-cmd-preview" data-tone={preview.tone} data-armed={preview.armed}>
            <span className="pd-cmd-badge">{preview.badge}</span>
            <span className="pd-cmd-preview-main">
              <strong>{preview.title}</strong>
              {preview.detail && <span className="pd-cmd-preview-detail">{preview.detail}</span>}
            </span>
            {preview.hint && (
              <span className="pd-cmd-preview-hint">
                <LuCornerDownLeft size={13} aria-hidden /> {preview.hint}
              </span>
            )}
          </div>
        )}

        <div className="pd-cmd-list" ref={listRef}>
          {sections.every((s) => s.items.length === 0) ? (
            <p className="pd-cmd-empty">{empty}</p>
          ) : (
            sections
              .filter((s) => s.items.length > 0)
              .map((section) => (
                <section key={section.id}>
                  <h3>{section.title}</h3>
                  {section.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="pd-cmd-row"
                      data-active={item.id === active?.id || undefined}
                      disabled={Boolean(item.disabled)}
                      title={item.disabled}
                      onMouseMove={() => !item.disabled && setActiveId(item.id)}
                      onClick={() => run(item)}
                    >
                      <span className="pd-cmd-icon" aria-hidden>
                        {item.icon}
                      </span>
                      <span className="pd-cmd-label">{item.label}</span>
                      <span className="pd-cmd-meta">{item.disabled ?? item.meta}</span>
                    </button>
                  ))}
                </section>
              ))
          )}
        </div>

        <footer className="pd-cmd-foot">
          <span>{tips}</span>
          <span>
            ↑↓ {t("cmd.move")} · <LuCornerDownLeft size={12} aria-hidden /> {t("cmd.run")}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
