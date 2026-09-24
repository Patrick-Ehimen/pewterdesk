import { type SecretStore, SecretStoreError } from "@pewterdesk/core";
import { invoke } from "@tauri-apps/api/core";

/**
 * KeychainError as serde emits it: adjacently tagged, so unit variants arrive
 * without a `detail` field. Keep in sync with keychain.rs.
 */
type RustKeychainError =
  | { kind: "invalidAccount"; detail: string }
  | { kind: "notFound" }
  | { kind: "backend"; detail: string };

function toSecretStoreError(raw: unknown): SecretStoreError {
  if (typeof raw === "object" && raw !== null && "kind" in raw) {
    const err = raw as RustKeychainError;
    switch (err.kind) {
      case "notFound":
        return new SecretStoreError("notFound", "no secret stored for this account");
      case "invalidAccount":
      case "backend":
        return new SecretStoreError(err.kind, err.detail);
    }
  }
  // Never interpolate the raw rejection into the message — an unexpected
  // reject shape is exactly the case where we don't know what's in it.
  return new SecretStoreError("backend", "keychain call failed");
}

/**
 * SecretStore backed by the OS keychain via the Tauri commands in
 * src-tauri/src/keychain.rs. Desktop-only by construction: apps/web has no
 * Tauri runtime and deliberately gets no SecretStore implementation.
 */
export const tauriSecretStore: SecretStore = {
  async store(account, secret) {
    try {
      await invoke("store_secret", { account, secret });
    } catch (e) {
      throw toSecretStoreError(e);
    }
  },

  async get(account) {
    try {
      return await invoke<string>("get_secret", { account });
    } catch (e) {
      throw toSecretStoreError(e);
    }
  },

  async has(account) {
    try {
      return await invoke<boolean>("has_secret", { account });
    } catch (e) {
      throw toSecretStoreError(e);
    }
  },

  async delete(account) {
    try {
      await invoke("delete_secret", { account });
    } catch (e) {
      throw toSecretStoreError(e);
    }
  },
};
