import { describe, expect, it } from "vitest";
import { accountViewOf } from "./accountView";
import { ALL_VENUES_ACCOUNT, PRESETS } from "./workspace";

describe("accountViewOf", () => {
  it("opens an ordinary Account panel on the venue's account", () => {
    expect(accountViewOf("account:account", {})).toBe("venue");
  });
  it("opens the Multi-venue layout's on every venue, until another view is picked", () => {
    expect(accountViewOf(ALL_VENUES_ACCOUNT, {})).toBe("all");
    expect(accountViewOf(ALL_VENUES_ACCOUNT, { [ALL_VENUES_ACCOUNT]: "venue" })).toBe("venue");
  });
  it("is the panel the Multi-venue layout uses", () => {
    const preset = PRESETS.find((p) => p.name === "Multi-venue");
    expect(preset?.layout.some((p) => p.i === ALL_VENUES_ACCOUNT)).toBe(true);
  });
});
