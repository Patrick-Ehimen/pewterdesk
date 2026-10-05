import type { AccountSnapshot, Order, Position } from "@pewterdesk/core";

/** Something that happened to the account between two snapshots. */
export type AccountEvent =
  | { kind: "partialFill"; order: Order }
  | { kind: "positionOpened"; position: Position }
  | { kind: "positionClosed"; position: Position }
  | { kind: "positionResized"; position: Position; from: string };

const positionKey = (p: Position) => `${p.market}:${p.side}`;

/**
 * What changed from `prev` to `next`, as far as two snapshots can say for
 * certain: an open order that filled further and is still open, and
 * positions opened, closed or resized. An order that's gone may have filled
 * or been cancelled - the snapshot doesn't say, so that's not reported here.
 */
export function accountEvents(prev: AccountSnapshot, next: AccountSnapshot): AccountEvent[] {
  const events: AccountEvent[] = [];
  const before = new Map(prev.openOrders.map((o) => [o.id, o]));
  for (const order of next.openOrders) {
    const was = before.get(order.id);
    if (was && Number(order.filledSize) > Number(was.filledSize)) {
      events.push({ kind: "partialFill", order });
    }
  }
  const held = new Map(prev.positions.map((p) => [positionKey(p), p]));
  for (const position of next.positions) {
    const was = held.get(positionKey(position));
    held.delete(positionKey(position));
    if (!was) events.push({ kind: "positionOpened", position });
    else if (Number(was.size) !== Number(position.size)) {
      events.push({ kind: "positionResized", position, from: was.size });
    }
  }
  for (const position of held.values()) events.push({ kind: "positionClosed", position });
  return events;
}
