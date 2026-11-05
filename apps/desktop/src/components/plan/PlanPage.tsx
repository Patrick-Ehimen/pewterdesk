import type { ClosedTrade, Market, MarketSummary, Position, VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import type { IconType } from "react-icons";
import {
  LuBookOpen,
  LuChartLine,
  LuLink,
  LuLogOut,
  LuNotebookPen,
  LuScrollText,
  LuSun,
  LuTriangleAlert,
} from "react-icons/lu";
import type { CalendarEvent } from "../../api/venueClient";
import { JOURNAL_DAYS, type Journal, useCloudAuth, useJournal } from "../../hooks/useJournal";
import { type Feed, useEconomicCalendar } from "../../hooks/useVenueFeeds";
import {
  addDays,
  clearedTrade,
  dayStart,
  type Plan,
  type Playbook,
  utcDay,
} from "../../lib/journal";
import { type JournalTrade, journalTrades, openTrades } from "../../lib/journalTrades";
import { paperAccount } from "../../lib/paperStore";
import type { RulesStatus, RulesView } from "../../lib/tradingRules";
import { CloudGate } from "./CloudGate";
import { JournalView } from "./JournalView";
import { PlanView } from "./PlanView";
import { PlaybooksView } from "./PlaybooksView";
import { Blank, useKept } from "./parts";
import { ReviewView } from "./ReviewView";
import {
  DaySkeleton,
  JournalSkeleton,
  PlanSkeleton,
  PlaybooksSkeleton,
  ReviewSkeleton,
  TodaySkeleton,
  TradeSkeleton,
} from "./Skeletons";
import { TodayView } from "./TodayView";
import { TradeDetail } from "./TradeDetail";

const NO_EVENTS: readonly CalendarEvent[] = [];
const NO_POSITIONS: readonly Position[] = [];
const NO_TRADES: readonly ClosedTrade[] = [];

export const PLAN_TABS = ["today", "plan", "playbooks", "journal", "review"] as const;
export type PlanTab = (typeof PLAN_TABS)[number];

const TAB_ICONS: Record<PlanTab, IconType> = {
  today: LuSun,
  plan: LuScrollText,
  playbooks: LuBookOpen,
  journal: LuNotebookPen,
  review: LuChartLine,
};

/** "0x7a3f…c91e", or the paper account's name. */
function accountLabel(accountKey: string | undefined, address: string | undefined) {
  // The paper account's venue label already says so ("Hyperliquid · Paper").
  if (accountKey?.startsWith("paper:")) return undefined;
  if (!address) return undefined;
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Where another page asked the Plan page to open. */
export interface PlanTarget {
  tab: PlanTab;
  /** A trade to open, by its key (`lib/journal.ts`). */
  trade?: string;
}

/** What every view of the page reads. */
export interface PlanContext {
  venue: VenueId;
  venueLabel: string;
  /** The connected account, as the venue names it. */
  address?: string;
  /** Whose journal: `venue:address`, or the paper account's. */
  accountKey?: string;
  quote: string;
  symbolFor: (market: string) => string;
  markets: readonly Market[];
  /** The venue's market by id, for its logo. */
  marketOf: (market: string) => Market | undefined;
  /** Each market's live summary by id (price, the day's change), where the venue's feed has it. */
  summaryOf: (market: string) => MarketSummary | undefined;
  journal: Journal;
  plan?: Plan;
  playbooks: ReadonlyMap<string, Playbook>;
  trades: readonly JournalTrade[];
  /** The account's open positions as trades, each with its note (the trade page opens them too). */
  openTrades: readonly JournalTrade[];
  rules?: RulesView;
  rulesStatus?: RulesStatus;
  calendar: readonly CalendarEvent[];
  equity?: number;
  /** The account's open positions now, for today's live session. */
  positions: readonly Position[];
  openTrade: (key: string) => void;
  openDay: (day: string) => void;
  goTo: (tab: PlanTab) => void;
  onOpenRules: () => void;
}

interface PlanPageProps {
  venue: VenueId;
  venueLabel: string;
  address?: string;
  accountKey?: string;
  closed: Feed<ClosedTrade[]>;
  markets: readonly Market[];
  /** The venue's live market summaries, for the watchlist's prices. */
  summaries?: readonly MarketSummary[];
  rules?: RulesView;
  rulesStatus?: RulesStatus;
  equity?: number;
  positions?: readonly Position[];
  target?: PlanTarget;
  onTargetDone: () => void;
  onOpenRules: () => void;
  onConnect: () => void;
}

/**
 * The trader's plan, playbooks, journal and review, after the Plan mockups in
 * `design/` (74-86): kept in PewterDesk Cloud, behind a sign-in. It reads the
 * account's trades and places nothing.
 */
export function PlanPage(props: PlanPageProps) {
  const { venue, accountKey, closed, markets, target, onTargetDone } = props;
  const cloud = useCloudAuth(true);
  const signedIn = cloud.auth.state === "signedIn";
  const journal = useJournal(accountKey, signedIn, cloud.lost);
  const [tab, setTab] = useKept<PlanTab>("plan.tab", "today");
  // What was open, per account: another account's trade or day isn't this one's.
  const [trade, setTrade] = useKept<string | undefined>(`plan.trade:${accountKey}`, undefined);
  const [day, setDay] = useKept<string | undefined>(`plan.day:${accountKey}`, undefined);

  useEffect(() => {
    if (!target) return;
    setTab(target.tab);
    setTrade(target.trade);
    setDay(undefined);
    onTargetDone();
  }, [target, onTargetDone, setTab, setDay, setTrade]);

  // A switch of account closes what was open (not the first account: a
  // target opened with the page must survive its mount).
  const seenAccount = useRef(accountKey);
  useEffect(() => {
    if (seenAccount.current === accountKey) return;
    seenAccount.current = accountKey;
    setTrade(undefined);
    setDay(undefined);
  }, [accountKey, setTrade, setDay]);

  const plan = journal.data.plan?.data;
  const positions = props.positions ?? NO_POSITIONS;
  const closedList =
    closed.status === "live" || closed.status === "closed" ? closed.data : NO_TRADES;
  // What the journal shows of the venue's trades: its own window, less what the trader cleared
  // (in the app only - the venue keeps them).
  const trades = useMemo(() => {
    const days = journal.data.days;
    const from = dayStart(addDays(utcDay(Date.now()), -JOURNAL_DAYS));
    const shown = closedList.filter((c) => c.time >= from && !clearedTrade(days, c.time));
    const notes = new Map(
      [...journal.data.notes].filter(([, n]) => !clearedTrade(days, n.data.trade.closedAt)),
    );
    return journalTrades(shown, notes, plan, positions);
  }, [closedList, journal.data.notes, journal.data.days, plan, positions]);
  const paper = accountKey?.startsWith("paper:") ?? false;
  const open = useMemo(
    () =>
      openTrades(
        positions,
        journal.data.notes,
        // A paper position keeps when it opened; a venue's doesn't say.
        paper
          ? (p) =>
              paperAccount(p.venue).positions.find(
                (x) => x.market === p.market && x.side === p.side,
              )?.openedAt
          : undefined,
      ),
    [positions, journal.data.notes, paper],
  );
  // An open trade's note a closed trade took over: saved under the closed
  // trade's key, then the open one removed, so a new position there starts fresh.
  const moving = useRef(new Set<string>());
  useEffect(() => {
    for (const x of trades) {
      const from = x.adoptedFrom;
      if (!from || moving.current.has(from)) continue;
      moving.current.add(from);
      journal
        .saveNote(x.key, x.note)
        .then(() => journal.removeNote(from))
        .catch(() => {})
        .finally(() => moving.current.delete(from));
    }
  }, [trades, journal]);
  const bySymbol = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);
  const byMarket = useMemo(
    () => new Map((props.summaries ?? []).map((x) => [x.market, x])),
    [props.summaries],
  );
  const quote = markets[0]?.quote ?? "";
  const calendarFeed = useEconomicCalendar();
  const calendar =
    calendarFeed.status === "live" || calendarFeed.status === "closed"
      ? calendarFeed.data
      : NO_EVENTS;

  const ctx: PlanContext = {
    ...props,
    venue,
    quote,
    positions,
    calendar,
    symbolFor: (id) => bySymbol.get(id)?.symbol ?? id,
    marketOf: (id) => bySymbol.get(id),
    summaryOf: (id) => byMarket.get(id),
    journal,
    plan,
    playbooks: journal.data.playbooks,
    trades,
    openTrades: open,
    openTrade: (key) => {
      setTrade(key);
      setTab("journal");
    },
    openDay: (d) => {
      setDay(d);
      setTrade(undefined);
      setTab("journal");
    },
    goTo: (next) => {
      setTrade(undefined);
      setDay(undefined);
      setTab(next);
    },
  };

  /** The open view's own skeleton, while what it reads loads. */
  const skeleton = () => {
    if (trade) return <TradeSkeleton />;
    switch (tab) {
      case "today":
        return <TodaySkeleton />;
      case "plan":
        return <PlanSkeleton />;
      case "playbooks":
        return <PlaybooksSkeleton />;
      case "journal":
        return day ? <DaySkeleton /> : <JournalSkeleton />;
      case "review":
        return <ReviewSkeleton />;
    }
  };

  const body = () => {
    if (cloud.auth.state === "loading") return skeleton();
    if (cloud.auth.state !== "signedIn") return <CloudGate cloud={cloud} />;
    if (!accountKey)
      return (
        <Blank
          icon={<LuLink size={22} aria-hidden />}
          title={t("plan.connectTitle")}
          action={
            <button type="button" className="jr-button jr-primary" onClick={props.onConnect}>
              {t("plan.connect")}
            </button>
          }
        >
          {t("plan.connectFirst", { venue: props.venueLabel })}
        </Blank>
      );
    // The journal, and the venue's closed trades it's read against.
    if (journal.load.state === "loading" || closed.status === "idle" || closed.status === "loading")
      return skeleton();
    if (journal.load.state === "error")
      return (
        <Blank
          icon={<LuTriangleAlert size={22} aria-hidden />}
          title={t("plan.loadFailed")}
          action={
            <button type="button" className="jr-button" onClick={journal.reload}>
              {t("plan.retry")}
            </button>
          }
        >
          {journal.load.error}
        </Blank>
      );
    if (trade) {
      const openOne = open.find((x) => x.key === trade);
      if (openOne)
        return (
          <TradeDetail
            ctx={ctx}
            trade={openOne}
            onOpen={setTrade}
            onBack={() => setTrade(undefined)}
          />
        );
      const at = trades.findIndex((x) => x.key === trade);
      return (
        <TradeDetail
          ctx={ctx}
          trade={trades[at]}
          prev={trades[at + 1]?.key}
          next={at > 0 ? trades[at - 1]?.key : undefined}
          onOpen={setTrade}
          onBack={() => setTrade(undefined)}
        />
      );
    }
    switch (tab) {
      case "today":
        return <TodayView ctx={ctx} />;
      case "plan":
        return <PlanView ctx={ctx} />;
      case "playbooks":
        return <PlaybooksView ctx={ctx} />;
      case "journal":
        return <JournalView ctx={ctx} day={day} onDay={setDay} />;
      case "review":
        return <ReviewView ctx={ctx} />;
    }
  };

  const account = accountLabel(accountKey, props.address);
  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const at = PLAN_TABS.indexOf(tab);
    const next =
      PLAN_TABS[(at + (e.key === "ArrowRight" ? 1 : -1) + PLAN_TABS.length) % PLAN_TABS.length];
    if (!next) return;
    e.preventDefault();
    ctx.goTo(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  };
  const syncState = journal.saveError ? "error" : journal.saving ? "saving" : "saved";

  return (
    <main className="page jr-page" aria-label={t("nav.plan")}>
      <header className="jr-top">
        <div className="jr-top-inner">
          <div className="jr-top-title">
            <h1>{t("nav.plan")}</h1>
            <span className="jr-top-account">
              {props.venueLabel}
              {account && ` · ${account}`}
            </span>
          </div>
          <div className="jr-nav" role="tablist" aria-label={t("nav.plan")} onKeyDown={onNavKey}>
            {PLAN_TABS.map((id) => {
              const Icon = TAB_ICONS[id];
              const active = id === tab && !trade;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  data-tab={id}
                  aria-selected={id === tab}
                  tabIndex={id === tab ? 0 : -1}
                  className="jr-nav-tab"
                  data-sub={id === tab && !active ? true : undefined}
                  onClick={() => ctx.goTo(id)}
                >
                  <Icon size={14} aria-hidden />
                  <span>{t(`plan.tab.${id}` as const)}</span>
                </button>
              );
            })}
          </div>
          {cloud.auth.state === "signedIn" && (
            <div className="jr-sync" title={t("plan.synced", { email: cloud.auth.email })}>
              <span className="jr-sync-dot" data-state={syncState} aria-hidden />
              <span className="jr-sync-text" title={journal.saveError}>
                {syncState === "error"
                  ? t("plan.saveFailed")
                  : syncState === "saving"
                    ? t("plan.saving")
                    : t("plan.savedCloud")}
              </span>
              <button
                type="button"
                className="jr-icon"
                aria-label={t("cloud.signOut")}
                title={t("cloud.signOut")}
                onClick={() => void cloud.signOut()}
              >
                <LuLogOut size={13} aria-hidden />
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="jr-body">
        <div className="jr-wrap">{body()}</div>
      </div>
    </main>
  );
}
