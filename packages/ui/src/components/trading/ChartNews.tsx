import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext } from "openalgo-charts";
import type { Widget } from "openalgo-charts/widget";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { LuX } from "react-icons/lu";
import { dateFormat, t } from "../../i18n";
import { type ChartNewsEvent, groupNews } from "../../lib/openAlgoChart";

const WHEN: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

const BADGE = 20;
/** Centre to centre, for its ring, its count and a gap. */
const BADGE_SPACING = 30;
/** Off the foot of the plot. */
const BADGE_FOOT = 4;

const CARD_WIDTH = 280;
const EDGE = 8;
/** Above the badge the card opens from. */
const OVER_BADGE = 14;

/** Where a card opens from a badge at (x, y), in a stage of the size given. */
export function newsCardPlace(x: number, y: number, width: number, height: number) {
  const bottom = Math.max(EDGE, height - y + OVER_BADGE);
  return {
    left: Math.max(EDGE, Math.min(x - CARD_WIDTH / 2, width - CARD_WIDTH - EDGE)),
    bottom,
    maxHeight: Math.max(0, height - bottom - EDGE),
  };
}

/** Draws nothing: it tells the badges each time the chart paints, so they move with it. */
class NewsLayer implements IPrimitive {
  private host: PrimitiveHost | undefined;
  constructor(private readonly onFrame: (rc: PrimitiveRenderContext) => void) {}
  attached(host: PrimitiveHost) {
    this.host = host;
  }
  detached() {
    this.host = undefined;
  }
  update() {
    this.host?.requestUpdate();
  }
  zOrder() {
    return "top" as const;
  }
  draw(_ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext) {
    this.onFrame(rc);
  }
}

const newsLine = (n: ChartNewsEvent) => `${n.title} · ${dateFormat(WHEN).format(n.time)}`;

/** The US flag, as a release's badge: every release here is a USD one. */
function UsdFlag() {
  return (
    <svg className="pd-chart-news-flag" viewBox="0 0 20 20" aria-hidden>
      <rect width="20" height="20" fill="#fff" />
      {[0, 3.1, 6.2, 9.3, 12.4, 15.5, 18.6].map((y) => (
        <rect key={y} y={y} width="20" height="1.55" fill="#b22234" />
      ))}
      <rect width="10.5" height="10.8" fill="#3c3b6e" />
      {[
        [2.5, 2.5],
        [6, 2.5],
        [8.6, 5.2],
        [4.2, 5.2],
        [2.5, 8],
        [6, 8],
      ].map(([x, y]) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r="0.8" fill="#fff" />
      ))}
    </svg>
  );
}

/**
 * The releases' buttons, at their times along the foot of the price pane:
 * one for each, or one that counts those too close to part (`groupNews`).
 * They sit over the chart rather than on its canvas, so each is a button of
 * its own, and are moved as the chart paints.
 */
export function ChartNewsBadges({
  widget,
  news,
  onPick,
}: {
  widget: Widget;
  news: readonly ChartNewsEvent[];
  /** The releases of the badge clicked, and the badge. */
  onPick: (ids: readonly string[], badge: HTMLElement) => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const badges = useRef(new Map<string, HTMLButtonElement>());
  const groups = useRef(new Map<string, readonly string[]>());
  const sorted = useMemo(
    () =>
      [...news].sort(
        (a, b) => a.time - b.time || Number(b.impact === "high") - Number(a.impact === "high"),
      ),
    [news],
  );
  const shown = useRef(sorted);
  shown.current = sorted;

  const layer = useMemo(() => {
    return new NewsLayer((rc) => {
      const box = overlay.current;
      const canvas = widget.root.querySelector("canvas");
      const plot = widget.chart.plotRect(widget.chart.primaryPaneIndex());
      for (const badge of badges.current.values()) badge.style.visibility = "hidden";
      groups.current.clear();
      if (!box || !canvas || !plot) return;
      const from = box.getBoundingClientRect();
      const to = canvas.getBoundingClientRect();
      const inView = shown.current.flatMap((n) => {
        const x = rc.timeScale.indexToX(rc.dataLayer.timeToIndexFloat(n.time / 1000));
        return Number.isFinite(x) && x >= 0 && x <= rc.plotWidth ? [{ id: n.id, x }] : [];
      });
      for (const { x, ids } of groupNews(inView, BADGE, BADGE_SPACING)) {
        const [id] = ids;
        const badge = id === undefined ? undefined : badges.current.get(id);
        if (id === undefined || !badge) continue;
        const foot = to.top - from.top + plot.top + rc.plotHeight;
        badge.style.left = `${to.left - from.left + plot.left + x - BADGE / 2}px`;
        badge.style.top = `${foot - BADGE - BADGE_FOOT}px`;
        badge.style.visibility = "visible";
        groups.current.set(id, ids);
        const group = shown.current.filter((n) => ids.includes(n.id));
        const one = group.length === 1 ? group[0] : undefined;
        // The ring says the most that's in it.
        badge.dataset.impact = group.some((n) => n.impact === "high") ? "high" : "medium";
        badge.title = one ? newsLine(one) : t("chart.newsCount", { count: group.length });
        badge.setAttribute("aria-label", one?.title ?? badge.title);
        if (one) delete badge.dataset.count;
        else badge.dataset.count = `x${group.length}`;
      }
    });
  }, [widget]);

  useEffect(() => {
    const { chart } = widget;
    const put = () => {
      chart.removePrimitive(layer);
      chart.addPrimitive(layer, chart.primaryPaneIndex());
    };
    put();
    // A layout put back replaces the panes.
    const stop = chart.on("state:restore:end", put);
    return () => {
      stop();
      if (!widget.isDestroyed) chart.removePrimitive(layer);
    };
  }, [widget, layer]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new list has new buttons to place
  useLayoutEffect(() => layer.update(), [layer, sorted]);

  return (
    <div ref={overlay} className="pd-chart-news-badges">
      {sorted.map((n) => (
        <button
          key={n.id}
          ref={(el) => {
            if (el) badges.current.set(n.id, el);
            else badges.current.delete(n.id);
          }}
          type="button"
          className="pd-chart-news-badge"
          data-impact={n.impact}
          aria-label={n.title}
          title={newsLine(n)}
          onClick={(e) => onPick(groups.current.get(n.id) ?? [n.id], e.currentTarget)}
        >
          <UsdFlag />
        </button>
      ))}
    </div>
  );
}

/**
 * The releases behind a badge on the chart. Text only: this calendar has a
 * forecast and the previous figure, no actuals, and nothing here trades.
 */
export function ChartNewsCard({
  events,
  place,
  onClose,
}: {
  events: readonly ChartNewsEvent[];
  place: ReturnType<typeof newsCardPlace>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A click elsewhere closes it, as Escape does; a badge says for itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointer = (e: PointerEvent) => {
      const on = e.target as Element;
      if (!ref.current?.contains(on) && !on.closest?.(".pd-chart-news-badge")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="pd-chart-news"
      style={place}
      role="dialog"
      aria-label={t("chart.news")}
    >
      <header className="pd-chart-news-head">
        <strong>{t("chart.news")}</strong>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("chart.newsClose")}
          onClick={onClose}
        >
          <LuX size={14} aria-hidden />
        </button>
      </header>
      <ul className="pd-chart-news-list">
        {events.map((e) => (
          <li key={e.id} className="pd-chart-news-item" data-impact={e.impact}>
            <span className="pd-chart-news-impact">{t(`calendar.impact.${e.impact}`)}</span>
            <span className="pd-chart-news-title">{e.title}</span>
            <time className="pd-num pd-chart-news-when" dateTime={new Date(e.time).toISOString()}>
              {dateFormat(WHEN).format(e.time)}
            </time>
            <dl className="pd-chart-news-figures">
              <div>
                <dt className="pd-chart-news-label">{t("calendar.forecast")}</dt>
                <dd className="pd-num pd-chart-news-figure">{e.forecast ?? "—"}</dd>
              </div>
              <div>
                <dt className="pd-chart-news-label">{t("calendar.previous")}</dt>
                <dd className="pd-num pd-chart-news-figure">{e.previous ?? "—"}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
