import type { CandleInterval } from "@pewterdesk/core";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  LuCamera,
  LuChartNoAxesCombined,
  LuCheck,
  LuChevronDown,
  LuSearch,
  LuStar,
} from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import {
  CHART_TYPES,
  type ChartType,
  INDICATORS,
  INTERVAL_GROUPS,
  type IndicatorId,
} from "../../lib/indicators";

const GAP = 4;

/** Chart type glyphs, drawn to read like TradingView's at 18px. */
function TypeIcon({ type }: { type: ChartType }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 18 18",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
  } as const;
  switch (type) {
    case "bars":
      return (
        <svg {...common} aria-hidden>
          <path d="M5 3v11M3 5h2M5 11h2M12 5v10M10 8h2M12 13h2" />
        </svg>
      );
    case "candles":
      return (
        <svg {...common} aria-hidden>
          <path d="M5.5 2.5v2M5.5 12.5v3M12.5 4.5v2M12.5 13v2.5" />
          <rect x="3.5" y="4.5" width="4" height="8" fill="currentColor" />
          <rect x="10.5" y="6.5" width="4" height="6.5" />
        </svg>
      );
    case "hollow":
      return (
        <svg {...common} aria-hidden>
          <path d="M5.5 2.5v2M5.5 12.5v3M12.5 4.5v2M12.5 13v2.5" />
          <rect x="3.5" y="4.5" width="4" height="8" />
          <rect x="10.5" y="6.5" width="4" height="6.5" />
        </svg>
      );
    case "heikinAshi":
      return (
        <svg {...common} aria-hidden>
          <path d="M5.5 3v2.5M5.5 12v3M12.5 2.5v3M12.5 10.5v3" />
          <rect x="3.5" y="5.5" width="4" height="6.5" fill="currentColor" />
          <rect x="10.5" y="5.5" width="4" height="5" fill="currentColor" />
        </svg>
      );
    case "line":
      return (
        <svg {...common} aria-hidden>
          <path d="M2 13l4-5 3 3 3.5-6L16 8" />
        </svg>
      );
    case "area":
      return (
        <svg {...common} aria-hidden>
          <path d="M2 13l4-5 3 3 3.5-6L16 8v7H2z" fill="currentColor" fillOpacity="0.25" />
          <path d="M2 13l4-5 3 3 3.5-6L16 8" />
        </svg>
      );
    case "baseline":
      return (
        <svg {...common} aria-hidden>
          <path d="M2 9.5h14" strokeDasharray="2 2" />
          <path d="M2 12l3.5-5 3 4 3.5-7 4 5" />
        </svg>
      );
  }
}

const TYPE_LABEL: Record<ChartType, MessageKey> = {
  bars: "chart.type.bars",
  candles: "chart.type.candles",
  hollow: "chart.type.hollow",
  heikinAshi: "chart.type.heikinAshi",
  line: "chart.type.line",
  area: "chart.type.area",
  baseline: "chart.type.baseline",
};
const GROUP_LABEL: Record<(typeof INTERVAL_GROUPS)[number]["id"], MessageKey> = {
  minutes: "chart.minutes",
  hours: "chart.hours",
  days: "chart.days",
};
const INDICATOR_LABEL: Record<IndicatorId, MessageKey> = {
  volume: "indicator.volume",
  sma: "indicator.sma",
  ema: "indicator.ema",
  bollinger: "indicator.bollinger",
  vwap: "indicator.vwap",
  rsi: "indicator.rsi",
  macd: "indicator.macd",
};

/** Days and weeks read in capitals, as on TradingView ("1D", "1W"). */
const intervalText = (i: CandleInterval) =>
  i.endsWith("d") || i.endsWith("w") ? i.toUpperCase() : i;

/**
 * A menu under its trigger, in a portal so the panel can't clip it. Closes on
 * Escape, on a pick, or on a click outside.
 */
function usePopover<T extends HTMLElement>(trigger: RefObject<T | null>) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>();
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(undefined);
      return;
    }
    const b = trigger.current?.getBoundingClientRect();
    const m = menuRef.current?.getBoundingClientRect();
    if (!b || !m) return;
    setPos({
      top: b.bottom + GAP,
      left: Math.max(GAP, Math.min(b.left, window.innerWidth - m.width - GAP)),
    });
  }, [open, trigger]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, trigger]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  const render = (label: string, children: ReactNode, className = "") =>
    open &&
    createPortal(
      <div
        ref={menuRef}
        role="dialog"
        aria-label={label}
        className={`pd-chart-menu ${className}`}
        data-visible={pos !== undefined || undefined}
        style={{ top: pos?.top ?? 0, left: pos?.left ?? 0 }}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>,
      document.body,
    );
  return { open, setOpen, close, render };
}

/** A pin beside a menu row: favorites get a button on the toolbar. */
function FavoriteStar({ on, name, onToggle }: { on: boolean; name: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="pd-chart-menu-star"
      data-on={on || undefined}
      aria-pressed={on}
      aria-label={t(on ? "chart.unfavorite" : "chart.favorite", { name })}
      onClick={onToggle}
    >
      <LuStar size={13} aria-hidden />
    </button>
  );
}

interface ChartToolbarProps {
  interval: CandleInterval;
  onInterval: (interval: CandleInterval) => void;
  /** Intervals with a button of their own; the rest are in the menu. */
  favoriteIntervals: readonly CandleInterval[];
  onToggleFavoriteInterval: (interval: CandleInterval) => void;
  chartType: ChartType;
  onChartType: (type: ChartType) => void;
  favoriteTypes: readonly ChartType[];
  onToggleFavoriteType: (type: ChartType) => void;
  indicators: readonly IndicatorId[];
  onToggleIndicator: (id: IndicatorId) => void;
  /** Takes the screenshot; resolves to what happened, for the button's label. */
  onScreenshot: () => Promise<"copied" | "saved" | "failed">;
}

/**
 * The chart's toolbar, after TradingView's: favorite intervals and the full
 * list, favorite chart types and the full list, indicators, and a
 * screenshot on the right.
 */
export function ChartToolbar({
  interval,
  onInterval,
  favoriteIntervals,
  onToggleFavoriteInterval,
  chartType,
  onChartType,
  favoriteTypes,
  onToggleFavoriteType,
  indicators,
  onToggleIndicator,
  onScreenshot,
}: ChartToolbarProps) {
  const intervalRef = useRef<HTMLButtonElement>(null);
  const typeRef = useRef<HTMLButtonElement>(null);
  const indicatorRef = useRef<HTMLButtonElement>(null);
  const intervalMenu = usePopover(intervalRef);
  const typeMenu = usePopover(typeRef);
  const indicatorMenu = usePopover(indicatorRef);
  const [search, setSearch] = useState("");
  const [shot, setShot] = useState<"copied" | "saved" | "failed">();

  useEffect(() => {
    if (!shot) return;
    const id = setTimeout(() => setShot(undefined), 2000);
    return () => clearTimeout(id);
  }, [shot]);

  // A pick from the menu that isn't a favorite still shows as a button.
  const quickIntervals = favoriteIntervals.includes(interval)
    ? favoriteIntervals
    : [...favoriteIntervals, interval];
  const quickTypes = favoriteTypes.includes(chartType)
    ? favoriteTypes
    : [...favoriteTypes, chartType];
  const needle = search.trim().toLowerCase();
  const matching = INDICATORS.filter((id) => t(INDICATOR_LABEL[id]).toLowerCase().includes(needle));

  return (
    <div className="pd-chart-toolbar" role="toolbar" aria-label={t("chart.toolbar")}>
      <div className="pd-chart-group" role="radiogroup" aria-label={t("chart.interval")}>
        {quickIntervals.map((i) => (
          // biome-ignore lint/a11y/useSemanticElements: toolbar-style radio, like the other segmented controls
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={i === interval}
            className="pd-chart-tool"
            onClick={() => onInterval(i)}
          >
            {intervalText(i)}
          </button>
        ))}
        <button
          ref={intervalRef}
          type="button"
          className="pd-chart-tool pd-chart-more"
          aria-label={t("chart.allIntervals")}
          aria-haspopup="dialog"
          aria-expanded={intervalMenu.open}
          onClick={() => intervalMenu.setOpen(!intervalMenu.open)}
        >
          <LuChevronDown size={14} aria-hidden />
        </button>
      </div>
      {intervalMenu.render(
        t("chart.allIntervals"),
        INTERVAL_GROUPS.map((g) => (
          <section key={g.id} className="pd-chart-menu-group">
            <h3>{t(GROUP_LABEL[g.id])}</h3>
            {g.intervals.map((i) => (
              <div key={i} className="pd-chart-menu-row" aria-current={i === interval || undefined}>
                <button
                  type="button"
                  className="pd-chart-menu-pick"
                  onClick={() => {
                    onInterval(i);
                    intervalMenu.close();
                  }}
                >
                  {intervalText(i)}
                </button>
                <FavoriteStar
                  on={favoriteIntervals.includes(i)}
                  name={intervalText(i)}
                  onToggle={() => onToggleFavoriteInterval(i)}
                />
              </div>
            ))}
          </section>
        )),
      )}

      <span className="pd-chart-divider" aria-hidden />

      <div className="pd-chart-group" role="radiogroup" aria-label={t("chart.type")}>
        {quickTypes.map((type) => (
          // biome-ignore lint/a11y/useSemanticElements: toolbar-style radio, like the other segmented controls
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={type === chartType}
            aria-label={t(TYPE_LABEL[type])}
            title={t(TYPE_LABEL[type])}
            className="pd-chart-tool pd-chart-icon"
            onClick={() => onChartType(type)}
          >
            <TypeIcon type={type} />
          </button>
        ))}
        <button
          ref={typeRef}
          type="button"
          className="pd-chart-tool pd-chart-more"
          aria-label={t("chart.allTypes")}
          aria-haspopup="dialog"
          aria-expanded={typeMenu.open}
          onClick={() => typeMenu.setOpen(!typeMenu.open)}
        >
          <LuChevronDown size={14} aria-hidden />
        </button>
      </div>
      {typeMenu.render(
        t("chart.allTypes"),
        CHART_TYPES.map((type) => (
          <div
            key={type}
            className="pd-chart-menu-row"
            aria-current={type === chartType || undefined}
          >
            <button
              type="button"
              className="pd-chart-menu-pick"
              onClick={() => {
                onChartType(type);
                typeMenu.close();
              }}
            >
              <TypeIcon type={type} />
              {t(TYPE_LABEL[type])}
            </button>
            <FavoriteStar
              on={favoriteTypes.includes(type)}
              name={t(TYPE_LABEL[type])}
              onToggle={() => onToggleFavoriteType(type)}
            />
          </div>
        )),
        "pd-chart-menu-types",
      )}

      <span className="pd-chart-divider" aria-hidden />

      <button
        ref={indicatorRef}
        type="button"
        className="pd-chart-tool pd-chart-indicators"
        aria-haspopup="dialog"
        aria-expanded={indicatorMenu.open}
        onClick={() => {
          setSearch("");
          indicatorMenu.setOpen(!indicatorMenu.open);
        }}
      >
        <LuChartNoAxesCombined size={17} aria-hidden />
        {t("chart.indicators")}
        {indicators.length > 0 && <span className="pd-chart-count">{indicators.length}</span>}
      </button>
      {indicatorMenu.render(
        t("chart.indicators"),
        <>
          <label className="pd-search pd-chart-menu-search">
            <LuSearch size={14} aria-hidden />
            <input
              type="search"
              placeholder={t("indicator.search")}
              aria-label={t("indicator.search")}
              // biome-ignore lint/a11y/noAutofocus: the menu opens to be searched
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <ul className="pd-chart-menu-list">
            {matching.map((id) => {
              const on = indicators.includes(id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="pd-chart-menu-pick"
                    aria-pressed={on}
                    onClick={() => onToggleIndicator(id)}
                  >
                    <span className="pd-chart-menu-check">
                      {on && <LuCheck size={14} aria-hidden />}
                    </span>
                    {t(INDICATOR_LABEL[id])}
                  </button>
                </li>
              );
            })}
          </ul>
          {matching.length === 0 && <p className="pd-chart-menu-empty">{t("indicator.noMatch")}</p>}
        </>,
        "pd-chart-menu-indicators",
      )}

      <div className="pd-chart-spacer" />

      <button
        type="button"
        className="pd-chart-tool pd-chart-icon"
        aria-label={t("chart.screenshot")}
        title={shot ? t(`chart.shot.${shot}`) : t("chart.screenshot")}
        data-state={shot}
        onClick={() => void onScreenshot().then(setShot)}
      >
        {shot && shot !== "failed" ? (
          <LuCheck size={17} aria-hidden />
        ) : (
          <LuCamera size={17} aria-hidden />
        )}
      </button>
      <span className="pd-visually-hidden" role="status">
        {shot ? t(`chart.shot.${shot}`) : ""}
      </span>
    </div>
  );
}
