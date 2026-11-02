import { setDisplayCurrency } from "@pewterdesk/ui";
import { FX_CURRENCIES, latestRates } from "./fxRates";

// The app's currency, set in Settings and kept on this machine. It changes
// what money is shown in, and nothing else.

const KEY = "pd.appCurrency";
/** How often the rate behind it is read again. */
const REFRESH_MS = 60 * 60 * 1000;

export function loadAppCurrency(): string | undefined {
  try {
    const code = localStorage.getItem(KEY);
    return FX_CURRENCIES.some((c) => c === code) ? (code as string) : undefined;
  } catch {
    return undefined;
  }
}

/** Shows `code`; false if there's no rate for it, and money stays as the venue has it. */
export async function applyAppCurrency(code: string | undefined): Promise<boolean> {
  if (!code) {
    setDisplayCurrency(undefined);
    return true;
  }
  const rate = await latestRates().then(
    (rates) => rates[code],
    () => undefined,
  );
  setDisplayCurrency(rate === undefined ? undefined : { code, rate });
  return rate !== undefined;
}

export function saveAppCurrency(code: string | undefined) {
  try {
    if (code) localStorage.setItem(KEY, code);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: it lasts for this session only.
  }
}

/** Puts the saved currency on, and keeps its rate fresh. Returns the stop. */
export function startAppCurrency(): () => void {
  void applyAppCurrency(loadAppCurrency());
  const id = setInterval(() => void applyAppCurrency(loadAppCurrency()), REFRESH_MS);
  return () => clearInterval(id);
}
