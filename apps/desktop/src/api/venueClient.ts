import type {
  AccountSnapshot,
  Market,
  MarketStats,
  OrderBook,
  Trade,
  VenueError,
  VenueId,
} from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

/**
 * StreamEvent as serde emits it from venues.rs: adjacently tagged, so
 * `closed` arrives without `data`. Keep in sync with venues.rs.
 */
export type StreamEvent<T> = { event: "update"; data: T } | { event: "closed" };

export interface StreamHandlers<T> {
  onUpdate: (value: T) => void;
  /** The venue ended the stream; nothing more will arrive. */
  onClosed: () => void;
  /** The subscribe command itself failed; `message` is safe to display. */
  onError: (message: string) => void;
}

const venueErrorKinds = new Set(["unsupported", "invalidRequest", "rejected", "network", "key"]);

/** Narrows an invoke rejection to a VenueError, or undefined if it isn't one. */
export function asVenueError(raw: unknown): VenueError | undefined {
  if (typeof raw === "object" && raw !== null && "kind" in raw) {
    const kind = (raw as { kind: unknown }).kind;
    if (typeof kind === "string" && venueErrorKinds.has(kind)) return raw as VenueError;
  }
  return undefined;
}

/**
 * A one-line message for the UI. Venue details are safe to show — venues.rs
 * guarantees they carry no key material — but an unrecognised rejection is
 * never echoed, since we don't know what's in it.
 */
export function describeVenueError(error: VenueError | undefined): string {
  if (!error) return t("error.failed");
  switch (error.kind) {
    case "unsupported":
      return t("error.unsupported", { detail: error.detail });
    case "invalidRequest":
      return t("error.invalidRequest", { detail: error.detail });
    case "rejected":
      return t("error.rejected", { detail: error.detail });
    case "network":
      return t("error.network", { detail: error.detail });
    case "key":
      return error.detail.kind === "notFound"
        ? t("error.noKey")
        : t("error.key", { detail: error.detail.detail });
  }
}

/** Rejects with an Error whose message is safe to display. */
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(t("error.noTauri"));
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw new Error(describeVenueError(asVenueError(e)));
  }
}

/**
 * Starts a subscription command and returns a function that ends it. Safe to
 * call the returned function before the command resolves — the subscription
 * is torn down as soon as its id arrives, and no handler fires after it.
 */
function subscribe<T>(
  command: string,
  args: Record<string, unknown>,
  handlers: StreamHandlers<T>,
): () => void {
  let stopped = false;
  let id: number | undefined;

  if (!isTauri()) {
    queueMicrotask(() => stopped || handlers.onError(t("error.noTauri")));
  } else {
    const channel = new Channel<StreamEvent<T>>();
    channel.onmessage = (message) => {
      if (stopped) return;
      if (message.event === "update") handlers.onUpdate(message.data);
      else handlers.onClosed();
    };
    invoke<number>(command, { ...args, onEvent: channel }).then(
      (subscriptionId) => {
        id = subscriptionId;
        if (stopped) void invoke("unsubscribe", { id });
      },
      (e) => stopped || handlers.onError(describeVenueError(asVenueError(e))),
    );
  }

  return () => {
    if (stopped) return;
    stopped = true;
    if (id !== undefined) void invoke("unsubscribe", { id });
  };
}

export const venueClient = {
  markets: (venue: VenueId) => call<Market[]>("markets", { venue }),

  orderBook: (venue: VenueId, market: string) => call<OrderBook>("order_book", { venue, market }),

  account: (venue: VenueId, address: string) =>
    call<AccountSnapshot>("account", { venue, address }),

  subscribeOrderBook: (venue: VenueId, market: string, handlers: StreamHandlers<OrderBook>) =>
    subscribe("subscribe_order_book", { venue, market }, handlers),

  subscribeTrades: (venue: VenueId, market: string, handlers: StreamHandlers<Trade[]>) =>
    subscribe("subscribe_trades", { venue, market }, handlers),

  subscribeMarketStats: (venue: VenueId, market: string, handlers: StreamHandlers<MarketStats>) =>
    subscribe("subscribe_market_stats", { venue, market }, handlers),

  subscribeAccount: (venue: VenueId, address: string, handlers: StreamHandlers<AccountSnapshot>) =>
    subscribe("subscribe_account", { venue, address }, handlers),
};
