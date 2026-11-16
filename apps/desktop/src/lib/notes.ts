/**
 * The notes panel's notes: the trader's own free text, kept on this machine
 * and, signed in, in PewterDesk Cloud (`notes`). Plain logic, no React.
 */

export interface Note {
  /** A uuid, so the cloud can keep it under the same id. */
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** The most a note holds: well inside the cloud's 256 KB a row. */
export const MAX_NOTE = 100_000;

export const newNoteId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (Math.floor(Math.random() * 16) >> (Number(c) / 4))).toString(16),
      );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newNote(now = Date.now()): Note {
  return { id: newNoteId(), text: "", createdAt: now, updatedAt: now };
}

/** A note from storage or the cloud, or nothing if it isn't one. */
export function restoreNote(id: unknown, data: unknown): Note | undefined {
  if (typeof id !== "string" || !UUID.test(id)) return undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.text !== "string") return undefined;
  const num = (v: unknown, or: number) => (typeof v === "number" && Number.isFinite(v) ? v : or);
  const updatedAt = num(d.updatedAt, 0);
  return {
    id,
    text: d.text.slice(0, MAX_NOTE),
    createdAt: num(d.createdAt, updatedAt),
    updatedAt,
  };
}

/** A note's title: its first line that has words, without list or heading marks. */
export function noteTitle(text: string): string {
  for (const line of text.split("\n")) {
    const words = line
      .replace(/^\s*(#{1,6}\s+|[-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+[.)]\s+|>\s+)/, "")
      .trim();
    if (words) return words.length > 80 ? `${words.slice(0, 79)}…` : words;
  }
  return "";
}

/** The text after the title, in one line, for the list. */
export function notePreview(text: string): string {
  const title = noteTitle(text);
  const at = title ? text.indexOf(title.replace(/…$/, "")) : -1;
  const rest = at === -1 ? text : text.slice(at + title.length);
  return rest
    .split("\n")
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+[.)]\s+|>\s+)/, "").trim())
    .filter(Boolean)
    .join(" · ")
    .slice(0, 120);
}

/** Newest change first. */
export const byRecent = (a: Note, b: Note) => b.updatedAt - a.updatedAt;

/** Notes whose text holds every word of `query`, case ignored. */
export function searchNotes(notes: readonly Note[], query: string): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...notes];
  return notes.filter((n) => {
    const text = n.text.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

// --- Lists and headings, as typed -----------------------------------------

/** What starts a line: a list's mark, a heading's, a quote's, and the indent before it. */
export interface LineMark {
  indent: string;
  kind: "number" | "bullet" | "check" | "heading" | "quote";
  /** The mark as typed, with its space: "1. ", "- ", "- [ ] ", "## ". */
  mark: string;
  /** For a numbered line, its number. */
  n?: number;
}

export function lineMark(line: string): LineMark | undefined {
  let m = /^(\s*)(\d+)([.)])\s/.exec(line);
  if (m)
    return {
      indent: m[1] ?? "",
      kind: "number",
      mark: m[0].slice((m[1] ?? "").length),
      n: Number(m[2]),
    };
  m = /^(\s*)([-*])\s\[([ xX])\]\s/.exec(line);
  if (m) return { indent: m[1] ?? "", kind: "check", mark: m[0].slice((m[1] ?? "").length) };
  m = /^(\s*)([-*])\s/.exec(line);
  if (m) return { indent: m[1] ?? "", kind: "bullet", mark: m[0].slice((m[1] ?? "").length) };
  m = /^(#{1,3})\s/.exec(line);
  if (m) return { indent: "", kind: "heading", mark: m[0] };
  m = /^(\s*)>\s/.exec(line);
  if (m) return { indent: m[1] ?? "", kind: "quote", mark: m[0].slice((m[1] ?? "").length) };
  return undefined;
}

/** A text edit: the new text and where the caret goes. */
export interface Edit {
  text: string;
  caret: number;
}

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end;
};

/**
 * Enter inside a list: the next line gets the next mark ("2. ", "- ",
 * "- [ ] "); Enter on an empty item ends the list instead. Nothing (undefined)
 * where Enter should just break the line.
 */
export function continueList(text: string, caret: number): Edit | undefined {
  const start = lineStart(text, caret);
  const line = text.slice(start, lineEnd(text, caret));
  const mark = lineMark(line);
  if (!mark || mark.kind === "heading") return undefined;
  const body = line.slice(mark.indent.length + mark.mark.length);
  if (body.trim() === "" && caret >= start + mark.indent.length + mark.mark.length) {
    // An empty item: the mark goes, and the list ends here.
    const out = text.slice(0, start) + text.slice(start + line.length);
    return { text: out, caret: start };
  }
  const next =
    mark.kind === "number"
      ? mark.mark.replace(/^\d+/, String((mark.n ?? 0) + 1))
      : mark.kind === "check"
        ? mark.mark.replace(/\[[xX]\]/, "[ ]")
        : mark.mark;
  const insert = `\n${mark.indent}${next}`;
  const out = text.slice(0, caret) + insert + text.slice(caret);
  return { text: renumber(out, caret + insert.length), caret: caret + insert.length };
}

/**
 * Numbered lines that follow one another at the same indent, numbered again
 * from the first one's number, around `at`.
 */
export function renumber(text: string, at: number): string {
  const lines = text.split("\n");
  let pos = 0;
  let row = 0;
  for (; row < lines.length; row++) {
    const len = (lines[row] ?? "").length + 1;
    if (pos + len > at) break;
    pos += len;
  }
  const here = lineMark(lines[row] ?? "");
  if (here?.kind !== "number") return text;
  const same = (i: number) => {
    const m = lineMark(lines[i] ?? "");
    return m?.kind === "number" && m.indent === here.indent;
  };
  let first = row;
  while (first > 0 && same(first - 1)) first--;
  let n = lineMark(lines[first] ?? "")?.n ?? 1;
  for (let i = first; i < lines.length && same(i); i++) {
    lines[i] = (lines[i] ?? "").replace(/^(\s*)\d+/, `$1${n}`);
    n++;
  }
  return lines.join("\n");
}

export type Format = "heading" | "bullet" | "number" | "check";

/**
 * The selected lines (or the caret's) turned into a list or heading, or
 * back to plain text when every one of them already is that.
 */
export function toggleFormat(text: string, from: number, to: number, format: Format): Edit {
  const start = lineStart(text, from);
  const end = lineEnd(text, Math.max(from, to));
  const lines = text.slice(start, end).split("\n");
  const kind = format === "heading" ? "heading" : format;
  const all = lines.every((l) => lineMark(l)?.kind === kind || l.trim() === "");
  let n = 0;
  const out = lines.map((l) => {
    const m = lineMark(l);
    const indent = m?.indent ?? /^\s*/.exec(l)?.[0] ?? "";
    const body = m ? l.slice(indent.length + m.mark.length) : l.slice(indent.length);
    if (all) return `${indent}${body}`;
    if (l.trim() === "" && lines.length > 1) return l;
    n++;
    const mark =
      format === "heading"
        ? "## "
        : format === "bullet"
          ? "- "
          : format === "check"
            ? "- [ ] "
            : `${n}. `;
    return `${format === "heading" ? "" : indent}${mark}${body}`;
  });
  const joined = out.join("\n");
  const next = text.slice(0, start) + joined + text.slice(end);
  return { text: next, caret: start + joined.length };
}

/** Ticks or unticks the checklist item on the line holding `at`. */
export function toggleCheck(text: string, at: number): Edit | undefined {
  const start = lineStart(text, at);
  const line = text.slice(start, lineEnd(text, at));
  const m = /^(\s*[-*]\s\[)([ xX])(\]\s)/.exec(line);
  if (!m) return undefined;
  const ticked = m[2] !== " ";
  const at2 = start + (m[1] ?? "").length;
  return { text: text.slice(0, at2) + (ticked ? " " : "x") + text.slice(at2 + 1), caret: at };
}

// --- Keeping the two copies together ---------------------------------------

/**
 * This machine's notes and the cloud's as one list: for a note on both, the
 * later change wins; one only here is kept to go up; one only in the cloud
 * is taken unless it was deleted here (`deleted`, its id).
 */
export function mergeNotes(
  local: readonly Note[],
  cloud: readonly Note[],
  deleted: ReadonlySet<string>,
): { notes: Note[]; toPush: Note[] } {
  const byId = new Map<string, Note>();
  for (const n of cloud) if (!deleted.has(n.id)) byId.set(n.id, n);
  const toPush: Note[] = [];
  for (const n of local) {
    const there = byId.get(n.id);
    if (!there || n.updatedAt > there.updatedAt) {
      byId.set(n.id, n);
      toPush.push(n);
    }
  }
  return { notes: [...byId.values()].sort(byRecent), toPush };
}
