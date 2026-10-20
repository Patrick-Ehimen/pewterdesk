// The analyst's answers as blocks the page draws as plain text: headings,
// paragraphs and lists, with **bold** and `code` spans. Nothing is read as
// HTML and nothing becomes a link.

export type Span = { kind: "text" | "bold" | "code"; text: string };

export type Block =
  | { kind: "heading"; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Span[][] };

/** A line's **bold** and `code` spans; unmatched markers stay as text. */
export function spansOf(line: string): Span[] {
  const out: Span[] = [];
  const push = (kind: Span["kind"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (kind === "text" && last?.kind === "text") last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  while (i < line.length) {
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
const HEADING = /^\s*#{1,6}\s+/;

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
      blocks.push({ kind: "heading", spans: spansOf(line.replace(HEADING, "")) });
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
