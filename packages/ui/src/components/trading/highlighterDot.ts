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
