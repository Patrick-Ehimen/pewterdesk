import {
  formatNumber,
  formatPercent,
  formatSigned,
  type MessageKey,
  Select,
  Sparkline,
  shortAddress,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { type ReactNode, useState } from "react";
import { botReason, DEMO_ALLOWED } from "../../hooks/useBots";
import { DEMO_STATES, type DemoState } from "../../lib/botDemo";
import { type BotView, statsOf, todayOf } from "../../lib/bots";

// Pieces the Bots panel and the Bots page share. Colours follow the brand:
// brass only for a live bot's running dot and the one primary action, green
// and red only for P&L and sides, the warning token for what needs a look.

/** A signed amount in the quote currency, coloured by its sign. */
export function Money({ value, decimals = 2 }: { value: number; decimals?: number }) {
  return <span className={`pd-num ${trendClass(value)}`}>{formatSigned(value, decimals)}</span>;
}

/** A fraction as a signed percentage, coloured by its sign. */
export function Pct({ value }: { value: number }) {
  return (
    <span className={`pd-num ${trendClass(value)}`}>
      {value > 0 ? "+" : ""}
      {formatPercent(value)}
    </span>
  );
}

/** Running (brass when live, an outline on a dry run), paused (warning) or stopped. */
export function StatusDot({ bot }: { bot: Pick<BotView, "status" | "mode"> }) {
  return (
    <span
      className="bot-dot"
      data-status={bot.status}
      data-mode={bot.mode}
      role="img"
      aria-label={t(`bots.status.${bot.status}` as MessageKey)}
    />
  );
}

export function ModeBadge({ bot }: { bot: Pick<BotView, "mode" | "demo"> }) {
  return (
    <>
      <span className="bot-badge" data-mode={bot.mode}>
        {t(bot.mode === "live" ? "bots.mode.live" : "bots.mode.dry")}
      </span>
      {bot.demo && <span className="bot-badge">{t("bots.demoBadge")}</span>}
    </>
  );
}

/** Where a bot trades: the account's short address, or the backtest account. */
export const whereOf = (bot: Pick<BotView, "account">) =>
  bot.account ? shortAddress(bot.account) : t("bots.backtestAccount");

/** Runs an action, saying where it's shown why it failed if it does. */
export function useAct() {
  const [error, setError] = useState<string>();
  const act = (run: () => Promise<unknown>) => {
    setError(undefined);
    run().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return { error, act };
}

/** A notice across the top of the panel or page: the engine out of reach, or a halt. */
export function BotNotice({
  tone,
  title,
  children,
  action,
}: {
  tone: "warn" | "neutral";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="bot-notice" data-tone={tone} role="status">
      <div className="bot-notice-text">
        <strong>{title}</strong>
        <span>{children}</span>
      </div>
      {action}
    </div>
  );
}

interface CardProps {
  bot: BotView;
  now: number;
  symbolFor: (market: string) => string;
  /** The engine can't be reached: nothing it would do is offered. */
  offline: boolean;
  expanded: boolean;
  onExpand: () => void;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onStop: (id: string, close: boolean) => Promise<void>;
}

/** One bot in the panel: how it's doing, its position, and pause / stop. */
export function BotCard({
  bot,
  now,
  symbolFor,
  offline,
  expanded,
  onExpand,
  onPause,
  onResume,
  onStop,
}: CardProps) {
  const { error, act } = useAct();
  const [stopping, setStopping] = useState(false);
  const stats = statsOf(bot);
  const reason = bot.status === "paused" ? botReason(bot) : "";
  const symbol = symbolFor(bot.market);
  return (
    <article className="bot-card" data-status={bot.status}>
      <header className="bot-card-head">
        <StatusDot bot={bot} />
        <span className="bot-name">{bot.name}</span>
        <ModeBadge bot={bot} />
      </header>
      <div className="bot-where">
        <span>
          {symbol} · {bot.interval} · {whereOf(bot)}
        </span>
        <span>{t(`bots.status.${bot.status}` as MessageKey)}</span>
      </div>
      <dl className="bot-figures">
        <div>
          <dt>{t("bots.total")}</dt>
          <dd>
            <Money value={stats.net} />
          </dd>
        </div>
        <div>
          <dt>{t("bots.today")}</dt>
          <dd>
            <Money value={todayOf(bot, now)} />
          </dd>
        </div>
        <div>
          <dt>{t("bots.trades")}</dt>
          <dd className="pd-num">{stats.closed}</dd>
        </div>
        <div>
          <dt>{t("bots.winRate")}</dt>
          <dd className="pd-num">
            {stats.winRate === undefined ? "-" : formatPercent(stats.winRate, 0)}
          </dd>
        </div>
      </dl>
      {bot.curve.length > 1 && (
        <div className="bot-spark">
          <Sparkline values={bot.curve.map((p) => p.value)} width={300} height={34} />
        </div>
      )}
      <p className="bot-position pd-num">
        {bot.position ? (
          <>
            <span className={bot.position.side === "long" ? "pd-up" : "pd-down"}>
              {t(bot.position.side === "long" ? "side.long" : "side.short")}{" "}
              {formatNumber(bot.position.size, 2)} {symbol}
            </span>{" "}
            <span className="bot-muted">@ {formatNumber(bot.position.entry, 3)} · </span>
            <Money value={bot.position.upnl} />
          </>
        ) : (
          <span className="bot-muted">{t("bots.flat")}</span>
        )}
      </p>
      {reason && <p className="bot-reason">{reason}</p>}
      {expanded && (
        <dl className="bot-details">
          <dt>{t("bots.strategy")}</dt>
          <dd>{bot.strategy}</dd>
          <dt>{t("bots.size")}</dt>
          <dd className="pd-num">{t("bots.sizeValue", { pct: bot.sizePct })}</dd>
          <dt>{t("bots.dailyLoss")}</dt>
          <dd className="pd-num">{formatNumber(-bot.maxDailyLoss, 2)}</dd>
          <dt>{t("bots.started")}</dt>
          <dd>{new Date(bot.startedAt).toLocaleDateString()}</dd>
        </dl>
      )}
      {expanded && (
        <p className="bot-muted bot-small">
          {t(bot.mode === "live" ? "bots.routerNote" : "bots.dryNote")}
        </p>
      )}
      {stopping && (
        <div className="bot-confirm">
          <span>{t("bots.stopAsk")}</span>
          <div className="bot-actions">
            {bot.position && (
              <button
                type="button"
                className="bot-button"
                data-danger
                onClick={() => act(() => onStop(bot.id, true))}
              >
                {t("bots.stopClose")}
              </button>
            )}
            <button
              type="button"
              className="bot-button"
              data-danger
              onClick={() => act(() => onStop(bot.id, false))}
            >
              {t(bot.position ? "bots.stopKeep" : "bots.stop")}
            </button>
            <button type="button" className="bot-button" onClick={() => setStopping(false)}>
              {t("bots.cancel")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="bot-reason" role="alert">
          {error}
        </p>
      )}
      <div className="bot-actions">
        {bot.status !== "stopped" && (
          <>
            <button
              type="button"
              className="bot-button"
              disabled={offline}
              onClick={() =>
                act(() => (bot.status === "paused" ? onResume(bot.id) : onPause(bot.id)))
              }
            >
              {t(bot.status === "paused" ? "bots.resume" : "bots.pause")}
            </button>
            {!stopping && (
              <button
                type="button"
                className="bot-button"
                disabled={offline}
                onClick={() => setStopping(true)}
              >
                {t("bots.stop")}
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="bot-button bot-more"
          aria-expanded={expanded}
          onClick={onExpand}
        >
          {t(expanded ? "bots.less" : "bots.details")}
        </button>
      </div>
    </article>
  );
}

/** Grey placeholders in the shape of `count` bot cards, while they load. */
export function CardSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="bot-cards" role="status" aria-busy="true" aria-label={t("bots.loading")}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
        <div key={i} className="bot-card">
          <div className="bot-card-head">
            <span className="bot-sk" style={{ width: 8, height: 8, borderRadius: "50%" }} />
            <span className="bot-sk" style={{ width: "45%", height: 12 }} />
          </div>
          <span className="bot-sk" style={{ width: "65%", height: 10 }} />
          <span className="bot-sk" style={{ height: 28 }} />
          <span className="bot-sk" style={{ height: 34 }} />
          <span className="bot-sk" style={{ height: 24 }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Development builds only: show the demo source's bots, in one of its
 * states, so each of the panel's and the page's can be seen.
 */
export function DemoControls({
  demo,
  onDemo,
}: {
  demo: DemoState | undefined;
  onDemo: (state: DemoState | undefined) => void;
}) {
  if (!DEMO_ALLOWED) return null;
  if (!demo) {
    return (
      <button type="button" className="bot-button" onClick={() => onDemo("normal")}>
        {t("bots.demo")}
      </button>
    );
  }
  return (
    <span className="bot-demo">
      <Select
        label={t("bots.demoState")}
        value={demo}
        options={DEMO_STATES.map((s) => ({
          value: s,
          label: t(`bots.demoState.${s}` as MessageKey),
        }))}
        onChange={onDemo}
      />
      <button type="button" className="bot-button" onClick={() => onDemo(undefined)}>
        {t("bots.demoOff")}
      </button>
    </span>
  );
}
