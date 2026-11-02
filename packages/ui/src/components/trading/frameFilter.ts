import { registerDrawingTool, registeredDrawingTools } from "openalgo-charts/draw";
import { groupOfBarSeconds } from "../../lib/drawingFrames";

// Timeframes left out inside a drawing's range. The chart's own filter is one
// unbroken range, so every tool is wrapped: left out here, a drawing neither
// paints nor catches the pointer. Register this after any tool that's wrapped
// for something else, so it wraps those too.

const SECONDS_BETWEEN = 3;

/** Seconds between a chart's bars: the shortest of the last few, past any gap. */
function barSeconds(bars: readonly { time: number }[] | undefined) {
  if (!bars || bars.length < 2) return undefined;
  let shortest = Number.POSITIVE_INFINITY;
  for (let i = bars.length - 1; i > 0 && i >= bars.length - SECONDS_BETWEEN; i--) {
    shortest = Math.min(shortest, (bars[i]?.time ?? 0) - (bars[i - 1]?.time ?? 0));
  }
  return shortest;
}

function leftOut(
  drawing: { props?: Record<string, unknown> },
  rc: { bars?: () => readonly { time: number }[] },
) {
  const hidden = drawing.props?.hiddenFrames;
  if (!Array.isArray(hidden) || hidden.length === 0) return false;
  const seconds = barSeconds(rc.bars?.());
  return seconds !== undefined && hidden.includes(groupOfBarSeconds(seconds));
}

let registered = false;

export function registerFrameFilter() {
  if (registered) return;
  registered = true;
  for (const tool of registeredDrawingTools()) {
    registerDrawingTool({
      ...tool,
      draw(c) {
        if (!leftOut(c.drawing, c.rc)) tool.draw(c);
      },
      distance(x, y, c) {
        return leftOut(c.drawing, c.rc) ? null : (tool.distance?.(x, y, c) ?? null);
      },
    });
  }
}
