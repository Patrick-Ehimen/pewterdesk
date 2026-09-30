import { beforeEach, describe, expect, it } from "vitest";
import {
  FEED_TIMEOUT_MS,
  feedHealth,
  feedSnapshot,
  resetFeeds,
  trackFeed,
} from "../src/lib/feedActivity";

describe("feed activity", () => {
  beforeEach(resetFeeds);

  it("records when a feed last delivered, and the book's lag", () => {
    let now = 1000;
    const book = trackFeed("subscribe_order_book", "hyperliquid", () => now);
    const [waiting] = feedSnapshot();
    expect(waiting?.kind).toBe("book");
    expect(feedHealth(waiting as never, now)).toBe("waiting");

    now = 1500;
    book.update({ time: 1320 });
    const [live] = feedSnapshot();
    expect(live?.last).toBe(1500);
    expect(live?.lagMs).toBe(180);
    expect(feedHealth(live as never, 1500 + FEED_TIMEOUT_MS.book)).toBe("live");
    expect(feedHealth(live as never, 1501 + FEED_TIMEOUT_MS.book)).toBe("late");
  });

  it("marks ended feeds down and drops stopped ones", () => {
    const stats = trackFeed("subscribe_market_stats", "aster", () => 0);
    stats.failed();
    expect(feedHealth(feedSnapshot()[0] as never, 0)).toBe("down");
    stats.stop();
    expect(feedSnapshot()).toEqual([]);
  });

  it("lists one feed per kind, in a fixed order, per venue", () => {
    trackFeed("subscribe_trades", "hyperliquid", () => 1);
    trackFeed("subscribe_order_book", "hyperliquid", () => 1);
    trackFeed("subscribe_order_book", "hyperliquid", () => 2);
    trackFeed("subscribe_order_book", "aster", () => 3);
    trackFeed("markets", "hyperliquid", () => 1);
    const hl = feedSnapshot("hyperliquid");
    expect(hl.map((f) => f.kind)).toEqual(["book", "trades"]);
    expect(hl[0]?.started).toBe(2);
    expect(feedSnapshot("aster").map((f) => f.kind)).toEqual(["book"]);
  });
});
