import { describe, expect, it } from "vitest";
import type { TraderHolding, TraderMove, TraderSnapshot } from "../src/api/venueClient";
import { avatarCells } from "../src/components/traders/TraderAvatar";
import {
  agreement,
  alertsFor,
  DEFAULT_ALERTS,
  DEFAULT_LIST_ALERTS,
  FOLLOWING,
  followedKeys,
  isFollowed,
  type ListAlerts,
  listAlertsFor,
  MAX_FOLLOWED,
  netSide,
  parseActivity,
  parseKey,
  parseTraders,
  toggledIn,
  toggleFollow,
  traderKey,
  watchFollows,
  withAlerts,
  withList,
  withListAlerts,
  withMove,
  withoutList,
  withoutOwnAlerts,
} from "../src/lib/traders";

const A = "0xf5d81a135f756ca16544e53c20fc20643ec3ad53";
const B = "0x7f3a000000000000000000000000000000019c2a";
const O = "9F25A5FBE6CFF912";
const hl = (id: string) => traderKey("hyperliquid", id);
const empty = () => parseTraders(null);

const holding = (market: string, side: "long" | "short", value: number): TraderHolding => ({
  market,
  side,
  size: 1,
  entry: value,
  mark: value,
  value,
  leverage: null,
  unrealized: 0,
  liquidation: null,
  openedAt: null,
});
const snap = (
  source: "hyperliquid" | "okx",
  id: string,
  holdings: TraderHolding[],
): TraderSnapshot => ({
  source,
  id,
  holdings,
  at: 1,
  every: 15,
  error: null,
});

describe("trader keys", () => {
  it("accepts only ids each source can be asked about", () => {
    expect(parseKey(hl(A))).toEqual({ source: "hyperliquid", id: A });
    expect(parseKey(`okx:${O}`)).toEqual({ source: "okx", id: O });
    for (const bad of [
      `hyperliquid:${A.toUpperCase()}`,
      `okx:${A}`,
      `hyperliquid:${O}`,
      "okx:9F25A5FBE6CFF91",
      `bybit:${O}`,
      `okx:${O}:x`,
      "",
    ]) {
      expect(parseKey(bad), bad).toBeUndefined();
    }
  });
});

describe("stored state", () => {
  it("always has the Following list, and drops what can't be read", () => {
    expect(empty().lists).toEqual([{ id: FOLLOWING, name: "", keys: [] }]);
    expect(parseTraders("not json").lists[0]?.id).toBe(FOLLOWING);
    const parsed = parseTraders(
      JSON.stringify({
        lists: [
          { id: "x", name: "  Whales  ", keys: [hl(A), hl(A), "okx:nope", `okx:${O}`] },
          { id: "y", name: "", keys: [] },
        ],
        active: "x",
        alerts: { [hl(A)]: { on: false, minValue: -5, kinds: ["open", "bogus"] }, junk: {} },
        names: { [hl(A)]: " Glacier ", bad: "x" },
      }),
    );
    expect(parsed.lists.map((l) => l.id)).toEqual([FOLLOWING, "x"]);
    expect(parsed.lists[1]).toEqual({ id: "x", name: "Whales", keys: [hl(A), `okx:${O}`] });
    expect(parsed.active).toBe("x");
    expect(parsed.alerts[hl(A)]).toEqual({
      on: false,
      minValue: DEFAULT_ALERTS.minValue,
      kinds: ["open"],
      markets: [],
      to: ["app", "desktop"],
    });
    expect(Object.keys(parsed.alerts)).toEqual([hl(A)]);
    expect(parsed.names).toEqual({ [hl(A)]: "Glacier" });
  });
});

describe("following", () => {
  it("the star follows into the list on screen, and unfollows from every list", () => {
    let s = toggleFollow(empty(), hl(A), "Glacier");
    expect(isFollowed(s, hl(A))).toBe(true);
    expect(s.names[hl(A)]).toBe("Glacier");
    s = withList(s, "w", "Whales");
    s = toggleFollow(s, hl(B));
    s = toggledIn(s, "w", hl(A));
    expect(followedKeys(s)).toEqual([hl(A), hl(B)]);
    s = toggleFollow(s, hl(A));
    expect(isFollowed(s, hl(A))).toBe(false);
    expect(s.lists.every((l) => !l.keys.includes(hl(A)))).toBe(true);
  });

  it("stops at the most Rust watches", () => {
    let s = empty();
    for (let i = 0; i < MAX_FOLLOWED + 3; i++) {
      s = toggleFollow(s, hl(`0x${i.toString(16).padStart(40, "0")}`));
    }
    expect(followedKeys(s)).toHaveLength(MAX_FOLLOWED);
  });

  it("deleting a list keeps Following, and moves the screen there", () => {
    let s = withList(empty(), "w", "Whales");
    expect(s.active).toBe("w");
    s = withoutList(s, "w");
    expect(s.lists.map((l) => l.id)).toEqual([FOLLOWING]);
    expect(s.active).toBe(FOLLOWING);
    expect(withoutList(s, FOLLOWING)).toBe(s);
  });

  it("hands Rust every followed trader; one with alerts off alerts on nothing", () => {
    let s = toggleFollow(toggleFollow(empty(), hl(A)), `okx:${O}`);
    s = withAlerts(s, `okx:${O}`, {
      on: false,
      minValue: 10,
      kinds: ["open"],
      markets: ["BTC", "not a coin!"],
      to: ["app"],
    });
    expect(watchFollows(s)).toEqual([
      {
        source: "hyperliquid",
        id: A,
        minValue: DEFAULT_ALERTS.minValue,
        kinds: DEFAULT_ALERTS.kinds,
        markets: [],
      },
      { source: "okx", id: O, minValue: 10, kinds: [], markets: ["BTC"] },
    ]);
  });

  it("a trader without alerts of their own takes their list's", () => {
    let s = withList(toggleFollow(empty(), hl(A)), "w", "Whales");
    s = toggledIn(s, "w", hl(B));
    const whales: ListAlerts = { ...DEFAULT_LIST_ALERTS, minValue: 1_000_000, agree: 3 };
    s = withListAlerts(s, "w", whales);
    // A is only in Following (no list alerts there): the defaults.
    expect(alertsFor(s, hl(A))).toEqual(DEFAULT_ALERTS);
    expect(alertsFor(s, hl(B)).minValue).toBe(1_000_000);
    expect(listAlertsFor(s, "w").agree).toBe(3);
    // Their own win, until they're reset.
    s = withAlerts(s, hl(B), { ...DEFAULT_ALERTS, minValue: 5 });
    expect(alertsFor(s, hl(B)).minValue).toBe(5);
    expect(alertsFor(withoutOwnAlerts(s, hl(B)), hl(B)).minValue).toBe(1_000_000);
    // An agree count outside 2 to the most followed is off.
    expect(listAlertsFor(withListAlerts(s, "w", { ...whales, agree: 1 }), "w").agree).toBeNull();
    // Stored and read back.
    expect(parseTraders(JSON.stringify(s)).listAlerts.w?.agree).toBe(3);
  });
});

describe("where they agree", () => {
  it("counts each trader once per market, by their net side", () => {
    const snaps = [
      snap("hyperliquid", A, [holding("BTC", "short", 900), holding("ETH", "long", 100)]),
      // Long and short BTC on OKX sub-positions: net short.
      snap("okx", O, [holding("BTC", "long", 100), holding("BTC", "short", 300)]),
      snap("hyperliquid", B, [holding("BTC", "long", 50)]),
    ];
    const keys = [hl(A), `okx:${O}`, hl(B)];
    const [btc, eth] = agreement(snaps, keys);
    expect(btc).toEqual({ market: "BTC", long: 1, short: 2, longValue: 50, shortValue: 1100 });
    expect(eth).toEqual({ market: "ETH", long: 1, short: 0, longValue: 100, shortValue: 0 });
    // Only the list's traders count.
    expect(agreement(snaps, [hl(B)])).toEqual([
      { market: "BTC", long: 1, short: 0, longValue: 50, shortValue: 0 },
    ]);
    expect(netSide(snaps[1], "BTC")).toBe("short");
    expect(netSide(snaps[1], "SOL")).toBeUndefined();
  });
});

describe("activity", () => {
  const move = (at: number): TraderMove => ({
    source: "hyperliquid",
    id: A,
    at,
    alert: true,
    change: {
      market: "BTC",
      kind: "open",
      side: "short",
      sizeBefore: 0,
      sizeAfter: 1,
      price: 1,
      value: 1,
    },
  });

  it("keeps the newest first, and forgets what's over 30 days old", () => {
    const now = 100 * 86_400_000;
    const log = withMove([move(now - 31 * 86_400_000), move(now - 1000)], move(now), now);
    expect(log.map((m) => m.at)).toEqual([now, now - 1000]);
  });

  it("reads back only moves it can show", () => {
    const raw = JSON.stringify([move(5), { ...move(6), id: "nope" }, { at: "x" }, null]);
    expect(parseActivity(raw).map((m) => m.at)).toEqual([5]);
    expect(parseActivity("{")).toEqual([]);
  });
});

describe("avatars", () => {
  it("are the same for the same trader, mirrored, and differ between traders", () => {
    const a = avatarCells(hl(A));
    expect(avatarCells(hl(A))).toEqual(a);
    expect(avatarCells(hl(B))).not.toEqual(a);
    for (const [x, y, dim] of a) {
      expect(a.some(([x2, y2, d2]) => x2 === 4 - x && y2 === y && d2 === dim)).toBe(true);
    }
  });
});
