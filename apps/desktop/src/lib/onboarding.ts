import type { VenueId } from "@pewterdesk/core";
import { VENUE_IDS } from "./venues";

// First-run setup: whether it's been done, and what was chosen. Kept in
// local storage (nothing secret: keys are in the keychain); Settings can run
// it again.

const KEY = "pd.onboarding";

/** Only mainnet works today; testnet is shown as coming soon. */
export type Network = "mainnet" | "testnet";

export interface OnboardingState {
  done: boolean;
  /** The venues chosen, in the venue chips' order; at least one. */
  venues: VenueId[];
  network: Network;
}

export const DEFAULT_ONBOARDING: OnboardingState = {
  done: false,
  venues: [...VENUE_IDS],
  network: "mainnet",
};

/** What's saved, made safe: unknown venues dropped, at least one kept. */
export function parseOnboarding(raw: string | null): OnboardingState {
  if (!raw) return DEFAULT_ONBOARDING;
  try {
    const value = JSON.parse(raw) as Partial<OnboardingState>;
    const venues = VENUE_IDS.filter((id) => value.venues?.includes(id));
    return {
      done: value.done === true,
      venues: venues.length > 0 ? venues : [...VENUE_IDS],
      network: value.network === "testnet" ? "testnet" : "mainnet",
    };
  } catch {
    return DEFAULT_ONBOARDING;
  }
}

export function loadOnboarding(): OnboardingState {
  try {
    return parseOnboarding(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_ONBOARDING;
  }
}

export function saveOnboarding(state: OnboardingState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable: setup shows again next launch, which is harmless.
  }
}
