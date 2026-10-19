// The P&L share card, drawn on a canvas so the preview and the saved image
// are the same pixels. Colours come from the --pd-* tokens at draw time:
// always the dark set, whatever the app's theme, so every card looks like the
// design; green and red (the user's, colorblind included) only for the PnL
// and the side, brass for the frame and the accents, and the art's own cyan
// and violet for the rings. Everything is drawn as shapes, never images, so
// it stays sharp at any export size.

/** One of the card's two figures: the big number, and its name in the chip. */
export interface ShareFigure {
  /** Over the big number, e.g. "Realized P&L (USDT)". */
  label: string;
  /** Already formatted, e.g. "+41.21" or "+14.17%". */
  value: string;
  /** In the chip under the art, on the other slide, e.g. "ROI". */
  short: string;
}

/** What a card shows. Labels arrive already in the user's language. */
export interface ShareCard {
  /** The venue's name and logo (an image URL). */
  venue: string;
  venueLogo?: string;
  /** PewterDesk's wordmark (an image URL), for the current theme. */
  brandLogo?: string;
  /** e.g. "BTC-USDT". */
  market: string;
  side: "long" | "short";
  /** The pill beside the market: "Position: Short", then "Leverage: 10x" when known. */
  position: { label: string; value: string };
  leverage?: { label: string; value: string };
  /** The big figure on each slide; each slide's chip shows the other one. */
  roi?: ShareFigure;
  pnl: ShareFigure;
  /** Whether the trade made money, for the figure's colour and the art. */
  profit: boolean;
  /** The two prices under the figure; `kind` picks each tile's icon. */
  prices: [SharePrice, SharePrice];
  /** On the frame's foot, e.g. "Closed: Oct 5, 2026, 14:02". */
  footnote?: string;
  /** A "Demo" badge, when shown. */
  demoLabel?: string;
}

export interface SharePrice {
  label: string;
  value: string;
  kind: "entry" | "exit" | "mark";
}

export type ShareSlide = "roi" | "pnl";
/**
 * The card's two designs: faceted slate with neon rings, or a perspective
 * grid to a lit horizon. The dialog picks one at random.
 */
export const SHARE_STYLES = ["slabs", "horizon"] as const;
export type ShareStyle = (typeof SHARE_STYLES)[number];

/** One of the designs at random; `not` is left out when there's another. */
export function randomStyle(not?: ShareStyle, random = Math.random): ShareStyle {
  const pool = SHARE_STYLES.filter((s) => s !== not);
  return pool[Math.floor(random() * pool.length)] ?? "slabs";
}
export type ShareLayout = "landscape" | "portrait";

/** The card's size in CSS pixels; saved at twice that. */
export const SHARE_SIZE: Record<ShareLayout, { w: number; h: number }> = {
  landscape: { w: 640, h: 380 },
  portrait: { w: 380, h: 500 },
};

interface Palette {
  bg: string;
  raised: string;
  border: string;
  text: string;
  pewter: string;
  dim: string;
  brass: string;
  buy: string;
  sell: string;
  info: string;
  onBrass: string;
  cyan: string;
  violet: string;
  font: string;
}

function palette(): Palette {
  // The dark set, read off a probe element (the token selectors work on any
  // element); the market colours stay the document's, so colorblind mode holds.
  const probe = document.createElement("div");
  probe.dataset.theme = "dark";
  probe.style.display = "none";
  document.body.append(probe);
  const dark = getComputedStyle(probe);
  const doc = getComputedStyle(document.documentElement);
  const v = (name: string) => dark.getPropertyValue(name).trim();
  const market = (name: string) => doc.getPropertyValue(name).trim() || v(name);
  const p = {
    bg: v("--pd-bg"),
    raised: v("--pd-surface-raised"),
    border: v("--pd-border"),
    text: v("--pd-text"),
    pewter: v("--pd-pewter"),
    dim: v("--pd-pewter-dim"),
    brass: v("--pd-brass"),
    buy: market("--pd-buy"),
    sell: market("--pd-sell"),
    info: v("--pd-info"),
    onBrass: v("--pd-on-brass"),
    cyan: v("--pd-art-cyan") || v("--pd-info"),
    violet: v("--pd-art-violet") || v("--pd-info"),
    font: getComputedStyle(document.body).fontFamily || "sans-serif",
  };
  probe.remove();
  return p;
}

/** Loads an image for drawing; resolves undefined if it can't. */
export function loadImage(src: string | undefined): Promise<HTMLImageElement | undefined> {
  if (!src) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A colour at `alpha`, through the canvas's own colour parsing. */
function alpha(ctx: CanvasRenderingContext2D, color: string, a: number): string {
  ctx.save();
  ctx.fillStyle = color;
  const parsed = ctx.fillStyle; // #rrggbb or rgba(...)
  ctx.restore();
  if (parsed.startsWith("#") && parsed.length === 7) {
    const n = Number.parseInt(parsed.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return parsed.replace(/rgba?\(([^)]+)\)/, (_, inner: string) => {
    const [r, g, b] = inner.split(",").map((s) => s.trim());
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  });
}

/** A colour as [r, g, b], through the canvas's own colour parsing. */
function rgb(ctx: CanvasRenderingContext2D, color: string): [number, number, number] {
  const parsed = alpha(ctx, color, 1);
  const [r = 0, g = 0, b = 0] = (parsed.match(/[\d.]+/g) ?? []).map(Number);
  return [r, g, b];
}

/** `a` blended towards `b` by `t` (0-1), as an opaque colour. */
function mix(ctx: CanvasRenderingContext2D, a: string, b: string, t: number): string {
  const x = rgb(ctx, a);
  const y = rgb(ctx, b);
  const c = x.map((v, i) => Math.round(v + ((y[i] ?? v) - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** `color` darker by `t` (0-1): the shadows under the slabs, below even the bg. */
function darken(ctx: CanvasRenderingContext2D, color: string, t: number): string {
  const c = rgb(ctx, color).map((v) => Math.round(v * (1 - t)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * The panel's backdrop, after the design's stone: thick slate slabs at
 * angles, overlapping, each with a chamfered edge lit from the top left and a
 * shadow under it, and a faint brushed grain on its face. Fixed positions, so
 * every card is the same art.
 */
const SLABS: readonly [number, number, number, number, number, number][] = [
  // cx, cy (fractions of the panel), w, h (of its longer side), angle (deg), shade (0-1)
  [0.02, 0.62, 0.62, 0.5, 52, 0.35],
  [0.5, 0.86, 0.7, 0.44, -36, 0.45],
  [1.02, 0.72, 0.5, 0.62, 40, 0.3],
  [0.36, 0.42, 0.48, 0.3, -42, 0.2],
  [0.16, 0.06, 0.52, 0.3, 34, 0.5],
  [0.56, 0.0, 0.34, 0.34, 45, 0.7],
  [0.86, 0.12, 0.44, 0.22, -45, 0.85],
  [0.98, -0.02, 0.26, 0.26, 45, 0.6],
  [0.72, 0.42, 0.3, 0.2, 45, 0.25],
];
/** Where the light comes from: up and to the left. */
const LIGHT = { x: -0.55, y: -0.83 };

function shards(ctx: CanvasRenderingContext2D, p: Palette, w: number, h: number) {
  const unit = Math.max(w, h);
  const deep = darken(ctx, p.bg, 0.35);
  for (const [fx, fy, fw, fh, deg, shade] of SLABS) {
    const sw = fw * unit;
    const sh = fh * unit;
    const bevel = Math.max(3, Math.min(sw, sh) * 0.035);
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const at = (x: number, y: number) => ({
      x: fx * w + x * cos - y * sin,
      y: fy * h + x * sin + y * cos,
    });
    const outer = [
      at(-sw / 2, -sh / 2),
      at(sw / 2, -sh / 2),
      at(sw / 2, sh / 2),
      at(-sw / 2, sh / 2),
    ];
    const inner = [
      at(-sw / 2 + bevel, -sh / 2 + bevel),
      at(sw / 2 - bevel, -sh / 2 + bevel),
      at(sw / 2 - bevel, sh / 2 - bevel),
      at(-sw / 2 + bevel, sh / 2 - bevel),
    ];
    const poly = (pts: { x: number; y: number }[]) => {
      ctx.beginPath();
      for (const [i, pt] of pts.entries()) {
        if (i) ctx.lineTo(pt.x, pt.y);
        else ctx.moveTo(pt.x, pt.y);
      }
      ctx.closePath();
    };
    const face = mix(ctx, p.bg, p.pewter, 0.05 + shade * 0.12);
    // Its shadow on what's under it: the one soft thing, under crisp edges.
    ctx.save();
    ctx.shadowColor = alpha(ctx, deep, 0.85);
    ctx.shadowBlur = bevel * 6;
    ctx.shadowOffsetX = bevel * 1.2;
    ctx.shadowOffsetY = bevel * 2;
    ctx.fillStyle = face;
    poly(outer);
    ctx.fill();
    ctx.restore();
    // The face: lighter towards the light, with a fine grain along it.
    ctx.save();
    poly(inner);
    ctx.clip();
    const from = at(-sw / 2, -sh / 2);
    const to = at(sw / 2, sh / 2);
    const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
    grad.addColorStop(0, mix(ctx, face, p.pewter, 0.07));
    grad.addColorStop(1, mix(ctx, face, deep, 0.25));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = alpha(ctx, p.pewter, 0.025);
    ctx.lineWidth = 0.5;
    for (let g = -sh / 2; g < sh / 2; g += 2.5) {
      const s0 = at(-sw / 2, g);
      const s1 = at(sw / 2, g);
      ctx.beginPath();
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
      ctx.stroke();
    }
    ctx.restore();
    // The chamfer: each edge's strip shaded by how squarely it faces the light.
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const o0 = outer[i];
      const o1 = outer[j];
      const i0 = inner[i];
      const i1 = inner[j];
      if (!o0 || !o1 || !i0 || !i1) continue;
      const ex = o1.x - o0.x;
      const ey = o1.y - o0.y;
      const len = Math.hypot(ex, ey) || 1;
      // Outward normal of a clockwise polygon.
      const lit = -((ey / len) * LIGHT.x - (ex / len) * LIGHT.y);
      ctx.fillStyle =
        lit > 0 ? mix(ctx, face, p.text, 0.12 + lit * 0.3) : mix(ctx, face, deep, 0.35 - lit * 0.5);
      poly([o0, o1, i1, i0]);
      ctx.fill();
      // A hairline on the lit rims: what makes the edge read sharp.
      if (lit > 0.2) {
        ctx.strokeStyle = alpha(ctx, p.text, 0.1 + lit * 0.16);
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(o0.x, o0.y);
        ctx.lineTo(o1.x, o1.y);
        ctx.stroke();
      }
    }
  }
  // Darker towards the edges, so the text in the middle sits on calm ground.
  const vignette = ctx.createRadialGradient(w * 0.4, h * 0.4, 0, w * 0.4, h * 0.4, unit * 0.85);
  vignette.addColorStop(0, alpha(ctx, p.bg, 0));
  vignette.addColorStop(1, alpha(ctx, p.bg, 0.5));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Strokes the current path as neon: a wide soft glow, a coloured body, then
 * a thin bright core, so it reads lit but stays crisp at its centre.
 */
function neon(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  stroke: string | CanvasGradient,
  glow: string,
  width: number,
) {
  ctx.save();
  ctx.shadowColor = alpha(ctx, glow, 0.9);
  ctx.shadowBlur = width * 7;
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width * 2.2;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.strokeStyle = alpha(ctx, p.text, 0.85);
  ctx.lineWidth = Math.max(0.6, width * 0.35);
  ctx.stroke();
  ctx.restore();
}

/**
 * The result's art, after the design: two interlocked rings, each a pair of
 * neon lines, and an arrow through them with speed lines trailing, in cyan
 * running to violet, two small orbs, and a pool of light under it. Up and to
 * the right for a profit, down for a loss.
 */
function art(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  cx: number,
  cy: number,
  size: number,
  up: boolean,
) {
  const dir = up ? -1 : 1;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const sweep = ctx.createLinearGradient(cx - size * 0.6, cy, cx + size * 0.6, cy);
  sweep.addColorStop(0, p.cyan);
  sweep.addColorStop(1, p.violet);

  // The pool of light under it, and a faint reflection line.
  const pool = ctx.createRadialGradient(cx, cy + size * 0.42, 0, cx, cy + size * 0.42, size * 0.55);
  pool.addColorStop(0, alpha(ctx, p.violet, 0.32));
  pool.addColorStop(0.5, alpha(ctx, p.cyan, 0.1));
  pool.addColorStop(1, alpha(ctx, p.violet, 0));
  ctx.fillStyle = pool;
  ctx.beginPath();
  ctx.ellipse(cx, cy + size * 0.42, size * 0.55, size * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();

  // The rings: tilted ellipses, each two lines a little apart.
  const ry = size * 0.3;
  const rx = size * 0.2;
  const tilt = -0.42 * -dir;
  const ringAt = [
    { x: cx - size * 0.13, color: p.cyan },
    { x: cx + size * 0.13, color: p.violet },
  ];
  const ring = (x: number, from: number, to: number, color: string) => {
    for (const k of [1, 0.84]) {
      ctx.beginPath();
      ctx.ellipse(x, cy, rx * k, ry * k, tilt, from, to);
      neon(ctx, p, color, color, size * 0.024);
    }
  };
  const [first, second] = ringAt;
  if (first && second) {
    ring(first.x, 0, Math.PI * 2, first.color);
    ring(second.x, 0, Math.PI * 2, second.color);
    // The first ring passes back over the second: that's what interlocks them.
    ring(first.x, -0.55, 0.65, first.color);
  }

  // The arrow: a shaft of three lines, the outer two breaking into dashes
  // behind, and an open head.
  const x0 = cx - size * 0.62;
  const y0 = cy - dir * size * 0.3;
  const x1 = cx + size * 0.5;
  const y1 = cy + dir * size * 0.36;
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  const along = (t: number, off: number) => ({
    x: x0 + (x1 - x0) * t + nx * off,
    y: y0 + (y1 - y0) * t + ny * off,
  });
  const gap = size * 0.045;
  const line = (t0: number, t1: number, off: number, width: number) => {
    const a = along(t0, off);
    const b = along(t1, off);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    neon(ctx, p, sweep, p.cyan, width);
  };
  line(0.12, 0.86, 0, size * 0.02);
  line(0.34, 0.86, gap, size * 0.013);
  line(0.34, 0.86, -gap, size * 0.013);
  // The trail: broken lines and dashes, thinning out behind.
  for (const [t0, t1, off] of [
    [0.04, 0.12, 0],
    [0.16, 0.3, gap],
    [0.08, 0.13, gap],
    [0.2, 0.3, -gap],
    [0.0, 0.08, -gap * 2],
    [0.14, 0.22, gap * 2],
    [0.24, 0.32, -gap * 2.2],
  ] as const) {
    line(t0, t1, off, size * 0.011);
  }
  // The head, open: two strokes back from the tip, joined by a short base.
  const tip = along(1, 0);
  const head = size * 0.2;
  const wing = (s: number) => ({
    x: tip.x - head * Math.cos(angle) + nx * s * head * 0.62,
    y: tip.y - head * Math.sin(angle) + ny * s * head * 0.62,
  });
  const l = wing(1);
  const r = wing(-1);
  const neck = along(0.86, 0);
  ctx.beginPath();
  ctx.moveTo(neck.x + nx * gap * 1.2, neck.y + ny * gap * 1.2);
  ctx.lineTo(l.x, l.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(r.x, r.y);
  ctx.lineTo(neck.x - nx * gap * 1.2, neck.y - ny * gap * 1.2);
  neon(ctx, p, sweep, p.violet, size * 0.02);

  // Two small orbs, each with a thin ring round it.
  for (const [ox, oy, rad, color] of [
    [-size * 0.46, size * 0.08 * -dir, size * 0.03, p.cyan],
    [size * 0.3, -size * 0.02 * -dir, size * 0.036, p.violet],
  ] as const) {
    const ball = ctx.createRadialGradient(
      cx + ox - rad * 0.4,
      cy + oy - rad * 0.4,
      0,
      cx + ox,
      cy + oy,
      rad,
    );
    ball.addColorStop(0, alpha(ctx, p.text, 0.9));
    ball.addColorStop(0.5, alpha(ctx, color, 0.8));
    ball.addColorStop(1, alpha(ctx, color, 0.25));
    ctx.save();
    ctx.shadowColor = alpha(ctx, color, 0.9);
    ctx.shadowBlur = rad * 3;
    ctx.fillStyle = ball;
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(cx + ox, cy + oy, rad * 1.9, rad * 0.7, -0.3, 0, Math.PI * 2);
    ctx.strokeStyle = alpha(ctx, color, 0.55);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The "horizon" design's backdrop: a floor grid running in perspective to a
 * lit horizon, under a faint sky grid, all in the result's colour (green for
 * a profit, red for a loss). Every line a
 * hairline, so it stays sharp.
 */
function horizon(ctx: CanvasRenderingContext2D, p: Palette, w: number, h: number, tone: string) {
  const deep = darken(ctx, p.bg, 0.35);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, deep);
  sky.addColorStop(0.62, mix(ctx, p.bg, p.raised, 0.6));
  sky.addColorStop(1, deep);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const hy = h * 0.66;
  const vx = w * 0.72;
  // The glow along the horizon.
  const glow = ctx.createRadialGradient(vx, hy, 0, vx, hy, Math.max(w, h) * 0.6);
  glow.addColorStop(0, alpha(ctx, tone, 0.22));
  glow.addColorStop(0.4, alpha(ctx, tone, 0.06));
  glow.addColorStop(1, alpha(ctx, tone, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 0.75;
  // The sky: a square grid, fading upwards.
  const cell = Math.max(w, h) / 16;
  for (let x = (vx % cell) - cell; x <= w; x += cell) {
    const g = ctx.createLinearGradient(0, 0, 0, hy);
    g.addColorStop(0, alpha(ctx, tone, 0));
    g.addColorStop(1, alpha(ctx, tone, 0.1));
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, hy);
    ctx.stroke();
  }
  for (let y = hy - cell; y > 0; y -= cell) {
    ctx.strokeStyle = alpha(ctx, tone, 0.1 * (y / hy));
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
  }
  // The floor: lines from the vanishing point, and rows closing up towards it.
  for (let i = -14; i <= 14; i++) {
    const x = vx + i * cell * 1.6;
    const g = ctx.createLinearGradient(0, hy, 0, h);
    g.addColorStop(0, alpha(ctx, tone, 0.35));
    g.addColorStop(1, alpha(ctx, tone, 0.14));
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(vx, hy);
    ctx.lineTo(vx + (x - vx) * 6, h + (h - hy) * 5);
    ctx.stroke();
  }
  for (let k = 1; k < 14; k++) {
    const y = hy + (h - hy) * ((k * k) / 120);
    if (y > h) break;
    ctx.strokeStyle = alpha(ctx, tone, 0.06 + 0.12 * ((y - hy) / (h - hy)));
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
  }
  // The horizon itself: a bright line in the result's colour.
  const line = ctx.createLinearGradient(0, 0, w, 0);
  line.addColorStop(0, alpha(ctx, tone, 0));
  line.addColorStop(0.72, alpha(ctx, tone, 0.85));
  line.addColorStop(1, alpha(ctx, tone, 0.1));
  ctx.save();
  ctx.shadowColor = alpha(ctx, tone, 0.9);
  ctx.shadowBlur = 10;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(hy) + 0.5);
  ctx.lineTo(w, Math.round(hy) + 0.5);
  ctx.stroke();
  ctx.restore();
  const vignette = ctx.createRadialGradient(
    w * 0.4,
    h * 0.45,
    0,
    w * 0.4,
    h * 0.45,
    Math.max(w, h) * 0.8,
  );
  vignette.addColorStop(0, alpha(ctx, p.bg, 0));
  vignette.addColorStop(1, alpha(ctx, p.bg, 0.55));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

/** A tile's small line icon, top right: in, out, or the live mark. */
function priceIcon(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  kind: SharePrice["kind"],
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (kind === "entry") {
    // An arrow into a bracket.
    ctx.moveTo(x + 9, y + 1);
    ctx.lineTo(x + 14, y + 1);
    ctx.lineTo(x + 14, y + 15);
    ctx.lineTo(x + 9, y + 15);
    ctx.moveTo(x + 1, y + 8);
    ctx.lineTo(x + 10, y + 8);
    ctx.moveTo(x + 7, y + 5);
    ctx.lineTo(x + 10, y + 8);
    ctx.lineTo(x + 7, y + 11);
    ctx.stroke();
  } else if (kind === "exit") {
    // A padlock: the position is closed.
    ctx.arc(x + 8, y + 6, 4, Math.PI, 0);
    ctx.lineTo(x + 12, y + 8);
    ctx.moveTo(x + 4, y + 8);
    ctx.lineTo(x + 4, y + 6);
    ctx.stroke();
    roundRect(ctx, x + 2, y + 8, 12, 8, 2);
    ctx.fill();
  } else {
    // A pulse: the price is live.
    ctx.moveTo(x, y + 9);
    ctx.lineTo(x + 4, y + 9);
    ctx.lineTo(x + 6, y + 3);
    ctx.lineTo(x + 9, y + 15);
    ctx.lineTo(x + 11, y + 9);
    ctx.lineTo(x + 15, y + 9);
    ctx.stroke();
  }
  ctx.restore();
}

/** A tile for one of the two prices: label over value, its icon top right. */
function tile(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  y: number,
  w: number,
  h: number,
  price: SharePrice,
  font: (weight: number, size: number) => string,
) {
  ctx.save();
  ctx.shadowColor = alpha(ctx, p.bg, 0.6);
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = alpha(ctx, p.raised, 0.78);
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = alpha(ctx, p.pewter, 0.28);
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 12);
  ctx.stroke();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = p.pewter;
  ctx.font = font(500, 13);
  ctx.fillText(price.label, x + 16, y + 26);
  ctx.fillStyle = p.text;
  ctx.font = font(700, 21);
  ctx.fillText(price.value, x + 16, y + 53);
  priceIcon(ctx, p.brass, x + w - 30, y + 14, price.kind);
}

/** A pill in two halves, e.g. "Position: Short | Leverage: 10x"; returns its width. */
function positionPill(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  card: ShareCard,
  x: number,
  y: number,
  font: (weight: number, size: number) => string,
  measureOnly = false,
) {
  const h = 30;
  const pad = 12;
  ctx.font = font(500, 13.5);
  const parts = [card.position, card.leverage].filter(Boolean) as {
    label: string;
    value: string;
  }[];
  const widths = parts.map(
    (part) =>
      ctx.measureText(`${part.label}: `).width + ctx.measureText(part.value).width + pad * 2,
  );
  const total = widths.reduce((a, b) => a + b, 0);
  if (measureOnly) return total;
  const sideColor = card.side === "long" ? p.buy : p.sell;
  ctx.save();
  roundRect(ctx, x, y, total, h, h / 2);
  ctx.clip();
  // The side's half in its colour; leverage on the neutral ground.
  ctx.fillStyle = alpha(ctx, p.raised, 0.9);
  ctx.fillRect(x, y, total, h);
  const sideGrad = ctx.createLinearGradient(x, 0, x + (widths[0] ?? 0), 0);
  sideGrad.addColorStop(0, alpha(ctx, sideColor, 0.34));
  sideGrad.addColorStop(1, alpha(ctx, sideColor, 0.12));
  ctx.fillStyle = sideGrad;
  ctx.fillRect(x, y, widths[0] ?? 0, h);
  ctx.restore();
  ctx.strokeStyle = alpha(ctx, sideColor, 0.55);
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, total - 1, h - 1, h / 2);
  ctx.stroke();
  ctx.textBaseline = "middle";
  let px = x;
  parts.forEach((part, i) => {
    if (i > 0) {
      ctx.strokeStyle = alpha(ctx, p.text, 0.6);
      ctx.beginPath();
      ctx.moveTo(px, y + 8);
      ctx.lineTo(px, y + h - 8);
      ctx.stroke();
    }
    ctx.font = font(500, 13.5);
    ctx.fillStyle = p.text;
    const lead = `${part.label}: `;
    ctx.fillText(lead, px + pad, y + h / 2 + 0.5);
    ctx.fillStyle = i === 0 ? sideColor : p.brass;
    ctx.fillText(part.value, px + pad + ctx.measureText(lead).width, y + h / 2 + 0.5);
    px += widths[i] ?? 0;
  });
  ctx.textBaseline = "alphabetic";
  return total;
}

/** The art's width as a share of its size, its smallest size, and its gap from the figure. */
const ART_SPAN = 1.22;
const ART_MIN = 72;
const ART_GAP = 10;

/** Draws `card` on `canvas` at its layout's size, `scale` times over. */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  card: ShareCard,
  images: { brand?: HTMLImageElement; venue?: HTMLImageElement },
  slide: ShareSlide,
  layout: ShareLayout,
  scale = 2,
  style: ShareStyle = "slabs",
) {
  const { w, h } = SHARE_SIZE[layout];
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const p = palette();
  const portrait = layout === "portrait";
  const tone = card.profit ? p.buy : p.sell;
  const font = (weight: number, size: number) => `${weight} ${size}px ${p.font}`;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // The frame: a metal bezel, dark at the top and brass at the foot, where
  // the dates sit; the panel sits inside it.
  const outerR = 26;
  const rim = 10;
  const foot = portrait ? 54 : 42;
  const frame = ctx.createLinearGradient(0, 0, 0, h);
  frame.addColorStop(0, p.raised);
  frame.addColorStop(0.6, alpha(ctx, p.pewter, 0.55));
  frame.addColorStop(0.86, alpha(ctx, p.brass, 0.7));
  frame.addColorStop(1, alpha(ctx, p.brass, 0.85));
  ctx.fillStyle = p.bg;
  roundRect(ctx, 0, 0, w, h, outerR);
  ctx.fill();
  ctx.fillStyle = frame;
  roundRect(ctx, 0, 0, w, h, outerR);
  ctx.fill();
  // A highlight along the rim's inner and outer edges.
  ctx.strokeStyle = alpha(ctx, p.text, 0.18);
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, outerR);
  ctx.stroke();

  const px = rim;
  const py = rim;
  const pw = w - rim * 2;
  const ph = h - rim - foot;
  const innerR = 18;
  ctx.save();
  roundRect(ctx, px, py, pw, ph, innerR);
  ctx.clip();
  ctx.translate(px, py);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, pw, ph);
  if (style === "horizon") horizon(ctx, p, pw, ph, tone);
  else shards(ctx, p, pw, ph);
  ctx.restore();
  ctx.strokeStyle = alpha(ctx, p.pewter, 0.35);
  roundRect(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, innerR);
  ctx.stroke();

  const pad = portrait ? 22 : 26;
  const left = px + pad;
  const right = px + pw - pad;

  // Header: the wordmark, a divider, the venue in a pill, then the demo badge.
  const hy = py + pad + 2;
  let hx = left;
  ctx.textBaseline = "middle";
  const headH = 30;
  if (images.brand) {
    const bw = (images.brand.width / images.brand.height) * headH;
    ctx.drawImage(images.brand, hx, hy, bw, headH);
    // Again, added on top, to brighten it against the dark card (canvas
    // filters aren't dependable in every webview; additive blending is).
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.55;
    ctx.drawImage(images.brand, hx, hy, bw, headH);
    ctx.restore();
    hx += bw + 14;
  } else {
    ctx.fillStyle = p.text;
    ctx.font = font(700, 20);
    ctx.fillText("pewterdesk", hx, hy + headH / 2);
    hx += ctx.measureText("pewterdesk").width + 14;
  }
  ctx.strokeStyle = alpha(ctx, p.pewter, 0.45);
  ctx.beginPath();
  ctx.moveTo(hx + 0.5, hy + 3);
  ctx.lineTo(hx + 0.5, hy + headH - 3);
  ctx.stroke();
  hx += 14;
  ctx.font = font(600, 15);
  const venueH = 34;
  const vy = hy + headH / 2 - venueH / 2;
  const venueW = ctx.measureText(card.venue).width + (images.venue ? 50 : 26);
  ctx.fillStyle = alpha(ctx, p.raised, 0.85);
  roundRect(ctx, hx, vy, venueW, venueH, venueH / 2);
  ctx.fill();
  ctx.strokeStyle = alpha(ctx, p.pewter, 0.3);
  ctx.stroke();
  let vx = hx + 13;
  if (images.venue) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(vx + 11, hy + headH / 2, 11, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(images.venue, vx, hy + headH / 2 - 11, 22, 22);
    ctx.restore();
    vx += 30;
  }
  ctx.fillStyle = p.text;
  ctx.fillText(card.venue, vx, hy + headH / 2 + 0.5);
  hx += venueW + 8;
  if (card.demoLabel) {
    const text = card.demoLabel.toUpperCase();
    ctx.font = font(700, 10.5);
    const dw = ctx.measureText(text).width + 16;
    ctx.fillStyle = alpha(ctx, p.info, 0.14);
    roundRect(ctx, hx, hy + headH / 2 - 12, dw, 24, 12);
    ctx.fill();
    ctx.fillStyle = p.info;
    ctx.fillText(text, hx + 8, hy + headH / 2 + 0.5);
  }

  // The market, and the position pill beside it, or under it if there's no room.
  ctx.textBaseline = "alphabetic";
  const marketSize = portrait ? 32 : 34;
  let y = hy + headH + (portrait ? 50 : 48);
  ctx.fillStyle = p.text;
  ctx.font = font(800, marketSize);
  ctx.fillText(card.market, left, y);
  const mw = ctx.measureText(card.market).width;
  const pillW = positionPill(ctx, p, card, 0, 0, font, true);
  if (left + mw + 14 + pillW <= right) {
    positionPill(ctx, p, card, left + mw + 14, y - marketSize * 0.72 - 3, font);
  } else {
    y += 14;
    positionPill(ctx, p, card, left, y, font);
    y += 30;
  }

  // The figure, with a glow in its colour behind a crisp copy.
  const figure = slide === "roi" && card.roi ? card.roi : card.pnl;
  const other = slide === "roi" ? card.pnl : card.roi;
  y += portrait ? 38 : 34;
  ctx.fillStyle = p.pewter;
  ctx.font = font(500, 16);
  ctx.fillText(figure.label, left, y);
  // The art needs room beside the figure: a long figure shrinks it, then
  // the figure itself, rather than running off the card.
  let artSize = portrait ? 124 : 132;
  let figureSize = portrait ? 56 : 62;
  ctx.font = font(800, figureSize);
  let room = right - left - ctx.measureText(figure.value).width - ART_GAP;
  if (room < artSize * ART_SPAN) {
    artSize = Math.max(room / ART_SPAN, ART_MIN);
    if (room < ART_MIN * ART_SPAN) {
      figureSize *= (right - left - ART_GAP - ART_MIN * ART_SPAN) / (right - left - ART_GAP - room);
      ctx.font = font(800, figureSize);
      room = right - left - ctx.measureText(figure.value).width - ART_GAP;
    }
  }
  const fy = y + (portrait ? 66 : 64);
  ctx.save();
  ctx.shadowColor = alpha(ctx, tone, 0.7);
  ctx.shadowBlur = 26;
  ctx.fillStyle = alpha(ctx, tone, 0.9);
  ctx.fillText(figure.value, left - 2, fy);
  ctx.restore();
  ctx.fillStyle = tone;
  ctx.fillText(figure.value, left - 2, fy);
  const figureW = ctx.measureText(figure.value).width;

  // The art, right of the figure, and the other figure in a chip under it.
  const artX = Math.max(right - artSize * 0.62, left + figureW + ART_GAP + artSize * 0.6);
  const artY = fy - figureSize * 0.45;
  // The horizon design has no art: its grid is the picture.
  if (style === "slabs") art(ctx, p, artX, artY, artSize, card.profit);
  if (other) {
    ctx.font = font(500, 13.5);
    const lead = `${other.short}: `;
    const cw = ctx.measureText(lead).width + ctx.measureText(other.value).width + 26;
    const cx = Math.min(artX - cw / 2, right - cw);
    const cy = artY + artSize * 0.48;
    ctx.fillStyle = alpha(ctx, p.raised, 0.9);
    roundRect(ctx, cx, cy, cw, 28, 14);
    ctx.fill();
    ctx.strokeStyle = alpha(ctx, p.pewter, 0.35);
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.fillStyle = p.text;
    ctx.fillText(lead, cx + 13, cy + 14.5);
    ctx.fillStyle = tone;
    ctx.fillText(other.value, cx + 13 + ctx.measureText(lead).width, cy + 14.5);
    ctx.textBaseline = "alphabetic";
  }

  // The two prices in tiles.
  const tilesY = fy + (portrait ? 62 : 26);
  const gap = 14;
  const tileW = portrait ? (right - left - gap) / 2 : 176;
  const tileH = 68;
  card.prices.forEach((price, i) => {
    tile(ctx, p, left + i * (tileW + gap), tilesY, tileW, tileH, price, font);
  });

  // The foot of the frame: the date, and the mark.
  ctx.textAlign = "center";
  ctx.fillStyle = p.onBrass;
  const footTop = py + ph;
  if (card.footnote) {
    ctx.font = font(500, portrait ? 15 : 13.5);
    ctx.fillText(card.footnote, w / 2, footTop + (portrait ? 25 : 20));
  }
  ctx.globalAlpha = 0.7;
  ctx.font = font(500, portrait ? 11.5 : 10.5);
  ctx.fillText("© pewterdesk", w / 2, footTop + (portrait ? 42 : 34));
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}
