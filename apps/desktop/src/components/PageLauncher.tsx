import { t } from "@pewterdesk/ui";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { LuChevronDown, LuCornerDownLeft, LuSearch } from "react-icons/lu";
import { keyLabel, onMac } from "../lib/hotkeys";
import { MENU_PAGES, type Page, SHORTCUT_PAGES } from "../lib/pages";
import { PageIcon, pageLabel } from "./preferences";

/** The pages in three kinds of work, each a column. */
const GROUPS = [
  { key: "trade", pages: ["trade", "charts", "screener", "maps", "venues"] },
  { key: "research", pages: ["news", "ai", "traders", "ideas"] },
  { key: "prepare", pages: ["plan", "rules", "backtest", "bots"] },
] as const satisfies readonly { key: string; pages: readonly Page[] }[];

const GAP = 6;

/**
 * The header's page menu: the pages in three columns by the kind of work
 * (trade, research, prepare), each with its icon and its Cmd/Ctrl key, a
 * search that narrows them as it's typed, and one line at the foot saying
 * what the page under the pointer or the keys is for.
 */
export function PageLauncher({ page, onChange }: { page: Page; onChange: (p: Page) => void }) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [lit, setLit] = useState<Page>(page);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const mac = useMemo(() => onMac(), []);

  // Every page the menu has, so a new one shows even before it's grouped.
  const groups = useMemo(() => {
    const placed = new Set<Page>(GROUPS.flatMap((g) => g.pages));
    const rest = MENU_PAGES.filter((p) => !placed.has(p));
    return GROUPS.map((g, i) => ({
      key: g.key,
      pages: [...g.pages, ...(i === 0 ? rest : [])].filter((p) => MENU_PAGES.includes(p)),
    }));
  }, []);

  const q = query.trim().toLowerCase();
  const matches = (p: Page) =>
    !q ||
    pageLabel(p).toLowerCase().includes(q) ||
    t(`nav.${p as Exclude<Page, "settings">}Desc`)
      .toLowerCase()
      .includes(q);
  const shown = groups.map((g) => ({ ...g, pages: g.pages.filter(matches) }));
  const flat = shown.flatMap((g) => g.pages);
  const litPage = flat.includes(lit) ? lit : flat[0];

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPosition(undefined);
    setQuery("");
    if (refocus) buttonRef.current?.focus();
  }, []);

  const go = (p: Page) => {
    onChange(p);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!button || !panel) return;
    const left = Math.max(GAP, Math.min(button.left, window.innerWidth - panel.width - GAP));
    setPosition({ top: button.bottom + GAP, left });
    setLit(page);
    searchRef.current?.focus();
  }, [open, page]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    const gone = () => close(false);
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", gone);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", gone);
    };
  }, [open, close]);

  // Arrows move through the columns: up and down within one, left and
  // right to the same row of the next (or its last, if it's shorter).
  const move = (dx: number, dy: number) => {
    if (!litPage) return;
    const col = shown.findIndex((g) => g.pages.includes(litPage));
    const row = shown[col]?.pages.indexOf(litPage) ?? 0;
    if (dy !== 0) {
      const list = shown[col]?.pages ?? [];
      setLit(list[(row + dy + list.length) % list.length] ?? litPage);
      return;
    }
    const cols = shown.filter((g) => g.pages.length > 0);
    const at = cols.findIndex((g) => g.pages.includes(litPage));
    const next = cols[(at + dx + cols.length) % cols.length];
    if (next) setLit(next.pages[Math.min(row, next.pages.length - 1)] ?? litPage);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(0, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(0, -1);
        break;
      case "ArrowRight":
        if (query && searchRef.current === document.activeElement) break;
        e.preventDefault();
        move(1, 0);
        break;
      case "ArrowLeft":
        if (query && searchRef.current === document.activeElement) break;
        e.preventDefault();
        move(-1, 0);
        break;
      case "Enter":
        e.preventDefault();
        if (litPage) go(litPage);
        break;
      case "Escape":
      case "Tab":
        e.preventDefault();
        close();
        break;
    }
  };

  const shortcut = (p: Page) => {
    const n = SHORTCUT_PAGES.indexOf(p);
    return n >= 0 && n < 9 ? `${keyLabel("mod", mac)}${n + 1}` : undefined;
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="pd-menu-trigger app-page-menu"
        aria-label={t("nav.menu")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <PageIcon page={page} size={13} />
        {pageLabel(page)}
        <LuChevronDown size={11} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="dialog"
            aria-label={t("nav.menu")}
            className="pl-panel"
            data-visible={position !== undefined || undefined}
            style={{ top: position?.top ?? 0, left: position?.left ?? 0 }}
            onKeyDown={onKeyDown}
          >
            <label className="pl-search">
              <LuSearch size={14} aria-hidden />
              <input
                ref={searchRef}
                value={query}
                placeholder={t("nav.jump")}
                aria-label={t("nav.jump")}
                aria-controls={`${id}-grid`}
                aria-activedescendant={litPage ? `${id}-${litPage}` : undefined}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>esc</kbd>
            </label>

            <div className="pl-grid" id={`${id}-grid`} role="listbox" aria-label={t("nav.menu")}>
              {shown.map((g) => (
                <div key={g.key} className="pl-col">
                  <span className="pl-col-head" aria-hidden>
                    {t(`nav.group.${g.key}`)}
                  </span>
                  {g.pages.map((p) => {
                    const key = shortcut(p);
                    return (
                      <div
                        key={p}
                        id={`${id}-${p}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={p === page}
                        className="pl-item"
                        data-lit={p === litPage || undefined}
                        data-current={p === page || undefined}
                        onPointerMove={() => setLit(p)}
                        onClick={() => go(p)}
                        onKeyDown={(e) => e.key === " " && go(p)}
                      >
                        <span className="pl-glyph">
                          <PageIcon page={p} size={15} />
                        </span>
                        <span className="pl-name">{pageLabel(p)}</span>
                        {key && <kbd className="pl-key">{key}</kbd>}
                      </div>
                    );
                  })}
                  {g.pages.length === 0 && <span className="pl-none">–</span>}
                </div>
              ))}
            </div>

            <div className="pl-foot" aria-live="polite">
              {litPage ? (
                <>
                  <span className="pl-foot-glyph">
                    <PageIcon page={litPage} size={18} />
                  </span>
                  <span className="pl-foot-text">
                    <b>{pageLabel(litPage)}</b>
                    <small>{t(`nav.${litPage as Exclude<Page, "settings">}Desc`)}</small>
                  </span>
                  <span className="pl-foot-go">
                    {litPage === page ? (
                      t("nav.here")
                    ) : (
                      <>
                        <LuCornerDownLeft size={12} aria-hidden /> {t("nav.open")}
                      </>
                    )}
                  </span>
                </>
              ) : (
                <span className="pl-foot-text">
                  <small>{t("nav.noMatch", { query })}</small>
                </span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
