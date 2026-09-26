import { invoke, isTauri } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { venueClient } from "../src/api/venueClient";

// Captures each Channel so tests can push events into it.
const channels: { onmessage: (m: unknown) => void }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
    constructor() {
      channels.push(this);
    }
  },
}));
const mockInvoke = vi.mocked(invoke);

function handlers() {
  return { onUpdate: vi.fn(), onClosed: vi.fn(), onError: vi.fn() };
}

beforeEach(() => {
  mockInvoke.mockReset();
  vi.mocked(isTauri).mockReturnValue(true);
  channels.length = 0;
});

describe("venueClient calls", () => {
  it("passes venue and market to order_book", async () => {
    mockInvoke.mockResolvedValue({ market: "HYPE", bids: [], asks: [], time: 0 });
    await venueClient.orderBook("hyperliquid", "HYPE");
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("order_book", {
      venue: "hyperliquid",
      market: "HYPE",
    });
  });

  it("turns a VenueError into a displayable message", async () => {
    mockInvoke.mockRejectedValue({ kind: "network", detail: "timed out" });
    await expect(venueClient.markets("hyperliquid")).rejects.toThrow("Network error: timed out");
  });

  it("never echoes an unrecognised rejection", async () => {
    mockInvoke.mockRejectedValue("something with a secret in it");
    await expect(venueClient.markets("hyperliquid")).rejects.toThrow("The venue call failed.");
  });

  it("explains that venue data needs the Tauri runtime", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(venueClient.markets("hyperliquid")).rejects.toThrow(/make dev/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("venueClient subscriptions", () => {
  it("forwards updates and the closing event", async () => {
    mockInvoke.mockResolvedValue(7);
    const h = handlers();
    venueClient.subscribeOrderBook("hyperliquid", "HYPE", h);
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledOnce());

    channels[0]?.onmessage({ event: "update", data: "book" });
    channels[0]?.onmessage({ event: "closed" });
    expect(h.onUpdate).toHaveBeenCalledExactlyOnceWith("book");
    expect(h.onClosed).toHaveBeenCalledOnce();
  });

  it("unsubscribes with the id the command returned", async () => {
    mockInvoke.mockResolvedValue(7);
    const stop = venueClient.subscribeAccount("hyperliquid", "0xabc", handlers());
    await Promise.resolve();
    await Promise.resolve();
    stop();
    expect(mockInvoke).toHaveBeenLastCalledWith("unsubscribe", { id: 7 });
  });

  it("unsubscribes once the id arrives if stopped before the command resolved", async () => {
    let resolve: (id: number) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const h = handlers();
    const stop = venueClient.subscribeOrderBook("hyperliquid", "HYPE", h);
    stop();
    expect(mockInvoke).toHaveBeenCalledOnce();

    resolve(9);
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenLastCalledWith("unsubscribe", { id: 9 }));
    channels[0]?.onmessage({ event: "update", data: "late" });
    expect(h.onUpdate).not.toHaveBeenCalled();
  });

  it("reports a failed subscribe as a message", async () => {
    mockInvoke.mockRejectedValue({ kind: "invalidRequest", detail: 'unknown market "NOPE"' });
    const h = handlers();
    venueClient.subscribeOrderBook("hyperliquid", "NOPE", h);
    await vi.waitFor(() =>
      expect(h.onError).toHaveBeenCalledWith('Invalid request: unknown market "NOPE"'),
    );
  });
});
