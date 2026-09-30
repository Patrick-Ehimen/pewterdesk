import type { Market, VenueId } from "@pewterdesk/core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { LuActivity, LuBell, LuCheck, LuCoins, LuPercent, LuTrash2, LuX } from "react-icons/lu";
import { dateFormat, type MessageKey, t } from "../../i18n";
import {
  ALERT_KINDS,
  type AlertChannel,
  type AlertCondition,
  type AlertKind,
  type AlertRepeat,
  distanceToFire,
  type FiredAlert,
  type MarketAlert,
  sortAlerts,
} from "../../lib/alerts";
import { decimalsOf, formatNumber, formatPercent } from "../../lib/format";
import { IconButton } from "../common/IconButton";
import { Select } from "../common/Select";
import { Switch } from "../common/Switch";
import { TokenIcon } from "./TokenIcon";

/** A new alert as the form fills it in; the app gives it an id and stores it. */
export type AlertDraft = Omit<MarketAlert, "id" | "active" | "createdAt" | "firedAt">;

interface VenueChip {
  id: VenueId;
  label: string;
  logo?: string;
}

interface AlertsPopoverProps {
  alerts: readonly MarketAlert[];
  /** Today's fired alerts, newest first. */
  fired: readonly FiredAlert[];
  /** Fired since the popover was last opened; shown on the bell. */
  unseen: number;
  /** Every alert held, without switching each one off. */
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  /** The market on the open chart; a new alert watches it. */
  market?: Market;
  venues: readonly VenueChip[];
  /** The value `kind` watches on that market right now, if it's known. */
  currentOf: (venue: VenueId, market: string, kind: AlertKind) => number | undefined;
  onCreate: (draft: AlertDraft) => void;
  onToggle: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
  onClearFired: () => void;
  /** "Chart" on a fired alert: put its market on screen. */
  onShowMarket: (venue: VenueId, market: string) => void;
  onOpenChange?: (open: boolean) => void;
}

const ICON_SIZE = 17;
/** Gap between the bell and the popover, and minimum distance from the window edge. */
const GAP = 8;

/** Types in the design that need account data or feeds pewterdesk doesn't have yet. */
const LATER_KINDS: readonly MessageKey[] = [
  "alerts.type.liq",
  "alerts.type.pnl",
  "alerts.type.wallet",
  "alerts.type.venue",
];
const CHANNELS: readonly AlertChannel[] = ["app", "desktop", "sound", "menuBar"];
/** Delivered so far; the rest come with desktop notifications. */
const LIVE_CHANNELS: ReadonlySet<AlertChannel> = new Set(["app"]);

const KIND_ICON: Record<AlertKind, ReactNode> = {
  price: <LuActivity size={15} aria-hidden />,
  move: <LuPercent size={15} aria-hidden />,
  funding: <LuCoins size={15} aria-hidden />,
};

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** A price to enough places to read, whatever the market's scale. */
const priceText = (n: number) => formatNumber(n, Math.min(Math.max(decimalsOf(String(n)), 2), 6));
/** A "move" or "funding" value, already in %. */
const pctText = (kind: AlertKind, n: number) => `${formatNumber(n, kind === "funding" ? 4 : 2)}%`;
const valueText = (kind: AlertKind, n: number) =>
  kind === "price" ? priceText(n) : pctText(kind, n);

/** The watched value as typed into the form (and suggested as its placeholder). */
const inputText = (kind: AlertKind, n: number) =>
  kind === "price" ? String(Number(n.toPrecision(6))) : n.toFixed(kind === "funding" ? 4 : 2);

/** "HYPE falls below 36.50", "BTC funding above 0.0100%". */
function describe(a: Pick<MarketAlert, "kind" | "condition" | "symbol" | "value">) {
  return t(`alerts.desc.${a.kind}.${a.condition}`, {
    market: a.symbol,
    value: valueText(a.kind, a.value),
  });
}

/** How far off firing, for the list and the form: "4.94% away", or "now" once past. */
function distanceText(kind: AlertKind, distance: number | undefined) {
  if (distance === undefined) return "-";
  if (distance <= 0) return t("alerts.status.now");
  const amount = kind === "price" ? formatPercent(distance) : pctText(kind, distance);
  return t("alerts.away", { distance: amount });
}

/**
 * The header's bell and its alerts popover, after the design's alerts
 * screen: a form for a new alert, the active ones closest-to-firing first,
 * and what fired today. Fed entirely by props; the app stores and checks
 * the alerts.
 */
export function AlertsPopover(props: AlertsPopoverProps) {
  const { unseen, onOpenChange } = props;
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number }>();

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setPosition(undefined);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(
    (refocus = true) => {
      setOpenState(false);
      if (refocus) buttonRef.current?.focus();
    },
    [setOpenState],
  );

  // Under the bell, right-aligned, and no taller than the window.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = buttonRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!button || !panel) return;
      const left = Math.max(
        GAP,
        Math.min(button.right - panel.width, window.innerWidth - panel.width - GAP),
      );
      const top = button.bottom + GAP;
      setPosition({ top, left, maxHeight: window.innerHeight - top - GAP });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Focus moves into the popover when it opens.
  useEffect(() => {
    if (open && position) panelRef.current?.focus({ preventScroll: true });
  }, [open, position]);

  // A click outside closes it, as Escape does.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        close(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  return (
    <>
      <span className="pd-alerts-bell">
        <IconButton
          ref={buttonRef}
          label={unseen > 0 ? t("alerts.bellUnseen", { count: unseen }) : t("alerts.title")}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? close() : setOpenState(true))}
        >
          <LuBell size={ICON_SIZE} aria-hidden />
        </IconButton>
        {unseen > 0 && (
          <span className="pd-alerts-badge pd-num" aria-hidden>
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={t("alerts.title")}
            tabIndex={-1}
            className="pd-alerts"
            data-visible={position !== undefined || undefined}
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              maxHeight: position?.maxHeight,
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            <AlertsPanel {...props} onClose={() => close()} />
          </div>,
          document.body,
        )}
    </>
  );
}

function AlertsPanel({
  alerts,
  fired,
  paused,
  onPausedChange,
  market,
  venues,
  currentOf,
  onCreate,
  onToggle,
  onDelete,
  onClearFired,
  onShowMarket,
  onClose,
}: AlertsPopoverProps & { onClose: () => void }) {
  const activeCount = alerts.filter((a) => a.active).length;
  const venueOf = (id: VenueId) => venues.find((v) => v.id === id);
  const sorted = sortAlerts(alerts, (a) => currentOf(a.venue, a.market, a.kind));

  return (
    <>
      <header className="pd-alerts-head">
        <h2>{t("alerts.title")}</h2>
        <span className="pd-muted">
          {t("alerts.summary", { active: activeCount, paused: alerts.length - activeCount })}
        </span>
        <span className="pd-alerts-pause">
          <span>{t("alerts.pauseAll")}</span>
          <Switch checked={paused} onChange={onPausedChange} label={t("alerts.pauseAll")} />
        </span>
        <IconButton label={t("alerts.close")} className="pd-kebab" onClick={onClose}>
          <LuX size={16} aria-hidden />
        </IconButton>
      </header>

      <NewAlertForm market={market} venues={venues} currentOf={currentOf} onCreate={onCreate} />

      <section className="pd-alerts-section" aria-labelledby="pd-alerts-active">
        <div className="pd-alerts-section-head">
          <h3 id="pd-alerts-active">{t("alerts.active")}</h3>
          {alerts.length > 1 && <span>{t("alerts.sorted")}</span>}
        </div>
        {sorted.length === 0 ? (
          <p className="pd-alerts-empty">{t("alerts.empty")}</p>
        ) : (
          <ul className="pd-alerts-list" data-paused={paused || undefined}>
            {sorted.map((a) => {
              const venue = venueOf(a.venue);
              const distance = distanceToFire(a, currentOf(a.venue, a.market, a.kind));
              return (
                <li key={a.id} className="pd-alerts-row" data-off={!a.active || undefined}>
                  <span className="pd-alerts-icon">{KIND_ICON[a.kind]}</span>
                  <span className="pd-alerts-text">
                    <strong>{describe(a)}</strong>
                    <span className="pd-alerts-meta">
                      {venue?.logo && <img src={venue.logo} width={12} height={12} alt="" />}
                      {[
                        venue?.label ?? a.venue,
                        t(`alerts.type.${a.kind}`),
                        t(`alerts.repeatShort.${a.repeat}`),
                        a.note,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span
                    className="pd-num pd-alerts-status"
                    data-now={(a.active && distance !== undefined && distance <= 0) || undefined}
                  >
                    {a.active ? distanceText(a.kind, distance) : t("alerts.status.paused")}
                  </span>
                  <Switch
                    checked={a.active}
                    onChange={(on) => onToggle(a.id, on)}
                    label={t("alerts.toggle", { alert: describe(a) })}
                  />
                  <IconButton
                    label={t("alerts.delete")}
                    className="pd-kebab pd-alerts-delete"
                    onClick={() => onDelete(a.id)}
                  >
                    <LuTrash2 size={14} aria-hidden />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {fired.length > 0 && (
        <section className="pd-alerts-section" aria-labelledby="pd-alerts-fired">
          <div className="pd-alerts-section-head">
            <h3 id="pd-alerts-fired">{t("alerts.firedToday", { count: fired.length })}</h3>
            <button type="button" className="pd-alerts-link" onClick={onClearFired}>
              {t("alerts.clear")}
            </button>
          </div>
          <ul className="pd-alerts-list">
            {fired.map((f) => (
              <li key={f.id} className="pd-alerts-row pd-alerts-fired">
                <span className="pd-alerts-icon">{KIND_ICON[f.kind]}</span>
                <span className="pd-alerts-text">
                  {t(`alerts.fired.${f.kind}.${f.condition}`, {
                    market: f.symbol,
                    value: valueText(f.kind, f.value),
                  })}
                </span>
                <time className="pd-num pd-muted">{dateFormat(CLOCK).format(f.time)}</time>
                <button
                  type="button"
                  className="pd-alerts-link"
                  onClick={() => {
                    onShowMarket(f.venue, f.market);
                    onClose();
                  }}
                >
                  {t("alerts.chart")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="pd-alerts-foot">{t("alerts.footer")}</footer>
    </>
  );
}

/** A chip toggled by `aria-checked`, like the app's others. */
function Chip({
  checked,
  disabled,
  title,
  onClick,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: chip-style radio, like the app's others
    <button
      type="button"
      role="radio"
      className="pd-alerts-chip"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function NewAlertForm({
  market: target,
  venues,
  currentOf,
  onCreate,
}: Pick<AlertsPopoverProps, "market" | "venues" | "currentOf" | "onCreate">) {
  const [kind, setKind] = useState<AlertKind>("price");
  const [condition, setCondition] = useState<AlertCondition>("above");
  const [input, setInput] = useState("");
  const [repeat, setRepeat] = useState<AlertRepeat>("once");
  const [notify, setNotify] = useState<ReadonlySet<AlertChannel>>(new Set(["app"]));
  const [note, setNote] = useState("");

  const venue = venues.find((v) => v.id === target?.venue);
  const current = target ? currentOf(target.venue, target.id, kind) : undefined;
  const value = Number(input.trim());
  const valid =
    target !== undefined &&
    input.trim() !== "" &&
    Number.isFinite(value) &&
    (kind !== "price" || value > 0) &&
    notify.size > 0;
  const distance = valid ? distanceToFire({ kind, condition, value }, current) : undefined;

  const reset = () => {
    setInput("");
    setNote("");
  };
  const submit = () => {
    if (!valid || !target) return;
    onCreate({
      kind,
      venue: target.venue,
      market: target.id,
      symbol: target.symbol,
      condition,
      value,
      repeat,
      notify: CHANNELS.filter((c) => notify.has(c)),
      note: note.trim() || undefined,
    });
    reset();
  };

  return (
    <form
      className="pd-alerts-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>{t("alerts.new")}</h3>

      <span className="pd-alerts-label" id="pd-alert-type">
        {t("alerts.field.type")}
      </span>
      <div className="pd-alerts-chips" role="radiogroup" aria-labelledby="pd-alert-type">
        {ALERT_KINDS.map((k) => (
          <Chip key={k} checked={kind === k} onClick={() => setKind(k)}>
            {t(`alerts.type.${k}`)}
          </Chip>
        ))}
        {LATER_KINDS.map((k) => (
          <Chip key={k} checked={false} disabled title={t("alerts.soon")}>
            {t(k)}
          </Chip>
        ))}
      </div>

      {/* The market on the open chart: switch the chart to alert on another. */}
      <span className="pd-alerts-label">{t("alerts.field.market")}</span>
      <div className="pd-alerts-fields">
        <span className="pd-alerts-market" title={t("alerts.marketHint")}>
          {target ? (
            <>
              <TokenIcon market={target} size={18} />
              <strong>{target.symbol}</strong>
            </>
          ) : (
            "-"
          )}
        </span>
        {venue && (
          <span className="pd-alerts-source">
            {venue.logo && <img src={venue.logo} width={14} height={14} alt="" />}
            {t("alerts.source", { venue: venue.label })}
          </span>
        )}
      </div>

      <label className="pd-alerts-label" htmlFor="pd-alert-condition">
        {t("alerts.field.when")}
      </label>
      <div className="pd-alerts-fields">
        <Select<AlertCondition>
          id="pd-alert-condition"
          value={condition}
          onChange={setCondition}
          options={[
            { value: "above", label: t("alerts.cond.above") },
            { value: "below", label: t("alerts.cond.below") },
          ]}
        />
        <span className="pd-alerts-value">
          <input
            className="pd-num"
            inputMode="decimal"
            aria-label={t("alerts.value")}
            placeholder={current === undefined ? "0" : inputText(kind, current)}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-invalid={(input.trim() !== "" && !Number.isFinite(value)) || undefined}
          />
          <span>{kind === "price" ? (target?.quote ?? "") : "%"}</span>
        </span>
        {current !== undefined && (
          <span className="pd-alerts-now pd-num">
            {t("alerts.now", { value: valueText(kind, current) })}
            {distance !== undefined && <> · {distanceText(kind, distance)}</>}
          </span>
        )}
      </div>

      <span className="pd-alerts-label" id="pd-alert-repeat">
        {t("alerts.field.repeat")}
      </span>
      <div className="pd-alerts-chips" role="radiogroup" aria-labelledby="pd-alert-repeat">
        {(["once", "every"] as const).map((r) => (
          <Chip key={r} checked={repeat === r} onClick={() => setRepeat(r)}>
            {t(`alerts.repeat.${r}`)}
          </Chip>
        ))}
      </div>

      <span className="pd-alerts-label" id="pd-alert-notify">
        {t("alerts.field.notify")}
      </span>
      <fieldset className="pd-alerts-chips" aria-labelledby="pd-alert-notify">
        {CHANNELS.map((c) => {
          const live = LIVE_CHANNELS.has(c);
          const on = live && notify.has(c);
          return (
            // biome-ignore lint/a11y/useSemanticElements: chip-style checkbox, like the app's others
            <button
              key={c}
              type="button"
              role="checkbox"
              className="pd-alerts-chip"
              aria-checked={on}
              disabled={!live}
              title={live ? undefined : t("alerts.soon")}
              onClick={() =>
                setNotify((s) => {
                  const next = new Set(s);
                  if (next.has(c)) next.delete(c);
                  else next.add(c);
                  return next;
                })
              }
            >
              {on && <LuCheck size={13} aria-hidden />}
              {t(`alerts.notify.${c}`)}
            </button>
          );
        })}
      </fieldset>

      <div className="pd-alerts-actions">
        <input
          className="pd-input"
          aria-label={t("alerts.note")}
          placeholder={t("alerts.note")}
          maxLength={120}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="button" className="pd-alerts-cancel" onClick={reset}>
          {t("alerts.cancel")}
        </button>
        <button type="submit" className="pd-alerts-create" disabled={!valid}>
          {t("alerts.create")}
        </button>
      </div>
    </form>
  );
}
