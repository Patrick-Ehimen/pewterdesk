import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuBellOff, LuInbox, LuX } from "react-icons/lu";
import { dateFormat, type MessageKey, t } from "../../i18n";
import { isToday } from "../../lib/alerts";
import type { ToastTone } from "../../lib/toasts";
import { IconButton } from "./IconButton";

/** What a notification is about; the centre filters by it. */
export type CentreNoteType = "order" | "fill" | "position" | "alert" | "risk";
const TYPES: readonly CentreNoteType[] = ["order", "fill", "position", "alert", "risk"];
const TYPE_LABEL: Record<CentreNoteType, MessageKey> = {
  order: "notes.type.order",
  fill: "notes.type.fill",
  position: "notes.type.position",
  alert: "notes.type.alert",
  risk: "notes.type.risk",
};

/** One notification, as the centre shows it. */
export interface CentreNote {
  id: string;
  type: CentreNoteType;
  title: string;
  body?: string;
  tone: ToastTone;
  time: number;
  read: boolean;
  /** The market it's about, as shown ("BTC-USDT"), when it can be opened. */
  marketLabel?: string;
}

/** Space between the button and its panel, and the panel and the window's edge. */
const GAP = 8;
const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const DAY_CLOCK: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

interface NotificationCentreProps {
  /** Newest first. */
  notes: readonly CentreNote[];
  /** Do not disturb is on: said at the top, since nothing is popping up. */
  dnd?: boolean;
  /** Marks these read (all of them when the panel closes). */
  onRead: (ids: readonly string[]) => void;
  onClear: () => void;
  /** Opens the market a notification is about. */
  onGoTo: (id: string) => void;
}

/**
 * The header's inbox and its panel: everything the app has told you
 * (orders, fills, position changes, fired alerts, liquidation warnings),
 * newest first, filtered by type, with what you haven't seen marked. Toasts
 * pass; this is where they stay. Closing it marks what was shown as read.
 */
export function NotificationCentre({
  notes,
  dnd,
  onRead,
  onClear,
  onGoTo,
}: NotificationCentreProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<CentreNoteType | "all">("all");
  const [place, setPlace] = useState<{ top: number; right: number }>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const unread = notes.filter((n) => !n.read).length;

  useLayoutEffect(() => {
    if (!open) return setPlace(undefined);
    const placeIt = () => {
      const b = buttonRef.current?.getBoundingClientRect();
      if (b) setPlace({ top: b.bottom + GAP, right: Math.max(window.innerWidth - b.right, GAP) });
    };
    placeIt();
    window.addEventListener("resize", placeIt);
    return () => window.removeEventListener("resize", placeIt);
  }, [open]);

  // The latest list and handler, for closing: read is whatever was there to see.
  const latest = useRef({ notes, onRead });
  latest.current = { notes, onRead };
  const close = () => {
    setOpen(false);
    const seen = latest.current.notes.filter((n) => !n.read).map((n) => n.id);
    if (seen.length > 0) latest.current.onRead(seen);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        closeRef.current();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeRef.current();
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = filter === "all" ? notes : notes.filter((n) => n.type === filter);
  const today = shown.filter((n) => isToday(n.time));
  const earlier = shown.filter((n) => !isToday(n.time));
  const row = (n: CentreNote, clock: Intl.DateTimeFormatOptions) => (
    <li key={n.id} className="pd-notes-row" data-tone={n.tone} data-unread={!n.read || undefined}>
      <span className="pd-notes-dot" aria-hidden />
      <div className="pd-notes-text">
        <span className="pd-notes-kind">{t(TYPE_LABEL[n.type])}</span>
        <strong>{n.title}</strong>
        {n.body && <span className="pd-notes-body">{n.body}</span>}
        {n.marketLabel && (
          <button
            type="button"
            className="pd-notes-go"
            onClick={() => {
              onGoTo(n.id);
              close();
            }}
          >
            {t("notes.goTo", { market: n.marketLabel })}
          </button>
        )}
      </div>
      <time className="pd-notes-time pd-num" dateTime={new Date(n.time).toISOString()}>
        {dateFormat(clock).format(n.time)}
      </time>
    </li>
  );

  return (
    <>
      <span className="pd-alerts-bell">
        <IconButton
          ref={buttonRef}
          label={unread > 0 ? t("notes.openUnread", { count: unread }) : t("notes.open")}
          aria-haspopup="dialog"
          aria-expanded={open}
          pressed={open}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <LuInbox size={17} aria-hidden />
        </IconButton>
        {unread > 0 && (
          <span className="pd-alerts-badge pd-num" aria-hidden>
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="pd-notes"
            role="dialog"
            aria-labelledby={titleId}
            style={place ? { top: place.top, right: place.right } : { visibility: "hidden" }}
          >
            <header className="pd-notes-head">
              <h3 id={titleId} className="pd-notes-title">
                {t("notes.title")}
              </h3>
              <button
                type="button"
                className="pd-notes-action"
                disabled={unread === 0}
                onClick={() => onRead(notes.filter((n) => !n.read).map((n) => n.id))}
              >
                {t("notes.markRead")}
              </button>
              <button
                type="button"
                className="pd-notes-action"
                disabled={notes.length === 0}
                onClick={onClear}
              >
                {t("notes.clear")}
              </button>
              <button
                type="button"
                className="pd-icon-button"
                aria-label={t("wallet.close")}
                onClick={close}
              >
                <LuX size={16} aria-hidden />
              </button>
            </header>
            {dnd && (
              <p className="pd-notes-dnd">
                <LuBellOff size={14} aria-hidden /> {t("notes.dndOn")}
              </p>
            )}
            <div
              className="pd-notes-filters"
              role="radiogroup"
              aria-label={t("settings.notifyType")}
            >
              {(["all", ...TYPES] as const).map((f) => {
                const count = f === "all" ? notes.length : notes.filter((n) => n.type === f).length;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: chip-style radio, like the app's others
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={f === filter}
                    className="pd-chip"
                    onClick={() => setFilter(f)}
                  >
                    {f === "all" ? t("notes.all") : t(TYPE_LABEL[f])}
                    <span className="pd-chip-count">{count}</span>
                  </button>
                );
              })}
            </div>
            <div className="pd-notes-list">
              {shown.length === 0 ? (
                <p className="pd-notes-empty">{t("notes.empty")}</p>
              ) : (
                <>
                  {today.length > 0 && (
                    <>
                      <h4 className="pd-notes-day">{t("notes.today")}</h4>
                      <ul className="pd-notes-rows">{today.map((n) => row(n, CLOCK))}</ul>
                    </>
                  )}
                  {earlier.length > 0 && (
                    <>
                      <h4 className="pd-notes-day">{t("notes.earlier")}</h4>
                      <ul className="pd-notes-rows">{earlier.map((n) => row(n, DAY_CLOCK))}</ul>
                    </>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
