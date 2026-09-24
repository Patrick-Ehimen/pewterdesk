/**
 * Exchange-agnostic contract for where private key material lives.
 *
 * core owns the interface; implementations are platform-specific and live in
 * the apps (apps/desktop wires this to the Tauri keychain commands). Exchange
 * adapters receive a SecretStore, they never construct one — same dependency
 * direction as ExchangeAdapter.
 */
export interface SecretStore {
  /** Store or overwrite the secret held under `account`. */
  store(account: string, secret: string): Promise<void>;
  /** Read the secret back. Rejects with SecretStoreError("notFound") if absent. */
  get(account: string): Promise<string>;
  /** Whether a secret exists, without materializing it. */
  has(account: string): Promise<boolean>;
  /** Idempotent: deleting an absent secret resolves. */
  delete(account: string): Promise<void>;
}

export type SecretStoreErrorKind = "invalidAccount" | "notFound" | "backend";

export class SecretStoreError extends Error {
  readonly kind: SecretStoreErrorKind;

  constructor(kind: SecretStoreErrorKind, message: string) {
    super(message);
    this.name = "SecretStoreError";
    this.kind = kind;
  }
}

/**
 * Mirrors the account validation the Rust side enforces, so the UI can reject
 * a bad label without a round trip. Rust remains the authority — this is a
 * convenience, never the only check.
 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9\-_.:]{1,128}$/;

export function isValidAccount(account: string): boolean {
  return ACCOUNT_PATTERN.test(account);
}

/**
 * The intended way to use a secret: scoped to a single callback, so key
 * material never lands in component state, a module-level cache, or a closure
 * that outlives the signing call.
 *
 * JS can't zero a string, so this doesn't clear anything — it exists to keep
 * the exposure window to one call and to give reviewers a single grep target
 * (`store.get(` outside this file is the smell). Anything needing a real
 * guarantee belongs in Rust.
 */
export async function withSecret<T>(
  store: SecretStore,
  account: string,
  use: (secret: string) => Promise<T>,
): Promise<T> {
  return use(await store.get(account));
}
