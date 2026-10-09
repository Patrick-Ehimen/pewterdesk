import { IconButton, type MessageKey, Select, Switch, t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuSettings } from "react-icons/lu";
import {
  DEFAULT_VIEW_PREFS,
  DEPTH_COLUMNS,
  DEPTH_SPANS,
  type DepthSpan,
  MIN_VOLUMES,
  type ViewId,
  type ViewPrefs,
} from "../../lib/viewPrefs";

/** Space between the button and its panel, and the panel and the window's edge. */
const GAP = 8;

const VIEW_LABEL: Record<ViewId, MessageKey> = {
  chart: "tab.chart",
  overview: "tab.overview",
  depth: "tab.depth",
  screener: "tab.screener",
  watchlist: "tab.watchlist",
};

/** A volume floor as the picker shows it: "$10M". */
const volumeLabel = (usd: number) => (usd >= 1e6 ? `$${usd / 1e6}M` : `$${usd}`);

/** One setting: its name on the left, its control on the right. */
export function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="view-setting">
      <span className="view-setting-name">{label}</span>
      {children}
    </div>
  );
}

/** A switch row: one setting that's on or off. */
export function SettingSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingRow label={label}>
      <Switch label={label} checked={checked} onChange={onChange} />
    </SettingRow>
  );
}

interface SettingsPopoverProps {
  /** The panel's heading, e.g. "Chart settings". */
  title: string;
  /** Puts every setting back to its default. */
  onReset: () => void;
  /** Extra class for the button. */
  className?: string;
  children: ReactNode;
}

/**
 * A settings button and its panel, opening under the button (above it where
 * there's no room below). Each change applies at once; it closes on Escape
 * or a click outside.
 */
export function SettingsPopover({
  title,
  onReset,
  className = "pd-kebab",
  children,
}: SettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; right: number }>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    if (!open) return setPlace(undefined);
    const placeIt = () => {
      const b = buttonRef.current?.getBoundingClientRect();
      if (!b) return;
      const height = popRef.current?.offsetHeight ?? 0;
      const below = b.bottom + GAP;
      setPlace({
        top:
          below + height > window.innerHeight - GAP ? Math.max(b.top - GAP - height, GAP) : below,
        right: Math.max(window.innerWidth - b.right, GAP),
      });
    };
    placeIt();
    window.addEventListener("resize", placeIt);
    return () => window.removeEventListener("resize", placeIt);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
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

  return (
    <>
      <IconButton
        ref={buttonRef}
        className={className}
        label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        pressed={open}
        onClick={() => setOpen((o) => !o)}
      >
        <LuSettings size={15} aria-hidden />
      </IconButton>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="view-settings"
            role="dialog"
            aria-labelledby={titleId}
            style={place ? { top: place.top, right: place.right } : { visibility: "hidden" }}
          >
            <h3 id={titleId} className="view-settings-title">
              {title}
            </h3>
            {children}
            <button type="button" className="view-reset" onClick={onReset}>
              {t("view.reset")}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

const Row = SettingRow;

interface ViewSettingsProps {
  /** The tab on screen, whose settings these are. */
  view: ViewId;
  prefs: ViewPrefs;
  /** Applied to the latest settings, so quick changes in a row all land. */
  onChange: (change: (prefs: ViewPrefs) => ViewPrefs) => void;
}

/**
 * The Markets panel's settings button: a panel of the showing tab's own
 * settings, opening under the button. Each change applies at once; it closes
 * on Escape or a click outside.
 */
export function ViewSettings({ view, prefs, onChange }: ViewSettingsProps) {
  /** A switch row bound to one boolean of this view's settings. */
  const toggle = <V extends ViewId>(section: V, key: keyof ViewPrefs[V], label: MessageKey) => (
    <Row label={t(label)}>
      <Switch
        label={t(label)}
        checked={Boolean(prefs[section][key])}
        onChange={(checked) =>
          onChange((p) => ({ ...p, [section]: { ...p[section], [key]: checked } }))
        }
      />
    </Row>
  );

  const table = (section: "screener" | "watchlist") => (
    <>
      {section === "screener" && (
        <Row label={t("view.screener.minVolume")}>
          <Select
            label={t("view.screener.minVolume")}
            value={String(prefs.screener.minVolume)}
            options={MIN_VOLUMES.map((v) => ({
              value: String(v),
              label: v === 0 ? t("view.screener.anyVolume") : volumeLabel(v),
            }))}
            onChange={(v) =>
              onChange((p) => ({ ...p, screener: { ...p.screener, minVolume: Number(v) } }))
            }
          />
        </Row>
      )}
      {toggle(section, "volume", "view.screener.volume")}
      {toggle(section, "funding", "view.screener.funding")}
      {toggle(section, "leverage", "view.screener.leverage")}
      {toggle(section, "logos", "view.screener.logos")}
      {toggle(section, "dense", "view.screener.dense")}
    </>
  );

  const columns = prefs.depth.columns;
  const body: Record<ViewId, () => ReactNode> = {
    chart: () => (
      <>
        {toggle("chart", "grid", "view.grid")}
        {toggle("chart", "logScale", "view.chart.log")}
        {toggle("chart", "countdown", "view.chart.countdown")}
        {toggle("chart", "levels", "view.chart.levels")}
        {toggle("chart", "fills", "view.chart.fills")}
      </>
    ),
    overview: () => (
      <>
        {toggle("overview", "about", "view.overview.about")}
        {toggle("overview", "tags", "coin.tags")}
        {toggle("overview", "links", "view.overview.links")}
        {toggle("overview", "socials", "coin.socials")}
      </>
    ),
    depth: () => (
      <>
        <Row label={t("view.depth.span")}>
          <Select<DepthSpan>
            label={t("view.depth.span")}
            value={prefs.depth.span}
            options={DEPTH_SPANS.map((s) => ({
              value: s,
              label: s === "book" ? t("view.depth.wholeBook") : `±${s}%`,
            }))}
            onChange={(span) => onChange((p) => ({ ...p, depth: { ...p.depth, span } }))}
          />
        </Row>
        {toggle("depth", "smooth", "view.depth.smooth")}
        {toggle("depth", "grid", "view.grid")}
        {toggle("depth", "band", "view.depth.band")}
        {toggle("depth", "walls", "view.depth.walls")}
        {toggle("depth", "bars", "view.depth.bars")}
        <Row label={t("view.depth.columns")}>
          <span className="view-slider pd-leverage-slider">
            <input
              type="range"
              min={DEPTH_COLUMNS.min}
              max={DEPTH_COLUMNS.max}
              step={DEPTH_COLUMNS.step}
              value={columns}
              disabled={!prefs.depth.bars}
              aria-label={t("view.depth.columns")}
              style={{
                ["--pd-fill" as string]: `${((columns - DEPTH_COLUMNS.min) / (DEPTH_COLUMNS.max - DEPTH_COLUMNS.min)) * 100}%`,
              }}
              onChange={(e) =>
                onChange((p) => ({ ...p, depth: { ...p.depth, columns: Number(e.target.value) } }))
              }
            />
          </span>
          <span className="view-value pd-num">{columns}</span>
        </Row>
      </>
    ),
    screener: () => table("screener"),
    watchlist: () => table("watchlist"),
  };

  return (
    <SettingsPopover
      title={t("view.title", { view: t(VIEW_LABEL[view]) })}
      onReset={() => onChange((p) => ({ ...p, [view]: DEFAULT_VIEW_PREFS[view] }))}
    >
      {body[view]()}
    </SettingsPopover>
  );
}
