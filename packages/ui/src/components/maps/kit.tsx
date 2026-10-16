import type { Market } from "@pewterdesk/core";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n";
import { formatNumber } from "../../lib/format";
import { EmptyState } from "../common/Status";

// What the Maps page's smaller views share: one frame (a title bar of
// controls, the map, a line on where the numbers come from), a segmented
// control, a colour scale and a hover card.

/**
 * Width and height of an element, tracked as it resizes. A callback ref, so
 * an element that mounts later (after a loading state) is still measured.
 */
export function useSize<T extends HTMLElement>() {
  const [el, ref] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [ref, size] as const;
}

/**
 * A market's name on a map: its coin, or its full symbol where two of the
 * markets shown share a coin (a venue listing one in two quote currencies).
 */
export function labelsOf(markets: readonly Market[]): (market: Market) => string {
  const counts = new Map<string, number>();
  for (const m of markets) counts.set(m.base, (counts.get(m.base) ?? 0) + 1);
  return (m) => ((counts.get(m.base) ?? 0) > 1 ? m.symbol : m.base);
}

/** "History 120 / 340" while every market's candles are still arriving. */
export function HistoryProgress({ done, total }: { done: number; total: number }) {
  if (total === 0 || done >= total) return null;
  return (
    <span className="pd-muted pd-num" role="status">
      {t("mapx.historyLoading", { done: Math.min(done, total), total })}
    </span>
  );
}

/** A compact radio group, after the other maps' window pickers. */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
  text = (o) => o.toUpperCase(),
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  text?: (option: T) => string;
}) {
  return (
    <div className="pd-map-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: compact segmented control
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={o === value}
          data-checked={o === value || undefined}
          onClick={() => onChange(o)}
        >
          {text(o)}
        </button>
      ))}
    </div>
  );
}

/**
 * A view's frame: the title and controls on one line, the map filling the
 * rest, and a note under it. `state` stands in for the map while there's
 * nothing to draw (loading, an error, nothing yet).
 */
export function MapFrame({
  title,
  controls,
  legend,
  note,
  state,
  side,
  children,
}: {
  title: ReactNode;
  controls?: ReactNode;
  legend?: ReactNode;
  note?: ReactNode;
  state?: ReactNode;
  side?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="pd-mx">
      <section className="pd-mx-main">
        <div className="pd-mx-bar">
          <h2>{title}</h2>
          {controls}
          {legend && <span className="pd-mx-legend">{legend}</span>}
        </div>
        <div className="pd-mx-body">{state ?? children}</div>
        {note && <p className="pd-mx-note">{note}</p>}
      </section>
      {side && <aside className="pd-mx-side">{side}</aside>}
    </div>
  );
}

/** The frame's stand-in: a loader with progress, or a message. */
export function MapState({
  loader,
  progress,
  message,
  error,
}: {
  loader?: ReactNode;
  progress?: { done: number; total: number };
  message?: ReactNode;
  error?: string;
}) {
  if (error) return <EmptyState error>{error}</EmptyState>;
  if (message) return <EmptyState>{message}</EmptyState>;
  return (
    <div className="pd-mx-loading" role="status" aria-label={t("feed.loading")}>
      {loader}
      {progress && progress.total > 0 && (
        <span className="pd-muted pd-num">
          {t("mapx.progress", { done: progress.done, total: progress.total })}
        </span>
      )}
    </div>
  );
}

export type Tone = "up" | "down" | "info" | "warn" | "flat";

/**
 * A tile's colour: `value` against `scale` picks how strong (`--mix`), its
 * sign which tone, up and down by default.
 */
export function heat(
  value: number | undefined,
  scale: number,
  tones: [Tone, Tone] = ["up", "down"],
): { style: CSSProperties; "data-heat": Tone } {
  if (value === undefined || !Number.isFinite(value) || scale <= 0) {
    return { style: { "--mix": "0%" } as CSSProperties, "data-heat": "flat" };
  }
  const strength = Math.min(Math.abs(value) / scale, 1);
  return {
    style: { "--mix": `${Math.round(12 + strength * 63)}%` } as CSSProperties,
    "data-heat": value >= 0 ? tones[0] : tones[1],
  };
}

/** A ratio as a signed percentage: "+1.24%". */
export function signedPct(ratio: number | undefined, decimals = 2): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "-";
  const text = formatNumber(ratio * 100, decimals);
  return `${ratio > 0 ? "+" : ""}${text}%`;
}

/** A floating card that follows the pointer within `box`, flipping at the edges. */
export function HoverCard({
  at,
  box,
  children,
}: {
  at: { x: number; y: number };
  box: { width: number; height: number };
  children: ReactNode;
}) {
  return (
    <div
      className="pd-map-card pd-mx-tip"
      style={{
        left: at.x + 240 > box.width ? Math.max(at.x - 232, 4) : at.x + 14,
        top: Math.min(Math.max(at.y - 24, 4), Math.max(box.height - 170, 4)),
      }}
      aria-hidden
    >
      {children}
    </div>
  );
}

/** A pointer position relative to the element's offset parent. */
export function pointerIn(e: { clientX: number; clientY: number; currentTarget: Element }) {
  const box = (e.currentTarget.closest(".pd-mx-body") ?? e.currentTarget).getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
}
