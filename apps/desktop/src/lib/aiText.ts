// The analyst's answers as blocks the page draws as plain text: headings,
// paragraphs and lists, with **bold** and `code` spans and [sN] citations.
// Nothing is read as HTML and nothing becomes a link: a citation is a
// number, which the page looks up in the answer's sources (Rust's own).

import type { AiSource } from "../api/venueClient";

export type Span =
  | { kind: "text" | "bold" | "code"; text: string }
  /** A citation: `n` of its `[sN]` tag. */
  | { kind: "cite"; n: number };

export type Block =
  /** `level` 1 to 6, as many `#` as it had. */
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Span[][] };

const CITE = /^\[s(\d{1,4})\]/;

/** A line's **bold** and `code` spans; unmatched markers stay as text. */
export function spansOf(line: string): Span[] {
  const out: Span[] = [];
  const push = (kind: "text" | "bold" | "code", text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (kind === "text" && last?.kind === "text") last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  while (i < line.length) {
    if (line[i] === "[") {
      const cite = CITE.exec(line.slice(i, i + 8));
      if (cite) {
        // The space before a citation goes with it, so "falls [s3]" draws as "falls³".
        const last = out[out.length - 1];
        if (last?.kind === "text") last.text = last.text.replace(/\s+$/, "");
        out.push({ kind: "cite", n: Number(cite[1]) });
        i += cite[0].length;
        continue;
      }
    }
    if (line.startsWith("**", i)) {
      const end = line.indexOf("**", i + 2);
      if (end > i + 2) {
        push("bold", line.slice(i + 2, end));
        i = end + 2;
        continue;
      }
    }
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end > i + 1) {
        push("code", line.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    push("text", line.charAt(i));
    i += 1;
  }
  return out;
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*(#{1,6})\s+/;

export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", spans: spansOf(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      const level = HEADING.exec(line)?.[1]?.length ?? 2;
      blocks.push({ kind: "heading", level, spans: spansOf(line.replace(HEADING, "")) });
      continue;
    }
    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      flush();
      const item = spansOf(line.replace(ordered ? NUMBERED : BULLET, ""));
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** A span's words, citations left out. */
export function plainOf(spans: readonly Span[]): string {
  return spans
    .map((s) => (s.kind === "cite" ? "" : s.text))
    .join("")
    .trim();
}

/** An answer laid out as the analyst was asked to: its TLDR, the rest, its bottom line. */
export interface Answer {
  tldr?: { lead: Span[]; points: Span[][] };
  /** Everything else, in order. */
  body: Block[];
  /** "**Bottom line:** ..." without its label. */
  bottom?: Span[];
}

const TLDR = /^tl;?dr\b/i;
const BOTTOM = /^bottom line\s*:?$/i;

/**
 * `text` as an answer: the blocks under a "TLDR" heading become its lead
 * sentence and points, and a paragraph opening with "**Bottom line:**" its
 * bottom line. An answer without them is all body.
 */
export function answerOf(text: string): Answer {
  const blocks = blocksOf(text);
  const answer: Answer = { body: [] };
  let i = 0;
  const first = blocks[0];
  if (first?.kind === "heading" && TLDR.test(plainOf(first.spans))) {
    const lead: Span[] = [];
    const points: Span[][] = [];
    i = 1;
    for (; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b || b.kind === "heading") break;
      if (b.kind === "paragraph")
        lead.push(...(lead.length ? [{ kind: "text" as const, text: " " }] : []), ...b.spans);
      else points.push(...b.items);
    }
    answer.tldr = { lead, points };
  }
  for (; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b) continue;
    if (b.kind === "paragraph" && !answer.bottom) {
      // The label can open its own paragraph or follow on in the last one.
      const at = b.spans.findIndex((x) => x.kind === "bold" && BOTTOM.test(x.text.trim()));
      if (at >= 0) {
        const before = b.spans.slice(0, at);
        const last = before[before.length - 1];
        if (last?.kind === "text")
          before[before.length - 1] = { kind: "text", text: last.text.trimEnd() };
        if (before.some((x) => x.kind !== "text" || x.text.trim())) {
          answer.body.push({ kind: "paragraph", spans: before });
        }
        const tail = b.spans.slice(at + 1);
        const head = tail[0];
        if (head?.kind === "text")
          tail[0] = { kind: "text", text: head.text.replace(/^\s*:?\s*/, "") };
        answer.bottom = tail;
        continue;
      }
    }
    answer.body.push(b);
  }
  return answer;
}

/**
 * An answer as text to paste anywhere: its own words, each citation as a
 * number, and the sources it cites listed under it by name (no links).
 */
export function copyText(text: string, sources: readonly AiSource[] = []): string {
  const order: number[] = [];
  const body = text.replace(/\s?\[s(\d{1,4})\]/g, (_, n: string) => {
    const tag = Number(n);
    if (!sources.some((s) => s.n === tag)) return "";
    if (!order.includes(tag)) order.push(tag);
    return ` [${order.indexOf(tag) + 1}]`;
  });
  if (order.length === 0) return body.trim();
  const listed = order.map((tag, i) => {
    const s = sources.find((x) => x.n === tag);
    return `[${i + 1}] ${s?.publisher ?? ""}${s?.title ? ` - ${s.title}` : ""}`;
  });
  return `${body.trim()}\n\n${listed.join("\n")}`;
}
