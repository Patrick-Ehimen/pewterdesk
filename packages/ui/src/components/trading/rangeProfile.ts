import type { Bar, PrimitiveRenderContext } from "openalgo-charts";
import { type Drawing, getDrawingTool, registerDrawingTool } from "openalgo-charts/draw";
import { t } from "../../i18n";
import { type VolumeProfile, volumeProfile } from "../../lib/volumeProfile";
import { tokens } from "./chartTheme";

// The fixed range volume profile, as TradingView has it: each row's up and
// down volume side by side in two colours of the trader's, one line at the
// point of control, the rows outside the value area paler, and a soft
// background over the range. The library's draws one colour and three lines,
// so its tool is wrapped: its anchors and the rest of its settings stay, and
// it still draws what it says when a range has no candles or no volume.

const TOOL = "fixed-range-volume-profile";

export const isRangeProfile = (tool: string) => tool === TOOL;
const ROWS = 24;
const WIDTH = 30;
const VALUE_AREA = 70;
const OPACITY = 0.85;
const BACKGROUND_OPACITY = 0.1;
/** How strong a row outside the value area is, against one inside. */
const OUTSIDE = 0.45;
/** The thinnest row, in media px, that keeps a gap under it. */
const MIN_GAPPED = 4;

type Props = {
  rows?: number;
  valueArea?: number;
  width?: number;
  side?: string;
  showPoc?: boolean;
  showValueArea?: boolean;
  upColor?: string;
  downColor?: string;
  opacity?: number;
  background?: boolean;
  backgroundColor?: string;
  backgroundOpacity?: number;
};

const clamp = (value: unknown, fallback: number, low: number, high: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(high, Math.max(low, value))
    : fallback;

/** The candles from one time to the other, either way round. */
export function barsInRange<T extends Pick<Bar, "time">>(bars: readonly T[], a: number, b: number) {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return bars.filter((bar) => bar.time >= from && bar.time <= to);
}

interface Layout {
  profile: VolumeProfile;
  /** The range, in media px. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** How long the busiest row is. */
  length: number;
  flipped: boolean;
}

function layoutOf(drawing: Drawing, rc: PrimitiveRenderContext): Layout | undefined {
  const [a, b] = drawing.points;
  if (!a || !b) return undefined;
  const props = (drawing.props ?? {}) as Props;
  const profile = volumeProfile(
    barsInRange(rc.bars?.() ?? [], a.time, b.time),
    clamp(props.rows, ROWS, 4, 200),
    clamp(props.valueArea, VALUE_AREA, 1, 100) / 100,
  );
  const lowest = profile?.rows[0];
  const highest = profile?.rows.at(-1);
  if (!profile || !lowest || !highest) return undefined;
  const xOf = (time: number) => rc.timeScale.indexToX(rc.dataLayer.timeToIndexFloat(time));
  const [left, right] = [xOf(a.time), xOf(b.time)].sort((x, y) => x - y) as [number, number];
  return {
    profile,
    left,
    right,
    top: rc.priceScale.priceToY(highest.high),
    bottom: rc.priceScale.priceToY(lowest.low),
    length: (Math.max(12, right - left) * clamp(props.width, WIDTH, 5, 100)) / 100,
    flipped: props.side === "right",
  };
}

let registered = false;

export function registerRangeProfile() {
  if (registered) return;
  registered = true;
  const tool = getDrawingTool(TOOL);
  const colors = tokens(document.documentElement);
  const fields = (tool.settings?.fields ?? [])
    // Its opacity, labels and their text have nothing left to act on.
    .filter(
      (field) =>
        field.group !== "text" && !["style.fillOpacity", "style.showLabels"].includes(field.path),
    )
    .map((field) => {
      if (field.path === "props.rows") return { ...field, defaultValue: ROWS };
      if (field.path === "props.width") return { ...field, defaultValue: WIDTH };
      if (field.path === "props.showValueArea") {
        return { ...field, label: t("chart.profileValueArea") };
      }
      return field;
    });
  registerDrawingTool({
    ...tool,
    settings: {
      ...tool.settings,
      fields: [
        {
          path: "props.upColor",
          label: t("chart.profileUp"),
          kind: "color",
          group: "fill",
          defaultValue: colors.up,
        },
        {
          path: "props.downColor",
          label: t("chart.profileDown"),
          kind: "color",
          group: "fill",
          defaultValue: colors.down,
        },
        {
          path: "props.opacity",
          label: t("chart.profileOpacity"),
          kind: "opacity",
          min: 0,
          max: 1,
          step: 0.05,
          group: "fill",
          defaultValue: OPACITY,
        },
        {
          path: "props.background",
          label: t("chart.profileBackground"),
          kind: "boolean",
          group: "fill",
          defaultValue: true,
        },
        {
          path: "props.backgroundColor",
          label: t("chart.profileBackgroundColor"),
          kind: "color",
          group: "fill",
          defaultValue: colors.text,
        },
        {
          path: "props.backgroundOpacity",
          label: t("chart.profileBackgroundOpacity"),
          kind: "opacity",
          min: 0,
          max: 1,
          step: 0.01,
          group: "fill",
          defaultValue: BACKGROUND_OPACITY,
        },
        ...fields,
      ],
    },
    draw(c) {
      const { ctx, rc, style } = c;
      const shape = layoutOf(c.drawing, rc);
      if (!shape) {
        tool.draw(c);
        return;
      }
      const props = (c.drawing.props ?? {}) as Props;
      const { profile, left, right, top, bottom, length, flipped } = shape;
      const dpr = rc.dpr;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, rc.plotWidth * dpr, rc.plotHeight * dpr);
      ctx.clip();

      const opacity = clamp(props.opacity, OPACITY, 0, 1);
      const base = ctx.globalAlpha;
      if (props.background !== false) {
        ctx.globalAlpha = base * clamp(props.backgroundOpacity, BACKGROUND_OPACITY, 0, 1);
        ctx.fillStyle = props.backgroundColor ?? rc.theme.axisText;
        ctx.fillRect(left * dpr, top * dpr, (right - left) * dpr, (bottom - top) * dpr);
      }

      const start = flipped ? right : left;
      const way = flipped ? -1 : 1;
      const tinted = props.showValueArea !== false;
      profile.rows.forEach((row, i) => {
        const y0 = rc.priceScale.priceToY(row.high);
        const y1 = rc.priceScale.priceToY(row.low);
        if (!Number.isFinite(y0) || !Number.isFinite(y1)) return;
        const inside = !tinted || (i >= profile.valueLow && i <= profile.valueHigh);
        ctx.globalAlpha = base * opacity * (inside ? 1 : OUTSIDE);
        const up = (length * row.up) / profile.max;
        const down = (length * row.down) / profile.max;
        // A hair between the rows, so each reads as its own; thin ones would stripe.
        const y = y0 * dpr;
        const tall = y1 - y0;
        const height = Math.max(1, tall * dpr - (tall >= MIN_GAPPED ? 1 : 0));
        ctx.fillStyle = props.upColor ?? rc.theme.upColor;
        ctx.fillRect((start + (flipped ? -up : 0)) * dpr, y, up * dpr, height);
        ctx.fillStyle = props.downColor ?? rc.theme.downColor;
        ctx.fillRect((start + way * up + (flipped ? -down : 0)) * dpr, y, down * dpr, height);
      });

      ctx.globalAlpha = base;
      const poc = profile.rows[profile.poc];
      if (poc && props.showPoc !== false) {
        const y = ((rc.priceScale.priceToY(poc.high) + rc.priceScale.priceToY(poc.low)) / 2) * dpr;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = Math.max(1, (style.lineWidth ?? 1) * dpr);
        ctx.beginPath();
        ctx.moveTo(left * dpr, y);
        ctx.lineTo(right * dpr, y);
        ctx.stroke();
      }
      ctx.restore();
    },
    distance(x, y, c) {
      const shape = layoutOf(c.drawing, c.rc);
      if (!shape) return tool.distance?.(x, y, c) ?? null;
      const { left, right, top, bottom, length, flipped } = shape;
      const solid = (c.drawing.props as Props | undefined)?.background !== false;
      const from = solid || !flipped ? left : right - length;
      const to = solid || flipped ? right : left + length;
      return x >= from && x <= to && y >= top && y <= bottom ? 0 : null;
    },
  });
}
