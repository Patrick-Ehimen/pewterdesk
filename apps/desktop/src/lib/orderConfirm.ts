const STORAGE_KEY = "pd.orderConfirm";

/** Whether the ticket asks before sending, and under what order value it doesn't. */
export interface OrderConfirmPrefs {
  enabled: boolean;
  /** In the quote coin; unset asks for every order. */
  skipUnder?: number;
}

const DEFAULT: OrderConfirmPrefs = { enabled: true };

export function loadOrderConfirm(): OrderConfirmPrefs {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object" && "enabled" in saved) {
      const { enabled, skipUnder } = saved as { enabled: unknown; skipUnder?: unknown };
      return {
        enabled: enabled !== false,
        skipUnder: typeof skipUnder === "number" && skipUnder > 0 ? skipUnder : undefined,
      };
    }
  } catch {
    // Unreadable: ask, as by default.
  }
  return DEFAULT;
}

export function saveOrderConfirm(prefs: OrderConfirmPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or off: the choice lasts this session.
  }
}
