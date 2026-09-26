import { t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import GridLayout, { type LayoutItem, type Layout as RglLayout } from "react-grid-layout";
import { PANELS, type PanelKind, panelKindOf, panelTitle } from "../../lib/panels";
import { GRID, isStatsBar, type Layout } from "../../lib/workspace";

const DROPPING_ID = "__dropping__";

/** Width and height of an element, tracked with a ResizeObserver. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

interface WorkspaceGridProps {
  layout: Layout;
  editing: boolean;
  onChange: (layout: Layout) => void;
  /** The palette panel being dragged over the grid, if any. */
  dragging?: PanelKind;
  onDrop: (kind: PanelKind, at: { x: number; y: number }) => void;
  onRemove: (id: string) => void;
  renderPanel: (kind: PanelKind, id: string) => ReactNode;
  /** Right side of a panel's title bar, e.g. the market it shows. */
  renderAside?: (kind: PanelKind) => ReactNode;
  /** The fixed market stats bar (see STATS_BAR_ID). */
  renderStatsBar: () => ReactNode;
}

export function WorkspaceGrid({
  layout,
  editing,
  onChange,
  dragging,
  onDrop,
  onRemove,
  renderPanel,
  renderAside,
  renderStatsBar,
}: WorkspaceGridProps) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const { cols, rows, margin } = GRID;
  // Stretch rows so the grid fills the window: rows × rowHeight + gaps = height.
  const rowHeight = Math.max(8, (height - margin * (rows - 1)) / rows);

  const items: RglLayout = layout.map((p) => {
    // Static: never dragged or resized, and other panels move around it.
    if (isStatsBar(p.i)) return { ...p, static: true };
    const kind = panelKindOf(p.i);
    const spec = kind && PANELS[kind];
    return { ...p, minW: spec?.minW, minH: spec?.minH };
  });
  const dropSize = dragging ? PANELS[dragging] : undefined;
  const droppingItem: LayoutItem | undefined = dropSize && {
    i: DROPPING_ID,
    x: 0,
    y: 0,
    w: dropSize.w,
    h: dropSize.h,
  };

  return (
    <div ref={ref} className="ws" data-editing={editing || undefined}>
      {width > 0 && (
        <GridLayout
          width={width}
          layout={items}
          gridConfig={{ cols, rowHeight, margin: [margin, margin], containerPadding: [0, 0] }}
          dragConfig={{ enabled: editing, handle: ".ws-panel-head", cancel: ".ws-panel-remove" }}
          resizeConfig={{ enabled: editing, handles: ["se", "e", "s"] }}
          dropConfig={{ enabled: editing && dragging !== undefined }}
          droppingItem={droppingItem}
          onLayoutChange={(next) =>
            onChange(
              next
                .filter((p) => p.i !== DROPPING_ID)
                .map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
            )
          }
          onDrop={(_layout, item) => {
            if (item && dragging) onDrop(dragging, { x: item.x, y: item.y });
          }}
        >
          {layout.map((p) => {
            if (isStatsBar(p.i)) {
              return (
                <div key={p.i} className="ws-stats">
                  {renderStatsBar()}
                </div>
              );
            }
            const kind = panelKindOf(p.i);
            if (!kind) return null;
            return (
              <section key={p.i} className="ws-panel" aria-label={panelTitle(kind)}>
                <header className="ws-panel-head">
                  <h2>{panelTitle(kind)}</h2>
                  {editing ? (
                    <>
                      <span className="pd-muted">
                        {p.w} × {p.h}
                      </span>
                      <button
                        type="button"
                        className="ws-panel-remove"
                        aria-label={t("panel.remove", { panel: panelTitle(kind) })}
                        onClick={() => onRemove(p.i)}
                      >
                        ×
                      </button>
                    </>
                  ) : (
                    <span className="ws-panel-aside">{renderAside?.(kind)}</span>
                  )}
                </header>
                {/* Kept mounted while editing so live feeds don't reconnect. */}
                <div className="ws-panel-body" inert={editing}>
                  {renderPanel(kind, p.i)}
                </div>
              </section>
            );
          })}
        </GridLayout>
      )}
    </div>
  );
}
