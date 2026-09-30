import { describe, expect, it } from "vitest";
import { connectionState, LOST_MS, STALE_MS } from "../src/hooks/useConnection";

const at = (quietMs: number, extra: Partial<Parameters<typeof connectionState>[0]> = {}) =>
  connectionState({ network: true, failed: false, lastUpdate: 0, now: quietMs, ...extra });

describe("connection state", () => {
  it("is online while data keeps arriving", () => {
    expect(at(0)).toBe("online");
    expect(at(STALE_MS)).toBe("online");
  });

  it("reads a quiet feed as unstable, then lost", () => {
    expect(at(STALE_MS + 1)).toBe("connecting");
    expect(at(LOST_MS)).toBe("connecting");
    expect(at(LOST_MS + 1)).toBe("offline");
  });

  it("is offline at once when the network or a feed goes", () => {
    expect(at(0, { network: false })).toBe("offline");
    expect(at(0, { failed: true })).toBe("offline");
  });

  it("is connecting until the first data arrives", () => {
    expect(at(0, { lastUpdate: undefined })).toBe("connecting");
  });
});
