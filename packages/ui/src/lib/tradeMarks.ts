import type {
  Candle,
  Decimal,
  Fill,
  Order,
  OrderType,
  Position,
  PositionProtection,
  PositionSide,
  Side,
} from "@pewterdesk/core";
import { onTick } from "./format";

// The account's trading drawn over the price chart: its position's levels
// as lines across the chart, and its fills as marks on the candles they
// happened in. Display only, so prices go through JS numbers.

export type LevelKind = "position" | "takeProfit" | "stopLoss" | "liquidation" | "order";

/** A horizontal line across the chart, and what its label says. */
export interface ChartLevel {
  /** Stable across updates, for React keys. */
  id: string;
  kind: LevelKind;
  price: number;
  /** The position's side, or an order's. */
  side?: PositionSide | Side;
  /** In base units, as the venue sent it. */
  size?: Decimal;
  /**
   * The position's unrealized PnL; for a TP or SL, the PnL if it fills. In
   * the quote asset.
   */
  pnl?: number;
  /** Liquidation only: its distance from the mark price, as a ratio (-0.11 is 11% below). */
  distance?: number;
  /** Orders only. */
  orderType?: OrderType;
  /** A TP or SL kept on the position, which can be moved by dragging its line. */
  movable?: boolean;
}

/** PnL of closing `size` of a position at `price`. */
export function pnlAt(position: Position, price: number, size: number) {
  const direction = position.side === "long" ? 1 : -1;
  return (price - Number(position.entryPrice)) * size * direction;
}

/**
 * The lines for one market: the position's entry, its take-profit and
 * stop-loss (kept on the position, or as exit orders, depending on the
 * venue), its liquidation price, and every other open order at its price.
 * `orders` are that market's open orders.
 */
export function tradeLevels(
  position: Position | undefined,
  orders: readonly Order[],
): ChartLevel[] {
  const levels: ChartLevel[] = [];
  const seen = new Set<string>();
  const add = (level: ChartLevel) => {
    if (!Number.isFinite(level.price) || level.price <= 0) return;
    // A venue can report the same TP both on the position and as its exit order.
    const key = `${level.kind}:${level.price}`;
    if (level.kind !== "order" && seen.has(key)) return;
    seen.add(key);
    levels.push(level);
  };
  const exit = (kind: ExitKind, id: string, price: number, size?: number, movable?: boolean) =>
    add({
      id,
      kind,
      price,
      pnl: position ? pnlAt(position, price, size || Number(position.size)) : undefined,
      movable,
    });

  if (position) {
    const mark = Number(position.markPrice);
    add({
      id: "position",
      kind: "position",
      price: Number(position.entryPrice),
      side: position.side,
      size: position.size,
      pnl: Number(position.unrealizedPnl),
    });
    if (position.takeProfit) {
      exit("takeProfit", "position:tp", Number(position.takeProfit), undefined, true);
    }
    if (position.stopLoss) {
      exit("stopLoss", "position:sl", Number(position.stopLoss), undefined, true);
    }
    if (position.liquidationPrice) {
      const liq = Number(position.liquidationPrice);
      add({
        id: "liquidation",
        kind: "liquidation",
        price: liq,
        distance: mark ? (liq - mark) / mark : undefined,
      });
    }
  }
  for (const o of orders) {
    const price = Number(o.triggerPrice ?? o.price);
    // Sized 0 where the exit closes the whole position, whatever its size.
    const size = Number(o.size) - Number(o.filledSize);
    if (o.category === "takeProfit" || o.category === "stopLoss") {
      exit(o.category, `order:${o.id}`, price, size);
    } else {
      add({
        id: `order:${o.id}`,
        kind: "order",
        price,
        side: o.side,
        size: String(size),
        orderType: o.type,
      });
    }
  }
  return levels;
}

export type ExitKind = "takeProfit" | "stopLoss";

/** What moving a position's TP or SL to a price comes to. */
export type ExitMove =
  | { result: "set"; price: Decimal; protection: PositionProtection }
  | { result: "unchanged" }
  | { result: "invalid"; error: "protect.tpSide" | "protect.slSide" | "protect.invalid" };

const KEEP = { action: "keep" } as const;

/**
 * The change that moves `position`'s TP or SL to `price`, on the tick: a TP
 * must stay on the profitable side of the mark price, an SL on the losing
 * side, as in the TP / SL editor. The other exits are kept.
 */
export function exitMove(
  position: Position,
  kind: ExitKind,
  price: number,
  tick: Decimal,
): ExitMove {
  const text = onTick(price, tick);
  if (!(Number(text) > 0)) return { result: "invalid", error: "protect.invalid" };
  const current = kind === "takeProfit" ? position.takeProfit : position.stopLoss;
  if (current !== undefined && Number(current) === Number(text)) return { result: "unchanged" };
  const dir = position.side === "long" ? 1 : -1;
  const ahead = (Number(text) - Number(position.markPrice)) * dir;
  if (kind === "takeProfit" && ahead <= 0) return { result: "invalid", error: "protect.tpSide" };
  if (kind === "stopLoss" && ahead >= 0) return { result: "invalid", error: "protect.slSide" };
  const set = { action: "set", price: text } as const;
  return {
    result: "set",
    price: text,
    protection: {
      takeProfit: kind === "takeProfit" ? set : KEEP,
      stopLoss: kind === "stopLoss" ? set : KEEP,
      trailingStop: KEEP,
    },
  };
}

export type FillKind = "entry" | "exit" | "flip" | "fill";

/** The fills of one side and kind in one candle, as one mark. */
export interface FillMark {
  /** The candle's open time, in ms. */
  time: number;
  side: Side;
  kind: FillKind;
  /** Size-weighted average price. */
  price: number;
  size: number;
}

const KIND: Record<Fill["effect"], FillKind> = {
  openLong: "entry",
  openShort: "entry",
  closeLong: "exit",
  closeShort: "exit",
  longToShort: "flip",
  shortToLong: "flip",
  other: "fill",
};

/**
 * Fills as marks on the candles they fell in (`candles` oldest first),
 * oldest first; one per candle, side and kind. Fills outside the candles
 * loaded are left out. Without `intervalMs`, the newest candle takes every
 * fill after it opened.
 */
export function fillMarks(
  fills: readonly Fill[],
  candles: readonly Candle[],
  intervalMs?: number,
): FillMark[] {
  const first = candles[0];
  if (!first) return [];
  const groups = new Map<string, FillMark & { notional: number }>();
  for (const f of fills) {
    // The newest candle that opened at or before the fill.
    let lo = 0;
    let hi = candles.length - 1;
    if (f.time < first.openTime) continue;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((candles[mid] as Candle).openTime <= f.time) lo = mid;
      else hi = mid - 1;
    }
    const time = (candles[lo] as Candle).openTime;
    const isLast = lo === candles.length - 1;
    if (isLast && intervalMs !== undefined && f.time >= time + intervalMs) continue;
    const price = Number(f.price);
    const size = Number(f.size);
    const kind = KIND[f.effect];
    const key = `${time}:${f.side}:${kind}`;
    const group = groups.get(key);
    if (group) {
      group.size += size;
      group.notional += price * size;
      group.price = group.size ? group.notional / group.size : price;
    } else {
      groups.set(key, { time, side: f.side, kind, price, size, notional: price * size });
    }
  }
  return [...groups.values()]
    .map(({ notional: _, ...mark }) => mark)
    .sort((a, b) => a.time - b.time);
}

/**
 * How far past the candles a level may sit and still be brought onto the
 * price scale, as a share of the candles' own range.
 */
export const LEVEL_REACH = 0.5;

/**
 * The price range to show for candles spanning `min` to `max`, with trade
 * levels (entry, TP, SL, open orders) beside them. The candles decide the
 * scale: a level just outside them is taken in, so its line doesn't sit a
 * few pixels off the edge, but one further away than `LEVEL_REACH` of the
 * candles' range is left off screen rather than squashing the candles flat
 * to reach it. Its label still shows on the price scale when scrolled to.
 */
export function scaleWithLevels(
  min: number,
  max: number,
  levels: readonly number[],
): { min: number; max: number } {
  const reach = (max - min) * LEVEL_REACH;
  let lo = min;
  let hi = max;
  for (const price of levels) {
    if (price < min && price >= min - reach) lo = Math.min(lo, price);
    if (price > max && price <= max + reach) hi = Math.max(hi, price);
  }
  return { min: lo, max: hi };
}
