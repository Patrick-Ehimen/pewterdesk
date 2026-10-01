/**
 * Exchange-agnostic contract for where private key material lives: write,
 * check and delete. There is no read - a stored key never comes back to JS;
 * Rust reads it through the app's `KeySource` for the signing call.
 *
 * core owns the interface; implementations are platform-specific and live in
 * the apps (apps/desktop wires this to the Tauri keychain commands). Exchange
 * adapters receive a SecretStore, they never construct one - same dependency
 * direction as ExchangeAdapter.
 */
export interface SecretStore {
  /** Store or overwrite the secret held under `account`. */
  store(account: string, secret: string): Promise<void>;
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
 * a bad label without a round trip. Rust remains the authority - this is a
 * convenience, never the only check.
 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9\-_.:]{1,128}$/;

export function isValidAccount(account: string): boolean {
  return ACCOUNT_PATTERN.test(account);
}
