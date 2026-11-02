import { getDrawingTool } from "openalgo-charts/draw";
import type { Widget } from "openalgo-charts/widget";

/** How far the pointer moves before a press is a drag, in pixels. */
const DRAG_FROM = 4;

/**
 * A shape that shows as it's dragged out, as TradingView has it. The library
 * takes a drag, but only places its points when the button comes up, and its
 * preview needs a first point down. So once a press moves, a first point goes
 * down to draw from, and it's taken back as the button comes up: the library
 * then places the drag's points itself, in order, snapped as any are. Freehand
 * tools show their strokes already, and a one-point tool has nothing to drag out.
 */
export function attachDragDraw(widget: Widget): () => void {
  const area = widget.root.querySelector("canvas")?.parentElement;
  if (!area) return () => {};
  const { draw, chart } = widget;

  /** Anchors placed so far: the library has no public way to read or take them back. */
  const placed = () => (draw as unknown as { _pending: unknown[] })._pending;
  const draggable = () => {
    const tool = draw.activeTool();
    if (!tool || placed().length > 0) return false;
    const { points, freehand } = getDrawingTool(tool);
    return points >= 2 && !freehand;
  };

  let press: { id: number; x: number; y: number; dragging: boolean } | undefined;

  /** The first point, as a click where the press began, so it snaps like one. */
  const placeFirst = (x: number, y: number) => {
    const pane = chart.primaryPaneIndex();
    const plot = chart.plotRect(pane);
    const from = area.getBoundingClientRect();
    if (!plot) return false;
    const point = { x: x - from.left, y: y - from.top - plot.top };
    const price = chart.coordinateToPrice(point.y, pane);
    if (price === null) return false;
    const time = chart.coordinateToTime(point.x);
    chart.emit("click", { id: null, time, price, paneIndex: pane, point });
    return true;
  };

  const onDown = (e: PointerEvent) => {
    if (e.button === 0 && e.pointerType !== "touch" && draggable()) {
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false };
    }
  };
  const onMove = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id || press.dragging) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_FROM) return;
    press.dragging = placeFirst(press.x, press.y);
    if (!press.dragging) press = undefined;
  };
  // First in line, before the chart hears of it and places the drag's points.
  const onEnd = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.id) return;
    if (press.dragging) placed().length = 0;
    press = undefined;
  };

  area.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onEnd, true);
  window.addEventListener("pointercancel", onEnd, true);
  return () => {
    area.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onEnd, true);
    window.removeEventListener("pointercancel", onEnd, true);
  };
}
