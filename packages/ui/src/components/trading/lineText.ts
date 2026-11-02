import { type DrawingText, getDrawingTool, registerDrawingTool } from "openalgo-charts/draw";
import { formatLabelFont } from "../../lib/chartColors";

// Words on a line, as TradingView has them: along it, at its middle. The
// library's line tools carry `drawing.text` but never paint it, so each is
// wrapped: drawn as it was, then the words over it, with the rectangle's own
// text settings (all but "inside or outside", which a line hasn't got).

const LINE_TOOLS = ["trend-line", "ray", "extended-line", "arrow", "info-line"];
/** The library's default, for a rectangle's text too. */
const FONT_SIZE = 14;
const LINE_HEIGHT = 1.35;
/** Off the line, in media px. */
const LIFT = 5;
/** In from the line's end, when aligned to one, in media px. */
const INSET = 4;
/** Past any chart, in device px. */
const CANVAS = 1e5;

let registered = false;

export const isLineTool = (tool: string) => LINE_TOOLS.includes(tool);

const fontOf = (text: DrawingText, size: number) =>
  `${text.italic ? "italic " : ""}${text.bold ? "700 " : ""}${
    text.fontFamily ? `${size}px ${text.fontFamily}` : formatLabelFont(size)
  }`;

/** The words as lines: their own, each broken to fit if wrapping is on. */
function linesOf(ctx: CanvasRenderingContext2D, text: DrawingText, width: number) {
  const lines = text.value.split("\n");
  if (!text.wrap) return lines;
  return lines.flatMap((line) => {
    const broken: string[] = [];
    let now = "";
    for (const word of line.split(/\s+/).filter(Boolean)) {
      const next = now ? `${now} ${word}` : word;
      if (now && ctx.measureText(next).width > width) {
        broken.push(now);
        now = word;
      } else {
        now = next;
      }
    }
    broken.push(now);
    return broken;
  });
}

export function registerLineText() {
  if (registered) return;
  registered = true;
  const textFields = (getDrawingTool("rectangle").settings?.fields ?? []).filter(
    (field) => field.group === "text" && field.path !== "text.position",
  );
  for (const id of LINE_TOOLS) {
    const tool = getDrawingTool(id);
    registerDrawingTool({
      ...tool,
      settings: { ...tool.settings, fields: [...(tool.settings?.fields ?? []), ...textFields] },
      draw(c) {
        const text = c.drawing.text;
        const [a, b] = c.pts;
        if (!text?.value || !a || !b) {
          tool.draw(c);
          return;
        }
        const { ctx, rc } = c;
        // Upright whichever way the line was drawn.
        const [left, right] = a.x <= b.x ? [a, b] : [b, a];
        const onLine = () => {
          ctx.translate((left.x + right.x) / 2, (left.y + right.y) / 2);
          ctx.rotate(Math.atan2(right.y - left.y, right.x - left.x));
        };
        const size = (text.fontSize ?? FONT_SIZE) * rc.dpr;
        // Along the line: from its left end, its right, or its middle.
        const align = text.align ?? "center";
        const end = Math.max(
          0,
          Math.hypot(right.x - left.x, right.y - left.y) / 2 - INSET * rc.dpr,
        );
        const x = align === "left" ? -end : align === "right" ? end : 0;
        ctx.save();
        ctx.font = fontOf(text, size);
        const lines = linesOf(ctx, text, Math.max(20 * rc.dpr, end * 2));
        // Across it: above the line, on it, or under it.
        const step = size * LINE_HEIGHT;
        const height = (lines.length - 1) * step + size;
        const lift = LIFT * rc.dpr;
        const top =
          text.valign === "middle" ? -height / 2 : text.valign === "bottom" ? lift : -lift - height;

        ctx.save();
        if (text.valign === "middle") {
          // On the line the words break it, or it would strike them through.
          const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
          const from = align === "left" ? x : align === "right" ? x - width : x - width / 2;
          const base = ctx.getTransform();
          onLine();
          ctx.beginPath();
          ctx.rect(-CANVAS, -CANVAS, CANVAS * 2, CANVAS * 2);
          ctx.rect(from - lift, top, width + lift * 2, height);
          ctx.clip("evenodd");
          ctx.setTransform(base);
        }
        tool.draw(c);
        ctx.restore();

        onLine();
        ctx.setLineDash([]);
        ctx.fillStyle = text.color ?? c.style.color ?? rc.theme.axisText;
        ctx.textAlign = align;
        ctx.textBaseline = "top";
        for (const [row, line] of lines.entries()) ctx.fillText(line, x, top + row * step);
        ctx.restore();
      },
    });
  }
}
