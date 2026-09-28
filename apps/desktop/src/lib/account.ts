/**
 * The connected trading account's address. Nothing sets one yet: wallet
 * connection arrives with order placement (docs/adr/0001-venues-in-rust.md).
 * Everything that shows an account (the account, positions and history
 * panels, Portfolio, the order ticket, the tray) reads it and shows its
 * "connect a wallet" state until then.
 */
export function connectedAddress(): string | undefined {
  return undefined;
}

/** Earlier versions could watch any address; forget one they stored. */
export function forgetWatchedAddress() {
  try {
    localStorage.removeItem("pd.watchAddress");
  } catch {
    // Storage unavailable: there's nothing stored to forget either.
  }
}
