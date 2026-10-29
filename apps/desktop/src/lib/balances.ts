import type { AccountSnapshot, VenueId } from "@pewterdesk/core";
import { type AccountsState, isDemoAccount, type VenueAccount, venueAccounts } from "./account";

// The Balances panel's arithmetic: every connected account on the venues
// turned on, side by side, and what they come to together, as Tealstreet's
// unified balances. Figures are in each venue's quote asset (USDT, USDC),
// added as dollars. Demo Trading funds are totalled apart, never with real
// ones. Paper accounts aren't venue accounts, and aren't in it.

export type BalanceKind = "live" | "demo";

export const kindOf = (account: { venue: VenueId; id: string }): BalanceKind =>
  isDemoAccount(account) ? "demo" : "live";

/** One account's figures, as the panel shows them. */
export interface Figures {
  /** Equity less unrealized PnL: what the account holds before open positions. */
  balance: number;
  unrealized: number;
  equity: number;
  available: number;
  positions: number;
}

export const NO_FIGURES: Figures = {
  balance: 0,
  unrealized: 0,
  equity: 0,
  available: 0,
  positions: 0,
};

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function figuresOf(snapshot: AccountSnapshot): Figures {
  const unrealized = snapshot.positions.reduce((sum, p) => sum + num(p.unrealizedPnl), 0);
  const equity = num(snapshot.equity);
  return {
    balance: equity - unrealized,
    unrealized,
    equity,
    available: num(snapshot.availableMargin),
    positions: snapshot.positions.length,
  };
}

/** `figures` added up. */
export function sumOf(figures: readonly Figures[]): Figures {
  return figures.reduce(
    (a, f) => ({
      balance: a.balance + f.balance,
      unrealized: a.unrealized + f.unrealized,
      equity: a.equity + f.equity,
      available: a.available + f.available,
      positions: a.positions + f.positions,
    }),
    NO_FIGURES,
  );
}

/** How an account is keyed among the panel's figures. */
export const accountKey = (account: { venue: VenueId; id: string }) =>
  `${account.venue}:${account.id}`;

/** The accounts the panel lists: every one on the venues turned on, in their order. */
export function balanceAccounts(state: AccountsState, venues: readonly VenueId[]): VenueAccount[] {
  return venues.flatMap((venue) => venueAccounts(state, venue));
}

/**
 * The live and demo totals of the accounts whose figures are in: demo funds
 * never join real ones. `counted` says how many of each are in so far.
 */
export function totals(
  accounts: readonly VenueAccount[],
  figures: ReadonlyMap<string, Figures>,
): Record<BalanceKind, Figures> & { counted: Record<BalanceKind, number> } {
  const by: Record<BalanceKind, Figures[]> = { live: [], demo: [] };
  for (const account of accounts) {
    const f = figures.get(accountKey(account));
    if (f) by[kindOf(account)].push(f);
  }
  return {
    live: sumOf(by.live),
    demo: sumOf(by.demo),
    counted: { live: by.live.length, demo: by.demo.length },
  };
}

/** An account's share of its total's equity (0 to 1); none when the total is nothing. */
export function shareOf(equity: number, total: number): number | undefined {
  if (!(total > 0) || !(equity > 0)) return total > 0 ? 0 : undefined;
  return Math.min(1, equity / total);
}
