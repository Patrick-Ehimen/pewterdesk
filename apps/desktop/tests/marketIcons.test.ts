import type { Market } from "@pewterdesk/core";
import { describe, expect, it, vi } from "vitest";
import {
  bybitBase,
  firstIcon,
  iconSources,
  isCryptoMarket,
  marketLogo,
} from "../src/lib/marketIcons";

describe("market logo sources", () => {
  it("asks a venue for its own markets", () => {
    expect(iconSources("hyperliquid", "BTC")).toEqual([["hyperliquid", "BTC"]]);
    expect(iconSources("aster", "BTCUSDT")).toEqual([["aster", "BTCUSDT"]]);
  });

  it("reads Bybit's base coin", () => {
    expect(bybitBase("BTCUSDT")).toBe("BTC");
    expect(bybitBase("BTCPERP")).toBe("BTC");
    expect(bybitBase("ETHUSDC")).toBe("ETH");
  });

  it("asks Bybit first, then borrows from Hyperliquid, then Aster", () => {
    expect(iconSources("bybit", "BTCUSDT")).toEqual([
      ["bybit", "BTCUSDT"],
      ["hyperliquid", "BTC"],
      ["aster", "BTCUSDT"],
    ]);
    // A thousand PEPE: kPEPE on Hyperliquid, 1000PEPEUSDT on Aster.
    expect(iconSources("bybit", "1000PEPEUSDT")).toEqual([
      ["bybit", "1000PEPEUSDT"],
      ["hyperliquid", "1000PEPE"],
      ["hyperliquid", "PEPE"],
      ["hyperliquid", "kPEPE"],
      ["aster", "1000PEPEUSDT"],
      ["aster", "PEPEUSDT"],
    ]);
  });

  it("takes Bybit's own logo when its list has one", async () => {
    const fetchIcon = vi.fn(async (venue: string) => (venue === "bybit" ? "<svg/>" : undefined));
    await expect(firstIcon(iconSources("bybit", "BTCUSDT"), fetchIcon)).resolves.toBe("<svg/>");
    expect(fetchIcon).toHaveBeenCalledTimes(1);
  });

  it("takes the first logo found, skipping failures", async () => {
    // Bybit's list can't be read (no account connected) and Hyperliquid
    // fails: Aster's logo is used.
    const fetchIcon = vi.fn(async (venue: string, market: string) => {
      if (venue !== "aster") throw new Error(`no ${market}`);
      return market === "BTCUSDT" ? "<svg/>" : undefined;
    });
    await expect(firstIcon(iconSources("bybit", "BTCUSDT"), fetchIcon)).resolves.toBe("<svg/>");
    expect(fetchIcon).toHaveBeenCalledTimes(3);
  });

  it("says there's no logo only when every source answered none", async () => {
    const none = vi.fn(async () => undefined);
    await expect(firstIcon(iconSources("bybit", "BTCUSDT"), none)).resolves.toBeUndefined();
  });

  it("fails, rather than caching no logo, when a source failed", async () => {
    // Hyperliquid rate-limited and Aster has none: try again later, don't save "none".
    const flaky = vi.fn(async (venue: string) => {
      if (venue === "hyperliquid") throw new Error("rate limited");
      return undefined;
    });
    await expect(firstIcon(iconSources("bybit", "BTCUSDT"), flaky)).rejects.toThrow("rate limited");
  });
});

describe("the app's own logos, then CoinGecko as the last resort", () => {
  const market = (over: Partial<Market> = {}): Market => ({
    venue: "bybit",
    id: "1000000MOGUSDT",
    symbol: "1000000MOG-USDT",
    base: "1000000MOG",
    quote: "USDT",
    tickSize: "0.0001",
    sizeStep: "1",
    minSize: "1",
    maxLeverage: 25,
    ...over,
  });
  const none = async () => undefined;
  const sources = (over: Partial<Parameters<typeof marketLogo>[3]> = {}) => ({
    venue: none,
    bundled: none,
    coin: none,
    ...over,
  });

  it("asks each source only when the ones before it have no logo", async () => {
    const bundled = vi.fn(async () => "<svg>bundled</svg>");
    const coin = vi.fn(async () => "<svg>coingecko</svg>");
    const venue = async (v: string) => (v === "aster" ? "<svg>aster</svg>" : undefined);
    // A venue has it: that's the logo, and nothing else is asked.
    await expect(
      marketLogo("bybit", "1000000MOGUSDT", market(), sources({ venue, bundled, coin })),
    ).resolves.toBe("<svg>aster</svg>");
    expect(bundled).not.toHaveBeenCalled();
    expect(coin).not.toHaveBeenCalled();
    // No venue has it: the one that ships with the app, by base coin.
    await expect(
      marketLogo("bybit", "1000000MOGUSDT", market(), sources({ bundled, coin })),
    ).resolves.toBe("<svg>bundled</svg>");
    expect(bundled).toHaveBeenCalledWith("1000000MOG");
    expect(coin).not.toHaveBeenCalled();
    // Neither: CoinGecko's, asked by the coin's ticker.
    await expect(marketLogo("bybit", "1000000MOGUSDT", market(), sources({ coin }))).resolves.toBe(
      "<svg>coingecko</svg>",
    );
    expect(coin).toHaveBeenCalledWith("1000000MOG");
  });

  it("uses a bundled logo for a stock, but never asks CoinGecko about one", async () => {
    const coin = vi.fn(async () => "<svg>wrong coin</svg>");
    const stock = market({ id: "AALUSDT", base: "AAL", category: "stock" });
    await expect(
      marketLogo(
        "bybit",
        "AALUSDT",
        stock,
        sources({ bundled: async () => "<svg>aal</svg>", coin }),
      ),
    ).resolves.toBe("<svg>aal</svg>");
    for (const over of [
      { category: "stock" },
      { category: "etf" },
      { category: "commodity" },
      { category: "forex" },
      { listedBy: "xyz" },
    ] as Partial<Market>[]) {
      expect(isCryptoMarket(market(over))).toBe(false);
      await expect(
        marketLogo("bybit", "AMCUSDT", market(over), sources({ coin })),
      ).resolves.toBeUndefined();
    }
    expect(coin).not.toHaveBeenCalled();
    // Innovation Zone coins are crypto; so is a market with no category.
    expect(isCryptoMarket(market({ category: "innovation" }))).toBe(true);
    expect(isCryptoMarket(market())).toBe(true);
    // Without the market itself, there's no telling what it is: CoinGecko
    // isn't asked, and a bundled logo is looked up by the id's coin.
    const bundled = vi.fn(none);
    await expect(
      marketLogo("bybit", "AMCUSDT", undefined, sources({ bundled, coin })),
    ).resolves.toBeUndefined();
    expect(bundled).toHaveBeenCalledWith("AMC");
  });

  it("steps in when a venue failed, and fails only if nobody has it", async () => {
    const down = async () => {
      throw new Error("no account connected");
    };
    await expect(
      marketLogo(
        "bybit",
        "1000000MOGUSDT",
        market(),
        sources({ venue: down, coin: async () => "<svg/>" }),
      ),
    ).resolves.toBe("<svg/>");
    // Nobody has it and a venue failed: not "no logo", so it's tried again.
    await expect(
      marketLogo("bybit", "1000000MOGUSDT", market(), sources({ venue: down })),
    ).rejects.toThrow();
    // CoinGecko rate-limited after the others answered none: also retried.
    await expect(
      marketLogo(
        "bybit",
        "1000000MOGUSDT",
        market(),
        sources({
          coin: async () => {
            throw new Error("rate limit");
          },
        }),
      ),
    ).rejects.toThrow("rate limit");
  });
});
