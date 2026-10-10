import { t } from "@pewterdesk/ui";
import { PANEL_KINDS, type PanelKind, panelTitle } from "../../lib/panels";

interface PanelPaletteProps {
  /** Kinds already on the grid: each can be there once, so these can't be added. */
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
        {PANEL_KINDS.map((kind) => {
          // A panel goes in once: one that's placed can't be dragged or clicked in again.
          const there = placed.has(kind);
          return (
            <li key={kind}>
              <button
                type="button"
                className="ws-palette-item"
                aria-disabled={there || undefined}
                title={there ? t("palette.already") : undefined}
                draggable={!there}
                onDragStart={(e) => {
                  if (there) return e.preventDefault();
                  // Firefox won't start a drag without data.
                  e.dataTransfer.setData("text/plain", kind);
                  onDragStart(kind);
                }}
                onDragEnd={onDragEnd}
                onClick={() => !there && onAdd(kind)}
              >
                <span className="ws-grip" aria-hidden>
                  ⠿
                </span>
                {panelTitle(kind)}
                {there && <span className="ws-palette-tag">{t("palette.inLayout")}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
