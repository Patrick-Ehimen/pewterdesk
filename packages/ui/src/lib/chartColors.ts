// The colours a drawing can take. These are a trader's marks on a chart, not
// the app's interface, so they're fixed values, not the theme's tokens.

const GREYS = [
  "#ffffff",
  "#d9d9d9",
  "#b3b3b3",
  "#999999",
  "#808080",
  "#666666",
  "#4d4d4d",
  "#262626",
  "#0d0d0d",
  "#000000",
];
const HUES = [
  "#e5484d",
  "#f59b2f",
  "#ffe552",
  "#5fae5a",
  "#3f9b82",
  "#4db8d6",
  "#3b6cf6",
  "#6240b8",
  "#8e35ab",
  "#d23a68",
];

const toHex = (v: number) => Math.round(v).toString(16).padStart(2, "0");

/** `hex` moved `amount` of the way to `towards`. */
function mix(hex: string, towards: number, amount: number) {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `#${channels.map((c) => toHex(c + (towards - c) * amount)).join("")}`;
}

const tints = [0.75, 0.55, 0.35, 0.15];
const shades = [0.25, 0.5];

/** Two rows of plain colours, the greys and the full hues. */
export const COLOR_BASE: readonly (readonly string[])[] = [GREYS, HUES];

/** Each hue from pale to deep, a row to a step. */
export const COLOR_RAMPS: readonly (readonly string[])[] = [
  ...tints.map((t) => HUES.map((hue) => mix(hue, 255, t))),
  ...shades.map((s) => HUES.map((hue) => mix(hue, 0, s))),
];

export interface PickedColor {
  /** "#rrggbb". */
  hex: string;
  /** 0 to 1. */
  alpha: number;
}

/** A style's colour as a hex and its opacity; black where it can't be read. */
export function readColor(color: string | undefined, fallbackAlpha = 1): PickedColor {
  const text = color?.trim().toLowerCase() ?? "";
  const hex = /^#([\da-f]{6})([\da-f]{2})?$/.exec(text);
  if (hex) {
    const alpha = hex[2] ? Number.parseInt(hex[2], 16) / 255 : fallbackAlpha;
    return { hex: `#${hex[1]}`, alpha };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  const parts =
    rgb?.[1]
      ?.split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number) ?? [];
  const [r, g, b, a] = parts;
  if (r === undefined || g === undefined || b === undefined || parts.some(Number.isNaN)) {
    return { hex: "#000000", alpha: fallbackAlpha };
  }
  return { hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`, alpha: a ?? fallbackAlpha };
}

/** A colour as a style holds it: plain hex when solid. */
export function writeColor({ hex, alpha }: PickedColor): string {
  if (alpha >= 1) return hex;
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${Number(alpha.toFixed(2))})`;
}

interface DrawnPoint {
  time: number;
  price: number;
}

/** Tools whose two points make a line that carries on: its price now is on that line. */
const LINES = new Set(["trend-line", "ray", "extended-line", "info-line", "trend-angle"]);

/**
 * The price an alert on a drawing watches: where a line is at `now` (UTC
 * seconds), or the last point of anything else. It's fixed when the alert is
 * set, so it doesn't follow the line afterwards.
 */
export function drawingPrice(
  tool: string,
  points: readonly DrawnPoint[],
  now: number,
): number | undefined {
  const [a, b] = points;
  if (a && b && LINES.has(tool) && b.time !== a.time) {
    return a.price + ((b.price - a.price) * (now - a.time)) / (b.time - a.time);
  }
  return points.at(-1)?.price;
}

/** The font of words on a drawing, at a size in device pixels. */
export const formatLabelFont = (size: number) =>
  `${size}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
