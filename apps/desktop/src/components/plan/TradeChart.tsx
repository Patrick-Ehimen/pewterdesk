import type { Candle } from "@pewterdesk/core";
import { formatSignedMoney, t } from "@pewterdesk/ui";
import { useId, useState } from "react";
import { utcTime } from "./parts";

/**
 * How the trade has done since it opened, as a line: its P&L at each candle's
 * close (from the entry, its size and side), green above zero and red below,
 * from zero at the entry to the exit (or the mark, while it's open). The
 * planned stop and target show as what they'd come to. It draws only.
 */
export function TradePnlChart({
  candles,
  interval,
  side,
  size,
  entryPrice,
  exitPrice,
  openedAt,
  closedAt,
  open,
  stop,
  target,
  events = [],
}: {
  candles: readonly Candle[];
  /** The candles' length, ms. */
  interval: number;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  /** The exit, or the mark while open. */
  exitPrice: number;
  openedAt?: number;
  closedAt: number;
  open?: boolean;
  stop?: number;
  target?: number;
  events?: readonly { at: number; label: string }[];
}) {
  const [hover, setHover] = useState<number>();
  const id = useId();
  const dir = side === "long" ? 1 : -1;
  const pnlAt = (price: number) => (price - entryPrice) * size * dir;
  const from = openedAt ?? candles[0]?.openTime ?? closedAt;
  const points = [
    { at: from, pnl: 0 },
    ...candles
      .map((c) => ({ at: c.openTime + interval, pnl: pnlAt(Number(c.close)) }))
      .filter((p) => p.at > from && p.at < closedAt),
    { at: closedAt, pnl: pnlAt(exitPrice) },
  ];
  if (!(size > 0) || !(entryPrice > 0) || points.length < 2)
    return <p className="jr-empty">{t("plan.td.noCandles")}</p>;

  const W = 900;
  const H = 300;
  const pad = { l: 8, r: 84, t: 18, b: 26 };
  const levels = [
    stop !== undefined && { label: t("plan.td.stop"), pnl: pnlAt(stop), tone: "down" as const },
    target !== undefined && { label: t("plan.td.target"), pnl: pnlAt(target), tone: "up" as const },
  ].filter(Boolean) as { label: string; pnl: number; tone: "up" | "down" }[];
  const values = [0, ...points.map((p) => p.pnl), ...levels.map((l) => l.pnl)];
  let hi = Math.max(...values);
  let lo = Math.min(...values);
  const margin = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
  hi += margin;
  lo -= margin;
  const t0 = points[0]?.at ?? from;
  const t1 = Math.max(t0 + 1, closedAt);
  const x = (ms: number) => pad.l + ((W - pad.l - pad.r) * (ms - t0)) / (t1 - t0);
  const y = (v: number) => pad.t + ((H - pad.t - pad.b) * (hi - v)) / Math.max(1e-12, hi - lo);
  const zero = y(0);
  const line = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.pnl).toFixed(1)}`)
    .join("");
  const area = `${line}L${x(t1).toFixed(1)},${zero.toFixed(1)}L${x(t0).toFixed(1)},${zero.toFixed(1)}Z`;
  const last = points[points.length - 1] ?? { at: closedAt, pnl: 0 };
  const shown = hover === undefined ? undefined : points[hover];
  const ticks = 4;
  const timeTicks = 6;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the pointer only moves a readout; nothing here acts
    <div
      className="jr-pnlchart-wrap"
      onMouseMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const ms =
          t0 +
          ((((e.clientX - box.left) / box.width) * W - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
        let best = 0;
        points.forEach((p, i) => {
          if (Math.abs(p.at - ms) < Math.abs((points[best]?.at ?? 0) - ms)) best = i;
        });
        setHover(best);
      }}
      onMouseLeave={() => setHover(undefined)}
    >
      <svg
        className="jr-tradechart jr-pnlchart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("plan.td.pnlChart")}
      >
        <defs>
          <clipPath id={`${id}-up`}>
            <rect x={0} y={0} width={W} height={Math.max(0, zero)} />
          </clipPath>
          <clipPath id={`${id}-down`}>
            <rect x={0} y={zero} width={W} height={Math.max(0, H - zero)} />
          </clipPath>
          <linearGradient
            id={`${id}-gu`}
            x1="0"
            x2="0"
            y1={pad.t}
            y2={zero}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" className="jr-pnl-stop-up" stopOpacity="0.32" />
            <stop offset="1" className="jr-pnl-stop-up" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient
            id={`${id}-gd`}
            x1="0"
            x2="0"
            y1={zero}
            y2={H - pad.b}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" className="jr-pnl-stop-down" stopOpacity="0.02" />
            <stop offset="1" className="jr-pnl-stop-down" stopOpacity="0.32" />
          </linearGradient>
        </defs>

        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = lo + ((hi - lo) * i) / ticks;
          // An axis label the current value's tag would cover is left out.
          const covered = Math.abs(y(v) - y(last.pnl)) < 16;
          return (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="jr-grid" />
              {!covered && (
                <text x={W - pad.r + 6} y={y(v)} dominantBaseline="central" className="jr-tick">
                  {formatSignedMoney(v)}
                </text>
              )}
            </g>
          );
        })}
        {Array.from({ length: timeTicks }, (_, i) => {
          const ms = t0 + ((t1 - t0) * (i + 0.5)) / timeTicks;
          return (
            <text key={ms} x={x(ms)} y={H - 8} textAnchor="middle" className="jr-tick">
              {utcTime(ms)}
            </text>
          );
        })}
        {events.map((e) =>
          e.at >= t0 && e.at <= t1 ? (
            <g key={`${e.at}:${e.label}`}>
              <line x1={x(e.at)} x2={x(e.at)} y1={pad.t} y2={H - pad.b} className="jr-event-line" />
              <text x={x(e.at) + 4} y={pad.t + 10} className="jr-event-text">
                {e.label}
              </text>
            </g>
          ) : null,
        )}
        {levels.map((l) => (
          <g key={l.label} className="jr-level" data-tone={l.tone}>
            <line x1={pad.l} x2={W - pad.r} y1={y(l.pnl)} y2={y(l.pnl)} />
            <text x={pad.l + 4} y={y(l.pnl) - 4}>
              {l.label} {formatSignedMoney(l.pnl)}
            </text>
          </g>
        ))}

        <line x1={pad.l} x2={W - pad.r} y1={zero} y2={zero} className="jr-pnl-zero" />
        <path d={area} fill={`url(#${id}-gu)`} clipPath={`url(#${id}-up)`} />
        <path d={area} fill={`url(#${id}-gd)`} clipPath={`url(#${id}-down)`} />
        <path d={line} className="jr-pnl-line" data-tone="up" clipPath={`url(#${id}-up)`} />
        <path d={line} className="jr-pnl-line" data-tone="down" clipPath={`url(#${id}-down)`} />

        <circle cx={x(t0)} cy={zero} r={4} className="jr-pnl-entry" />
        <g
          className="jr-pnl-end"
          data-tone={last.pnl >= 0 ? "up" : "down"}
          data-open={open || undefined}
        >
          {open && <circle cx={x(last.at)} cy={y(last.pnl)} r={9} className="jr-pnl-pulse" />}
          <circle cx={x(last.at)} cy={y(last.pnl)} r={4.5} />
          {/* The current value as a tag on the axis, not over the line's end. */}
          <line
            x1={x(last.at)}
            x2={W - pad.r + 2}
            y1={y(last.pnl)}
            y2={y(last.pnl)}
            className="jr-pnl-tagline"
          />
          <rect
            x={W - pad.r + 2}
            y={y(last.pnl) - 10}
            width={pad.r - 4}
            height={20}
            rx={4}
            className="jr-pnl-tag"
          />
          <text
            x={W - pad.r + 2 + (pad.r - 4) / 2}
            y={y(last.pnl)}
            textAnchor="middle"
            dominantBaseline="central"
            className="jr-pnl-tagtext"
          >
            {formatSignedMoney(last.pnl)}
          </text>
        </g>

        {shown && (
          <g className="jr-pnl-hover" data-tone={shown.pnl >= 0 ? "up" : "down"}>
            <line x1={x(shown.at)} x2={x(shown.at)} y1={pad.t} y2={H - pad.b} />
            <circle cx={x(shown.at)} cy={y(shown.pnl)} r={4} />
          </g>
        )}
      </svg>
      {shown && (
        <div
          className="jr-pnl-tip"
          data-tone={shown.pnl >= 0 ? "up" : "down"}
          style={{ left: `${(x(shown.at) / W) * 100}%` }}
        >
          <span className="pd-num">{utcTime(shown.at)} UTC</span>
          <strong className="pd-num">{formatSignedMoney(shown.pnl)}</strong>
        </div>
      )}
    </div>
  );
}
