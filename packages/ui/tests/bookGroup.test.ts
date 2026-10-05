import type { OrderBook } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { groupBook, groupStep } from "../src/components/trading/OrderBookView";

describe("groupStep", () => {
  it("multiplies the tick without float noise", () => {
    expect(groupStep("0.1", "1")).toBe("0.1");
    expect(groupStep("0.1", "10")).toBe("1");
    expect(groupStep("0.1", "500")).toBe("50");
    expect(groupStep("0.001", "10")).toBe("0.01");
    expect(groupStep("0.00001", "100")).toBe("0.001");
    expect(groupStep("1", "100")).toBe("100");
  });
});

describe("groupBook", () => {
  const book: OrderBook = {
    market: "BTCUSDT",
    bids: [
      { price: "84548.7", size: "3.511" },
      { price: "84548.6", size: "0.002" },
      { price: "84547.8", size: "0.438" },
      { price: "84539.9", size: "1" },
    ],
    asks: [
      { price: "84548.8", size: "4.312" },
      { price: "84548.9", size: "0.68" },
      { price: "84549", size: "0.5" },
      { price: "84551.2", size: "1" },
    ],
    time: 0,
  };

  it("leaves the book alone without a step", () => {
    expect(groupBook(book, "0")).toBe(book);
  });

  it("rounds bids down and asks up, summing sizes", () => {
    const out = groupBook(book, "1");
    expect(out.bids).toEqual([
      { price: "84548", size: "3.513" },
      { price: "84547", size: "0.438" },
      { price: "84539", size: "1.000" },
    ]);
    expect(out.asks).toEqual([
      { price: "84549", size: "5.492" },
      { price: "84552", size: "1.000" },
    ]);
  });

  it("keeps a level that's already on the step", () => {
    expect(groupBook(book, "0.1").asks.map((l) => l.price)).toEqual([
      "84548.8",
      "84548.9",
      "84549.0",
      "84551.2",
    ]);
  });

  it("groups by tens", () => {
    const out = groupBook(book, "10");
    expect(out.bids.map((l) => l.price)).toEqual(["84540", "84530"]);
    expect(out.asks.map((l) => l.price)).toEqual(["84550", "84560"]);
  });
});
