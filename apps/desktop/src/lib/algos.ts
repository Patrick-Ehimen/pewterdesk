import type {
  AlgoKind,
  AlgoSpec,
  AlgoView,
  Distribution,
  Market,
  SliceStyle,
  Unfilled,
  VenueId,
} from "@pewterdesk/core";

// Algo orders (chaser, TWAP, scaled) on the page: building what's sent to
// the engine, and reading what it reports. The engine runs them and sends
// every order through the same gate as the ticket (`crates/engine`); this
// file only prepares and describes. No React.

/** Who an algo trades for, and its venue's bound on anything at market. */
export interface AlgoTarget {
  venue: VenueId;
  account: string;
  maxSlippageBps: number;
}

/** A venue-run TWAP's limits (Hyperliquid's): 5 minutes to 7 days. */
const NATIVE_MIN_MINUTES = 5;
const NATIVE_MAX_MINUTES = 7 * 24 * 60;
/** A TWAP on this machine: from 10 seconds to 7 days, 1 to 500 slices. */
export const TWAP_MIN_MS = 10_000;
export const TWAP_MAX_MS = 7 * 24 * 60 * 60_000;
export const MAX_SLICES = 500;
export const MAX_LEVELS = 50;

/**
 * Whether the venue would run `spec` itself: the same rule as the engine's
 * (`native.rs`) - a TWAP at market on Hyperliquid, 5 minutes to 7 days,
 * with native left on. Everything else runs on this machine.
 */
export function runsOnVenue(spec: AlgoSpec): boolean {
  if (spec.kind !== "twap" || !spec.preferNative || spec.venue !== "hyperliquid") return false;
  if (spec.style !== "market") return false;
  const minutes = Math.ceil(spec.durationMs / 60_000);
  return minutes >= NATIVE_MIN_MINUTES && minutes <= NATIVE_MAX_MINUTES;
}

/** Slices for a TWAP of `durationMs` when none are asked for: about one a minute, 2 to 60. */
export function defaultSlices(durationMs: number): number {
  return Math.min(60, Math.max(2, Math.round(durationMs / 60_000)));
}

/**
 * "30m", "1h", "1h30m", "2d", "45s" as milliseconds; anything else, or
 * nothing at all, is undefined.
 */
export function parseDuration(word: string | undefined): number | undefined {
  if (!word) return undefined;
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(word.toLowerCase());
  if (!m || m[0] === "") return undefined;
  const [d, h, min, s] = m.slice(1).map((n) => Number(n ?? 0));
  const ms = ((((d ?? 0) * 24 + (h ?? 0)) * 60 + (min ?? 0)) * 60 + (s ?? 0)) * 1000;
  return ms > 0 ? ms : undefined;
}

/** A duration in words: "1h 30m", "45s", "2d 4h". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`, !d && !h && s && `${s}s`].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(" ") : "0s";
}

export interface ChaserInput {
  side: "buy" | "sell";
  market: Market;
  size: string;
  reduceOnly?: boolean;
  postOnly?: boolean;
  /** Give up this far from the start, in percent; unset to chase on. */
  giveUpPct?: number;
  finishAtMarket?: boolean;
}

export interface TwapInput {
  side: "buy" | "sell";
  market: Market;
  size: string;
  durationMs: number;
  slices?: number;
  randomize?: boolean;
  style?: SliceStyle;
  unfilled?: Unfilled;
  reduceOnly?: boolean;
  /** Use the venue's own TWAP where there is one (on by default). */
  native?: boolean;
}

export interface ScaledInput {
  side: "buy" | "sell";
  market: Market;
  size: string;
  from: string;
  to: string;
  count: number;
  distribution?: Distribution;
  postOnly?: boolean;
  reduceOnly?: boolean;
}

function base(
  input: { side: "buy" | "sell"; market: Market; size: string; reduceOnly?: boolean },
  target: AlgoTarget,
  kind: AlgoKind,
  preferNative = true,
): AlgoSpec {
  return {
    venue: target.venue,
    account: target.account,
    market: input.market.id,
    side: input.side,
    size: input.size,
    reduceOnly: input.reduceOnly ?? false,
    maxSlippageBps: target.maxSlippageBps,
    preferNative,
    ...kind,
  };
}

export function chaserSpec(input: ChaserInput, target: AlgoTarget): AlgoSpec {
  return base(input, target, {
    kind: "chaser",
    postOnly: input.postOnly ?? true,
    ...(input.giveUpPct !== undefined && { giveUpBps: Math.round(input.giveUpPct * 100) }),
    finishAtMarket: input.finishAtMarket ?? false,
  });
}

export function twapSpec(input: TwapInput, target: AlgoTarget): AlgoSpec {
  return base(
    input,
    target,
    {
      kind: "twap",
      durationMs: input.durationMs,
      slices: input.slices ?? defaultSlices(input.durationMs),
      randomize: input.randomize ?? true,
      style: input.style ?? "market",
      unfilled: input.unfilled ?? "market",
    },
    input.native ?? true,
  );
}

export function scaledSpec(input: ScaledInput, target: AlgoTarget): AlgoSpec {
  return base(input, target, {
    kind: "scaled",
    from: input.from,
    to: input.to,
    count: input.count,
    distribution: input.distribution ?? "flat",
    postOnly: input.postOnly ?? true,
  });
}

/** What's wrong with `spec` before it's sent, as a message key's suffix; undefined if nothing. */
export function specProblem(spec: AlgoSpec, market: Market): string | undefined {
  const size = Number(spec.size);
  if (!(size > 0)) return "size";
  if (size < Number(market.minSize)) return "minSize";
  if (spec.kind === "twap") {
    if (spec.durationMs < TWAP_MIN_MS || spec.durationMs > TWAP_MAX_MS) return "duration";
    if (!runsOnVenue(spec)) {
      if (spec.slices < 1 || spec.slices > MAX_SLICES) return "slices";
      if (size / spec.slices < Number(market.minSize)) return "sliceSize";
    }
  }
  if (spec.kind === "scaled") {
    if (!(Number(spec.from) > 0) || !(Number(spec.to) > 0)) return "price";
    if (spec.count < 2 || spec.count > MAX_LEVELS) return "count";
    if (size / spec.count < Number(market.minSize)) return "sliceSize";
  }
  return undefined;
}

/** How much of it has filled, 0 to 1. */
export function progressOf(view: AlgoView): number {
  const size = Number(view.spec.size);
  return size > 0 ? Math.min(1, Number(view.filled) / size) : 0;
}

/** Time until it's due to end, in ms; undefined if it has no end time. */
export function timeLeft(view: AlgoView, now: number): number | undefined {
  return view.endsAt === undefined ? undefined : Math.max(0, view.endsAt - now);
}

/**
 * Its average fill against the price when it started, in basis points:
 * positive is worse (paid more on a buy, got less on a sell).
 */
export function slippageOf(view: AlgoView): number | undefined {
  const start = Number(view.startPrice);
  const avg = Number(view.avgPrice);
  if (!(start > 0) || !(avg > 0)) return undefined;
  const raw = ((avg - start) / start) * 10_000;
  return view.spec.side === "buy" ? raw : -raw;
}

/** Whether it can still be paused, resumed or stopped. */
export const isLive = (view: AlgoView) => view.status === "running" || view.status === "paused";

/** Live ones first (newest first), then the rest by when they last changed. */
export function sortAlgos(views: readonly AlgoView[]): AlgoView[] {
  return [...views].sort((a, b) => {
    const live = Number(isLive(b)) - Number(isLive(a));
    if (live !== 0) return live;
    return isLive(a) ? b.startedAt - a.startedAt : b.updatedAt - a.updatedAt;
  });
}

/** `views` with `view` in (replacing the same id). */
export function withAlgo(views: readonly AlgoView[], view: AlgoView): AlgoView[] {
  const others = views.filter((v) => v.id !== view.id);
  return sortAlgos([view, ...others]);
}

/** The slice sizes a TWAP run here would send, as the engine splits them (on the step). */
export function previewSlices(spec: AlgoSpec, market: Market): number[] {
  if (spec.kind !== "twap") return [];
  const step = Number(market.sizeStep) || 0;
  const n = Math.max(1, spec.slices);
  const floor = (v: number) => (step > 0 ? Math.floor(v / step + 1e-9) * step : v);
  const each = floor(Number(spec.size) / n);
  if (!(each >= Number(market.minSize))) return [];
  const sizes = Array.from({ length: n }, () => each);
  const rest = floor(Number(spec.size) - each * n);
  sizes[n - 1] = (sizes[n - 1] ?? 0) + rest;
  return sizes;
}
