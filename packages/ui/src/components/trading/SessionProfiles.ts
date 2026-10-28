import {
  type Bar,
  getChartType,
  type IPrimitive,
  type PrimitiveHost,
  type PrimitiveRenderContext,
  registerChartType,
} from "openalgo-charts";
import {
  computeMarketProfile,
  computeVolumeProfileSessions,
  MarketProfile,
  type MarketProfileSession,
  VolumeProfile,
} from "openalgo-charts/profile";
import { type Tokens, withAlpha } from "./chartTheme";

// Two chart types after TradingView's: Session volume profile (the candles,
// with each session's volume at price behind them) and Time price
// opportunity (each session's TPO letters in place of the candles). Both are
// the chart library's own profiles, worked out from the candles the chart
// has: no other data. The types are registered with the library, so they
// sit in its chart type list and are kept with the layout like the rest;
// one primitive on the price pane draws whichever is picked, and nothing
// for the others.

export const SESSION_PROFILE_TYPE = "session-volume-profile";
export const TPO_TYPE = "tpo";

/** Whether `type` is one of these, and so draws a profile. */
export const isProfileType = (type: string) => type === SESSION_PROFILE_TYPE || type === TPO_TYPE;

let registered = false;

/** Puts the two types in the library's list. Before a chart restores a layout that uses one. */
export function registerProfileChartTypes() {
  if (registered) return;
  registered = true;
  // The candles, as the candlestick type draws them.
  registerChartType(SESSION_PROFILE_TYPE, { ...getChartType("candlestick") });
  // No candles: the letters are the chart. Their range still frames it.
  registerChartType(TPO_TYPE, {
    defaultStyle: getChartType("candlestick").defaultStyle,
    isPriceSeries: true,
    draw: () => {},
    extents: (bar) => ({ min: bar.low, max: bar.high }),
  });
}

const DAY = 86_400;

/** How the bars are grouped into sessions, by how wide they are (TradingView's choice). */
function sessionFor(barSeconds: number): MarketProfileSession {
  if (barSeconds <= 30 * 60) return "day";
  if (barSeconds <= 4 * 3600) return "week";
  if (barSeconds <= 3 * DAY) return "month";
  return "composite";
}

/** A TPO period: half an hour in a day, longer for longer sessions, never under a bar. */
function blockMinutes(session: MarketProfileSession, barSeconds: number): number {
  const bar = Math.round(barSeconds / 60);
  if (session === "day") return Math.max(30, bar);
  if (session === "week") return Math.max(240, bar);
  if (session === "month") return Math.max(1440, bar);
  return bar;
}

/** The bars' usual width in seconds: the commonest gap between neighbours. */
export function barWidth(bars: readonly Bar[]): number {
  const counts = new Map<number, number>();
  for (let i = Math.max(1, bars.length - 200); i < bars.length; i++) {
    const gap = (bars[i]?.time ?? 0) - (bars[i - 1]?.time ?? 0);
    if (gap > 0) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best = 60;
  let most = 0;
  for (const [gap, n] of counts) {
    if (n > most) {
      best = gap;
      most = n;
    }
  }
  return best;
}

/** Which session (by UTC calendar) a bar's time falls in, as a key. */
export function sessionKey(time: number, session: MarketProfileSession): number {
  const day = Math.floor(time / DAY);
  if (session === "day") return day;
  // Weeks start on Monday: day 0 (1970-01-01) was a Thursday.
  if (session === "week") return Math.floor((day + 3) / 7);
  if (session === "month") {
    const d = new Date(time * 1000);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  return 0;
}

/** 1, 2, 2.5 or 5 times a power of ten: the step nearest above `raw`. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10;
  return step * power;
}

/**
 * How tall a profile row is: a usual session's range in about `rows` rows,
 * on a round number and a whole number of ticks.
 */
export function rowSize(
  bars: readonly Bar[],
  session: MarketProfileSession,
  rows: number,
  tick: number,
): number {
  const ranges = new Map<number, { high: number; low: number }>();
  for (const b of bars) {
    const key = sessionKey(b.time, session);
    const r = ranges.get(key);
    if (r) {
      r.high = Math.max(r.high, b.high);
      r.low = Math.min(r.low, b.low);
    } else ranges.set(key, { high: b.high, low: b.low });
  }
  const spans = [...ranges.values()].map((r) => r.high - r.low).sort((a, b) => a - b);
  const median = spans[Math.floor(spans.length / 2)] ?? 0;
  const step = tick > 0 ? tick : 0;
  if (!(median > 0)) return step || 1;
  const size = niceStep(median / rows);
  return step > 0 ? Math.max(step, Math.round(size / step) * step) : size;
}

/** Rows a session's range is split into. */
const VOLUME_ROWS = 40;
const TPO_ROWS = 30;
/** Most bars a profile is worked out from: the sessions on screen and those just before. */
const MAX_BARS = 6000;
/** A forming candle's ticks redraw the profile at most this often. */
const LIVE_MS = 1000;

/**
 * The one primitive a chart's price pane carries for these types. It draws
 * the library's `VolumeProfile` or `MarketProfile` (never attached
 * themselves, so sizing them as it draws asks for no further frame), sized
 * to the sessions on screen.
 */
export class SessionProfile implements IPrimitive {
  private host: PrimitiveHost | null = null;
  private readonly volume = new VolumeProfile();
  private readonly tpo = new MarketProfile();
  private tick = 0;
  /** What the profile was last worked out from, and when. */
  private key = "";
  private at = 0;
  /** The widest session's bars, for sizing the histogram or letters to it. */
  private sessionBars = 1;
  private mostTpos = 1;

  /** `type` reads the chart type now picked. */
  constructor(private readonly type: () => string) {}

  attached(host: PrimitiveHost) {
    this.host = host;
  }
  detached() {
    this.host = null;
  }
  zOrder() {
    return this.type() === TPO_TYPE ? ("normal" as const) : ("bottom" as const);
  }

  /** The market's tick: rows are a whole number of them. */
  setTick(tick: number) {
    if (tick === this.tick) return;
    this.tick = tick;
    this.key = "";
    this.host?.requestUpdate();
  }

  /** Colours from the app's theme tokens. */
  setColors(t: Tokens) {
    this.volume.setOptions({
      displayMode: "buySell",
      side: "left",
      opacity: 0.45,
      barColor: t.muted,
      buyColor: t.up,
      sellColor: t.down,
      pocColor: t.brass,
      vahColor: t.muted,
      valColor: t.muted,
      valueAreaFillColor: t.muted,
      valueAreaFillOpacity: 0.06,
      valueAreaOpacityDim: 0.5,
    });
    this.tpo.setOptions({
      colorMode: "valueArea",
      color: t.muted,
      vaColor: t.info,
      pocColor: t.brass,
      vahColor: t.muted,
      valColor: t.muted,
      valueAreaFillColor: t.info,
      ibColor: t.info,
      singlePrintColor: t.warning,
      buyTailColor: t.up,
      sellTailColor: t.down,
      poorColor: t.warning,
      nakedColor: t.brass,
      developingPocColor: t.brass,
      developingVaColor: t.info,
      sessionOpenColor: t.line,
      lastPriceColor: t.line,
      labelColor: withAlpha(t.text, 0.8),
      countColor: t.muted,
      volumeColor: t.muted,
      showDayType: false,
      showOpenType: false,
      showDevelopingPoc: false,
      showDevelopingVa: false,
      showNakedLevels: false,
    });
    this.host?.requestUpdate();
  }

  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext) {
    const type = this.type();
    if (!isProfileType(type)) return;
    const all = rc.bars?.() ?? [];
    if (all.length < 2) return;
    const tpo = type === TPO_TYPE;
    this.update(all, rc, tpo);
    const ts = rc.timeScale;
    const spacing = Math.abs(ts.indexToX(1) - ts.indexToX(0));
    const span = this.sessionBars * spacing;
    if (tpo) {
      // Letters packed left: the busiest row's count fits the session.
      this.tpo.setOptions({ letterWidth: Math.max(1, Math.min(12, (span * 0.9) / this.mostTpos)) });
      this.tpo.draw(ctx, rc);
    } else {
      this.volume.setOptions({ width: Math.max(8, span * 0.9) });
      this.volume.draw(ctx, rc);
    }
  }

  /** Works the profile out again when the candles or the view changed. */
  private update(all: readonly Bar[], rc: PrimitiveRenderContext, tpo: boolean) {
    const width = barWidth(all);
    const session = sessionFor(width);
    // The sessions on screen, and one before them so the first is whole.
    const { from, to } = rc.timeScale.visibleRange();
    const first = Math.max(0, Math.floor(from));
    const last = Math.min(all.length - 1, Math.ceil(to));
    const firstKey = sessionKey(all[first]?.time ?? 0, session);
    let start = first;
    while (start > 0 && sessionKey(all[start - 1]?.time ?? 0, session) >= firstKey - 1) start--;
    start = Math.max(start, last - MAX_BARS);
    const bars = all.slice(start);
    const end = bars.at(-1);
    if (!end) return;
    const shape = [tpo, start, bars.length, bars[0]?.time, end.time, this.tick].join("|");
    const now = Date.now();
    const live = `${end.close}|${end.volume}`;
    if (shape === this.key.split("#")[0]) {
      if (live === this.key.split("#")[1] || now - this.at < LIVE_MS) return;
    }
    this.key = `${shape}#${live}`;
    this.at = now;

    const rows = rowSize(bars, session, tpo ? TPO_ROWS : VOLUME_ROWS, this.tick);
    const counts = new Map<number, number>();
    for (const b of bars) {
      const k = sessionKey(b.time, session);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    this.sessionBars = Math.max(1, ...counts.values());
    if (tpo) {
      const tick = this.tick > 0 ? this.tick : rows;
      const result = computeMarketProfile(bars, {
        tickSize: tick,
        rowTicks: Math.max(1, Math.round(rows / tick)),
        session,
        blockMinutes: blockMinutes(session, width),
        timezone: "UTC",
      });
      this.mostTpos = Math.max(
        1,
        ...result.sessions.flatMap((s) => s.levels.map((level) => level.count)),
      );
      this.tpo.setData(result);
    } else {
      this.volume.setData(
        computeVolumeProfileSessions(bars, {
          tickSize: rows,
          session,
          valueAreaPercent: 0.7,
          deltaFromBarDirection: true,
          timezone: "UTC",
        }),
      );
    }
  }
}
