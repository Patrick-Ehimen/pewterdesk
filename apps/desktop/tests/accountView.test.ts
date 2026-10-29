import { describe, expect, it } from "vitest";
import { accountViewOf } from "../src/lib/accountView";

describe("account view", () => {
  it("opens on the venue's view, or all venues for a former Balances panel", () => {
    expect(accountViewOf("account:1a2b", {})).toBe("venue");
    expect(accountViewOf("balances:9f8e", {})).toBe("all");
    expect(accountViewOf("account:1a2b", { "account:1a2b": "all" })).toBe("all");
    expect(accountViewOf("balances:9f8e", { "balances:9f8e": "venue" })).toBe("venue");
  });
});
