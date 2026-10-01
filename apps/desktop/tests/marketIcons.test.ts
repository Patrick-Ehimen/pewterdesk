import { describe, expect, it, vi } from "vitest";
import { bybitBase, firstIcon, iconSources } from "../src/lib/marketIcons";

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

  it("borrows Bybit logos from Hyperliquid, then Aster", () => {
    expect(iconSources("bybit", "BTCUSDT")).toEqual([
      ["hyperliquid", "BTC"],
      ["aster", "BTCUSDT"],
    ]);
    // A thousand PEPE: kPEPE on Hyperliquid, 1000PEPEUSDT on Aster.
    expect(iconSources("bybit", "1000PEPEUSDT")).toEqual([
      ["hyperliquid", "1000PEPE"],
      ["hyperliquid", "PEPE"],
      ["hyperliquid", "kPEPE"],
      ["aster", "1000PEPEUSDT"],
      ["aster", "PEPEUSDT"],
    ]);
  });

  it("takes the first logo found, skipping failures", async () => {
    const fetchIcon = vi.fn(async (venue: string, market: string) => {
      if (venue === "hyperliquid") throw new Error(`no ${market}`);
      return market === "BTCUSDT" ? "<svg/>" : undefined;
    });
    await expect(firstIcon(iconSources("bybit", "BTCUSDT"), fetchIcon)).resolves.toBe("<svg/>");
    expect(fetchIcon).toHaveBeenCalledTimes(2);
    await expect(firstIcon([["aster", "NOPEUSDT"]], fetchIcon)).resolves.toBeUndefined();
  });
});
