import type {
  Candle,
  CandleInterval,
  Fill,
  FundingPayment,
  OrderRequest,
  Position,
} from "@pewterdesk/core";

/** Sizes closer than this are the same (float sums of decimal sizes). */
const EPSILON = 1e-9;

export interface PositionFills {
  /** The fills that built the position as it stands, oldest first. */
  fills: Fill[];
  /**
   * When the position was opened: its oldest fill. Unset when the fills
   * loaded don't reach back that far (the venue keeps a limited history).
   */
  openedAt?: number;
}

/**
 * The fills behind `position`: walking back from the newest fill on its
 * market, until they add up to its size. Fills before that belong to an
 * earlier position (closed, or on the other side).
 */
export function positionFills(fills: readonly Fill[], position: Position): PositionFills {
  const dir = position.side === "long" ? 1 : -1;
  let left = Number(position.size) * dir;
  const out: Fill[] = [];
  const mine = fills
    .filter((f) => f.market === position.market && Number(f.size) > 0)
    .sort((a, b) => b.time - a.time);
  for (const f of mine) {
    out.push(f);
    left -= Number(f.size) * (f.side === "buy" ? 1 : -1);
    if (Math.abs(left) <= EPSILON * Math.max(1, Number(position.size))) {
      out.reverse();
      return { fills: out, openedAt: out[0]?.time };
    }
  }
  return { fills: out.reverse() };
}

/** What the position's fills cost in fees: their sum, so negative for a rebate. */
export function feesPaid(fills: readonly Fill[]): number {
  return fills.reduce((sum, f) => sum + Number(f.fee), 0);
}

/** The position's funding: its market's payments since `since`, newest first. */
export function positionFunding(
  payments: readonly FundingPayment[],
  market: string,
  since: number,
): FundingPayment[] {
  return payments
    .filter((p) => p.market === market && p.time >= since)
    .sort((a, b) => b.time - a.time);
}

/** A candle interval that spans `ms` in a few hundred candles at most. */
export function intervalFor(ms: number): CandleInterval {
  const hour = 3_600_000;
  if (ms <= 6 * hour) return "1m";
  if (ms <= 24 * hour) return "5m";
  if (ms <= 4 * 24 * hour) return "15m";
  if (ms <= 16 * 24 * hour) return "1h";
  return "4h";
}

export interface PnlPoint {
  /** Milliseconds since the Unix epoch. */
  time: number;
  pnl: number;
}

/**
 * The position's PnL at each candle's close since `since`, at its present
 * size and entry, ending on its PnL now. An estimate where it was scaled
 * into, which the label says ("since entry").
 */
export function pnlSeries(
  candles: readonly Candle[],
  position: Position,
  since: number,
  now: number,
): PnlPoint[] {
  const entry = Number(position.entryPrice);
  const size = Number(position.size);
  const dir = position.side === "long" ? 1 : -1;
  const points = candles
    .filter((c) => c.openTime >= since - 1 && Number(c.close) > 0)
    .map((c) => ({ time: c.openTime, pnl: (Number(c.close) - entry) * size * dir }));
  points.push({ time: now, pnl: Number(position.unrealizedPnl) });
  return points;
}

/** An SVG path through `points`, scaled into `width` x `height`; also its area to the zero line. */
export function sparkPath(
  points: readonly PnlPoint[],
  width: number,
  height: number,
): { line: string; area: string; zero: number } | null {
  if (points.length < 2) return null;
  const first = points[0] as PnlPoint;
  const last = points[points.length - 1] as PnlPoint;
  const t0 = first.time;
  const span = Math.max(1, last.time - t0);
  let lo = 0;
  let hi = 0;
  for (const p of points) {
    lo = Math.min(lo, p.pnl);
    hi = Math.max(hi, p.pnl);
  }
  const range = hi - lo || 1;
  const x = (time: number) => ((time - t0) / span) * width;
  const y = (pnl: number) => height - ((pnl - lo) / range) * height;
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time).toFixed(1)},${y(p.pnl).toFixed(1)}`)
    .join("");
  const zero = y(0);
  const area = `${line}L${width},${zero.toFixed(1)}L0,${zero.toFixed(1)}Z`;
  return { line, area, zero };
}

/**
 * The order that closes all of `position`: the other side, its whole size,
 * reduce-only (so it can never open or flip one). At market, it goes with a
 * slippage bound like every market order.
 */
export function closeOrder(
  position: Position,
  how: { type: "market"; maxSlippageBps: number } | { type: "limit"; price: string },
): OrderRequest {
  return {
    market: position.market,
    side: position.side === "long" ? "sell" : "buy",
    size: position.size,
    reduceOnly: true,
    ...how,
  };
}

/** How long a position has been held, as days/hours/minutes parts. */
export function heldParts(ms: number): { d: number; h: number; m: number } {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60), m: minutes % 60 };
}
