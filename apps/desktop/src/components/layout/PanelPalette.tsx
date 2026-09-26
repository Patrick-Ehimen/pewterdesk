import { t } from "@pewterdesk/ui";
import { PANEL_KINDS, type PanelKind, panelTitle } from "../../lib/panels";

interface PanelPaletteProps {
  /** Kinds already on the grid. */
  placed: ReadonlySet<PanelKind>;
  onDragStart: (kind: PanelKind) => void;
  onDragEnd: () => void;
  /** Click (or keyboard) fallback for dragging: adds the panel at the bottom. */
  onAdd: (kind: PanelKind) => void;
}

export function PanelPalette({ placed, onDragStart, onDragEnd, onAdd }: PanelPaletteProps) {
  return (
    <aside className="ws-palette" aria-label={t("palette.title")}>
      <h2>{t("palette.title")}</h2>
      <p className="pd-muted">{t("palette.help")}</p>
      <ul>
        {PANEL_KINDS.map((kind) => (
          <li key={kind}>
            <button
              type="button"
              className="ws-palette-item"
              draggable
              onDragStart={(e) => {
                // Firefox won't start a drag without data.
                e.dataTransfer.setData("text/plain", kind);
                onDragStart(kind);
              }}
              onDragEnd={onDragEnd}
              onClick={() => onAdd(kind)}
            >
              <span className="ws-grip" aria-hidden>
                ⠿
              </span>
              {panelTitle(kind)}
              {placed.has(kind) && <span className="ws-palette-tag">{t("palette.inLayout")}</span>}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
