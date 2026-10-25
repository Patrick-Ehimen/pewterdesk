import type { Market, VenueId } from "@pewterdesk/core";
import { dateFormat, formatNumber, formatPercent, type MessageKey, Tabs, t } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import type { BotBook } from "../../hooks/useBots";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import {
  type BotDraft,
  type BotEvent,
  type BotMode,
  botsOn,
  draftProblem,
  netOf,
} from "../../lib/bots";
import {
  BotCard,
  BotNotice,
  CardSkeletons,
  DemoControls,
  Money,
  StatusDot,
  useAct,
} from "../bots/parts";

// Bots as a workspace panel: the ones on the market on screen (or all of
// them), a form to start one from a saved backtest, and their log. The
// engine would run them and send every order through the router; this
// panel only shows them and passes on what the trader asks.

const TABS = ["running", "new", "log"] as const;
const LOG_FILTERS = ["all", "orders", "refusals"] as const;
type LogFilter = (typeof LOG_FILTERS)[number];
const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

const inFilter = (e: BotEvent, f: LogFilter) =>
  f === "all" || (f === "orders" ? e.kind === "fill" : e.kind === "refused");

interface BotsPanelProps {
  book: BotBook;
  venue: VenueId;
  venueLabel: string;
  /** The market on screen: where a new bot goes, and whose bots show first. */
  market?: Market;
  symbolFor: (market: string) => string;
  /** The venue's active account, which a live bot trades for. */
  account?: string;
  /** Whether that account has live trading on. */
  tradingOn: boolean;
  onOpenWallet: () => void;
  onOpenPage: () => void;
}

export function BotsPanel({
  book,
  venue,
  venueLabel,
  market,
  symbolFor,
  account,
  tradingOn,
  onOpenWallet,
  onOpenPage,
}: BotsPanelProps) {
  const [tab, setTab] = useStoredChoice("pd.bots.tab", TABS, "running");
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [halting, setHalting] = useState(false);
  const [now, setNow] = useState(Date.now);
  const { error, act } = useAct();
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const offline = !book.link.reachable;
  const active = book.bots.filter((b) => b.status !== "stopped");
  const here = botsOn(active, venue, market?.id);
  const elsewhere = active.filter((b) => !here.includes(b));
  const shown = showAll ? active : here;
  const running = active.filter((b) => b.status === "running").length;
  const net = active.reduce((sum, b) => sum + netOf(b), 0);
  const marketName = market ? symbolFor(market.id) : "";

  const summary =
    book.status === "loading"
      ? t("bots.loading")
      : offline
        ? t("bots.summaryOffline")
        : active.length === 0
          ? t("bots.summaryNone")
          : null;

  return (
    <div className="bots-panel">
      <Tabs
        variant="sub"
        label={t("panel.bots")}
        tabs={[
          { id: "running", label: t("bots.tab.running", { count: active.length }) },
          { id: "new", label: t("bots.tab.new") },
          { id: "log", label: t("bots.tab.log") },
        ]}
        active={tab}
        onChange={setTab}
        aside={
          <span className="bot-tabs-aside">
            <span className="bot-muted bot-small">
              {summary ?? (
                <>
                  {t("bots.summary", { running })} · <Money value={net} />
                </>
              )}
            </span>
            {running > 0 &&
              (halting ? (
                <button
                  type="button"
                  className="bot-button"
                  data-danger
                  data-armed
                  disabled={offline}
                  onClick={() => {
                    setHalting(false);
                    act(book.halt);
                  }}
                >
                  {t("bots.haltConfirm")}
                </button>
              ) : (
                <button
                  type="button"
                  className="bot-button"
                  data-danger
                  disabled={offline}
                  onClick={() => setHalting(true)}
                >
                  {t("bots.halt")}
                </button>
              ))}
            <button type="button" className="bot-button" onClick={onOpenPage}>
              {t("bots.openPage")}
            </button>
          </span>
        }
      />

      {offline && (
        <BotNotice
          tone="warn"
          title={t("bots.unreachableTitle")}
          action={
            <button type="button" className="bot-button" onClick={book.retry}>
              {t("bots.retry")}
            </button>
          }
        >
          {t("bots.unreachableBody", { time: dateFormat(CLOCK).format(book.link.at) })}
        </BotNotice>
      )}
      {book.haltedAt !== undefined && !offline && (
        <BotNotice
          tone="neutral"
          title={t("bots.haltedTitle", { time: dateFormat(CLOCK).format(book.haltedAt) })}
          action={
            <button type="button" className="bot-button" onClick={() => act(book.resumeAll)}>
              {t("bots.resumeAll")}
            </button>
          }
        >
          {t("bots.haltedBody")}
        </BotNotice>
      )}
      {error && (
        <p className="bot-reason bot-pad" role="alert">
          {error}
        </p>
      )}

      {tab === "running" && (
        <Running
          book={book}
          shown={shown}
          elsewhere={elsewhere}
          showAll={showAll}
          marketName={marketName}
          venueLabel={venueLabel}
          now={now}
          offline={offline}
          expanded={expanded}
          symbolFor={symbolFor}
          onExpand={(id) => setExpanded((e) => (e === id ? undefined : id))}
          onShowAll={() => setShowAll(true)}
          onNew={() => setTab("new")}
        />
      )}
      {tab === "new" && (
        <NewBot
          book={book}
          venue={venue}
          venueLabel={venueLabel}
          market={market}
          marketName={marketName}
          symbolFor={symbolFor}
          account={account}
          tradingOn={tradingOn}
          offline={offline}
          onOpenWallet={onOpenWallet}
          onStarted={(id) => {
            setExpanded(id);
            setTab("running");
          }}
        />
      )}
      {tab === "log" && <Log book={book} symbolFor={symbolFor} />}
    </div>
  );
}

function Running({
  book,
  shown,
  elsewhere,
  showAll,
  marketName,
  venueLabel,
  now,
  offline,
  expanded,
  symbolFor,
  onExpand,
  onShowAll,
  onNew,
}: {
  book: BotBook;
  shown: BotBook["bots"];
  elsewhere: BotBook["bots"];
  showAll: boolean;
  marketName: string;
  venueLabel: string;
  now: number;
  offline: boolean;
  expanded: string | undefined;
  symbolFor: (market: string) => string;
  onExpand: (id: string) => void;
  onShowAll: () => void;
  onNew: () => void;
}) {
  if (book.status === "loading") return <CardSkeletons />;
  if (book.status === "error") {
    return (
      <div className="bot-empty" role="alert">
        <strong>{t("bots.errorTitle")}</strong>
        <span>{t("bots.errorBody")}</span>
        {book.error && <code className="bot-code">{book.error}</code>}
        <button type="button" className="bot-button" onClick={book.retry}>
          {t("bots.retry")}
        </button>
      </div>
    );
  }
  if (!book.source.engine) {
    return (
      <div className="bot-empty">
        <strong>{t("bots.unavailableTitle")}</strong>
        <span>{t("bots.unavailableBody")}</span>
        <DemoControls demo={book.demo} onDemo={book.setDemo} />
      </div>
    );
  }
  if (shown.length === 0 && elsewhere.length === 0) {
    return (
      <div className="bot-empty">
        <strong>{t("bots.emptyTitle")}</strong>
        <span>{t("bots.emptyBody")}</span>
        <ol className="bot-steps">
          <li>{t("bots.step1")}</li>
          <li>{t("bots.step2")}</li>
          <li>{t("bots.step3")}</li>
        </ol>
        <button type="button" className="bot-button" data-primary onClick={onNew}>
          {t("bots.startFromRun")}
        </button>
        <DemoControls demo={book.demo} onDemo={book.setDemo} />
      </div>
    );
  }
  return (
    <>
      {shown.length === 0 && !showAll && (
        <div className="bot-elsewhere">
          <strong>{t("bots.noneHere", { market: marketName || venueLabel })}</strong>
          <span className="bot-muted">{t("bots.elsewhere", { count: elsewhere.length })}</span>
          <ul className="bot-mini-list">
            {elsewhere.map((b) => (
              <li key={b.id}>
                <StatusDot bot={b} />
                <span className="bot-mini-name">
                  {b.name}
                  <span className="bot-muted bot-small">
                    {symbolFor(b.market)} · {b.interval}
                  </span>
                </span>
                <Money value={netOf(b)} />
              </li>
            ))}
          </ul>
          <div className="bot-actions">
            <button type="button" className="bot-button" onClick={onShowAll}>
              {t("bots.showAll")}
            </button>
            <button type="button" className="bot-button" onClick={onNew}>
              {t("bots.newHere", { market: marketName })}
            </button>
          </div>
        </div>
      )}
      {shown.length > 0 && (
        <div className="bot-cards">
          {shown.map((bot) => (
            <BotCard
              key={bot.id}
              bot={bot}
              now={now}
              symbolFor={symbolFor}
              offline={offline}
              expanded={expanded === bot.id}
              onExpand={() => onExpand(bot.id)}
              onPause={book.pause}
              onResume={book.resume}
              onStop={book.stop}
            />
          ))}
        </div>
      )}
      {book.source.demo && (
        <div className="bot-pad">
          <DemoControls demo={book.demo} onDemo={book.setDemo} />
        </div>
      )}
    </>
  );
}

function NewBot({
  book,
  venue,
  venueLabel,
  market,
  marketName,
  symbolFor,
  account,
  tradingOn,
  offline,
  onOpenWallet,
  onStarted,
}: {
  book: BotBook;
  venue: VenueId;
  venueLabel: string;
  market?: Market;
  marketName: string;
  symbolFor: (market: string) => string;
  account?: string;
  tradingOn: boolean;
  offline: boolean;
  onOpenWallet: () => void;
  onStarted: (id: string) => void;
}) {
  const [runId, setRunId] = useState<string>();
  const [mode, setMode] = useState<BotMode>("dry");
  const [size, setSize] = useState("25");
  const [loss, setLoss] = useState("150");
  const [reviewing, setReviewing] = useState(false);
  const { error, act } = useAct();

  if (!book.source.engine) {
    return (
      <div className="bot-empty">
        <strong>{t("bots.unavailableTitle")}</strong>
        <span>{t("bots.unavailableBody")}</span>
      </div>
    );
  }
  if (book.runs.length === 0) {
    return (
      <div className="bot-empty">
        <strong>{t("bots.noRunsTitle")}</strong>
        <span>{t("bots.noRunsBody")}</span>
      </div>
    );
  }

  const run = book.runs.find((r) => r.id === runId);
  const draft: Partial<BotDraft> = {
    runId,
    venue,
    market: market?.id,
    mode,
    account,
    sizePct: Number(size),
    maxDailyLoss: Number(loss),
  };
  const problem = market ? draftProblem(draft, { account, tradingOn }) : "noRun";

  if (reviewing && run && !problem) {
    return (
      <div className="bot-form">
        <strong>{t("bots.confirmTitle", { name: run.name })}</strong>
        <dl className="bot-details">
          <dt>{t("bots.market")}</dt>
          <dd>
            {marketName} · {run.interval}
          </dd>
          <dt>{t("bots.account")}</dt>
          <dd>{mode === "live" ? account : t("bots.backtestAccount")}</dd>
          <dt>{t("bots.mode")}</dt>
          <dd>{t(mode === "live" ? "bots.mode.live" : "bots.mode.dry")}</dd>
          <dt>{t("bots.size")}</dt>
          <dd className="pd-num">{t("bots.sizeValue", { pct: Number(size) })}</dd>
          <dt>{t("bots.dailyLoss")}</dt>
          <dd className="pd-num">{formatNumber(-Number(loss), 2)}</dd>
          <dt>{t("bots.backtestResult")}</dt>
          <dd>
            <Money value={run.net} /> · {formatPercent(run.maxDrawdown, 1)}
          </dd>
        </dl>
        {mode === "live" && (
          <p className="bot-warn">{t("bots.liveWarn", { account: account ?? "" })}</p>
        )}
        {error && (
          <p className="bot-reason" role="alert">
            {error}
          </p>
        )}
        <div className="bot-actions">
          <button type="button" className="bot-button" onClick={() => setReviewing(false)}>
            {t("bots.back")}
          </button>
          <button
            type="button"
            className="bot-button"
            data-primary
            disabled={offline}
            onClick={() =>
              act(async () => {
                const bot = await book.start(draft as BotDraft);
                setReviewing(false);
                onStarted(bot.id);
              })
            }
          >
            {t("bots.startBot")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="bot-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) setReviewing(true);
      }}
    >
      <fieldset className="bot-runs">
        <legend className="bot-label">{t("bots.fromRun")}</legend>
        {book.runs.map((r) => (
          <label key={r.id} className="bot-run" data-checked={r.id === runId || undefined}>
            <input
              type="radio"
              name="bot-run"
              checked={r.id === runId}
              onChange={() => setRunId(r.id)}
            />
            <span className="bot-run-text">
              <span>{r.name}</span>
              <span className="bot-muted bot-small">
                {symbolFor(r.market)} · {r.summary}
              </span>
            </span>
            <span className="bot-run-figures pd-num">
              <Money value={r.net} />
              <span className="pd-down bot-small">{formatPercent(r.maxDrawdown, 1)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="bot-form-grid">
        <label className="bot-field">
          <span>{t("bots.sizePct")}</span>
          <input
            className="pd-input pd-num"
            inputMode="decimal"
            value={size}
            aria-invalid={problem === "size" || undefined}
            onChange={(e) => setSize(e.target.value)}
          />
        </label>
        <label className="bot-field">
          <span>{t("bots.maxLoss")}</span>
          <input
            className="pd-input pd-num"
            inputMode="decimal"
            value={loss}
            aria-invalid={problem === "loss" || undefined}
            onChange={(e) => setLoss(e.target.value)}
          />
        </label>
      </div>
      <div className="bot-label">{t("bots.where")}</div>
      <div className="pd-segmented" role="radiogroup" aria-label={t("bots.where")}>
        {(["dry", "live"] as const).map((m) => (
          <label key={m} data-checked={mode === m || undefined}>
            <input type="radio" name="bot-mode" checked={mode === m} onChange={() => setMode(m)} />
            {t(m === "live" ? "bots.mode.live" : "bots.mode.dry")}
          </label>
        ))}
      </div>
      {problem === "liveOff" || problem === "noAccount" ? (
        <div className="bot-warn">
          <span>{t(`bots.problem.${problem}` as MessageKey, { venue: venueLabel })}</span>
          <button type="button" className="bot-link" onClick={onOpenWallet}>
            {t("bots.openWallet")}
          </button>
        </div>
      ) : (
        <p className="bot-muted bot-small">
          {mode === "live" ? t("bots.liveNote", { account: account ?? "" }) : t("bots.dryNote")}
        </p>
      )}
      {problem && problem !== "liveOff" && problem !== "noAccount" && (
        <p className="bot-muted bot-small">{t(`bots.problem.${problem}` as MessageKey)}</p>
      )}
      <button
        type="submit"
        className="bot-button"
        disabled={Boolean(problem) || offline}
        title={
          problem ? t(`bots.problem.${problem}` as MessageKey, { venue: venueLabel }) : undefined
        }
      >
        {t("bots.review")}
      </button>
    </form>
  );
}

function Log({ book, symbolFor }: { book: BotBook; symbolFor: (market: string) => string }) {
  const [filter, setFilter] = useStoredChoice("pd.bots.log", LOG_FILTERS, "all");
  const shown = book.events.filter((e) => inFilter(e, filter));
  const name = (id: string) => {
    const bot = book.bots.find((b) => b.id === id);
    return bot ? `${bot.name} · ${symbolFor(bot.market)}` : "";
  };
  return (
    <>
      <div className="bot-filters">
        {LOG_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="bot-button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {t(`bots.log.${f}` as MessageKey)}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="bot-empty">
          <strong>
            {t(
              book.events.length === 0
                ? "bots.logEmpty"
                : filter === "refusals"
                  ? "bots.noRefusals"
                  : "bots.noOrders",
            )}
          </strong>
          <span>
            {t(
              book.events.length === 0 || filter !== "refusals"
                ? "bots.logEmptyBody"
                : "bots.noRefusalsBody",
            )}
          </span>
        </div>
      ) : (
        <ol className="bot-log">
          {shown.map((e) => (
            <li key={e.id}>
              <span className="pd-num bot-muted">{dateFormat(CLOCK).format(e.at)}</span>
              <span className="bot-log-text">
                <span>
                  <strong>{name(e.botId)}</strong>{" "}
                  <span className="bot-event" data-kind={e.kind}>
                    {t(`bots.event.${e.kind}` as MessageKey)}
                  </span>
                </span>
                {e.text && <span className="pd-num bot-muted bot-small">{e.text}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
