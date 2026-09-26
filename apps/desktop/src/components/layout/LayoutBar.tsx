import { type MessageKey, t } from "@pewterdesk/ui";
import { useState } from "react";
import { PRESETS, type SavedLayout } from "../../lib/workspace";

/** Built-in layouts are named in English internally; show them translated. */
const presetLabel = (name: string) => t(`preset.${name}` as MessageKey);

interface LayoutBarProps {
  active: string;
  saved: SavedLayout[];
  onApply: (layout: SavedLayout) => void;
  onSaveAs: (name: string) => void;
  onDelete: (name: string) => void;
  onDone: () => void;
}

/** The "Editing layout" strip under the header: presets, saved layouts, Save as…, Done. */
export function LayoutBar({ active, saved, onApply, onSaveAs, onDelete, onDone }: LayoutBarProps) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const taken = PRESETS.some((p) => p.name === name.trim());

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
      <span className="ws-bar-hint">{t("layout.hint")}</span>
      <span className="app-spacer" />
      {naming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || taken) return;
            onSaveAs(name);
            setName("");
            setNaming(false);
          }}
        >
          <input
            className="pd-input"
            placeholder={t("layout.name")}
            aria-label={t("layout.name")}
            aria-invalid={taken}
            title={taken ? t("layout.nameTaken") : undefined}
            // biome-ignore lint/a11y/noAutofocus: the field appears because the user just asked for it
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
          />
        </form>
      ) : (
        <button type="button" className="ws-button" onClick={() => setNaming(true)}>
          {t("layout.saveAs")}
        </button>
      )}
      <button type="button" className="ws-button ws-button-primary" onClick={onDone}>
        {t("layout.done")}
      </button>
    </div>
  );
}
