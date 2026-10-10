import { type MessageKey, t } from "@pewterdesk/ui";
import { useState } from "react";
import { PRESETS, type SavedLayout } from "../../lib/workspace";

/** Built-in layouts are named in English internally; show them translated. */
const presetLabel = (name: string) => t(`preset.${name}` as MessageKey);

interface LayoutBarProps {
  active: string;
  saved: SavedLayout[];
  onApply: (layout: SavedLayout) => void;
  /** A built-in layout is on screen and has been changed: it isn't kept unless saved. */
  changed: boolean;
  /** Keeps the layout on screen as one of the user's own, under `name`. */
  onSaveAs: (name: string) => void;
  /** Starts an empty layout of the user's own, under `name`. */
  onNew: (name: string) => void;
  onDelete: (name: string) => void;
  onDone: () => void;
}

/** The "Editing layout" strip under the header: presets, saved layouts, Save as…, Done. */
export function LayoutBar({
  active,
  saved,
  changed,
  onApply,
  onSaveAs,
  onNew,
  onDelete,
  onDone,
}: LayoutBarProps) {
  // Naming a layout: the one on screen (save as) or a new, empty one.
  const [naming, setNaming] = useState<"saveAs" | "new">();
  const [name, setName] = useState("");
  const typed = name.trim();
  // A built-in name can't be used; nor can one of the user's own for a new layout.
  const taken =
    PRESETS.some((p) => p.name === typed) ||
    (naming === "new" && saved.some((l) => l.name === typed));
  const mine = saved.some((l) => l.name === active);
  const cancel = () => {
    setName("");
    setNaming(undefined);
  };
  /** Keeps what's been named; false if there's a name that can't be used. */
  const commit = (): boolean => {
    if (!naming || !typed) {
      cancel();
      return true;
    }
    if (taken) return false;
    if (naming === "new") onNew(typed);
    else onSaveAs(typed);
    cancel();
    return true;
  };

  return (
    <div className="ws-bar" role="toolbar" aria-label={t("layout.editor")}>
      <span className="ws-bar-title">{t("layout.editing")}</span>
      {[...PRESETS, ...saved].map((l) => {
        const custom = !PRESETS.includes(l);
        return (
          <span key={l.name} className="ws-chip" aria-current={l.name === active || undefined}>
            <button type="button" onClick={() => onApply(l)}>
              {custom ? l.name : presetLabel(l.name)}
            </button>
            {custom && (
              <button
                type="button"
                className="ws-chip-remove"
                aria-label={t("layout.delete", { name: l.name })}
                onClick={() => onDelete(l.name)}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
      <span className="ws-bar-hint">
        {/* Where the layout on screen stands: kept as it changes, or not kept. */}
        {mine
          ? t("layout.kept", { name: active })
          : changed
            ? t("layout.unsaved")
            : t("layout.hint")}
      </span>
      <span className="app-spacer" />
      {naming ? (
        <form
          className="ws-naming"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <input
            className="pd-input"
            placeholder={t(naming === "new" ? "layout.newName" : "layout.name")}
            aria-label={t(naming === "new" ? "layout.newName" : "layout.name")}
            aria-invalid={taken}
            title={taken ? t("layout.nameTaken") : undefined}
            // biome-ignore lint/a11y/noAutofocus: the field appears because the user just asked for it
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && cancel()}
          />
          {/* A button to press, not only Enter. */}
          <button type="submit" className="ws-button ws-button-primary" disabled={!typed || taken}>
            {t("layout.save")}
          </button>
          <button type="button" className="ws-button" onClick={cancel}>
            {t("protect.cancel")}
          </button>
          {taken && <span className="ws-naming-note">{t("layout.nameTaken")}</span>}
        </form>
      ) : (
        <>
          <button type="button" className="ws-button" onClick={() => setNaming("new")}>
            {t("layout.new")}
          </button>
          <button
            type="button"
            className={changed ? "ws-button ws-button-attention" : "ws-button"}
            onClick={() => setNaming("saveAs")}
          >
            {t("layout.saveAs")}
          </button>
        </>
      )}
      <button
        type="button"
        className={naming ? "ws-button" : "ws-button ws-button-primary"}
        // A name typed and not yet entered is kept, not thrown away.
        onClick={() => commit() && onDone()}
      >
        {t("layout.done")}
      </button>
    </div>
  );
}
