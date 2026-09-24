import { describe, expect, it, vi } from "vitest";
import { isValidAccount, type SecretStore, SecretStoreError, withSecret } from "../src";

function stubStore(get: SecretStore["get"]): SecretStore {
  return {
    store: vi.fn(),
    get: vi.fn(get),
    has: vi.fn(),
    delete: vi.fn(),
  };
}

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

describe("withSecret", () => {
  it("reads the account once and returns the callback's result", async () => {
    const store = stubStore(async () => "s3cret");
    const use = vi.fn(async (secret: string) => secret.length);

    await expect(withSecret(store, "wallet", use)).resolves.toBe(6);
    expect(store.get).toHaveBeenCalledExactlyOnceWith("wallet");
    expect(use).toHaveBeenCalledExactlyOnceWith("s3cret");
  });

  it("propagates a store rejection without calling the callback", async () => {
    const store = stubStore(async () => {
      throw new SecretStoreError("notFound", "no secret for wallet");
    });
    const use = vi.fn(async () => "unreachable");

    await expect(withSecret(store, "wallet", use)).rejects.toMatchObject({
      name: "SecretStoreError",
      kind: "notFound",
    });
    expect(use).not.toHaveBeenCalled();
  });

  it("propagates a rejection from the callback", async () => {
    const store = stubStore(async () => "s3cret");
    const failure = new Error("signing failed");

    await expect(
      withSecret(store, "wallet", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
