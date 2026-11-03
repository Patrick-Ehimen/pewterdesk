import type { DrawingPoint, ScreenPoint } from "openalgo-charts/draw";
import { getDrawingTool, registerDrawingTool } from "openalgo-charts/draw";
import type { Widget } from "openalgo-charts/widget";

// A tap with the highlighter leaves a dot, as TradingView's does. The
// library's highlighter only inks while the pointer moves, and drops a stroke
// of fewer than two points, so a tap left nothing. Its tool is wrapped to
// paint a stroke whose points all sit in one place as a round dot, of the
// stroke's own width and opacity, and a tap places one: a one-point drawing,
// added by the same `add` the library's own strokes go through.

const TOOL = "highlighter";
const WIDTH = 12;
/** The sizes its width menu offers, as TradingView's; the library's run 1 to 4 px. */
const WIDTHS = [8, 12, 20, 32, 48, 64, 80, 96];
const OPACITY = 0.28;
/** How far the pointer moves before a press is a stroke, in pixels. */
const STROKE_FROM = 4;
/** Points closer than this, in pixels, are one place. */
const SAME_PLACE = 1.5;

function dotOf(pts: readonly ScreenPoint[], scale: number) {
  const [first] = pts;
  if (!first) return undefined;
  const near = (p: ScreenPoint) => Math.hypot(p.x - first.x, p.y - first.y) <= SAME_PLACE * scale;
  return pts.every(near) ? first : undefined;
}

let registered = false;

export function registerHighlighterDot() {
  if (registered) return;
  registered = true;
  const tool = getDrawingTool(TOOL);
  registerDrawingTool({
    ...tool,
    draw(c) {
      const dot = dotOf(c.pts, c.rc.dpr);
      if (!dot) return tool.draw(c);
      const { ctx, style } = c;
      ctx.save();
      ctx.globalAlpha = style.fillOpacity ?? OPACITY;
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, Math.max(2, (style.lineWidth || WIDTH) * c.rc.dpr) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
    distance(x, y, c) {
      const dot = dotOf(c.pts, 1);
      if (!dot) return tool.distance(x, y, c);
      const away = Math.hypot(x - dot.x, y - dot.y);
      return away <= Math.max(6, (c.drawing.style.lineWidth ?? WIDTH) / 2) ? 0 : away;
    },
  });
}

/**
 * A tap with the highlighter armed places a dot where it went down. Heard
 * before the chart, so the few points a shaky tap inked are taken back and
 * the library has no stroke of its own to finish.
 */
export function attachHighlighterDot(widget: Widget): () => void {
  const area = widget.root.querySelector("canvas")?.parentElement;
  if (!area) return () => {};
  const { draw, chart } = widget;

  /** Points inked so far: the library has no public way to read or take them back. */
  const inked = () => (draw as unknown as { _pending: unknown[] })._pending;
  const stays = () =>
    (draw as unknown as { _opts?: { stayInDrawingMode?: boolean } })._opts?.stayInDrawingMode ===
    true;

  /** Where a press went down, as a point on the chart's main pane. */
  const pointAt = (x: number, y: number): DrawingPoint | undefined => {
    const pane = chart.primaryPaneIndex();
    const plot = chart.plotRect(pane);
    if (!plot) return undefined;
    const from = area.getBoundingClientRect();
    const inPlot = { x: x - from.left, y: y - from.top - plot.top };
    if (inPlot.y < 0 || inPlot.y > plot.height) return undefined;
    const price = chart.coordinateToPrice(inPlot.y, pane);
    const time = chart.coordinateToTime(inPlot.x);
    if (price === null || !Number.isFinite(price) || !Number.isFinite(time)) return undefined;
    return { time, price };
  };

  let press: { id: number; x: number; y: number; moved: boolean } | undefined;

  const onDown = (e: PointerEvent) => {
    press =
      e.button === 0 && draw.activeTool() === TOOL
        ? { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
        : undefined;
  };
  const onMove = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id || press.moved) return;
    press.moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) >= STROKE_FROM;
  };
  const onUp = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return;
    const tap = !press.moved && draw.activeTool() === TOOL;
    const point = tap ? pointAt(press.x, press.y) : undefined;
    press = undefined;
    if (!point) return;
    inked().length = 0;
    const dot = draw.add({
      tool: TOOL,
      points: [point],
      style: {},
      paneIndex: chart.primaryPaneIndex(),
    });
    // As the library ends a stroke: the tool let go, unless it's kept, and the dot picked.
    if (!stays()) draw.setTool(null);
    draw.select(dot.id);
  };
  const onCancel = (e: PointerEvent) => {
    if (press && e.pointerId === press.id) press = undefined;
  };

  area.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  return () => {
    area.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
  };
}

/**
 * The drawing toolbar's width button, with only highlighters selected, offers
 * a highlighter's sizes: the library's menu is a line's, 1 to 4 px. The menu
 * is built from the library's own, so it looks and closes as that does.
 */
export function attachHighlighterWidths(widget: Widget): () => void {
  const { draw, chart, root } = widget;
  let menu: { el: HTMLElement; close: () => void } | undefined;

  const highlighters = () => {
    const picked = draw.selection().flatMap((id) => draw.get(id) ?? []);
    return picked.length > 0 && picked.every((d) => d.tool === TOOL) ? picked : undefined;
  };

  const open = (button: HTMLElement) => {
    const picked = highlighters();
    if (!picked) return;
    const now = new Set(picked.map((d) => d.style.lineWidth ?? WIDTH));
    const el = document.createElement("div");
    el.className = "oac-menu oac-pop";
    el.setAttribute("role", "menu");
    el.setAttribute("aria-label", button.title);
    const body = document.createElement("div");
    body.className = "oac-menu__body";
    for (const width of WIDTHS) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "oac-menu__row";
      row.setAttribute("role", "menuitemradio");
      row.setAttribute("aria-checked", String(now.size === 1 && now.has(width)));
      const label = document.createElement("span");
      label.className = "oac-menu__label";
      label.textContent = `${width} px`;
      row.append(label);
      row.addEventListener("click", () => {
        draw.updateMany(
          (highlighters() ?? []).map((d) => ({ id: d.id, patch: { style: { lineWidth: width } } })),
        );
        close();
      });
      body.append(row);
    }
    el.append(body);
    // Where the library's own menus go, over the chart.
    const layer = root.querySelector<HTMLElement>(":scope > .oac-layer") ?? root;
    layer.append(el);
    const stage = layer.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    el.style.left = `${at.left - stage.left}px`;
    el.style.top = `${at.bottom - stage.top + 4}px`;
    button.setAttribute("aria-expanded", "true");

    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!el.contains(target) && !button.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const off = chart.on("draw:select", () => close());
    function close() {
      el.remove();
      button.setAttribute("aria-expanded", "false");
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", onKey, true);
      off();
      menu = undefined;
    }
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", onKey, true);
    menu = { el, close };
  };

  // Heard before the library's own handler, which would open the line widths.
  const onClick = (e: MouseEvent) => {
    const button = (e.target as Element).closest?.<HTMLElement>(".oac-drawbar__width");
    if (!button || !highlighters()) return;
    e.preventDefault();
    e.stopPropagation();
    if (menu) menu.close();
    else open(button);
  };
  root.addEventListener("click", onClick, true);
  return () => {
    root.removeEventListener("click", onClick, true);
    menu?.close();
  };
}
