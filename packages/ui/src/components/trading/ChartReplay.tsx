import type { Bar } from "openalgo-charts";
import { ReplayController, ReplayShade, type ReplayState } from "openalgo-charts";
import type { Widget } from "openalgo-charts/widget";
import { useCallback, useEffect, useRef, useState } from "react";
import { LuHistory, LuPause, LuPlay, LuStepBack, LuStepForward, LuX } from "react-icons/lu";
import { dateFormat, t as tr } from "../../i18n";
import { tokens, withAlpha } from "./chartTheme";

// Bar replay, after TradingView's: pick a bar in the past, the chart is cut
// back to it, and the candles after it play forward one at a time - to
// practise reading price without knowing what came next. The chart library
// does the replaying (`ReplayController` feeds the chart a prefix of its
// bars, so every study redraws as it stood then); this is its controls.
// Display only: a replayed chart places nothing, and its TP / SL lines can't
// be dragged while it plays.

/** Live candles held back while a replay has the chart, put on when it ends. */
export interface LiveGate {
  held: boolean;
  /** The latest update of each candle, by its open time. */
  pending: Map<number, () => void>;
}

export const newLiveGate = (): LiveGate => ({ held: false, pending: new Map() });

/** `gate`'s held updates, oldest candle first, and the gate opened. */
export function releaseGate(gate: LiveGate) {
  gate.held = false;
  const due = [...gate.pending.entries()].sort(([a], [b]) => a - b);
  gate.pending.clear();
  for (const [, put] of due) put();
}

/** Bars a second at 1x; the speeds offered over it. */
const BAR_MS = 1000;
export const REPLAY_SPEEDS = [0.5, 1, 3, 10] as const;

/** The bar a click at `time` (UTC seconds) is on: the last opening at or before it. */
export function barIndexAt(bars: readonly Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid]?.time ?? Number.POSITIVE_INFINITY) <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Bars of space kept right of the newest once playing catches up with the edge. */
const FOLLOW_MARGIN = 5;

/**
 * The chart's right offset (bars from the newest to the right edge; the
 * edge is anchored to the newest) after `delta` new bars, so the view holds
 * still: they fill the space on the right until the newest is
 * `FOLLOW_MARGIN` from the edge, and the chart follows from there. With the
 * newest off to the right (scrolled back) it holds still whatever happens.
 */
export function followOffset(offset: number, delta: number, margin = FOLLOW_MARGIN): number {
  if (delta <= 0 || offset < 0) return offset - delta;
  return Math.max(offset - delta, Math.min(offset, margin));
}

export type ReplayMode = "off" | "picking" | "on";

/**
 * A chart's replay: off, picking the bar to start from (the bars after the
 * pointer shaded; a click starts it, Escape gives up), or on. Ends by itself
 * when the market or interval changes, putting the live candles back.
 */
export function useChartReplay(widget: Widget | null, gate: LiveGate, reset: unknown) {
  const [mode, setMode] = useState<ReplayMode>("off");
  const [state, setState] = useState<ReplayState>();
  const [speed, setSpeed] = useState<number>(1);
  const controller = useRef<ReplayController>(undefined);
  const picking = useRef<() => void>(undefined);

  const stopPicking = useCallback(() => {
    picking.current?.();
    picking.current = undefined;
  }, []);

  /** Gives up picking: back to the replay running, or to live. */
  const cancelPick = useCallback(() => {
    stopPicking();
    setMode(controller.current ? "on" : "off");
  }, [stopPicking]);

  const exit = useCallback(() => {
    stopPicking();
    const running = controller.current;
    controller.current = undefined;
    if (running) {
      running.stop();
      releaseGate(gate);
    }
    setState(undefined);
    setMode("off");
  }, [gate, stopPicking]);

  const begin = useCallback(
    (index: number) => {
      if (!widget || widget.isDestroyed) return;
      stopPicking();
      const scale = widget.chart.timeScale;
      // The bar at the right edge now: the view stays on it, cut or not.
      const edge = widget.series.getData().length - 1 + scale.rightOffset;
      controller.current?.pause();
      // One replay at a time: picking again starts from the live candles.
      if (controller.current) {
        controller.current.stop();
        releaseGate(gate);
      }
      gate.held = true;
      let shown = index;
      controller.current = new ReplayController(widget.chart, {
        startIndex: index,
        barMs: BAR_MS,
        speed,
        onFrame: (frame) => {
          if (frame.index >= 0 && frame.index !== shown) {
            scale.setRightOffset(followOffset(scale.rightOffset, frame.index - shown));
            shown = frame.index;
          }
          setState(frame);
        },
      });
      // Cut at `index`: everything to its right goes, the rest stays put.
      scale.setRightOffset(edge - index);
      setState(controller.current.state());
      setMode("on");
    },
    [widget, gate, speed, stopPicking],
  );

  /** Shades the bars after the pointer, and starts from the one clicked. */
  const pick = useCallback(() => {
    if (!widget || widget.isDestroyed) return;
    controller.current?.pause();
    stopPicking();
    const { chart } = widget;
    const t = tokens(widget.root);
    const shade = new ReplayShade({
      index: null,
      color: withAlpha(t.bg, 0.72),
      lineColor: t.brass,
    });
    chart.addPrimitive(shade, 0);
    const offs = [
      chart.on("crosshair:move", (e) => shade.setOptions({ index: e.index ?? null })),
      // Mid-replay the chart shows the first bars of the same set, so an
      // index on screen is the same bar in the whole.
      chart.on("click", (e) => {
        const index = barIndexAt(widget.series.getData(), e.time);
        if (index >= 0) begin(index);
      }),
    ];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelPick();
    };
    window.addEventListener("keydown", onKey);
    picking.current = () => {
      for (const off of offs) off();
      window.removeEventListener("keydown", onKey);
      chart.removePrimitive(shade);
    };
    setMode("picking");
  }, [widget, begin, stopPicking, cancelPick]);

  // A new market, interval or chart ends it, before the chart moves on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reset` names what ends it
  useEffect(() => exit, [widget, reset, exit]);

  const controls = {
    play: () => controller.current?.play({ speed }),
    pause: () => controller.current?.pause(),
    step: () => controller.current?.step(),
    stepBack: () => controller.current?.stepBack(),
    setSpeed: (next: number) => {
      setSpeed(next);
      if (controller.current?.state().playing) controller.current.play({ speed: next });
    },
  };
  return { mode, state, speed, pick, cancelPick, exit, ...controls };
}

export type ChartReplay = ReturnType<typeof useChartReplay>;

const barTime = (time: number) =>
  dateFormat({
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time * 1000);

/** The transport over the chart: what's picked, and play, step, speed and exit. */
export function ReplayControls({ replay }: { replay: ChartReplay }) {
  const { mode, state } = replay;
  if (mode === "off") return null;
  if (mode === "picking") {
    return (
      <div className="pd-replay" role="toolbar" aria-label={tr("replay.title")}>
        <LuHistory size={15} aria-hidden />
        <span className="pd-replay-hint">{tr("replay.pick")}</span>
        <button type="button" className="pd-chart-tool" onClick={replay.cancelPick}>
          {tr("replay.cancel")}
        </button>
      </div>
    );
  }
  const playing = state?.playing ?? false;
  const atEnd = state ? state.index >= state.total - 1 : true;
  return (
    <div className="pd-replay" role="toolbar" aria-label={tr("replay.title")}>
      <button
        type="button"
        className="pd-chart-tool pd-chart-icon"
        aria-label={tr("replay.pickAgain")}
        title={tr("replay.pickAgain")}
        onClick={replay.pick}
      >
        <LuHistory size={16} aria-hidden />
      </button>
      <button
        type="button"
        className="pd-chart-tool pd-chart-icon"
        aria-label={tr("replay.back")}
        title={tr("replay.back")}
        disabled={!state || state.index <= 0}
        onClick={replay.stepBack}
      >
        <LuStepBack size={16} aria-hidden />
      </button>
      <button
        type="button"
        className="pd-chart-tool pd-chart-icon"
        aria-label={tr(playing ? "replay.pause" : "replay.play")}
        title={tr(playing ? "replay.pause" : "replay.play")}
        disabled={!playing && atEnd}
        onClick={playing ? replay.pause : replay.play}
      >
        {playing ? <LuPause size={16} aria-hidden /> : <LuPlay size={16} aria-hidden />}
      </button>
      <button
        type="button"
        className="pd-chart-tool pd-chart-icon"
        aria-label={tr("replay.forward")}
        title={tr("replay.forward")}
        disabled={atEnd}
        onClick={replay.step}
      >
        <LuStepForward size={16} aria-hidden />
      </button>
      <div className="pd-chart-group" role="radiogroup" aria-label={tr("replay.speed")}>
        {REPLAY_SPEEDS.map((s) => (
          // biome-ignore lint/a11y/useSemanticElements: toolbar-style radio, like the intervals
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={s === replay.speed}
            className="pd-chart-tool"
            onClick={() => replay.setSpeed(s)}
          >
            {s}x
          </button>
        ))}
      </div>
      {state?.bar && <span className="pd-replay-time">{barTime(state.bar.time)}</span>}
      <button
        type="button"
        className="pd-chart-tool"
        aria-label={tr("replay.exit")}
        title={tr("replay.exit")}
        onClick={replay.exit}
      >
        <LuX size={15} aria-hidden />
        {tr("replay.live")}
      </button>
    </div>
  );
}
