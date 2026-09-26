import { describe, expect, it } from "vitest";
import { isAddress } from "../src/lib/watchAddress";

describe("isAddress", () => {
  it("accepts 0x plus 40 hex characters, any case", () => {
    expect(isAddress("0x7a3f00000000000000000000000000000000c91e")).toBe(true);
    expect(isAddress("0xABCDEFabcdef0123456789ABCDEFabcdef012345")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isAddress("")).toBe(false);
    expect(isAddress("7a3f00000000000000000000000000000000c91e")).toBe(false);
    expect(isAddress("0x7a3f")).toBe(false);
    expect(isAddress("0x7a3f00000000000000000000000000000000c91e0")).toBe(false);
    expect(isAddress("0xg000000000000000000000000000000000000000")).toBe(false);
    expect(isAddress(" 0x7a3f00000000000000000000000000000000c91e")).toBe(false);
  });
});
