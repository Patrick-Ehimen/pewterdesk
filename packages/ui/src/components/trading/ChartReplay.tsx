import type { CandleInterval } from "@pewterdesk/core";
import type { Bar } from "openalgo-charts";
import { ReplayController, ReplayShade, type ReplayState } from "openalgo-charts";
import type { Widget } from "openalgo-charts/widget";
import { useCallback, useEffect, useRef, useState } from "react";
import { LuHistory, LuPause, LuPlay, LuStepBack, LuStepForward, LuX } from "react-icons/lu";
import { dateFormat, t as tr } from "../../i18n";
import { INTERVAL_MS } from "../../lib/chart";
import { chartCode } from "../../lib/openAlgoChart";
import { tokens, withAlpha } from "./chartTheme";

// Bar replay, after TradingView's: pick a bar in the past, the chart is cut
// back to it, and the candles after it play forward one at a time - to
// practise reading price without knowing what came next. The chart library
// does the replaying (`ReplayController` feeds the chart a prefix of its
// bars, so every study redraws as it stood then); this is its controls.
// A replayed chart places nothing itself, and its TP / SL lines can't be
// dragged while it plays. It says what it's showing (`onSession`), so the app
// can run its replay account on those candles: nothing here reaches a venue.
//
// A replay is a moment in time, not a place in one interval's candles: a new
// interval goes on from the same moment, on that interval's candles around it,
// showing only those closed by then. So it never gives away what came next.

/** What a replay has on screen: the whole set of bars and the newest shown. */
export interface ReplayProgress {
  /** New for each start. */
  id: number;
  bars: readonly Bar[];
  index: number;
  /** UTC seconds: the moment on screen, when the newest candle closed. */
  time: number;
}

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

/** Numbers each replay started, on any chart. */
let sessions = 0;

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

/** When the bar at `i` closes: the next one's open, or the last one's length on from its own. */
export function barEnd(bars: readonly Pick<Bar, "time">[], i: number): number {
  const bar = bars[i];
  if (!bar) return Number.NaN;
  const next = bars[i + 1];
  if (next) return next.time;
  const before = bars[i - 1];
  return bar.time + (before ? bar.time - before.time : 0);
}

/** The newest bar closed by `time`, or -1: any later one hadn't finished by then. */
export function lastClosedAt(bars: readonly Pick<Bar, "time">[], time: number): number {
  for (let i = bars.length - 1; i >= 0; i--) if (barEnd(bars, i) <= time) return i;
  return -1;
}

/** Candles fetched around the moment on a new interval, and how many are still to come. */
const WINDOW_BARS = 1000;
const AHEAD_BARS = 300;
/** How long a new interval's own candles may take, before going on without them. */
const SETTLE_MS = 8000;

/** The chart's own load of `code` has finished: it can't land on a replay after this. */
function settled(widget: Widget, code: string) {
  return new Promise<void>((done) => {
    const data = widget.dataController;
    const ready = () => {
      const state = data?.getState();
      if (!state) return true;
      const busy = state.status === "loading" || state.status === "refreshing";
      return state.request?.interval === code && !busy;
    };
    if (ready()) return done();
    const finish = () => {
      clearTimeout(limit);
      off?.();
      done();
    };
    const limit = setTimeout(finish, SETTLE_MS);
    const off = data?.subscribe(() => {
      if (ready()) finish();
    });
  });
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
 * pointer shaded; a click starts it, Escape gives up), or on. A new interval
 * carries on from the same moment; a new market ends it, putting the live
 * candles back.
 */
export function useChartReplay(
  widget: Widget | null,
  gate: LiveGate,
  reset: unknown,
  interval: CandleInterval,
  /** Up to `count` candles of `interval` that opened before `before` (UTC seconds). */
  load: (interval: CandleInterval, before: number, count: number) => Promise<Bar[]>,
  /** Takes the chart back to an interval: the one asked for has nothing that far back. */
  onInterval: (interval: CandleInterval) => void,
  onSession?: (progress: ReplayProgress | undefined) => void,
) {
  const [mode, setMode] = useState<ReplayMode>("off");
  const [state, setState] = useState<ReplayState>();
  const [speed, setSpeed] = useState<number>(1);
  /** Fetching the candles to go on with: the chart is covered until they're on. */
  const [switching, setSwitching] = useState(false);
  const [notice, setNotice] = useState<string>();
  const controller = useRef<ReplayController>(undefined);
  const picking = useRef<() => void>(undefined);
  const told = useRef(onSession);
  told.current = onSession;
  const latest = useRef({ interval, load, onInterval, speed });
  latest.current = { interval, load, onInterval, speed };
  /** The session running, across its intervals. */
  const session = useRef<number>(undefined);
  /** The moment on screen. */
  const clock = useRef(0);
  /** Only the newest `resume` may finish. */
  const attempt = useRef(0);
  /** Playing when the candles were taken off, so it goes on. */
  const playOn = useRef(false);
  /** The interval is going back to where there are candles: not the trader's change. */
  const goingBack = useRef(false);

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
    attempt.current++;
    const running = controller.current;
    const was = session.current;
    controller.current = undefined;
    session.current = undefined;
    running?.stop();
    if (was !== undefined) {
      releaseGate(gate);
      told.current?.(undefined);
    }
    setSwitching(false);
    setNotice(undefined);
    setState(undefined);
    setMode("off");
  }, [gate, stopPicking]);

  /** Runs `bars` from `index`. The newest candles reached ask for the next ones. */
  const run = useCallback(
    (
      chartWidget: Widget,
      id: number,
      bars: readonly Bar[],
      index: number,
      time: number,
      onEnd: (playing: boolean) => void,
    ) => {
      const scale = chartWidget.chart.timeScale;
      const last = bars.length - 1;
      const toLive = barEnd(bars, last) * 1000 > Date.now();
      let shown = index;
      let playing = false;
      clock.current = time;
      told.current?.({ id, bars, index, time });
      controller.current = new ReplayController(chartWidget.chart, {
        bars,
        startIndex: index,
        barMs: BAR_MS,
        speed: latest.current.speed,
        onFrame: (frame) => {
          if (frame.index >= 0 && frame.index !== shown) {
            scale.setRightOffset(followOffset(scale.rightOffset, frame.index - shown));
            shown = frame.index;
            clock.current = barEnd(bars, frame.index);
            told.current?.({ id, bars, index: frame.index, time: clock.current });
          }
          setState(frame);
          if (!toLive && frame.index >= last) onEnd(playing);
          playing = frame.playing;
        },
      });
      setState(controller.current.state());
    },
    [],
  );

  /**
   * Goes on from the moment on screen, on the current interval's candles
   * around it. Fetched for it, not paged back to: the chart's own stay as they
   * are, ready for the way back to live. `back` is where to go if there are none.
   */
  const resume = useCallback(
    async (playing: boolean, back?: CandleInterval) => {
      const id = session.current;
      if (!widget || widget.isDestroyed || id === undefined) return;
      const mine = ++attempt.current;
      const time = clock.current;
      const code = chartCode(latest.current.interval);
      const scale = widget.chart.timeScale;
      const offset = controller.current ? scale.rightOffset : FOLLOW_MARGIN * 2;
      playOn.current ||= playing;
      setSwitching(true);
      let bars: Bar[] = [];
      try {
        await settled(widget, code);
        const { interval: shown, load: fetch } = latest.current;
        const ahead = (INTERVAL_MS[shown] / 1000) * AHEAD_BARS;
        const before = Math.min(time + ahead, Math.ceil(Date.now() / 1000) + 1);
        bars = await fetch(shown, before, WINDOW_BARS);
      } catch {
        bars = [];
      }
      if (mine !== attempt.current || widget.isDestroyed) return;
      const index = lastClosedAt(bars, time);
      if (index < 0) {
        playOn.current = false;
        // Nothing to go on with: stay in the replay if there's somewhere to stay.
        if (back) {
          setNotice(tr("replay.noHistory"));
          goingBack.current = true;
          latest.current.onInterval(back);
        } else if (controller.current) {
          setSwitching(false);
        } else exit();
        return;
      }
      const go = playOn.current;
      playOn.current = false;
      controller.current?.stop();
      run(widget, id, bars, index, time, (more) => void resume(more));
      scale.setRightOffset(offset);
      if (go) controller.current?.play({ speed: latest.current.speed });
      setState(controller.current?.state());
      setMode("on");
      setSwitching(false);
    },
    [widget, exit, run],
  );

  const begin = useCallback(
    (time: number) => {
      if (!widget || widget.isDestroyed) return;
      stopPicking();
      attempt.current++;
      const scale = widget.chart.timeScale;
      // The bar at the right edge now: the view stays on it, cut or not.
      const edge = widget.series.getData().length - 1 + scale.rightOffset;
      controller.current?.pause();
      // One replay at a time: picking again starts from the live candles.
      if (controller.current) {
        controller.current.stop();
        controller.current = undefined;
        releaseGate(gate);
      }
      gate.held = true;
      const bars = [...widget.series.getData()];
      const index = barIndexAt(bars, time);
      const id = ++sessions;
      session.current = id;
      setNotice(undefined);
      setSwitching(false);
      // Further back than the chart has loaded (a replay had reached there):
      // a candle's length on from the click, so the one clicked is the newest.
      if (index < 0) {
        clock.current = time + INTERVAL_MS[latest.current.interval] / 1000;
        void resume(false);
        return;
      }
      run(widget, id, bars, index, barEnd(bars, index), (more) => void resume(more));
      // Cut at `index`: everything to its right goes, the rest stays put.
      scale.setRightOffset(edge - index);
      setMode("on");
    },
    [widget, gate, stopPicking, run, resume],
  );

  /** Shades the bars after the pointer, and starts from the one clicked. */
  const pick = useCallback(() => {
    if (!widget || widget.isDestroyed) return;
    controller.current?.pause();
    if (controller.current) setState(controller.current.state());
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
      chart.on("click", (e) => begin(e.time)),
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

  // A new market or chart ends it, before the chart moves on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reset` names what ends it
  useEffect(() => exit, [widget, reset, exit]);

  // A new interval goes on from the same moment: its candles off the chart
  // now, as the chart moves to the new interval, and put back from there.
  const onScreen = useRef(interval);
  useEffect(() => {
    const was = onScreen.current;
    onScreen.current = interval;
    if (was === interval) return;
    if (picking.current) cancelPick();
    if (session.current === undefined) return;
    const running = controller.current;
    const playing = running?.state().playing ?? false;
    // Updates of the old interval's candles mean nothing on the new one.
    gate.pending.clear();
    running?.stop();
    controller.current = undefined;
    // Back where it came from, it says why and has nowhere further to go.
    const returning = goingBack.current;
    goingBack.current = false;
    if (!returning) setNotice(undefined);
    void resume(playing, returning ? undefined : was);
  }, [interval, gate, cancelPick, resume]);

  // Play and pause only say so through a frame while frames run: one that
  // stops them leaves the button showing what was.
  const refresh = () => {
    if (controller.current) setState(controller.current.state());
  };
  const controls = {
    play: () => {
      controller.current?.play({ speed });
      refresh();
    },
    pause: () => {
      controller.current?.pause();
      refresh();
    },
    step: () => controller.current?.step(),
    stepBack: () => controller.current?.stepBack(),
    setSpeed: (next: number) => {
      setSpeed(next);
      if (controller.current?.state().playing) controller.current.play({ speed: next });
    },
  };
  return { mode, state, speed, switching, notice, pick, cancelPick, exit, ...controls };
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
      {replay.notice && <span className="pd-replay-hint">{replay.notice}</span>}
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
