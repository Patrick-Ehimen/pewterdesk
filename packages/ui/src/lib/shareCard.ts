// The P&L share card, drawn on a canvas so the preview and the saved image
// are the same pixels. Colours come from the theme's --pd-* tokens at draw
// time; green and red only for the PnL itself and the side, brass for the
// glow and the accents.

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
  /** The side as shown, with leverage, e.g. "Short 10x". */
  sideLabel: string;
  /** The big figure on each slide, already formatted (e.g. "+14.17%"), and its label. */
  roi?: { label: string; value: string };
  pnl: { label: string; value: string };
  /** Whether the trade made money, for the figure's colour and the art. */
  profit: boolean;
  /** The two prices under the figure. */
  prices: [{ label: string; value: string }, { label: string; value: string }];
  /** Under the PewterDesk mark, e.g. a date. */
  footnote?: string;
  /** A "Demo" badge, when shown. */
  demoLabel?: string;
}

export type ShareSlide = "roi" | "pnl";
export type ShareLayout = "landscape" | "portrait";

/** The card's size in CSS pixels; saved at twice that. */
export const SHARE_SIZE: Record<ShareLayout, { w: number; h: number }> = {
  landscape: { w: 640, h: 340 },
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
 * PewterDesk's mark as a watermark: five pill bars forming a diamond, the
 * middle one brass (the brand's depth-ladder mark), large and soft-lit.
 */
function watermark(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  cx: number,
  cy: number,
  size: number,
) {
  const widths = [0.42, 0.72, 1, 0.72, 0.42];
  const bar = size * 0.13;
  const gap = size * 0.085;
  const total = widths.length * bar + (widths.length - 1) * gap;
  ctx.save();
  widths.forEach((wf, i) => {
    const w = size * wf;
    const y = cy - total / 2 + i * (bar + gap);
    const grad = ctx.createLinearGradient(cx - w / 2, y, cx + w / 2, y);
    if (i === 2) {
      grad.addColorStop(0, alpha(ctx, p.brass, 0.2));
      grad.addColorStop(0.5, alpha(ctx, p.brass, 0.75));
      grad.addColorStop(1, alpha(ctx, p.brass, 0.2));
    } else {
      grad.addColorStop(0, alpha(ctx, p.pewter, 0.06));
      grad.addColorStop(0.5, alpha(ctx, p.pewter, 0.22));
      grad.addColorStop(1, alpha(ctx, p.pewter, 0.06));
    }
    ctx.save();
    // The accent bar glows a little, so the mark reads as lit, not faded.
    if (i === 2) {
      ctx.shadowColor = alpha(ctx, p.brass, 0.45);
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = grad;
    roundRect(ctx, cx - w / 2, y, w, bar, bar / 2);
    ctx.fill();
    ctx.restore();
  });
  ctx.restore();
}

/** A tile for one of the two prices: label over value. */
function tile(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  font: (weight: number, size: number) => string,
) {
  const h = 58;
  ctx.fillStyle = alpha(ctx, p.raised, 0.7);
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.strokeStyle = alpha(ctx, p.border, 0.9);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = p.pewter;
  ctx.font = font(500, 11.5);
  ctx.fillText(label, x + 14, y + 22);
  ctx.fillStyle = p.text;
  ctx.font = font(700, 18);
  ctx.fillText(value, x + 14, y + 45);
}

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
  const radius = 22;

  // Backdrop: the base, lifted towards one corner, brass light from the
  // other, and a glow in the result's colour behind the figure.
  ctx.save();
  roundRect(ctx, 0, 0, w, h, radius);
  ctx.clip();
  // A near-flat dark base: quiet, so the mark and the figure carry the card.
  const base = ctx.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, alpha(ctx, p.raised, 0.55));
  base.addColorStop(1, p.bg);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  const brassLight = ctx.createRadialGradient(w, 0, 0, w, 0, Math.max(w, h) * 0.75);
  brassLight.addColorStop(0, alpha(ctx, p.brass, 0.08));
  brassLight.addColorStop(1, alpha(ctx, p.brass, 0));
  ctx.fillStyle = brassLight;
  ctx.fillRect(0, 0, w, h);
  const toneGlow = ctx.createRadialGradient(
    w * 0.12,
    h * (portrait ? 0.42 : 0.62),
    0,
    w * 0.12,
    h * (portrait ? 0.42 : 0.62),
    Math.max(w, h) * 0.55,
  );
  toneGlow.addColorStop(0, alpha(ctx, tone, 0.07));
  toneGlow.addColorStop(1, alpha(ctx, tone, 0));
  ctx.fillStyle = toneGlow;
  ctx.fillRect(0, 0, w, h);
  // The mark, large and faint, off to the side.
  // The mark, in the space the figures leave: right of them, or under them.
  if (portrait) watermark(ctx, p, w * 0.5, h * 0.76, 150);
  else watermark(ctx, p, w * 0.8, h * 0.52, 190);
  ctx.restore();
  // A hairline edge.
  ctx.strokeStyle = alpha(ctx, p.border, 1);
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, radius);
  ctx.stroke();

  const pad = portrait ? 28 : 32;

  // Header: the wordmark, then the venue in a pill, then the demo badge.
  const hy = pad;
  let hx = pad;
  ctx.textBaseline = "middle";
  if (images.brand) {
    // The wordmark, larger than the venue beside it: the card is PewterDesk's.
    const bh = 30;
    const bw = (images.brand.width / images.brand.height) * bh;
    ctx.drawImage(images.brand, hx, hy - 4, bw, bh);
    // Again, added on top, to brighten it against the dark card (canvas
    // filters aren't dependable in every webview; additive blending is).
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.55;
    ctx.drawImage(images.brand, hx, hy - 4, bw, bh);
    ctx.restore();
    hx += bw + 16;
  } else {
    ctx.fillStyle = p.text;
    ctx.font = font(700, 18);
    ctx.fillText("pewterdesk", hx, hy + 11);
    hx += ctx.measureText("pewterdesk").width + 14;
  }
  ctx.font = font(600, 13);
  const venueW = ctx.measureText(card.venue).width + (images.venue ? 36 : 20);
  ctx.fillStyle = alpha(ctx, p.raised, 0.85);
  roundRect(ctx, hx, hy - 2, venueW, 26, 13);
  ctx.fill();
  ctx.strokeStyle = alpha(ctx, p.border, 1);
  ctx.stroke();
  let vx = hx + 10;
  if (images.venue) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(vx + 8, hy + 11, 8, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(images.venue, vx, hy + 3, 16, 16);
    ctx.restore();
    vx += 22;
  }
  ctx.fillStyle = p.text;
  ctx.fillText(card.venue, vx, hy + 11.5);
  hx += venueW + 8;
  if (card.demoLabel) {
    const text = card.demoLabel.toUpperCase();
    ctx.font = font(700, 10.5);
    const dw = ctx.measureText(text).width + 16;
    ctx.fillStyle = alpha(ctx, p.info, 0.14);
    roundRect(ctx, hx, hy - 2, dw, 26, 13);
    ctx.fill();
    ctx.fillStyle = p.info;
    ctx.fillText(text, hx + 8, hy + 11.5);
  }

  // The market and its side.
  const marketY = hy + (portrait ? 78 : 74);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = p.text;
  ctx.font = font(700, 26);
  ctx.fillText(card.market, pad, marketY);
  const mw = ctx.measureText(card.market).width;
  ctx.font = font(700, 12);
  const sw = ctx.measureText(card.sideLabel).width + 18;
  const sideColor = card.side === "long" ? p.buy : p.sell;
  ctx.fillStyle = alpha(ctx, sideColor, 0.16);
  roundRect(ctx, pad + mw + 12, marketY - 20, sw, 24, 12);
  ctx.fill();
  ctx.fillStyle = sideColor;
  ctx.fillText(card.sideLabel, pad + mw + 21, marketY - 4);

  // The figure: crisp, no glow (a shadow behind text softens its edges).
  const figure = slide === "roi" && card.roi ? card.roi : card.pnl;
  const labelY = marketY + 34;
  ctx.fillStyle = p.pewter;
  ctx.font = font(600, 12);
  ctx.fillText(figure.label.toUpperCase(), pad, labelY);
  const figureSize = portrait ? 60 : 66;
  ctx.fillStyle = tone;
  ctx.font = font(800, figureSize);
  ctx.fillText(figure.value, pad - 2, labelY + figureSize + 6);

  // The two prices in tiles.
  const tilesY = labelY + figureSize + (portrait ? 36 : 30);
  const tileW = portrait ? (w - pad * 2 - 12) / 2 : 168;
  card.prices.forEach((price, i) => {
    tile(ctx, p, pad + i * (tileW + 12), tilesY, tileW, price.label, price.value, font);
  });

  // The date, quietly, at the foot.
  if (card.footnote) {
    ctx.fillStyle = p.dim;
    ctx.font = font(500, 11.5);
    ctx.textAlign = "right";
    ctx.fillText(card.footnote, w - pad, h - pad + 8);
    ctx.textAlign = "left";
  }
}
