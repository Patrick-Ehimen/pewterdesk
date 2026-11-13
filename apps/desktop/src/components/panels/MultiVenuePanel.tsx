import { venueLogos } from "@pewterdesk/assets";
import type { Market, OrderRequest, VenueId } from "@pewterdesk/core";
import { formatNumber, t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useMarketSummaries, useMarkets } from "../../hooks/useVenueFeeds";
import {
  type AccountsState,
  activeAccount,
  isDemoAccount,
  type VenueAccount,
} from "../../lib/account";
import {
  coinOf,
  type LegPlan,
  legRequest,
  type MultiTicket,
  marketForCoin,
  NO_ATTACHED_EXITS,
  planLeg,
} from "../../lib/multiVenue";
import { notifyEvent } from "../../lib/notifications";
import type { RuleCheck } from "../../lib/tradingRules";
import { VENUES } from "../../lib/venues";
import { InfoTip } from "../rules/explain";
import { NumberField, Segmented } from "../rules/parts";
import { accountName } from "../wallet/AccountList";

/** One venue's order, ready to send. */
export interface MultiLeg {
  venue: VenueId;
  account: VenueAccount;
  market: Market;
  request: OrderRequest;
  /** Exits to put on the position after a market order, where the venue takes none with it. */
  after?: { stopLoss?: string; takeProfit?: string };
}

interface MultiVenuePanelProps {
  /** The venues turned on in the header, in its order. */
  venues: readonly VenueId[];
  accounts: AccountsState;
  /** Whether an account can trade now (a demo one, or live trading on). */
  canTrade: (account: VenueAccount) => boolean;
  /** Whether a venue is in paper mode: its legs are left out. */
  isPaper: (venue: VenueId) => boolean;
  /** The market on screen's coin, to start from. */
  coin?: string;
  maxSlippageBps: (venue: VenueId) => number;
  /** The account's rules' answer for an order; only what fails. */
  checkRules: (leg: MultiLeg) => Promise<RuleCheck[]>;
  ruleText: (check: RuleCheck) => string;
  /** Sends one leg through the ordinary order path; rejects with why not. */
  place: (leg: MultiLeg) => Promise<"placed" | { protectFailed: string }>;
}

const STORE = "pd.multiVenue";
const DEFAULT: MultiTicket = {
  side: "buy",
  style: "market",
  offsetPct: 0.1,
  riskPct: 1,
  balancePct: 10,
  stopPct: 2,
  targetPct: 4,
};

interface Kept {
  ticket: MultiTicket;
  /** Venues ticked off; every other one is ticked. */
  off: VenueId[];
}

function load(): Kept {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<Kept>;
    return { ticket: { ...DEFAULT, ...raw.ticket }, off: Array.isArray(raw.off) ? raw.off : [] };
  } catch {
    return { ticket: DEFAULT, off: [] };
  }
}

/** What one venue's row comes to: an order, or why there isn't one. */
type LegState =
  | { kind: "ready"; leg: MultiLeg; plan: LegPlan; equity: number; price: number }
  | { kind: "blocked"; reason: string; plan?: LegPlan; market?: Market; price?: number };

type Outcome =
  | { state: "placing" }
  | { state: "placed"; note?: string }
  | { state: "failed"; reason: string };

const num = (v: string | undefined) => (v === undefined ? Number.NaN : Number(v));
const usd = (v: number) => formatNumber(v, 2);

/**
 * One venue: finds the coin on it, reads its account, and works out its
 * order. Reports what it came to; draws its row.
 */
function VenueRow({
  venue,
  account,
  name,
  coin,
  ticket,
  on,
  paper,
  trades,
  slippageBps,
  outcome,
  onToggle,
  onState,
  checkRules,
  ruleText,
}: {
  venue: VenueId;
  account?: VenueAccount;
  /** The account's name, as the account list shows it. */
  name?: string;
  coin: string;
  ticket: MultiTicket;
  on: boolean;
  paper: boolean;
  trades: boolean;
  slippageBps: number;
  outcome?: Outcome;
  onToggle: (on: boolean) => void;
  onState: (venue: VenueId, state: LegState) => void;
  checkRules: (leg: MultiLeg) => Promise<RuleCheck[]>;
  ruleText: (check: RuleCheck) => string;
}) {
  const markets = useMarkets(venue);
  const summaries = useMarketSummaries(venue, account !== undefined);
  const feed = useAccount(venue, account?.id);
  const list = markets.status === "live" || markets.status === "closed" ? markets.data : undefined;
  const market = list && marketForCoin(list, coin);
  const summary =
    market && (summaries.status === "live" || summaries.status === "closed")
      ? summaries.data.find((s) => s.market === market.id)
      : undefined;
  const snapshot = feed.status === "live" || feed.status === "closed" ? feed.data : undefined;
  const price = num(summary?.markPrice);
  const equity = num(snapshot?.equity);
  const available = num(snapshot?.availableMargin);

  const state: LegState = useMemo(() => {
    if (!account) return { kind: "blocked", reason: t("multi.state.noAccount") };
    if (paper) return { kind: "blocked", reason: t("multi.state.paper") };
    if (!trades) return { kind: "blocked", reason: t("multi.state.liveOff") };
    if (!list) return { kind: "blocked", reason: t("multi.state.loading") };
    if (!market) return { kind: "blocked", reason: t("multi.state.notListed", { coin }) };
    if (!snapshot || !(price > 0)) {
      return { kind: "blocked", reason: t("multi.state.loading"), market };
    }
    const plan = planLeg(ticket, { market, price, equity, available });
    if (plan.problem) {
      return { kind: "blocked", reason: t(`multi.problem.${plan.problem}`), plan, market, price };
    }
    const attaches = !NO_ATTACHED_EXITS.has(venue);
    const request = legRequest(ticket, market, plan, slippageBps, attaches);
    const exits = {
      ...(plan.stopText && { stopLoss: plan.stopText }),
      ...(plan.targetText && { takeProfit: plan.targetText }),
    };
    const after =
      !attaches && ticket.style === "market" && (exits.stopLoss || exits.takeProfit)
        ? exits
        : undefined;
    return { kind: "ready", leg: { venue, account, market, request, after }, plan, equity, price };
  }, [
    account,
    paper,
    trades,
    list,
    market,
    snapshot,
    price,
    equity,
    available,
    ticket,
    venue,
    coin,
    slippageBps,
  ]);

  // The parent gathers every row's order; told only when it changes.
  const key = JSON.stringify(
    state.kind === "ready" ? [state.leg.request, state.leg.after, account?.id] : state.reason,
  );
  const report = useRef(onState);
  report.current = onState;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `state`
  useEffect(() => report.current(venue, state), [key, venue]);

  // The account's own rules, asked as the order changes (Rust's check in place_order decides).
  const [rules, setRules] = useState<string>();
  const ask = useRef(checkRules);
  ask.current = checkRules;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the order
  useEffect(() => {
    setRules(undefined);
    if (state.kind !== "ready" || !on) return;
    let live = true;
    const timer = setTimeout(() => {
      ask.current(state.leg).then(
        (checks) => live && setRules(checks[0] ? ruleText(checks[0]) : undefined),
        () => {},
      );
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, on]);

  const plan = state.kind === "ready" ? state.plan : state.plan;
  const shownMarket = state.kind === "ready" ? state.leg.market : state.market;
  const ready = state.kind === "ready";
  const notes: ReactNode[] = [];
  if (ready && NO_ATTACHED_EXITS.has(venue) && (plan?.stopText || plan?.targetText)) {
    notes.push(t(ticket.style === "market" ? "multi.asterExits" : "multi.asterLimitExits"));
  }
  if (rules) notes.push(t("multi.rules", { message: rules }));

  return (
    <div className="mv-row" data-off={!on || !ready || undefined} data-outcome={outcome?.state}>
      <label className="mv-venue">
        <input
          type="checkbox"
          checked={on && ready}
          disabled={!ready}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <img src={venueLogos[venue]} alt="" width={18} height={18} />
        <span>
          <strong>{VENUES[venue].label}</strong>
          {account && (
            <small>
              {name} · {isDemoAccount(account) ? t("multi.demo") : t("multi.live")}
            </small>
          )}
        </span>
      </label>
      <span className="mv-cell">{shownMarket?.symbol ?? "–"}</span>
      <span className="mv-cell pd-num">{price > 0 ? formatNumber(price) : "–"}</span>
      <span className="mv-cell pd-num">{equity > 0 ? usd(equity) : "–"}</span>
      <span className="mv-cell pd-num">
        {plan && plan.size > 0 ? (
          <>
            {formatNumber(plan.coins)} <small>{coin}</small>
          </>
        ) : (
          "–"
        )}
      </span>
      <span className="mv-cell pd-num">{plan && plan.notional > 0 ? usd(plan.notional) : "–"}</span>
      <span className="mv-cell pd-num">{plan?.risk !== undefined ? usd(plan.risk) : "–"}</span>
      <span className="mv-cell pd-num mv-exits">
        {plan?.stopText ?? "–"} / {plan?.targetText ?? "–"}
      </span>
      {(state.kind === "blocked" || notes.length > 0 || outcome) && (
        <p
          className="mv-note"
          data-tone={outcome?.state === "failed" || rules ? "warn" : undefined}
        >
          {outcome?.state === "placing"
            ? t("multi.placing")
            : outcome?.state === "placed"
              ? (outcome.note ?? t("multi.placed"))
              : outcome?.state === "failed"
                ? t("multi.failed", { reason: outcome.reason })
                : state.kind === "blocked"
                  ? state.reason
                  : notes.map((n, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of notes
                      <span key={i}>{n}</span>
                    ))}
        </p>
      )}
    </div>
  );
}

/**
 * One coin, an order on each venue ticked, after Tealstreet's multi-exchange
 * ticket. Each venue's order is sized against its own account (the same
 * share of its equity at risk to the stop, or of its available margin
 * without one), with its stop and target the same % from its own price.
 * Each goes through the ordinary order path, with that account's switch and
 * rules, after a review; one refused doesn't stop the rest.
 */
export function MultiVenuePanel({
  venues,
  accounts,
  canTrade,
  isPaper,
  coin: screenCoin,
  maxSlippageBps,
  checkRules,
  ruleText,
  place,
}: MultiVenuePanelProps) {
  const [kept, setKept] = useState(load);
  const { ticket } = kept;
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(kept));
    } catch {
      // Storage unavailable: it's kept for this session only.
    }
  }, [kept]);
  const setTicket = (change: Partial<MultiTicket>) =>
    setKept((k) => ({ ...k, ticket: { ...k.ticket, ...change } }));

  const fromScreen = screenCoin ? coinOf(screenCoin).coin : "BTC";
  const [coin, setCoin] = useState(fromScreen);
  const [typed, setTyped] = useState(false);
  // Follows the market on screen until the trader types a coin of their own.
  useEffect(() => {
    if (!typed) setCoin(fromScreen);
  }, [fromScreen, typed]);

  const [states, setStates] = useState<Partial<Record<VenueId, LegState>>>({});
  const [outcomes, setOutcomes] = useState<Partial<Record<VenueId, Outcome>>>({});
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);

  const legs = venues.flatMap((v) => {
    const s = states[v];
    return s?.kind === "ready" && !kept.off.includes(v) ? [{ leg: s.leg, plan: s.plan }] : [];
  });
  const totalValue = legs.reduce((sum, l) => sum + l.plan.notional, 0);
  const totalRisk = legs.reduce((sum, l) => sum + (l.plan.risk ?? 0), 0);
  const hasStop = ticket.stopPct > 0;
  const sideText = t(ticket.side === "buy" ? "multi.buy" : "multi.sell");

  const send = async () => {
    setBusy(true);
    const sent = legs.map((l) => l.leg);
    setOutcomes(Object.fromEntries(sent.map((l) => [l.venue, { state: "placing" }])));
    const placed: VenueId[] = [];
    // One after another: each through the gate on its own, none waiting on another's answer to go.
    for (const leg of sent) {
      try {
        const result = await place(leg);
        placed.push(leg.venue);
        setOutcomes((o) => ({
          ...o,
          [leg.venue]:
            result === "placed"
              ? { state: "placed" }
              : {
                  state: "placed",
                  note: t("multi.protectFailed", { reason: result.protectFailed }),
                },
        }));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        setOutcomes((o) => ({ ...o, [leg.venue]: { state: "failed", reason } }));
      }
    }
    notifyEvent({
      type: "order",
      title: t("multi.note.title", { placed: placed.length, count: sent.length }),
      body: t("multi.note.body", {
        side: sideText,
        coin,
        venues: sent.map((l) => VENUES[l.venue].label).join(", "),
      }),
      tone: placed.length === sent.length ? (ticket.side === "buy" ? "buy" : "sell") : "warn",
    });
    setBusy(false);
    setReviewing(false);
  };

  return (
    <section className="mv">
      <div className="mv-form">
        <label className="mv-field">
          <span className="mv-label">
            {t("multi.coin")}
            <InfoTip label={t("multi.coin")} help="multi.coinHint" />
          </span>
          <span className="rules-field">
            <input
              aria-label={t("multi.coin")}
              value={coin}
              onChange={(e) => {
                setTyped(true);
                setCoin(
                  e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, "")
                    .slice(0, 16),
                );
              }}
            />
          </span>
          {typed && coin !== fromScreen && (
            <button type="button" className="rules-link" onClick={() => setTyped(false)}>
              {t("multi.followScreen")}
            </button>
          )}
        </label>
        <Segmented
          label={t("multi.side")}
          value={ticket.side}
          options={[
            { value: "buy", label: t("multi.buy") },
            { value: "sell", label: t("multi.sell") },
          ]}
          onChange={(side) => setTicket({ side })}
        />
        <Segmented
          label={t("multi.style")}
          value={ticket.style}
          options={[
            { value: "market", label: t("multi.market") },
            { value: "limit", label: t("multi.limit") },
          ]}
          onChange={(style) => setTicket({ style })}
        />
        {ticket.style === "limit" && (
          <span className="mv-field">
            <span className="mv-label">
              {t("multi.offset")}
              <InfoTip label={t("multi.offset")} help="multi.offsetHint" />
            </span>
            <NumberField
              label={t("multi.offset")}
              value={ticket.offsetPct}
              unit="%"
              onChange={(offsetPct) => setTicket({ offsetPct })}
            />
          </span>
        )}
        {hasStop ? (
          <span className="mv-field">
            <span className="mv-label">
              {t("multi.risk")}
              <InfoTip label={t("multi.risk")} help="multi.riskHint" />
            </span>
            <NumberField
              label={t("multi.risk")}
              value={ticket.riskPct}
              unit="%"
              onChange={(riskPct) => setTicket({ riskPct })}
            />
          </span>
        ) : (
          <span className="mv-field">
            <span className="mv-label">
              {t("multi.balance")}
              <InfoTip label={t("multi.balance")} help="multi.balanceHint" />
            </span>
            <NumberField
              label={t("multi.balance")}
              value={ticket.balancePct}
              unit="%"
              onChange={(balancePct) => setTicket({ balancePct })}
            />
          </span>
        )}
        <span className="mv-field">
          <span className="mv-label">
            {t("multi.stop")}
            <InfoTip label={t("multi.stop")} help="multi.exitHint" />
          </span>
          <NumberField
            label={t("multi.stop")}
            value={ticket.stopPct}
            unit="%"
            onChange={(stopPct) => setTicket({ stopPct })}
          />
        </span>
        <span className="mv-field">
          <span className="mv-label">{t("multi.target")}</span>
          <NumberField
            label={t("multi.target")}
            value={ticket.targetPct}
            unit="%"
            onChange={(targetPct) => setTicket({ targetPct })}
          />
        </span>
      </div>
      {!hasStop && <p className="mv-hint">{t("multi.noStopNote")}</p>}

      <div className="mv-table">
        <div className="mv-row mv-head" aria-hidden>
          <span>{t("multi.col.venue")}</span>
          <span>{t("multi.col.market")}</span>
          <span>{t("multi.col.price")}</span>
          <span>{t("multi.col.equity")}</span>
          <span>{t("multi.col.size")}</span>
          <span>{t("multi.col.value")}</span>
          <span>{t("multi.col.risk")}</span>
          <span>{t("multi.col.exits")}</span>
        </div>
        {venues.map((v) => {
          const account = activeAccount(accounts, v);
          return (
            <VenueRow
              key={v}
              venue={v}
              account={account}
              name={account && accountName(accounts, account)}
              coin={coin}
              ticket={ticket}
              on={!kept.off.includes(v)}
              paper={isPaper(v)}
              trades={account !== undefined && canTrade(account)}
              slippageBps={maxSlippageBps(v)}
              outcome={outcomes[v]}
              onToggle={(on) =>
                setKept((k) => ({
                  ...k,
                  off: on ? k.off.filter((x) => x !== v) : [...k.off.filter((x) => x !== v), v],
                }))
              }
              onState={(venue, state) => setStates((s) => ({ ...s, [venue]: state }))}
              checkRules={checkRules}
              ruleText={ruleText}
            />
          );
        })}
      </div>

      <footer className="mv-foot">
        <span className="mv-total pd-num">
          {legs.length === 0
            ? t("multi.nothing", { coin })
            : hasStop
              ? t("multi.total", {
                  count: legs.length,
                  value: usd(totalValue),
                  risk: usd(totalRisk),
                })
              : t("multi.totalNoRisk", { count: legs.length, value: usd(totalValue) })}
        </span>
        <button
          type="button"
          className="rules-button rules-primary"
          data-side={ticket.side}
          disabled={legs.length === 0 || busy}
          onClick={() => {
            setOutcomes({});
            setReviewing(true);
          }}
        >
          {legs.length === 1 ? t("multi.reviewOne") : t("multi.review", { count: legs.length })}
        </button>
      </footer>

      {reviewing && (
        <div className="mv-review" role="dialog" aria-label={t("multi.confirmTitle")}>
          <strong>{t("multi.confirmTitle")}</strong>
          <p>{t("multi.confirmBody")}</p>
          <ul>
            {legs.map(({ leg, plan }) => (
              <li key={leg.venue} className="pd-num">
                {t("multi.confirmLine", {
                  side: sideText,
                  size: `${formatNumber(plan.coins)} ${coin}`,
                  venue: VENUES[leg.venue].label,
                  value: usd(plan.notional),
                })}
              </li>
            ))}
          </ul>
          <div className="mv-review-actions">
            <button
              type="button"
              className="rules-button"
              disabled={busy}
              onClick={() => setReviewing(false)}
            >
              {t("multi.back")}
            </button>
            <button
              type="button"
              className="rules-button rules-primary"
              disabled={busy}
              onClick={() => void send()}
            >
              {busy ? t("multi.placing") : t("multi.place", { count: legs.length })}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
