import type { RunResult } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useMemo } from "react";

const W = 600;
const PRICE_H = 250;
const PANE_H = 80;
const GAP = 26;

const TONES = ["info", "warning", "brass", "muted"] as const;

/**
 * A stretch of the preview run: its candles, the averages the entry reads
 * over them, an oscillator (an RSI) beneath with the level a rule compares
 * it with, and where every entry condition held (filled) or only the first
 * did (hollow). It only draws.
 */
export function SignalsChart({
  run,
  level,
  span = 140,
}: {
  run: RunResult;
  /** The value a rule compares the oscillator with, drawn as a dashed line. */
  level?: number;
  span?: number;
}) {
  const view = useMemo(() => {
    const n = run.bars.length;
    const passed = run.funnel?.passed ?? [];
    const filtered = run.funnel?.filtered ?? [];
    // End a little after the latest signal, so it's in view with what led to it.
    const last = passed.at(-1) ?? filtered.at(-1) ?? n - 1;
    const to = Math.min(n, last + Math.round(span * 0.15) + 1);
    const from = Math.max(0, to - span);
    const bars = run.bars.slice(from, to);
    const overlays = (run.studies ?? [])
      .filter((s) => !s.pane)
      .slice(0, 3)
      .map((s, k) => ({
        name: s.name,
        tone: TONES[k] ?? "muted",
        values: s.values.slice(from, to),
      }));
    const pane = (run.studies ?? []).find((s) => s.pane);
    const paneValues = pane?.values.slice(from, to);
    const prices = [
      ...bars.flatMap((b) => [b.high, b.low]),
      ...overlays.flatMap((o) => o.values.filter((v): v is number => v != null)),
    ];
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const inView = (i: number) => i >= from && i < to;
    return {
      from,
      bars,
      overlays,
      pane: pane && paneValues ? { name: pane.name, values: paneValues } : undefined,
      lo,
      hi: hi > lo ? hi : lo + 1,
      passed: passed.filter(inView).map((i) => i - from),
      filtered: filtered.filter(inView).map((i) => i - from),
    };
  }, [run, span]);

  const { bars, lo, hi } = view;
  if (bars.length < 2) return <p className="lab-dim lab-pad">{t("bt.side.noSignals")}</p>;
  const H = PRICE_H + (view.pane ? GAP + PANE_H : 0);
  const step = W / bars.length;
  const x = (i: number) => i * step + step / 2;
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (PRICE_H - 16);
  const line = (values: readonly (number | null | undefined)[], yy: (v: number) => number) =>
    values
      .map((v, i) =>
        v == null
          ? ""
          : `${values[i - 1] == null ? "M" : "L"}${x(i).toFixed(1)},${yy(v).toFixed(1)}`,
      )
      .join("");
  const paneTop = PRICE_H + GAP;
  const paneVals = view.pane?.values.filter((v): v is number => v != null) ?? [];
  const pLo = Math.min(...paneVals, level ?? Infinity);
  const pHi = Math.max(...paneVals, level ?? -Infinity);
  const py = (v: number) => paneTop + 4 + (1 - (v - pLo) / (pHi - pLo || 1)) * (PANE_H - 8);
  const first = bars[0];
  const lastBar = bars.at(-1);
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const tick = (v: number) =>
    v >= 1000
      ? `${Math.round(v / 1000)}k`
      : v.toLocaleString("en-US", { maximumFractionDigits: 2 });

  return (
    <div className="lab-signals">
      <div className="lab-signals-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {bars.map((b, i) => (
            <g key={b.time} className={b.close >= b.open ? "up" : "dn"}>
              <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} />
              <rect
                x={x(i) - step * 0.32}
                width={step * 0.64}
                y={Math.min(y(b.open), y(b.close))}
                height={Math.max(0.8, Math.abs(y(b.open) - y(b.close)))}
              />
            </g>
          ))}
          {view.overlays.map((o) => (
            <path key={o.name} className={`lab-sig-line ${o.tone}`} d={line(o.values, y)} />
          ))}
          {view.filtered.map((i) => {
            const b = bars[i];
            return b ? (
              <path
                key={`f${i}`}
                className="lab-sig-filtered"
                d={`M${x(i)},${y(b.low) + 6} l5,9 l-10,0 z`}
              />
            ) : null;
          })}
          {view.passed.map((i) => {
            const b = bars[i];
            return b ? (
              <path
                key={`p${i}`}
                className="lab-sig-passed"
                d={`M${x(i)},${y(b.low) + 6} l6,10 l-12,0 z`}
              />
            ) : null;
          })}
          {view.pane && (
            <>
              <rect className="lab-sig-panebg" x={0} y={paneTop} width={W} height={PANE_H} />
              {level !== undefined && (
                <line className="lab-sig-level" x1={0} x2={W} y1={py(level)} y2={py(level)} />
              )}
              <path className="lab-sig-pane" d={line(view.pane.values, py)} />
            </>
          )}
        </svg>
        <div className="lab-signals-axis" aria-hidden="true">
          <span style={{ top: `${(y(hi) / H) * 100}%` }}>{tick(hi)}</span>
          <span style={{ top: `${(y((hi + lo) / 2) / H) * 100}%` }}>{tick((hi + lo) / 2)}</span>
          {view.pane && level !== undefined && (
            <span className="brass" style={{ top: `${(py(level) / H) * 100}%` }}>
              {level}
            </span>
          )}
        </div>
        {view.pane && (
          <span className="lab-signals-pane" style={{ top: `${(paneTop / H) * 100}%` }}>
            {view.pane.name}
          </span>
        )}
      </div>
      <div className="lab-signals-foot">
        <span>{first ? day(first.time) : ""}</span>
        <span>{lastBar ? day(lastBar.time) : ""}</span>
      </div>
      <div className="lab-signals-key">
        <span className="passed">▲ {t("bt.side.passes")}</span>
        <span className="filtered">△ {t("bt.side.filtered")}</span>
        {view.overlays.map((o) => (
          <span key={o.name} className={`lab-line-key ${o.tone}`}>
            <i />
            {o.name}
          </span>
        ))}
      </div>
    </div>
  );
}
