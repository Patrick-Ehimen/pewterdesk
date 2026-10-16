import { t } from "@pewterdesk/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { LuBookmark, LuChevronDown, LuX } from "react-icons/lu";
import { type SavedMapView, VIEW_NAME_MAX } from "../../lib/mapViews";

interface SavedViewsProps {
  views: readonly SavedMapView[];
  /** What a saved view is: its view's name and market, for the second line. */
  describe: (view: SavedMapView) => string;
  /** The name offered for the view on screen. */
  suggestion: string;
  onApply: (view: SavedMapView) => void;
  onSave: (name: string) => void;
  onRemove: (id: string) => void;
}

/**
 * The Maps page's saved views: a menu of the trader's own (open one, or
 * delete it) and a field to save the view on screen under a name. Saving
 * under a name already used updates that view.
 */
export function SavedViews({
  views,
  describe,
  suggestion,
  onApply,
  onSave,
  onRemove,
}: SavedViewsProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const typed = name.trim() || suggestion;
  const replaces = views.some((v) => v.name.toLowerCase() === typed.toLowerCase());
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!typed) return;
    onSave(typed);
    setName("");
  };

  return (
    <div ref={rootRef} className="maps-saved">
      <button
        ref={buttonRef}
        type="button"
        className="maps-saved-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <LuBookmark size={14} aria-hidden />
        {t("maps.saved.button")}
        {views.length > 0 && <span className="maps-saved-count pd-num">{views.length}</span>}
        <LuChevronDown size={13} aria-hidden className="maps-saved-chevron" />
      </button>
      {open && (
        <div className="maps-saved-menu" role="dialog" aria-label={t("maps.saved.button")}>
          {views.length === 0 ? (
            <p className="maps-saved-empty">{t("maps.saved.empty")}</p>
          ) : (
            <ul className="maps-saved-list">
              {views.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className="maps-saved-item"
                    onClick={() => {
                      onApply(v);
                      setOpen(false);
                    }}
                  >
                    <strong>{v.name}</strong>
                    <span className="pd-muted">{describe(v)}</span>
                  </button>
                  <button
                    type="button"
                    className="maps-saved-remove"
                    aria-label={t("maps.saved.remove", { name: v.name })}
                    title={t("maps.saved.remove", { name: v.name })}
                    onClick={() => onRemove(v.id)}
                  >
                    <LuX size={13} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="maps-saved-form" onSubmit={save}>
            <input
              aria-label={t("maps.saved.name")}
              placeholder={suggestion}
              value={name}
              maxLength={VIEW_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className="maps-saved-save" disabled={!typed}>
              {t(replaces ? "maps.saved.update" : "maps.saved.save")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
