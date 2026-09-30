import { describe, expect, it } from "vitest";
import { countdown, SESSIONS, sessionState, untilText, zoneOffset } from "../src/lib/sessions";

const byId = (id: string) => SESSIONS.find((s) => s.id === id) as (typeof SESSIONS)[number];
const at = (iso: string) => Date.parse(iso);
const H = 3_600_000;
const M = 60_000;

describe("market sessions", () => {
  it("knows each zone's offset, daylight saving included", () => {
    expect(zoneOffset("Asia/Tokyo", at("2026-01-15T00:00:00Z"))).toBe(9 * H);
    expect(zoneOffset("Europe/London", at("2026-01-15T12:00:00Z"))).toBe(0);
    expect(zoneOffset("Europe/London", at("2026-07-15T12:00:00Z"))).toBe(1 * H);
    expect(zoneOffset("America/New_York", at("2026-07-15T12:00:00Z"))).toBe(-4 * H);
  });

  it("opens New York at 9:30 local, which moves in UTC with daylight saving", () => {
    // Wednesday 30 Sep 2026: EDT, so 9:30 is 13:30 UTC.
    const ny = byId("newYork");
    expect(sessionState(ny, at("2026-09-30T13:29:00Z"))).toMatchObject({
      open: false,
      untilChange: 1 * M,
    });
    expect(sessionState(ny, at("2026-09-30T13:30:00Z"))).toMatchObject({
      open: true,
      untilChange: 6.5 * H,
    });
    // In January (EST) the same 9:30 is 14:30 UTC.
    expect(sessionState(ny, at("2026-01-14T14:00:00Z")).open).toBe(false);
    expect(sessionState(ny, at("2026-01-14T15:00:00Z")).open).toBe(true);
  });

  it("stays shut over the weekend, reopening on Monday", () => {
    // Saturday 3 Oct 2026, noon UTC: London next opens Monday 08:00 BST (07:00 UTC).
    const london = sessionState(byId("london"), at("2026-10-03T12:00:00Z"));
    expect(london.open).toBe(false);
    expect(london.untilChange).toBe(43 * H);
    // Friday after the close: also Monday.
    const friday = sessionState(byId("london"), at("2026-10-02T16:00:00Z"));
    expect(friday.open).toBe(false);
    expect(friday.untilChange).toBe(63 * H);
  });

  it("formats time to go and countdowns", () => {
    expect(untilText(45 * M)).toBe("45m");
    expect(untilText(2 * H + 10 * M)).toBe("2h 10m");
    expect(untilText(76 * H)).toBe("3d 4h");
    expect(countdown(41 * M + 5_000)).toBe("41:05");
    expect(countdown(7 * H + 41 * M + 5_000)).toBe("07:41:05");
    expect(countdown(-5)).toBe("00:00");
  });
});
