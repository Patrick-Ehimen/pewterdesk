// An answer from PewterDesk AI as a share card: the question, the answer's
// TLDR and its points, drawn on a canvas so the preview and the saved image
// are the same pixels. Colours are the P&L card's (`sharePalette`: the dark
// set, read from the --pd-* tokens), brass - the one accent - for the
// accents and the glow. Text only: no links, and nothing of the account.

import type { SharePalette } from "@pewterdesk/ui";

export interface AiShareCard {
  question: string;
  /** The TLDR's sentence (or the answer's opening, without one). */
  lead: string;
  /** The TLDR's points, at most four shown. */
  points: string[];
  /** Over the answer: "TLDR". */
  label: string;
  /** Under it: the model and the date. */
  footer: string;
  /** "Not financial advice", in the trader's language. */
  disclaimer: string;
}

/** The card's width in CSS pixels; its height follows the text. */
export const AI_CARD_WIDTH = 720;
/** Saved at this many pixels per CSS pixel. */
export const AI_CARD_EXPORT_SCALE = 2;

const PAD = 40;
const MAX_POINTS = 4;

function rgba(ctx: CanvasRenderingContext2D, color: string, a: number): string {
  ctx.save();
  ctx.fillStyle = color;
  const parsed = ctx.fillStyle;
  ctx.restore();
  if (parsed.startsWith("#") && parsed.length === 7) {
    const n = Number.parseInt(parsed.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return parsed.replace(/rgba?\(([^)]+)\)/, (_, inner: string) => {
    const [r, g, b] = inner.split(",").map((x) => x.trim());
    return `rgba(${r}, ${g}, ${b}, ${a})`;
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

/** `text` in lines no wider than `width`, at most `max`, the last cut with "…". */
export function wrapLines(
  measure: (text: string) => number,
  text: string,
  width: number,
  max: number,
): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= width || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === max) break;
  }
  if (lines.length < max && line) lines.push(line);
  const used = lines.join(" ").split(" ").filter(Boolean).length;
  if (used < words.length && lines.length > 0) {
    let last = lines[lines.length - 1] ?? "";
    while (last && measure(`${last}…`) > width) last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

interface Layout {
  question: string[];
  lead: string[];
  points: string[][];
  height: number;
}

const FONT = {
  question: (f: string) => `600 23px ${f}`,
  label: (f: string) => `700 12px ${f}`,
  lead: (f: string) => `500 17px ${f}`,
  point: (f: string) => `400 15px ${f}`,
  badge: (f: string) => `700 12px ${f}`,
  foot: (f: string) => `500 12px ${f}`,
};
const LINE = { question: 31, lead: 25, point: 22 };
const HEADER = 34;
const BOX_PAD = 22;
const BADGE = 22;

function layout(ctx: CanvasRenderingContext2D, card: AiShareCard, font: string): Layout {
  const inner = AI_CARD_WIDTH - PAD * 2;
  const boxInner = inner - BOX_PAD * 2;
  const measure = (f: string) => (text: string) => {
    ctx.font = f;
    return ctx.measureText(text).width;
  };
  const question = wrapLines(measure(FONT.question(font)), card.question, inner, 3);
  const lead = wrapLines(measure(FONT.lead(font)), card.lead, boxInner, 5);
  const points = card.points
    .slice(0, MAX_POINTS)
    .map((p) => wrapLines(measure(FONT.point(font)), p, boxInner - BADGE - 12, 3));
  let height = PAD + HEADER + 22 + question.length * LINE.question + 22;
  // The TLDR box: its label, the lead, the points.
  let box = BOX_PAD + 18 + 10 + lead.length * LINE.lead;
  for (const p of points) box += 14 + Math.max(BADGE, p.length * LINE.point);
  box += BOX_PAD;
  height += box + 26 + 18 + PAD;
  return { question, lead, points, height };
}

/** Draws `card` on `canvas` at `scale` pixels per CSS pixel; returns its CSS height. */
export function drawAiShareCard(
  canvas: HTMLCanvasElement,
  card: AiShareCard,
  p: SharePalette,
  brand: HTMLImageElement | undefined,
  scale: number,
): number {
  const probe = canvas.getContext("2d");
  if (!probe) return 0;
  const font = p.font;
  const plan = layout(probe, card, font);
  const w = AI_CARD_WIDTH;
  const h = plan.height;
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return h;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = "alphabetic";

  // The ground: the dark set, a brass glow at the top right and a fainter
  // one at the bottom left.
  ctx.fillStyle = p.bg;
  roundRect(ctx, 0, 0, w, h, 24);
  ctx.fill();
  ctx.save();
  roundRect(ctx, 0, 0, w, h, 24);
  ctx.clip();
  const glow = (x: number, y: number, r: number, color: string, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(ctx, color, a));
    g.addColorStop(1, rgba(ctx, color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  glow(w * 0.92, 0, w * 0.75, p.brass, 0.28);
  glow(0, h, w * 0.7, p.brass, 0.1);
  ctx.restore();
  ctx.strokeStyle = rgba(ctx, p.pewter, 0.28);
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 24);
  ctx.stroke();

  // The header: the wordmark, and "AI" in a brass pill.
  let y = PAD;
  let x = PAD;
  if (brand) {
    const bh = 24;
    const bw = (brand.naturalWidth / Math.max(1, brand.naturalHeight)) * bh;
    ctx.drawImage(brand, x, y + (HEADER - bh) / 2, bw, bh);
    x += bw + 12;
  }
  ctx.font = FONT.badge(font);
  const pill = ctx.measureText("AI").width + 18;
  ctx.fillStyle = p.brass;
  roundRect(ctx, x, y + (HEADER - 22) / 2, pill, 22, 11);
  ctx.fill();
  ctx.fillStyle = p.onBrass;
  ctx.textAlign = "center";
  ctx.fillText("AI", x + pill / 2, y + HEADER / 2 + 4);
  ctx.textAlign = "left";
  y += HEADER + 22;

  // The question.
  ctx.font = FONT.question(font);
  ctx.fillStyle = p.text;
  for (const line of plan.question) {
    y += LINE.question - 7;
    ctx.fillText(line, PAD, y);
    y += 7;
  }
  y += 22;

  // The TLDR: a box washed brass, strong to faint, its label, its sentence, its points.
  const boxTop = y;
  const boxH = plan.height - boxTop - 26 - 18 - PAD;
  const wash = ctx.createLinearGradient(PAD, boxTop, w - PAD, boxTop + boxH);
  wash.addColorStop(0, rgba(ctx, p.brass, 0.2));
  wash.addColorStop(1, rgba(ctx, p.brass, 0.04));
  ctx.fillStyle = rgba(ctx, p.raised, 0.85);
  roundRect(ctx, PAD, boxTop, w - PAD * 2, boxH, 16);
  ctx.fill();
  ctx.fillStyle = wash;
  roundRect(ctx, PAD, boxTop, w - PAD * 2, boxH, 16);
  ctx.fill();
  ctx.strokeStyle = rgba(ctx, p.brass, 0.5);
  roundRect(ctx, PAD + 0.5, boxTop + 0.5, w - PAD * 2 - 1, boxH - 1, 16);
  ctx.stroke();

  const bx = PAD + BOX_PAD;
  y = boxTop + BOX_PAD + 12;
  ctx.font = FONT.label(font);
  ctx.fillStyle = p.brass;
  ctx.fillText(card.label.toUpperCase(), bx, y);
  y += 16;
  ctx.font = FONT.lead(font);
  ctx.fillStyle = p.text;
  for (const line of plan.lead) {
    y += LINE.lead - 6;
    ctx.fillText(line, bx, y);
    y += 6;
  }
  plan.points.forEach((lines, i) => {
    y += 14;
    const top = y;
    ctx.fillStyle = rgba(ctx, p.brass, 0.22);
    ctx.beginPath();
    ctx.arc(bx + BADGE / 2, top + BADGE / 2, BADGE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.brass;
    ctx.font = FONT.badge(font);
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), bx + BADGE / 2, top + BADGE / 2 + 4);
    ctx.textAlign = "left";
    ctx.font = FONT.point(font);
    ctx.fillStyle = rgba(ctx, p.text, 0.92);
    let ly = top;
    for (const line of lines) {
      ly += LINE.point - 5;
      ctx.fillText(line, bx + BADGE + 12, ly + 1);
      ly += 5;
    }
    y = top + Math.max(BADGE, lines.length * LINE.point);
  });

  // The foot: the model and date, and the disclaimer.
  const foot = plan.height - PAD + 4;
  ctx.font = FONT.foot(font);
  ctx.fillStyle = p.pewter;
  ctx.fillText(card.footer, PAD, foot);
  ctx.textAlign = "right";
  ctx.fillStyle = p.dim;
  ctx.fillText(card.disclaimer, w - PAD, foot);
  ctx.textAlign = "left";
  return h;
}
