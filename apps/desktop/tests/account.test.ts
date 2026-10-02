import { describe, expect, it } from "vitest";
import {
  type AccountsState,
  accountLabel,
  activeAccount,
  canTrade,
  isAccountId,
  isDemoAccount,
  migrateLegacy,
  NAME_MAX,
  parseAccounts,
  type VenueAccount,
  venueAccounts,
  withAccount,
  withName,
  withoutAccount,
} from "../src/lib/account";

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const EMPTY: AccountsState = { accounts: [], active: {} };

describe("connected accounts", () => {
  it("checks ids per venue", () => {
    expect(isAccountId("hyperliquid", A)).toBe(true);
    expect(isAccountId("hyperliquid", "24617703")).toBe(false);
    expect(isAccountId("bybit", "24617703")).toBe(true);
    expect(isAccountId("bybit", A)).toBe(false);
    expect(isAccountId("bybit", "demo:24617703")).toBe(true);
    expect(isAccountId("bybit", "demo:")).toBe(false);
    expect(isAccountId("hyperliquid", `demo:${A}`)).toBe(false);
  });

  it("trades only on Bybit demo accounts, for now", () => {
    const demo = { venue: "bybit" as const, id: "demo:24617703" };
    const live = { venue: "bybit" as const, id: "24617703" };
    expect(isDemoAccount(demo) && canTrade(demo)).toBe(true);
    expect(isDemoAccount(live) || canTrade(live)).toBe(false);
    expect(canTrade({ venue: "hyperliquid", id: A })).toBe(false);
    expect(canTrade(undefined)).toBe(false);
  });

  it("adds accounts, making the newest active, without repeats", () => {
    let s = withAccount(EMPTY, "hyperliquid", A, "Main");
    s = withAccount(s, "hyperliquid", B, "");
    s = withAccount(s, "bybit", "24617703", "Desk");
    expect(venueAccounts(s, "hyperliquid").map((a) => a.id)).toEqual([A, B]);
    expect(activeAccount(s, "hyperliquid")?.id).toBe(B);
    expect(activeAccount(s, "bybit")?.name).toBe("Desk");
    // Connecting one again keeps its name and makes it active.
    s = withAccount(s, "hyperliquid", A, "Renamed?");
    expect(venueAccounts(s, "hyperliquid")).toHaveLength(2);
    expect(activeAccount(s, "hyperliquid")?.name).toBe("Main");
  });

  it("hands active to the next account when the active one goes", () => {
    let s = withAccount(withAccount(EMPTY, "hyperliquid", A, ""), "hyperliquid", B, "");
    s = withoutAccount(s, "hyperliquid", B);
    expect(activeAccount(s, "hyperliquid")?.id).toBe(A);
    s = withoutAccount(s, "hyperliquid", A);
    expect(activeAccount(s, "hyperliquid")).toBeUndefined();
    expect(s.active.hyperliquid).toBeUndefined();
  });

  it("renames, tidying the name, and labels unnamed ones by place", () => {
    let s = withAccount(withAccount(EMPTY, "bybit", "1", ""), "bybit", "2", "");
    s = withName(s, "bybit", "2", "  Swing   desk ");
    const [first, second] = venueAccounts(s, "bybit") as [VenueAccount, VenueAccount];
    expect(second.name).toBe("Swing desk");
    expect(accountLabel(s, second)).toEqual({ name: "Swing desk" });
    expect(accountLabel(s, first)).toEqual({ index: 1 });
    s = withName(s, "bybit", "2", "x".repeat(NAME_MAX + 10));
    expect(venueAccounts(s, "bybit")[1]?.name).toHaveLength(NAME_MAX);
    // An empty name makes it unnamed again.
    s = withName(s, "bybit", "2", "   ");
    expect(accountLabel(s, venueAccounts(s, "bybit")[1] as VenueAccount)).toEqual({ index: 2 });
  });

  it("parses what was stored, dropping what's malformed or repeated", () => {
    const raw = JSON.stringify({
      accounts: [
        { venue: "hyperliquid", id: A, name: "Main" },
        { venue: "hyperliquid", id: A, name: "Again" },
        { venue: "bybit", id: "not-a-uid", name: "x" },
        { venue: "nowhere", id: A, name: "x" },
        { venue: "bybit", id: "42", name: 7 },
        { venue: "bybit", id: "43", name: "Ok" },
      ],
      active: { hyperliquid: B, bybit: "43" },
    });
    const s = parseAccounts(raw);
    expect(s.accounts.map((a) => `${a.venue}:${a.id}`)).toEqual([`hyperliquid:${A}`, "bybit:43"]);
    // An active id that isn't listed falls back to the venue's first account.
    expect(s.active).toEqual({ hyperliquid: A, bybit: "43" });
    expect(parseAccounts("{oops")).toEqual(EMPTY);
    expect(parseAccounts(null)).toEqual(EMPTY);
  });

  it("carries over the single wallet and Bybit UID earlier versions kept", () => {
    const s = migrateLegacy(JSON.stringify({ venue: "hyperliquid", address: A }), "24617703");
    expect(activeAccount(s, "hyperliquid")).toEqual({ venue: "hyperliquid", id: A, name: "" });
    expect(activeAccount(s, "bybit")?.id).toBe("24617703");
    expect(migrateLegacy("{bad", "nope")).toEqual(EMPTY);
    expect(migrateLegacy(null, null)).toEqual(EMPTY);
  });
});
