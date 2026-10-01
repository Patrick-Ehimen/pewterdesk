import { describe, expect, it } from "vitest";
import { isValidAccount, SecretStoreError } from "../src";

describe("isValidAccount", () => {
  it.each(["a", "hyperliquid:main", "wallet_0.api-key", "ABC123", "x".repeat(128)])(
    "accepts %j",
    (account) => {
      expect(isValidAccount(account)).toBe(true);
    },
  );

  it.each([
    ["empty", ""],
    ["over 128 chars", "x".repeat(129)],
    ["a space", "my wallet"],
    ["a slash", "venue/main"],
    ["non-ASCII", "wället"],
    ["a trailing newline", "wallet\n"],
    ["a null byte", "wallet\0"],
  ])("rejects %s", (_, account) => {
    expect(isValidAccount(account)).toBe(false);
  });
});

describe("SecretStoreError", () => {
  it("is an Error carrying its kind and message", () => {
    const err = new SecretStoreError("notFound", "no secret for wallet");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect(err.name).toBe("SecretStoreError");
    expect(err.kind).toBe("notFound");
    expect(err.message).toBe("no secret for wallet");
  });
});
