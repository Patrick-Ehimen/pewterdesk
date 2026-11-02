import { drawingShortcuts } from "openalgo-charts/draw";
import { toolGlyph, toolName, type Widget } from "openalgo-charts/widget";
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuGripVertical } from "react-icons/lu";
import { t } from "../../i18n";
import { type ChartToolsPrefs, loadChartTools, saveChartTools } from "../../lib/chartTools";

/** How far down the chart the bar is before tool names open upward. */
const LOW_ON_CHART = 0.75;
const FAVORITES = ".oac-rail__favs";
const FAVORITE = ".oac-rail__fav";

/** The tools starred on the rail: the library draws them there, and doesn't say otherwise. */
const starred = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>(`${FAVORITES} ${FAVORITE}`)].flatMap(
    (el) => el.dataset.tools ?? [],
  );

/** A tool's name and its key, spelled as the rail's menus spell it. */
function tipOf(tool: string) {
  const key = drawingShortcuts()[tool];
  if (!key) return toolName(tool);
  const mac = navigator.platform.toLowerCase().includes("mac");
  return `${toolName(tool)}  ${mac ? key.replace("Alt", "Opt") : key}`;
}

/** The rail's pins: the library has no other way to change them. */
const railOf = (widget: Widget) =>
  (widget as unknown as { _rail?: { toggleFavorite(id: string, on?: boolean): void } })._rail;

/** A tool's icon, as the rail draws it. */
function ToolIcon({ tool }: { tool: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(toolGlyph(document, tool));
  }, [tool]);
  return <span ref={ref} className="pd-chart-tools-icon" aria-hidden />;
}

/**
 * The drawing tools starred in the rail's menus, in a bar of their own that
 * can be dragged anywhere on the chart. Only tools: it draws, it places nothing.
 */
export function ChartTools({ widget }: { widget: Widget }) {
  const [tools, setTools] = useState<readonly string[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [place, setPlace] = useState<Pick<ChartToolsPrefs, "x" | "y">>(() => {
    const { x, y } = loadChartTools();
    return { x, y };
  });
  const [collapsed, setCollapsed] = useState(() => loadChartTools().collapsed);
  // Double-clicked, a tool stays armed after each drawing until it's let go.
  const [kept, setKept] = useState<string>();
  const keptRef = useRef(kept);
  keptRef.current = kept;
  const [menu, setMenu] = useState<string>();
  const bar = useRef<HTMLDivElement>(null);
  const grip = useRef<{ x: number; y: number }>(undefined);

  useEffect(() => {
    const favorites = widget.root.querySelector(FAVORITES);
    if (!favorites) return;
    const read = () => setTools(starred(widget.root));
    const first = starred(widget.root);
    setTools(first);
    // Stars made before this bar stay on this chart's rail: bring them to all of them.
    if (first.length > 0 && loadChartTools().favorites.length === 0) {
      saveChartTools({ favorites: first });
    }
    const watch = new MutationObserver(() => {
      read();
      saveChartTools({ favorites: starred(widget.root) });
    });
    watch.observe(favorites, { childList: true });
    return () => watch.disconnect();
  }, [widget]);

  useEffect(() => {
    if (widget.isDestroyed) return;
    setArmed(widget.draw.activeTool());
    let drawn = false;
    const off = [
      widget.chart.on("draw:add", () => {
        drawn = true;
      }),
      widget.chart.on("draw:tool", ({ tool }) => {
        setArmed(tool);
        if (tool !== null) return;
        // Let go by a finished drawing, it's armed again; by Escape, it stays let go.
        setTimeout(() => {
          // Armed again by now: a double-click, whose second click let go first.
          if (widget.isDestroyed || widget.draw.activeTool()) return;
          if (keptRef.current && drawn) widget.draw.setTool(keptRef.current);
          else setKept(undefined);
          drawn = false;
        }, 0);
      }),
    ];
    return () => {
      for (const stop of off) stop();
    };
  }, [widget]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const startDrag = (e: PointerEvent<HTMLElement>) => {
    const at = bar.current?.getBoundingClientRect();
    if (!at) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    grip.current = { x: e.clientX - at.left, y: e.clientY - at.top };
  };
  const drag = (e: PointerEvent<HTMLElement>) => {
    const stage = bar.current?.parentElement?.getBoundingClientRect();
    const at = bar.current?.getBoundingClientRect();
    if (!grip.current || !stage || !at) return;
    const along = (from: number, room: number) =>
      room > 0 ? Math.min(1, Math.max(0, from / room)) : 0;
    setPlace({
      x: along(e.clientX - grip.current.x - stage.left, stage.width - at.width),
      y: along(e.clientY - grip.current.y - stage.top, stage.height - at.height),
    });
  };
  const endDrag = () => {
    if (grip.current) saveChartTools(place);
    grip.current = undefined;
  };

  const toggle = () => {
    setCollapsed(!collapsed);
    saveChartTools({ collapsed: !collapsed });
  };

  if (tools.length === 0) return null;
  // Folded, a tool still armed stays in sight, and can be let go.
  const shown = collapsed ? tools.filter((tool) => tool === armed) : tools;
  const toggleLabel = t(collapsed ? "chart.expandTools" : "chart.collapseTools");
  return (
    <div
      ref={bar}
      className="pd-chart-tools"
      role="toolbar"
      aria-label={t("chart.starredTools")}
      // Low on the chart, tool names open upward.
      data-low={place.y > LOW_ON_CHART || undefined}
      style={{
        left: `${place.x * 100}%`,
        top: `${place.y * 100}%`,
        transform: `translate(${-place.x * 100}%, ${-place.y * 100}%)`,
      }}
    >
      <span
        className="pd-chart-tools-grip"
        title={t("chart.moveTools")}
        aria-hidden
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <LuGripVertical size={14} />
      </span>
      {shown.map((tool) => (
        <button
          key={tool}
          type="button"
          className="pd-chart-tools-tool"
          aria-pressed={armed === tool}
          aria-label={toolName(tool)}
          data-tip={menu ? undefined : tipOf(tool)}
          data-kept={kept === tool || undefined}
          onClick={() => {
            setKept(undefined);
            widget.draw.setTool(armed === tool ? null : tool);
          }}
          onDoubleClick={() => {
            setKept(tool);
            widget.draw.setTool(tool);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(tool);
          }}
        >
          <ToolIcon tool={tool} />
          {menu === tool && (
            <span className="pd-chart-tools-menu">
              <span
                className="pd-chart-tools-item"
                role="menuitem"
                tabIndex={-1}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  railOf(widget)?.toggleFavorite(tool, false);
                  setMenu(undefined);
                }}
              >
                {t("chart.toolRemove")}
              </span>
            </span>
          )}
        </button>
      ))}
      <button
        type="button"
        className="pd-chart-tools-tool pd-chart-tools-toggle"
        aria-expanded={!collapsed}
        aria-label={toggleLabel}
        data-tip={toggleLabel}
        onClick={toggle}
      >
        {collapsed ? (
          <LuChevronRight size={15} aria-hidden />
        ) : (
          <LuChevronLeft size={15} aria-hidden />
        )}
      </button>
    </div>
  );
}
