import { currentLocale, IconButton, t } from "@pewterdesk/ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LuCheck,
  LuCloud,
  LuCloudOff,
  LuHeading,
  LuList,
  LuListChecks,
  LuListOrdered,
  LuLoaderCircle,
  LuNotebookPen,
  LuPlus,
  LuSearch,
  LuTrash2,
  LuType,
  LuX,
} from "react-icons/lu";
import type { NotesSync } from "../../hooks/useNotes";
import {
  continueList,
  type Edit,
  type Format,
  lineMark,
  MAX_NOTE,
  type Note,
  newNote,
  notePreview,
  noteTitle,
  renumber,
  searchNotes,
  toggleCheck,
  toggleFormat,
} from "../../lib/notes";

const ICON = 16;

/** "3 min ago", "yesterday", in the app's language. */
function when(ms: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" });
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(s / 86_400), "day");
  return new Date(ms).toLocaleDateString(currentLocale(), { month: "short", day: "numeric" });
}

/**
 * The note's text drawn under the textarea, line for line in the same font,
 * so list marks and headings show in colour while the textarea does the
 * typing. Only colour and decoration differ: anything that changed a
 * character's width would put the caret in the wrong place.
 */
function Highlight({ text }: { text: string }) {
  const lines = text.split("\n");
  let titled = false;
  return (
    <>
      {lines.map((line, i) => {
        const m = lineMark(line);
        const isTitle = !titled && line.trim() !== "";
        if (isTitle) titled = true;
        let body: ReactNode = line;
        let cls = isTitle ? "title" : "";
        if (m) {
          const head = line.slice(0, m.indent.length + m.mark.length);
          const rest = line.slice(head.length);
          const done = m.kind === "check" && /\[[xX]\]/.test(m.mark);
          if (m.kind === "heading") cls = "heading";
          if (done) cls = `${cls} done`;
          body = (
            <>
              <span className={`mark ${m.kind}`}>{head}</span>
              <span className="body">{rest}</span>
            </>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no ids; the order is the identity
          <div key={i} className={cls || undefined}>
            {body}
            {line === "" ? "​" : null}
          </div>
        );
      })}
    </>
  );
}

const FORMATS: readonly { format: Format; icon: ReactNode; keys: string }[] = [
  { format: "heading", icon: <LuHeading size={14} aria-hidden />, keys: "⇧⌘1" },
  { format: "bullet", icon: <LuList size={14} aria-hidden />, keys: "⇧⌘8" },
  { format: "number", icon: <LuListOrdered size={14} aria-hidden />, keys: "⇧⌘7" },
  { format: "check", icon: <LuListChecks size={14} aria-hidden />, keys: "⇧⌘9" },
];
const FORMAT_KEYS: Record<string, Format> = {
  Digit1: "heading",
  Digit8: "bullet",
  Digit7: "number",
  Digit9: "check",
};

function SyncState({ sync }: { sync: NotesSync }) {
  switch (sync.state) {
    case "local":
      return (
        <span className="notes-sync" title={t("notepad.sync.localHint")}>
          <LuCloudOff size={13} aria-hidden />
          {t("notepad.sync.local")}
        </span>
      );
    case "syncing":
      return (
        <span className="notes-sync">
          <LuLoaderCircle size={13} aria-hidden className="notes-spin" />
          {t("notepad.sync.syncing")}
        </span>
      );
    case "synced":
      return (
        <span className="notes-sync">
          <LuCloud size={13} aria-hidden />
          {t("notepad.sync.synced")}
        </span>
      );
    case "error":
      return (
        <span className="notes-sync warn" title={t("notepad.sync.error", { error: sync.error })}>
          <LuCloudOff size={13} aria-hidden />
          {t("notepad.sync.error", { error: sync.error })}
        </span>
      );
  }
}

/**
 * The notes panel, beside the workspace (not over it: the chart stays in
 * reach). One note at a time, titled by its first line, with lists and
 * checklists as typed, or every note to pick from and search. It only
 * writes notes: nothing in it reaches an order or an account.
 */
/** The panel's size, kept on this machine; unset for the default. */
const SIZE_KEY = "pd.notes.size";
const MIN_W = 300;
const MIN_H = 320;
/** The space the panel can take: right of a margin, below the header, above the status bar. */
const room = () => ({ w: window.innerWidth - 28, h: window.innerHeight - 130 });

interface Size {
  w: number;
  h: number;
}

function loadSize(): Size | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as Partial<Size> | null;
    if (raw && typeof raw.w === "number" && typeof raw.h === "number")
      return { w: raw.w, h: raw.h };
  } catch {
    // Unreadable: the default size.
  }
  return undefined;
}

const withinRoom = (s: Size): Size => {
  const r = room();
  return {
    w: Math.round(Math.max(MIN_W, Math.min(r.w, s.w))),
    h: Math.round(Math.max(MIN_H, Math.min(r.h, s.h))),
  };
};

/**
 * The panel's size, dragged from its left edge, its bottom edge or the
 * corner between them (it's pinned at the top right). Kept on this
 * machine; a double-click on a handle puts it back to the default.
 */
function useResize() {
  const [size, setSize] = useState<Size | undefined>(loadSize);
  const drag = useRef<{ x: number; y: number; from: Size; edges: string }>(undefined);
  const panelRef = useRef<HTMLElement>(null);
  // A window made smaller since keeps the panel inside it.
  useEffect(() => {
    const onResize = () => setSize((s) => (s ? withinRoom(s) : s));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const keep = (s: Size | undefined) => {
    try {
      if (s) localStorage.setItem(SIZE_KEY, JSON.stringify(s));
      else localStorage.removeItem(SIZE_KEY);
    } catch {
      // Full or off: this session only.
    }
  };
  const handle = (edges: "w" | "s" | "sw") => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      const box = panelRef.current?.getBoundingClientRect();
      if (!box) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, from: { w: box.width, h: box.height }, edges };
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      // The left edge grows the panel leftwards; the bottom, downwards.
      const w = d.edges.includes("w") ? d.from.w + (d.x - e.clientX) : d.from.w;
      const h = d.edges.includes("s") ? d.from.h + (e.clientY - d.y) : d.from.h;
      setSize(withinRoom({ w, h }));
    },
    onPointerUp: () => {
      if (!drag.current) return;
      drag.current = undefined;
      setSize((s) => {
        keep(s);
        return s;
      });
    },
    onDoubleClick: () => {
      setSize(undefined);
      keep(undefined);
    },
  });
  return { size, panelRef, handle };
}

export function NotesPanel({
  notes,
  sync,
  onSave,
  onRemove,
  onClose,
}: {
  notes: readonly Note[];
  sync: NotesSync;
  onSave: (note: Note) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const [openId, setOpenId] = useState<string | undefined>(() => notes[0]?.id);
  const [listing, setListing] = useState(false);
  const [query, setQuery] = useState("");
  const [formatOpen, setFormatOpen] = useState(false);
  const [sure, setSure] = useState<string>();
  const { size, panelRef, handle } = useResize();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const shadeRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number>(undefined);

  const open = notes.find((n) => n.id === openId);
  // The note on screen; a fresh one until the first character is typed.
  const [draft, setDraft] = useState<Note>(() => open ?? newNote());
  const note = open ?? draft;

  // A note left empty is dropped when the panel moves on from it.
  const leave = () => {
    if (open && open.text.trim() === "") onRemove(open.id);
  };
  const startNew = () => {
    leave();
    const n = newNote();
    setDraft(n);
    setOpenId(n.id);
    setListing(false);
    requestAnimationFrame(() => areaRef.current?.focus());
  };
  const pick = (id: string) => {
    if (id !== openId) leave();
    setOpenId(id);
    setListing(false);
    requestAnimationFrame(() => areaRef.current?.focus());
  };

  useEffect(() => {
    if (!listing) areaRef.current?.focus();
  }, [listing]);
  useEffect(() => {
    if (pendingCaret.current !== undefined && areaRef.current) {
      areaRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = undefined;
    }
  });

  const write = (text: string) => {
    const capped = text.slice(0, MAX_NOTE);
    const next = { ...note, text: capped, updatedAt: Date.now() };
    if (!open) setDraft(next);
    // The first character puts a new note in the list.
    if (open || capped.trim() !== "") onSave(next);
    setOpenId(next.id);
  };
  const apply = (e: Edit | undefined) => {
    if (!e) return false;
    pendingCaret.current = e.caret;
    write(e.text);
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const area = e.currentTarget;
    const { selectionStart: from, selectionEnd: to, value } = area;
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && from === to) {
      if (apply(continueList(value, from))) e.preventDefault();
      return;
    }
    if (e.key === "Tab") {
      const start = value.lastIndexOf("\n", from - 1) + 1;
      if (
        lineMark(
          value.slice(
            start,
            value.indexOf("\n", from) === -1 ? undefined : value.indexOf("\n", from),
          ),
        )
      ) {
        e.preventDefault();
        if (e.shiftKey) {
          const strip = value.startsWith("  ", start) ? 2 : value.startsWith(" ", start) ? 1 : 0;
          if (strip) {
            const text = value.slice(0, start) + value.slice(start + strip);
            apply({ text: renumber(text, start), caret: Math.max(start, from - strip) });
          }
        } else {
          const text = `${value.slice(0, start)}  ${value.slice(start)}`;
          apply({ text: renumber(text, start + 2), caret: from + 2 });
        }
      }
      return;
    }
    const format = FORMAT_KEYS[e.code];
    if (format && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      apply(toggleFormat(value, from, to, format));
    }
  };

  const shown = useMemo(() => searchNotes(notes, query), [notes, query]);
  const chars = note.text.length;

  return (
    <aside
      ref={panelRef}
      className="notes-panel"
      aria-label={t("notepad.title")}
      style={size ? { width: size.w, height: size.h } : undefined}
    >
      <div className="notes-grip w" title={t("notepad.resize")} {...handle("w")} />
      <div className="notes-grip s" title={t("notepad.resize")} {...handle("s")} />
      <div className="notes-grip sw" title={t("notepad.resize")} {...handle("sw")} />
      <header className="notes-head">
        <LuNotebookPen size={ICON} aria-hidden className="notes-icon" />
        <h2>{listing ? t("notepad.all") : noteTitle(note.text) || t("notepad.title")}</h2>
        <IconButton
          label={listing ? t("notepad.back") : t("notepad.all")}
          pressed={listing}
          onClick={() => setListing((l) => !l)}
        >
          <LuList size={ICON} aria-hidden />
        </IconButton>
        <IconButton label={t("notepad.new")} onClick={startNew}>
          <LuPlus size={ICON} aria-hidden />
        </IconButton>
        <IconButton
          label={t("notepad.close")}
          onClick={() => {
            leave();
            onClose();
          }}
        >
          <LuX size={ICON} aria-hidden />
        </IconButton>
      </header>

      {listing ? (
        <div className="notes-list">
          <label className="notes-search">
            <LuSearch size={14} aria-hidden />
            <input
              // biome-ignore lint/a11y/noAutofocus: the list opens to be searched
              autoFocus
              value={query}
              placeholder={t("notepad.search")}
              aria-label={t("notepad.search")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) pick(shown[0].id);
                if (e.key === "Escape") setListing(false);
              }}
            />
          </label>
          <ul>
            {shown.map((n) => (
              <li key={n.id} className={n.id === note.id ? "on" : undefined}>
                <button type="button" className="notes-item" onClick={() => pick(n.id)}>
                  <b>{noteTitle(n.text) || t("notepad.untitled")}</b>
                  <span>{notePreview(n.text) || " "}</span>
                  <small>{when(n.updatedAt)}</small>
                </button>
                <button
                  type="button"
                  className={`notes-del${sure === n.id ? " sure" : ""}`}
                  aria-label={t("notepad.delete")}
                  title={t("notepad.delete")}
                  onBlur={() => setSure(undefined)}
                  onClick={() => {
                    if (sure !== n.id) return setSure(n.id);
                    setSure(undefined);
                    onRemove(n.id);
                    if (n.id === openId) setOpenId(undefined);
                  }}
                >
                  {sure === n.id ? t("notepad.deleteSure") : <LuTrash2 size={13} aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 && (
            <p className="notes-empty">{notes.length ? t("notepad.noMatch") : t("notepad.none")}</p>
          )}
        </div>
      ) : (
        <div className="notes-editor">
          <div className="notes-shade" ref={shadeRef} aria-hidden="true">
            <Highlight text={note.text} />
          </div>
          <textarea
            ref={areaRef}
            className="notes-area"
            value={note.text}
            placeholder={t("notepad.placeholder")}
            aria-label={t("notepad.title")}
            spellCheck
            onChange={(e) => write(e.target.value)}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              if (shadeRef.current) shadeRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onMouseUp={(e) => {
              // A click on a checklist's box ticks it.
              const area = e.currentTarget;
              const at = area.selectionStart;
              if (at !== area.selectionEnd) return;
              const start = area.value.lastIndexOf("\n", at - 1) + 1;
              const m = /^(\s*[-*]\s)\[[ xX]\]/.exec(area.value.slice(start));
              if (!m) return;
              const box = start + (m[1] ?? "").length;
              if (at >= box && at <= box + 3) apply(toggleCheck(area.value, at));
            }}
          />
        </div>
      )}

      <footer className="notes-foot">
        {listing ? (
          <span>{t("notepad.count", { n: notes.length })}</span>
        ) : (
          <span>
            {chars === 1
              ? t("notepad.char")
              : t("notepad.chars", { n: chars.toLocaleString("en-US") })}
          </span>
        )}
        <SyncState sync={sync} />
        {!listing && (
          <span className="notes-tools">
            {formatOpen && (
              <span className="notes-formats" role="toolbar" aria-label={t("notepad.format")}>
                {FORMATS.map((f) => (
                  <button
                    key={f.format}
                    type="button"
                    title={`${t(`notepad.fmt.${f.format}`)}  ${f.keys}`}
                    aria-label={t(`notepad.fmt.${f.format}`)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      const a = areaRef.current;
                      apply(
                        toggleFormat(
                          note.text,
                          a?.selectionStart ?? note.text.length,
                          a?.selectionEnd ?? note.text.length,
                          f.format,
                        ),
                      );
                      a?.focus();
                    }}
                  >
                    {f.icon}
                  </button>
                ))}
              </span>
            )}
            <IconButton
              label={t("notepad.format")}
              pressed={formatOpen}
              onClick={() => setFormatOpen((o) => !o)}
            >
              <LuType size={15} aria-hidden />
            </IconButton>
            {open && (
              <IconButton
                label={sure === open.id ? t("notepad.deleteSure") : t("notepad.delete")}
                pressed={sure === open.id}
                onClick={() => {
                  if (sure !== open.id) return setSure(open.id);
                  setSure(undefined);
                  onRemove(open.id);
                  const next = notes.find((n) => n.id !== open.id);
                  setOpenId(next?.id);
                  if (!next) setDraft(newNote());
                }}
              >
                {sure === open.id ? (
                  <LuCheck size={15} aria-hidden />
                ) : (
                  <LuTrash2 size={15} aria-hidden />
                )}
              </IconButton>
            )}
          </span>
        )}
      </footer>
    </aside>
  );
}
