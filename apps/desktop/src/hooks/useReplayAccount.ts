import type {
  AccountSnapshot,
  Market,
  Order,
  OrderAmend,
  OrderRequest,
  Position,
  PositionProtection,
  VenueId,
} from "@pewterdesk/core";
import { barEnd, lastClosedAt, t } from "@pewterdesk/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  adjustFunds,
  amendOrder,
  cancelOrder,
  newPaperState,
  PAPER_START,
  type PaperError,
  type PaperState,
  placeOrder,
  protectPosition,
  type Quotes,
  setLeverage,
  setMarginMode,
  snapshot,
  tradeSettings,
  withdrawable,
} from "../lib/paper";
import { endSession, type ReplayBar, type ReplaySession, stepBar } from "../lib/replayAccount";
import { replayAccount, saveReplayAccount, subscribeReplay } from "../lib/replayStore";
import { VENUES } from "../lib/venues";
import { type Paper, paperErrorText } from "./usePaper";
import type { Feed } from "./useVenueFeeds";

/** A finished session: what it came to, for the summary. */
export interface ReplayResult {
  market: string;
  /** Closed in the session, newest first. */
  trades: PaperState["closed"];
  before: number;
  after: number;
}

export interface ReplayAccount {
  /** A session is running: the Trade page trades this account. */
  on: boolean;
  paper: Paper;
  /** The price of the candle on screen. */
  price?: number;
  /** Stepped back: orders wait until the newest candle again. */
  behind: boolean;
  /** Balance when the session began. */
  sessionStart: number;
  result?: ReplayResult;
  dismissResult: () => void;
}

/** What a session has done so far, kept while it runs. */
interface Running {
  id: number;
  market: Market;
  /** The candles it's on: another interval's, after a change. */
  bars: readonly ReplayBar[];
  /** The newest candle the account has been moved through. */
  done: number;
  /** When that one closed. */
  doneAt: number;
  last: ReplayBar;
  before: number;
  closedBefore: number;
}

/**
 * The replay account, behind the same shape as a paper one so every order path
 * can use it. A session runs on the candles of a replay on the chart: each new
 * one moves the account on, and when it ends what's open is closed and the
 * balance kept for next time. Nothing here reaches a venue.
 */
export function useReplayAccount({
  venue,
  markets,
  selected,
  session,
}: {
  venue: VenueId;
  markets: readonly Market[];
  selected?: Market;
  session?: ReplaySession;
}): ReplayAccount {
  const state = useSyncExternalStore(subscribeReplay, () => replayAccount(venue));
  const fees = VENUES[venue].fees;
  const running = useRef<Running>(undefined);
  const [result, setResult] = useState<ReplayResult>();
  const [sessionStart, setSessionStart] = useState(0);

  const finish = useCallback(() => {
    const was = running.current;
    if (!was) return;
    running.current = undefined;
    const ended = endSession(replayAccount(venue), was.market, was.last, fees);
    saveReplayAccount(ended);
    const trades = ended.closed.slice(0, Math.max(0, ended.closed.length - was.closedBefore));
    if (trades.length > 0) {
      setResult({ market: was.market.id, trades, before: was.before, after: ended.cash });
    }
  }, [venue, fees]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: what runs is read from `session` alone
  useEffect(() => {
    if (running.current && running.current.id !== session?.id) finish();
    if (!session) return;
    const market = markets.find((m) => m.id === session.market);
    if (!market) return;
    if (!running.current) {
      const now = replayAccount(venue);
      const bar = session.bars[session.index];
      if (!bar) return;
      running.current = {
        id: session.id,
        market,
        bars: session.bars,
        done: session.index,
        doneAt: session.time,
        last: bar,
        before: now.cash,
        closedBefore: now.closed.length,
      };
      setSessionStart(now.cash);
      return;
    }
    const run = running.current;
    // Another interval: the account carries on from the same moment.
    if (session.bars !== run.bars) {
      run.bars = session.bars;
      run.done = lastClosedAt(session.bars, run.doneAt);
    }
    let next = replayAccount(venue);
    for (let i = run.done + 1; i <= session.index; i++) {
      const bar = session.bars[i];
      if (!bar) break;
      next = stepBar(next, market, bar, fees);
      run.done = i;
      run.doneAt = barEnd(session.bars, i);
      run.last = bar;
    }
    if (next !== replayAccount(venue)) saveReplayAccount(next);
  }, [session]);

  // Leaving (a closed panel, another venue) ends it like the Live button.
  useEffect(() => finish, [finish]);

  const on = session !== undefined;
  const bar = session?.bars[session.index];
  const price = bar?.close;
  const behind = session !== undefined && session.time < (running.current?.doneAt ?? 0);
  const marketId = session?.market;
  const quotes = useMemo<Quotes>(
    () => (marketId && price ? { [marketId]: { mark: price } } : {}),
    [marketId, price],
  );
  const marketMap = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);
  const barMs = bar ? bar.time * 1000 : 0;

  const account: Feed<AccountSnapshot> = useMemo(
    () =>
      on && price
        ? { status: "live", data: snapshot(state, quotes, marketMap, barMs) }
        : { status: "idle" },
    [on, price, state, quotes, marketMap, barMs],
  );
  const settings = useMemo(
    () => (selected ? tradeSettings(state, selected) : undefined),
    [state, selected],
  );

  // Money put in or taken out isn't P&L: the session counts from it.
  const sessionBase = () => running.current?.before ?? sessionStart;
  const rebase = (before: number) => {
    const run = running.current;
    if (run) {
      run.before = before;
      if (before === PAPER_START && replayAccount(venue).closed.length === 0) run.closedBefore = 0;
    }
    setSessionStart(before);
  };

  /** Refuses unless a session is on its newest candle: a closed one trades nothing. */
  const ready = () => {
    if (!running.current) throw new Error(t("replay.ended"));
    if (behind) throw new Error(t("replay.behind"));
  };
  const apply = (run: (s: PaperState) => { state: PaperState; error?: PaperError }) => {
    const now = replayAccount(venue);
    const out = run(now);
    if (out.state !== now) saveReplayAccount(out.state);
    if (out.error) throw new Error(paperErrorText(out.error));
  };
  const marketOf = (id: string) => {
    const m = marketMap.get(id);
    if (!m) throw new Error(t("paper.error.noMarket"));
    return m;
  };

  const paper: Paper = {
    available: true,
    on,
    setOn: () => {},
    state,
    account,
    place: async (request: OrderRequest) => {
      ready();
      apply((s) => placeOrder(s, request, marketOf(request.market), quotes, fees, barMs));
    },
    cancel: async (order: Order) => {
      ready();
      apply((s) => cancelOrder(s, order.id));
    },
    amend: async (order: Order, change: OrderAmend) => {
      ready();
      apply((s) => amendOrder(s, order.id, change, marketOf(order.market)));
    },
    protect: async (position: Position, protection: PositionProtection) => {
      ready();
      apply((s) => protectPosition(s, position.market, protection));
    },
    settings,
    setLeverage: async (leverage) => {
      if (selected) saveReplayAccount(setLeverage(replayAccount(venue), selected, leverage));
    },
    setMarginMode: async (mode) => {
      if (selected) apply((s) => setMarginMode(s, selected, mode));
    },
    reset: () => {
      saveReplayAccount(newPaperState(venue, PAPER_START));
      rebase(PAPER_START);
    },
    adjust: (amount) => {
      apply((s) => adjustFunds(s, amount, quotes));
      rebase(sessionBase() + amount);
    },
    withdrawable: withdrawable(state, quotes),
  };

  return {
    on,
    paper,
    price,
    behind,
    sessionStart,
    result,
    dismissResult: () => setResult(undefined),
  };
}
