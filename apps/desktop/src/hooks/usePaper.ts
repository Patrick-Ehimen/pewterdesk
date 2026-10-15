import type {
  AccountSnapshot,
  MarginMode,
  Market,
  MarketSummary,
  Order,
  OrderAmend,
  OrderRequest,
  Position,
  PositionProtection,
  TradeSettings,
  VenueId,
} from "@pewterdesk/core";
import { type MessageKey, t } from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  adjustFunds,
  amendOrder,
  cancelOrder,
  isPaperVenue,
  PAPER_START,
  type PaperError,
  type PaperState,
  placeOrder,
  protectPosition,
  type Quotes,
  setLeverage,
  setMarginMode,
  snapshot,
  tick,
  tradeSettings,
  withdrawable,
} from "../lib/paper";
import {
  isPaperMode,
  paperAccount,
  resetPaperAccount,
  savePaperAccount,
  setPaperMode,
  subscribePaper,
} from "../lib/paperStore";
import { VENUES } from "../lib/venues";
import type { Feed } from "./useVenueFeeds";

/** How often resting orders, exits, funding and liquidations are checked. */
const TICK_MS = 1000;

const ERROR: Record<PaperError, MessageKey> = {
  noPrice: "paper.error.noPrice",
  size: "paper.error.size",
  minSize: "paper.error.minSize",
  margin: "paper.error.margin",
  reduceOnly: "paper.error.reduceOnly",
  postOnly: "paper.error.postOnly",
  notFound: "paper.error.notFound",
  price: "paper.error.price",
  hasPosition: "paper.error.hasPosition",
  amount: "paper.error.amount",
  tooMuch: "paper.error.tooMuch",
};

export interface Paper {
  /** The venue has paper trading (no demo of its own). */
  available: boolean;
  /** The venue is in paper mode: the Trade page trades the paper account. */
  on: boolean;
  setOn: (on: boolean) => void;
  state: PaperState;
  /** The paper account as the panels read a venue's; idle when off. */
  account: Feed<AccountSnapshot>;
  place: (request: OrderRequest) => Promise<void>;
  cancel: (order: Order) => Promise<void>;
  amend: (order: Order, change: OrderAmend) => Promise<void>;
  protect: (position: Position, protection: PositionProtection) => Promise<void>;
  settings?: TradeSettings;
  setLeverage: (leverage: number) => Promise<void>;
  setMarginMode: (mode: MarginMode) => Promise<void>;
  /** Starts the account again at the default balance: no positions, orders or history. */
  reset: () => void;
  /** Adds funds (positive) or takes them out (negative); throws why it can't. */
  adjust: (amount: number) => void;
  /** What could be taken out now. */
  withdrawable: number;
}

/**
 * The venue's paper account, run on its live prices: every venue's mark from
 * the summaries, the best bid and ask from the book of the market on screen.
 * While it's on, it moves forward once a second. Nothing here reaches a
 * venue: orders, cancels and exits change the paper account only.
 */
export function usePaper({
  venue,
  markets,
  summaries,
  selected,
  bid,
  ask,
}: {
  venue: VenueId;
  markets: readonly Market[];
  summaries?: readonly MarketSummary[];
  /** The market on screen, whose book gives the best prices. */
  selected?: Market;
  bid?: string;
  ask?: string;
}): Paper {
  const available = isPaperVenue(venue);
  const on = useSyncExternalStore(subscribePaper, () => isPaperMode(venue));
  const state = useSyncExternalStore(subscribePaper, () => paperAccount(venue));
  const fees = VENUES[venue].fees;

  const marketMap = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);
  const quotes = useMemo(() => {
    const out: Record<string, Quotes[string]> = {};
    for (const s of summaries ?? []) {
      const mark = Number(s.markPrice);
      if (!(mark > 0)) continue;
      out[s.market] = {
        mark,
        fundingRate: Number(s.fundingRate),
        fundingIntervalSecs: s.fundingIntervalSecs,
      };
    }
    const b = Number(bid);
    const a = Number(ask);
    if (selected && b > 0 && a > 0) {
      out[selected.id] = { ...(out[selected.id] ?? { mark: (a + b) / 2 }), bid: b, ask: a };
    }
    return out as Quotes;
  }, [summaries, selected, bid, ask]);

  // The ticker reads the latest prices without restarting on each one.
  const latest = useRef({ quotes, marketMap });
  latest.current = { quotes, marketMap };
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => {
      const now = paperAccount(venue);
      const next = tick(now, latest.current.quotes, latest.current.marketMap, fees, Date.now());
      if (next !== now) savePaperAccount(next);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [on, venue, fees]);

  const ready = Object.keys(quotes).length > 0;
  const account: Feed<AccountSnapshot> = useMemo(
    () =>
      !on
        ? { status: "idle" }
        : ready
          ? { status: "live", data: snapshot(state, quotes, marketMap, Date.now()) }
          : { status: "loading" },
    [on, ready, state, quotes, marketMap],
  );

  const settings = useMemo(
    () => (selected ? tradeSettings(state, selected) : undefined),
    [state, selected],
  );

  const marketOf = (id: string) => {
    const m = marketMap.get(id);
    if (!m) throw new Error(t("paper.error.noMarket"));
    return m;
  };
  /** Applies a change to the stored account, or throws its reason in words. */
  const apply = (run: (s: PaperState) => { state: PaperState; error?: PaperError }) => {
    const result = run(paperAccount(venue));
    if (result.state !== paperAccount(venue)) savePaperAccount(result.state);
    if (result.error) throw new Error(t(ERROR[result.error]));
  };

  return {
    available,
    on: available && on,
    setOn: (next) => setPaperMode(venue, next),
    state,
    account,
    place: async (request) =>
      apply((s) => placeOrder(s, request, marketOf(request.market), quotes, fees, Date.now())),
    cancel: async (order) => apply((s) => cancelOrder(s, order.id)),
    amend: async (order, change) =>
      apply((s) => amendOrder(s, order.id, change, marketOf(order.market))),
    protect: async (position, protection) =>
      apply((s) => protectPosition(s, position.market, protection)),
    settings,
    setLeverage: async (leverage) => {
      if (selected) savePaperAccount(setLeverage(paperAccount(venue), selected, leverage));
    },
    setMarginMode: async (mode) => {
      if (selected) apply((s) => setMarginMode(s, selected, mode));
    },
    reset: () => resetPaperAccount(venue, PAPER_START),
    adjust: (amount) => apply((s) => adjustFunds(s, amount, quotes)),
    withdrawable: withdrawable(state, quotes),
  };
}
