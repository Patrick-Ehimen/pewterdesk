import { dateFormat, formatNumber, formatSigned, type MessageKey, t } from "@pewterdesk/ui";
import { LuCircle, LuPause, LuSquare, LuTriangleAlert } from "react-icons/lu";
import { type Bot, type BotEvent, botActions, PAPER_DAYS } from "../../lib/bots";
import { Lifecycle } from "./ui";

const KIND: Record<Bot["kind"], MessageKey> = {
  grid: "bots.kind.grid",
  dca: "bots.kind.dca",
  trend: "bots.kind.trend",
  custom: "bots.kind.custom",
};

const EVENT: Record<BotEvent["kind"], MessageKey> = {
  bought: "bots.event.bought",
  paused: "bots.event.paused",
  stoppedByLimit: "bots.event.stoppedByLimit",
  backtestDone: "bots.event.backtestDone",
  started: "bots.event.started",
  stopped: "bots.event.stopped",
  halted: "bots.event.halted",
};

const time = () =>
  dateFormat({ hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const day = () => dateFormat({ day: "numeric", month: "short", timeZone: "UTC" });

/** "Live", "Paper · day 4 of 7" or "Backtest". */
export function ModeBadge({ bot }: { bot: Pick<Bot, "mode" | "paperDay"> }) {
  return (
    <span className="bt-badge" data-mode={bot.mode}>
      {bot.mode === "live" && <span className="bt-dot" aria-hidden />}
      {bot.mode === "paper"
        ? t("bots.mode.paperDay", { day: bot.paperDay ?? 1, days: PAPER_DAYS })
        : t(`bots.mode.${bot.mode}`)}
    </span>
  );
}

function State({ bot }: { bot: Bot }) {
  switch (bot.state) {
    case "running":
      return (
        <span className="bt-state" data-state="running">
          <LuCircle size={8} className="bt-state-icon" aria-hidden />
          {t("bots.state.running")}
        </span>
      );
    case "paused":
      return (
        <span className="bt-state">
          <LuPause size={11} aria-hidden />
          {t("bots.state.paused")}
        </span>
      );
    case "limit":
      return (
        <span className="bt-state" data-state="limit">
          <LuTriangleAlert size={12} aria-hidden />
          {t("bots.state.limit")}
        </span>
      );
    default:
      return (
        <span className="bt-state">
          <LuSquare size={9} aria-hidden />
          {t("bots.state.stopped")}
        </span>
      );
  }
}

interface BotCardProps {
  bot: Bot;
  venueLabel: string;
  /** The market's name as the app shows it. */
  marketLabel: string;
  onStart: () => void;
  onPause: () => void;
  onStop: (flatten: boolean) => void;
  onStartPaper: () => void;
  /** Takes it live (after its paper run); unset where nothing can go live. */
  onGoLive?: () => void;
  /** Opens the bot's backtest, where it has one. */
  onOpenBacktest?: () => void;
}

/** One bot: what it's on, how it's doing, what it last did, and its controls. */
export function BotCard({
  bot,
  venueLabel,
  marketLabel,
  onStart,
  onPause,
  onStop,
  onStartPaper,
  onGoLive,
  onOpenBacktest,
}: BotCardProps) {
  const can = botActions(bot);
  const backtest = bot.mode === "backtest";
  const limitShare = bot.limit ? Math.min(1, bot.limit.used / bot.limit.max) : 0;
  const atLimit = limitShare >= 1;
  const sinceLabel = backtest
    ? t("bots.card.backtestDays", { days: bot.days })
    : t("bots.card.sinceStart", { days: bot.days });
  const event = bot.event;
  return (
    <article className="bt-card" data-state={bot.state}>
      <header className="bt-card-head">
        <h3>{bot.name ?? t(KIND[bot.kind])}</h3>
        <span className="bt-card-market">
          {marketLabel} · {venueLabel}
        </span>
        <ModeBadge bot={bot} />
        <State bot={bot} />
      </header>
      <Lifecycle bot={bot} />
      <dl className="bt-card-figures">
        <div>
          <dt>{t("bots.card.pnlToday")}</dt>
          <dd className="pd-num" data-trend={trend(bot.pnlToday)}>
            {bot.pnlToday === undefined ? "-" : formatSigned(bot.pnlToday)}
          </dd>
        </div>
        <div>
          <dt>{sinceLabel}</dt>
          <dd className="pd-num" data-trend={trend(bot.sinceStart)}>
            {formatSigned(bot.sinceStart)}
          </dd>
        </div>
        <div>
          <dt>
            {bot.mode === "paper" ? t("bots.card.positionSimulated") : t("bots.card.position")}
          </dt>
          <dd
            className="pd-num"
            data-trend={bot.position ? (bot.position.side === "long" ? "up" : "down") : undefined}
          >
            {backtest
              ? "-"
              : bot.position
                ? t("bots.card.positionValue", {
                    side: t(bot.position.side === "long" ? "side.long" : "side.short"),
                    size: `${formatNumber(bot.position.size, sizeDecimals(bot.position.size))} ${bot.position.base}`,
                    price: formatNumber(bot.position.entry, 1),
                  })
                : t("bots.card.flat")}
          </dd>
        </div>
      </dl>
      {event && (
        <p className="bt-card-event">
          <time className="pd-num">
            {backtest ? day().format(event.time) : time().format(event.time)}
          </time>
          {t(EVENT[event.kind], event.values ?? {})}
        </p>
      )}
      {(backtest || bot.limit) && (
        <div className="bt-card-limit" data-at-limit={atLimit || undefined}>
          <span>{backtest ? t("bots.card.limits") : t("bots.card.closestLimit")}</span>
          {backtest ? (
            <>
              <span className="bt-meter" aria-hidden />
              <span>{t("bots.card.limitsFromPaper")}</span>
            </>
          ) : bot.limit ? (
            <>
              <span className="bt-meter" aria-hidden>
                <span className="bt-meter-fill" style={{ width: `${limitShare * 100}%` }} />
              </span>
              <span className="pd-num">
                {t(bot.limit.kind === "position" ? "bots.limit.position" : "bots.limit.lossToday", {
                  used: formatNumber(bot.limit.used, sizeDecimals(bot.limit.used)),
                  max: formatNumber(bot.limit.max, sizeDecimals(bot.limit.max)),
                  unit: bot.limit.kind === "position" ? bot.limit.unit : "",
                }).trim()}
              </span>
            </>
          ) : null}
        </div>
      )}
      <footer className="bt-card-actions">
        {backtest ? (
          <button type="button" className="bt-button" data-primary onClick={onStartPaper}>
            {t("bots.action.startPaper")}
          </button>
        ) : (
          <button type="button" className="bt-button" disabled={!can.start} onClick={onStart}>
            {t("bots.action.start")}
          </button>
        )}
        {!backtest && (
          <>
            <button type="button" className="bt-button" disabled={!can.pause} onClick={onPause}>
              {t("bots.action.pause")}
            </button>
            <button
              type="button"
              className="bt-button"
              disabled={!can.stop}
              onClick={() => onStop(false)}
            >
              {t("bots.action.stop")}
            </button>
            <button
              type="button"
              className="bt-button"
              disabled={!can.flatten}
              onClick={() => onStop(true)}
            >
              {t("bots.action.flatten")}
            </button>
          </>
        )}
        {bot.mode === "paper" && (
          <button
            type="button"
            className="bt-button"
            disabled={!(can.goLive && onGoLive)}
            onClick={onGoLive}
            title={
              can.goLive
                ? onGoLive
                  ? undefined
                  : t("bots.goLiveNotYet")
                : t("bots.goLiveAfter", { days: PAPER_DAYS - (bot.paperDay ?? 0) })
            }
          >
            {t("bots.action.goLive")}
          </button>
        )}
        <span className="bt-spacer" />
        {onOpenBacktest && (
          <button type="button" className="bt-button" onClick={onOpenBacktest}>
            {t("bots.action.backtest")}
          </button>
        )}
      </footer>
    </article>
  );
}

const trend = (v: number | undefined) =>
  v === undefined || v === 0 ? undefined : v > 0 ? "up" : "down";
const sizeDecimals = (v: number) => (Number.isInteger(v) ? 0 : v < 1 ? 2 : 2);
