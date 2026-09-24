import { SecretStoreError } from "@pewterdesk/core";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tauriSecretStore } from "../src/secrets/tauriSecretStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("tauriSecretStore commands", () => {
  it("store passes account and secret to store_secret", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await tauriSecretStore.store("wallet", "s3cret");
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("store_secret", {
      account: "wallet",
      secret: "s3cret",
    });
  });

  it("get resolves the secret from get_secret", async () => {
    mockInvoke.mockResolvedValue("s3cret");
    await expect(tauriSecretStore.get("wallet")).resolves.toBe("s3cret");
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("get_secret", { account: "wallet" });
  });

  it("has resolves the boolean from has_secret", async () => {
    mockInvoke.mockResolvedValue(false);
    await expect(tauriSecretStore.has("wallet")).resolves.toBe(false);
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("has_secret", { account: "wallet" });
  });

  it("delete calls delete_secret", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await tauriSecretStore.delete("wallet");
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("delete_secret", { account: "wallet" });
  });
});

describe("tauriSecretStore error mapping", () => {
  async function rejectionFrom(raw: unknown): Promise<SecretStoreError> {
    mockInvoke.mockRejectedValue(raw);
    const err = await tauriSecretStore.get("wallet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    return err as SecretStoreError;
  }

  it("maps notFound, which arrives without a detail", async () => {
    const err = await rejectionFrom({ kind: "notFound" });
    expect(err.kind).toBe("notFound");
  });

  it.each(["invalidAccount", "backend"] as const)("maps %s with its detail", async (kind) => {
    const err = await rejectionFrom({ kind, detail: "from rust" });
    expect(err.kind).toBe(kind);
    expect(err.message).toBe("from rust");
  });

  it.each([
    ["a string", "command get_secret not found"],
    ["an unknown kind", { kind: "surprise", detail: "0xdeadbeef" }],
    ["null", null],
  ])("maps %s to a generic backend error without echoing it", async (_, raw) => {
    const err = await rejectionFrom(raw);
    expect(err.kind).toBe("backend");
    expect(err.message).toBe("keychain call failed");
  });
});
