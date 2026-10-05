// The P&L share card, drawn on a canvas so the preview and the saved image
// are the same pixels. Colours come from the theme's --pd-* tokens at draw
// time; green and red only for the PnL, the side and the result's art, brass
// for the frame and the accents.

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
  font: string;
}

function palette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    bg: v("--pd-bg"),
    raised: v("--pd-surface-raised"),
    border: v("--pd-border"),
    text: v("--pd-text"),
    pewter: v("--pd-pewter"),
    dim: v("--pd-pewter-dim"),
    brass: v("--pd-brass"),
    buy: v("--pd-buy"),
    sell: v("--pd-sell"),
    info: v("--pd-info"),
    onBrass: v("--pd-on-brass"),
    font: getComputedStyle(document.body).fontFamily || "sans-serif",
  };
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

/**
 * The panel's backdrop: large dark shards at angles, each lit a little along
 * one edge, after the faceted stone of the design. Fixed positions, so every
 * card is the same art.
 */
const SHARDS: readonly [number, number, number, number, number, number][] = [
  // cx, cy, w, h (fractions of the panel), angle (deg), lift (0-1)
  [0.08, 0.1, 0.5, 0.34, 38, 0.55],
  [0.62, 0.02, 0.46, 0.3, -24, 0.35],
  [1.02, 0.28, 0.42, 0.5, 44, 0.6],
  [0.32, 0.42, 0.56, 0.3, -38, 0.3],
  [0.82, 0.62, 0.5, 0.36, 30, 0.45],
  [0.12, 0.72, 0.44, 0.42, 48, 0.5],
  [0.52, 0.9, 0.62, 0.3, -18, 0.25],
  [0.98, 0.98, 0.4, 0.3, 40, 0.4],
  [-0.06, 0.4, 0.3, 0.5, -12, 0.35],
];

function shards(ctx: CanvasRenderingContext2D, p: Palette, w: number, h: number) {
  const unit = Math.max(w, h);
  for (const [fx, fy, fw, fh, deg, lift] of SHARDS) {
    const sw = fw * unit;
    const sh = fh * unit;
    ctx.save();
    ctx.translate(fx * w, fy * h);
    ctx.rotate((deg * Math.PI) / 180);
    const grad = ctx.createLinearGradient(0, -sh / 2, 0, sh / 2);
    grad.addColorStop(0, alpha(ctx, p.raised, 0.25 + lift * 0.45));
    grad.addColorStop(1, alpha(ctx, p.bg, 0.6));
    ctx.fillStyle = grad;
    ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
    // The lit edge, and a darker one opposite: what makes it read as a facet.
    ctx.strokeStyle = alpha(ctx, p.pewter, 0.05 + lift * 0.1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-sw / 2, -sh / 2);
    ctx.lineTo(sw / 2, -sh / 2);
    ctx.stroke();
    ctx.strokeStyle = alpha(ctx, p.bg, 0.8);
    ctx.beginPath();
    ctx.moveTo(-sw / 2, sh / 2);
    ctx.lineTo(sw / 2, sh / 2);
    ctx.stroke();
    ctx.restore();
  }
  // Darker towards the edges, so the text in the middle sits on calm ground.
  const vignette = ctx.createRadialGradient(w * 0.4, h * 0.4, 0, w * 0.4, h * 0.4, unit * 0.8);
  vignette.addColorStop(0, alpha(ctx, p.bg, 0));
  vignette.addColorStop(1, alpha(ctx, p.bg, 0.55));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

/**
 * The result's art: two interlocked rings and an arrow through them, lit in
 * the result's colour (up and to the right for a profit, down for a loss),
 * with a brass ring for the accent.
 */
function art(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  cx: number,
  cy: number,
  size: number,
  tone: string,
  up: boolean,
) {
  const glow = (color: string, blur: number) => {
    ctx.shadowColor = alpha(ctx, color, 0.8);
    ctx.shadowBlur = blur;
  };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // A soft pool of light under it.
  const pool = ctx.createRadialGradient(cx, cy + size * 0.38, 0, cx, cy + size * 0.38, size * 0.6);
  pool.addColorStop(0, alpha(ctx, tone, 0.22));
  pool.addColorStop(1, alpha(ctx, tone, 0));
  ctx.fillStyle = pool;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);
  // The rings, tilted, each drawn twice: a glow, then a bright core.
  const rings: [number, string][] = [
    [-size * 0.16, tone],
    [size * 0.16, p.brass],
  ];
  for (const [dx, color] of rings) {
    for (const [width, a, blur] of [
      [3.2, 0.55, 16],
      [1.4, 1, 0],
    ] as const) {
      ctx.save();
      if (blur) glow(color, blur);
      ctx.strokeStyle = alpha(ctx, color, a);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.ellipse(cx + dx, cy, size * 0.2, size * 0.3, -0.35, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  // The arrow through them, with a dashed trail behind.
  const dir = up ? -1 : 1;
  const x0 = cx - size * 0.55;
  const y0 = cy - dir * size * 0.32;
  const x1 = cx + size * 0.5;
  const y1 = cy + dir * size * 0.34;
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const head = size * 0.13;
  for (const [width, a, blur] of [
    [5, 0.5, 18],
    [2, 1, 0],
  ] as const) {
    ctx.save();
    if (blur) glow(tone, blur);
    ctx.strokeStyle = alpha(ctx, tone, a);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.3);
    ctx.lineTo(x1, y1);
    ctx.moveTo(x1 - head * Math.cos(angle - 0.5), y1 - head * Math.sin(angle - 0.5));
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(angle + 0.5), y1 - head * Math.sin(angle + 0.5));
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = alpha(ctx, tone, 0.55);
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 5]);
  for (const off of [-6, 6]) {
    const ox = -Math.sin(angle) * off;
    const oy = Math.cos(angle) * off;
    ctx.beginPath();
    ctx.moveTo(x0 + ox, y0 + oy);
    ctx.lineTo(x0 + (x1 - x0) * 0.3 + ox, y0 + (y1 - y0) * 0.3 + oy);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // Two small orbs, as in the design.
  for (const [ox, oy, r] of [
    [-size * 0.42, size * 0.12, 3],
    [size * 0.4, -size * 0.06 * dir, 4],
  ] as const) {
    ctx.save();
    glow(tone, 8);
    ctx.fillStyle = alpha(ctx, tone, 0.7);
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
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
  shards(ctx, p, pw, ph);
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
  let artSize = portrait ? 104 : 128;
  let figureSize = portrait ? 64 : 62;
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
  art(ctx, p, artX, artY, artSize, tone, card.profit);
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
