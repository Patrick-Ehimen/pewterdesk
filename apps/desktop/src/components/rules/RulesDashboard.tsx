import { dateFormat, formatNumber, formatSigned, t, trendClass } from "@pewterdesk/ui";
import type { ReactNode } from "react";
import { LuInfo, LuShield } from "react-icons/lu";
import {
  amounts,
  hasTarget,
  hoursNow,
  type RulesStatus,
  type TradingRules,
  WARN_AT,
} from "../../lib/tradingRules";
import { Badge, Bar, money, span, type Tone, usedTone } from "./parts";
import { MAX_KIND_NAME, PRESET_NAME } from "./RulesEditor";

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
/** "07:00" as the rules list shows it: "07". */
const hour = (clock: string) => (clock.endsWith(":00") ? clock.slice(0, 2) : clock);

/** One of the trader's rules: where it stands, its limit, and a bar. */
function RuleRow({
  title,
  badge,
  value,
  limit,
  bar,
  note,
}: {
  title: string;
  badge?: ReactNode;
  value: ReactNode;
  limit: ReactNode;
  bar?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="rules-rule">
      <div className="rules-rule-head">
        <strong>{title}</strong>
        {badge}
      </div>
      <div className="rules-rule-values">
        <span className="pd-num">{value}</span>
        <span className="rules-rule-limit">
          {t("rules.limit")} <b className="pd-num">{limit}</b>
        </span>
      </div>
      {bar}
      {note && <p className="rules-rule-note">{note}</p>}
    </div>
  );
}

/** One of the challenge's four numbers. */
function ChallengeCard({
  label,
  share,
  value,
  limit,
  tone,
  note,
}: {
  label: string;
  share?: number;
  value: ReactNode;
  limit: ReactNode;
  tone: Tone;
  note: ReactNode;
}) {
  return (
    <div className="rules-stat">
      <div className="rules-stat-head">
        <span>{label}</span>
        {share !== undefined && (
          <span className="pd-num rules-stat-share" data-tone={tone}>
            {pct(Math.min(share, 1))}
          </span>
        )}
      </div>
      <div className="rules-stat-value pd-num">
        {value} <small>/ {limit}</small>
      </div>
      <Bar label={label} share={share} tone={tone} />
      <p className="rules-stat-note">{note}</p>
    </div>
  );
}

interface Level {
  label: string;
  value: number;
  tone: "target" | "daily" | "max" | "start";
}

/** Equity since the challenge began, against the lines it must stay between. */
function EquityChart({
  curve,
  levels,
  peak,
}: {
  curve?: RulesStatus["curve"];
  levels: readonly Level[];
  peak?: number;
}) {
  const values = [...levels.map((l) => l.value), ...(curve ?? []).map((p) => p.equity)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || 1) * 0.12;
  // A value's place, as a share of the height from the top.
  const y = (v: number) => (hi + pad - v) / (hi - lo + 2 * pad);
  const first = curve?.[0];
  const last = curve?.at(-1);
  const x = (at: number) =>
    first && last && last.at > first.at ? (at - first.at) / (last.at - first.at) : 0;
  const path = (curve ?? [])
    .map(
      (p, i) => `${i ? "L" : "M"}${(x(p.at) * 100).toFixed(2)},${(y(p.equity) * 100).toFixed(2)}`,
    )
    .join("");
  const top = curve?.find((p) => p.equity === peak);
  return (
    <div className="rules-chart">
      <div className="rules-chart-plot">
        {levels.map((l) => (
          <div
            key={l.tone}
            className="rules-chart-line"
            data-tone={l.tone}
            style={{ top: `${y(l.value) * 100}%` }}
          >
            <span className="pd-num rules-chart-label">{l.label}</span>
          </div>
        ))}
        {curve && curve.length > 1 ? (
          <>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <path d={path} />
            </svg>
            {last && (
              <span
                className="rules-chart-dot"
                style={{ left: `${x(last.at) * 100}%`, top: `${y(last.equity) * 100}%` }}
              />
            )}
            {top && peak !== undefined && (
              <span
                className="rules-chart-peak pd-num"
                style={{ left: `${x(top.at) * 100}%`, top: `${y(top.equity) * 100}%` }}
              >
                {t("rules.peak", { equity: formatNumber(peak, 0) })}
              </span>
            )}
          </>
        ) : (
          <p className="rules-chart-empty">{t("rules.notTracked")}</p>
        )}
      </div>
      {first && last && (
        <div className="rules-chart-axis pd-num">
          <span>{dateFormat({ month: "short", day: "numeric" }).format(first.at)}</span>
          <span>{t("rules.today")}</span>
        </div>
      )}
    </div>
  );
}

interface RulesDashboardProps {
  rules: TradingRules;
  /** The venue whose account the rules are checked against. */
  venue: string;
  /** The connected account's equity, where there is one. */
  equity?: number;
  /** Where the account stands; unset until that's tracked. */
  status?: RulesStatus;
  /** The time, for the trading hours. */
  now: Date;
  onEdit: () => void;
}

/**
 * The rules at a glance: each of the trader's limits and how much of it is
 * used, the challenge's numbers with equity drawn against its floors, the
 * tilt signals, and today's trades.
 */
export function RulesDashboard({ rules, venue, equity, status, now, onEdit }: RulesDashboardProps) {
  const { challenge, tilt } = rules;
  const usd = amounts(rules);
  const none = "–";

  // The day's loss, and the account's fall from where the drawdown is measured.
  const dayLoss = status ? Math.max(-status.dayPnl, 0) : undefined;
  const dayShare = dayLoss === undefined ? undefined : dayLoss / (usd.daily || 1);
  const from = status ? (challenge.maxKind === "static" ? challenge.size : status.peak) : undefined;
  const fall = status && from !== undefined ? Math.max(from - status.equity, 0) : undefined;
  const fallShare = fall === undefined ? undefined : fall / (usd.max || 1);
  const profit = status ? status.equity - challenge.size : undefined;
  const breached = (dayShare ?? 0) >= 1 || (fallShare ?? 0) >= 1;

  const riskShare =
    status?.lastRisk === undefined ? undefined : status.lastRisk / (usd.tradeLoss || 1);
  const sizeShare = status?.position
    ? Math.max(
        status.position.notional / (rules.position.usd || 1),
        status.position.leverage / (rules.position.leverage || 1),
      )
    : undefined;
  const tradesLeft = status ? Math.max(rules.tradesPerDay - status.tradesToday, 0) : undefined;
  const hours = hoursNow(rules.hours, now);
  const cooling = status?.coolOffUntil !== undefined && status.coolOffUntil > now.getTime();

  const maxLabel = `${t("rules.maxDrawdown")} · ${challenge.maxPct}% ${t(MAX_KIND_NAME[challenge.maxKind])}`;
  const staticFloor = challenge.size - usd.max;
  const levels: Level[] = [
    ...(hasTarget(rules.preset) && challenge.targetPct > 0
      ? [
          {
            tone: "target" as const,
            value: challenge.size + usd.target,
            label: `${t("rules.legend.target")} ${formatNumber(challenge.size + usd.target, 0)}`,
          },
        ]
      : []),
    {
      tone: "start",
      value: challenge.size,
      label: `${t("rules.legend.start")} ${formatNumber(challenge.size, 0)}`,
    },
    ...(status
      ? [
          {
            tone: "daily" as const,
            value: status.dayStart - usd.daily,
            label: `${t("rules.legend.dailyFloor")} ${formatNumber(status.dayStart - usd.daily, 0)}`,
          },
        ]
      : []),
    {
      tone: "max",
      value: from === undefined ? staticFloor : from - usd.max,
      label: `${t("rules.legend.maxFloor")} ${formatNumber(from === undefined ? staticFloor : from - usd.max, 0)}`,
    },
  ];

  const lastSize = status?.sizes?.recent.at(-1);
  const creep =
    status?.sizes && lastSize !== undefined && status.sizes.usual > 0
      ? lastSize / status.sizes.usual
      : undefined;
  const pace =
    status?.pace && status.pace.average > 0 ? status.pace.today / status.pace.average : undefined;
  const firing = [
    tilt.revenge.on && status?.revenge !== undefined,
    tilt.sizeCreep.on && creep !== undefined && creep >= tilt.sizeCreep.factor,
    tilt.overtrading.on && pace !== undefined && pace >= tilt.overtrading.factor,
  ];
  const biggest = Math.max(...(status?.sizes?.recent ?? [1]), 1);
  const time = dateFormat({ hour: "2-digit", minute: "2-digit", hour12: false });
  const onOff = (on: boolean) => <Badge>{t(on ? "rules.on" : "rules.off")}</Badge>;

  return (
    <div className="page rules rules-dash">
      {/* The trader's own limits */}
      <aside className="rules-panel rules-mine">
        <header className="rules-mine-head">
          <LuShield size={18} aria-hidden />
          <h2>{t("rules.yours")}</h2>
          <button type="button" className="rules-button" onClick={onEdit}>
            {t("rules.edit")}
          </button>
        </header>
        <div className="rules-mine-list">
          <RuleRow
            title={t("rules.dailyLoss")}
            badge={
              dayShare !== undefined && (
                <Badge tone={usedTone(dayShare)}>{t("rules.used", { pct: pct(dayShare) })}</Badge>
              )
            }
            value={status ? formatSigned(Math.min(status.dayPnl, 0)) : none}
            limit={`${money(usd.daily)} USD`}
            bar={
              <Bar
                label={t("rules.dailyLoss")}
                share={dayShare}
                tone={usedTone(dayShare ?? 0)}
                tick={rules.breach === "warnLock" ? WARN_AT : undefined}
              />
            }
            note={
              rules.breach === "warnLock"
                ? t("rules.dailyNote.warnLock", { warn: money(usd.daily * WARN_AT) })
                : t(rules.breach === "lock" ? "rules.dailyNote.lock" : "rules.dailyNote.warn")
            }
          />
          <RuleRow
            title={t("rules.tradeLoss")}
            badge={
              status &&
              (riskShare === undefined ? (
                rules.tradeLoss.mode === "stop" && <Badge tone="warn">{t("rules.needsStop")}</Badge>
              ) : (
                <Badge tone={usedTone(riskShare)}>{t("rules.used", { pct: pct(riskShare) })}</Badge>
              ))
            }
            value={
              status?.lastRisk === undefined
                ? none
                : t("rules.onLastEntry", { risk: money(status.lastRisk) })
            }
            limit={`${money(usd.tradeLoss)} USD`}
            bar={
              <Bar
                label={t("rules.tradeLoss")}
                share={riskShare}
                tone={usedTone(riskShare ?? 0)}
                tick={WARN_AT}
              />
            }
            note={t(
              rules.tradeLoss.mode === "stop"
                ? "rules.tradeLossNote.stop"
                : "rules.tradeLossNote.warn",
            )}
          />
          <RuleRow
            title={t("rules.position")}
            badge={
              sizeShare !== undefined && (
                <Badge tone={usedTone(sizeShare)}>
                  {sizeShare >= 1 ? t("rules.over") : t("rules.ok")}
                </Badge>
              )
            }
            value={
              status?.position
                ? `${money(status.position.notional)} · ${formatNumber(status.position.leverage, 1)}×`
                : none
            }
            limit={`${formatNumber(rules.position.usd, 0)} · ${rules.position.leverage}×`}
            bar={
              <Bar
                label={t("rules.position")}
                share={sizeShare}
                tone={usedTone(sizeShare ?? 0)}
                tick={WARN_AT}
              />
            }
          />
          <RuleRow
            title={t("rules.tradesPerDay")}
            badge={
              tradesLeft !== undefined && (
                <Badge tone={tradesLeft === 0 ? "over" : tradesLeft <= 1 ? "warn" : "ok"}>
                  {t("rules.left", { count: tradesLeft })}
                </Badge>
              )
            }
            value={
              status
                ? t("rules.countOf", { used: status.tradesToday, limit: rules.tradesPerDay })
                : none
            }
            limit={rules.tradesPerDay}
            bar={
              <Bar
                label={t("rules.tradesPerDay")}
                share={status ? status.tradesToday / (rules.tradesPerDay || 1) : undefined}
                tone={usedTone(status ? status.tradesToday / (rules.tradesPerDay || 1) : 0)}
                tick={WARN_AT}
              />
            }
          />
          <RuleRow
            title={t("rules.hours")}
            badge={
              <Badge tone={hours.open ? "ok" : "muted"}>
                {t(hours.open ? "rules.open" : "rules.closed")}
              </Badge>
            }
            value={
              hours.minutes === undefined
                ? t(hours.open ? "rules.open" : "rules.closed")
                : t(hours.open ? "rules.openLeft" : "rules.closedOpens", {
                    time: span(hours.minutes),
                  })
            }
            limit={`${hour(rules.hours.from)}–${hour(rules.hours.to)} UTC`}
            note={rules.news.on ? t("rules.newsNote", { minutes: rules.news.minutes }) : undefined}
          />
          <RuleRow
            title={t("rules.coolOff")}
            badge={
              cooling ? (
                <Badge tone="warn">{t("rules.cooling")}</Badge>
              ) : status?.coolOffServed ? (
                <Badge tone="info">{t("rules.served")}</Badge>
              ) : undefined
            }
            value={status ? t("rules.streak", { count: status.lossStreak }) : none}
            limit={`${rules.coolOff.losses} → ${rules.coolOff.minutes} ${t("rules.min")}`}
          />
        </div>
        <footer className="rules-mine-foot">
          <LuInfo size={15} aria-hidden />
          <span>{t("rules.preview")}</span>
        </footer>
      </aside>

      {/* The challenge, and equity against its floors */}
      <section className="rules-panel rules-challenge">
        <header className="rules-challenge-head">
          <div>
            <h1>
              {t(PRESET_NAME[rules.preset])}
              {status && (
                <Badge tone={breached ? "over" : "ok"}>
                  {t(breached ? "rules.breached" : "rules.onTrack")}
                </Badge>
              )}
            </h1>
            <p>
              {t(rules.preset === "own" ? "rules.checkedOn" : "rules.simulated", {
                venue,
                size: formatNumber(challenge.size, 0),
              })}
              {status &&
                ` · ${t("rules.started", {
                  date: dateFormat({ month: "short", day: "numeric" }).format(status.startedAt),
                })}`}
            </p>
          </div>
          <div className="rules-equity">
            <span>{t("account.equity")}</span>
            <strong className="pd-num">
              {status ? money(status.equity) : equity !== undefined ? money(equity) : none}
            </strong>
          </div>
        </header>
        <div className="rules-stats">
          {hasTarget(rules.preset) && challenge.targetPct > 0 && (
            <ChallengeCard
              label={`${t("rules.target")} · ${challenge.targetPct}%`}
              share={profit === undefined ? undefined : Math.max(profit, 0) / (usd.target || 1)}
              tone="brass"
              value={profit === undefined ? none : formatSigned(profit)}
              limit={money(usd.target)}
              note={
                profit === undefined
                  ? t("rules.targetEquity", { equity: money(challenge.size + usd.target) })
                  : t("rules.toGo", {
                      amount: money(Math.max(usd.target - profit, 0)),
                      equity: money(challenge.size + usd.target),
                    })
              }
            />
          )}
          <ChallengeCard
            label={`${t("rules.dailyDrawdown")} · ${challenge.dailyPct}%`}
            share={dayShare}
            tone={usedTone(dayShare ?? 0)}
            value={status ? formatSigned(Math.min(status.dayPnl, 0)) : none}
            limit={money(usd.daily)}
            note={
              status
                ? t("rules.floor.day", {
                    start: money(status.dayStart),
                    floor: money(status.dayStart - usd.daily),
                  })
                : t("rules.resets")
            }
          />
          <ChallengeCard
            label={maxLabel}
            share={fallShare}
            tone={usedTone(fallShare ?? 0)}
            value={fall === undefined ? none : formatSigned(-fall)}
            limit={money(usd.max)}
            note={
              from === undefined
                ? challenge.maxKind === "static"
                  ? t("rules.floor.start", {
                      start: money(challenge.size),
                      floor: money(staticFloor),
                    })
                  : t("rules.floor.trails")
                : t(challenge.maxKind === "static" ? "rules.floor.start" : "rules.floor.peak", {
                    start: money(from),
                    floor: money(from - usd.max),
                  })
            }
          />
          {hasTarget(rules.preset) && (challenge.minDays > 0 || challenge.maxDays > 0) && (
            <ChallengeCard
              label={t("rules.tradingDays")}
              share={
                status && challenge.minDays > 0 ? status.tradingDays / challenge.minDays : undefined
              }
              tone="ok"
              value={status ? status.tradingDays : none}
              limit={t("rules.minN", { days: challenge.minDays })}
              note={
                status && challenge.maxDays > 0
                  ? `${t("rules.dayOf", { day: status.day, days: challenge.maxDays })}${
                      status.tradingDays >= challenge.minDays ? ` · ${t("rules.minMet")}` : ""
                    }`
                  : challenge.maxDays > 0
                    ? t("rules.maxDaysNote", { days: challenge.maxDays })
                    : t("rules.noTimeLimit")
              }
            />
          )}
        </div>
        <div className="rules-chart-head">
          <span>{t("rules.chart")}</span>
          <span className="rules-legend">
            <i data-tone="equity" /> {t("rules.legend.equity")}
            {levels
              .filter((l) => l.tone !== "start")
              .map((l) => (
                <span key={l.tone}>
                  <i data-tone={l.tone} />{" "}
                  {t(
                    l.tone === "target"
                      ? "rules.legend.target"
                      : l.tone === "daily"
                        ? "rules.legend.dailyFloor"
                        : "rules.legend.maxFloor",
                  )}
                </span>
              ))}
          </span>
        </div>
        <EquityChart curve={status?.curve} levels={levels} peak={status?.peak} />
        <footer className="rules-challenge-foot">
          <span>{t("rules.measured")}</span>
          <button type="button" className="rules-link" onClick={onEdit}>
            {t("rules.changePreset")}
          </button>
        </footer>
      </section>

      {/* Tilt signals, and today's trades */}
      <div className="rules-side">
        <section className="rules-panel">
          <header className="rules-side-head">
            <h2>{t("rules.tilt")}</h2>
            {status && (
              <Badge tone={firing.some(Boolean) ? "warn" : "ok"}>
                {t("rules.active", { count: firing.filter(Boolean).length })}
              </Badge>
            )}
          </header>
          <div className="rules-signal">
            <div className="rules-signal-head">
              <strong>{t("rules.revenge")}</strong>
              {firing[0] && status?.revenge ? (
                <Badge tone="warn">{t("rules.countToday", { count: status.revenge.count })}</Badge>
              ) : (
                onOff(tilt.revenge.on)
              )}
            </div>
            <p>
              {firing[0] && status?.revenge
                ? t("rules.revengeHit", {
                    coin: status.revenge.coin,
                    minutes: status.revenge.minutes,
                  })
                : t("rules.revengeRule", { minutes: tilt.revenge.minutes })}
            </p>
          </div>
          <div className="rules-signal">
            <div className="rules-signal-head">
              <strong>{t("rules.sizeCreep")}</strong>
              {tilt.sizeCreep.on && creep !== undefined ? (
                <Badge tone={firing[1] ? "warn" : "ok"}>{creep.toFixed(1)}×</Badge>
              ) : (
                onOff(tilt.sizeCreep.on)
              )}
            </div>
            <p>
              {firing[1] && status?.sizes && lastSize !== undefined
                ? t("rules.sizeCreepHit", {
                    size: formatNumber(lastSize, 0),
                    usual: formatNumber(status.sizes.usual, 0),
                  })
                : t("rules.sizeCreepRule", { factor: tilt.sizeCreep.factor })}
            </p>
            {tilt.sizeCreep.on && status?.sizes && (
              <div className="rules-sizes" aria-hidden>
                {status.sizes.recent.map((size, i, all) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a trade is its place among the last few
                  <span key={i} className="rules-size">
                    <i
                      data-hot={(i === all.length - 1 && firing[1]) || undefined}
                      style={{ height: `${Math.max((size / biggest) * 100, 8)}%` }}
                    />
                    <small>#{i + 1}</small>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="rules-signal">
            <div className="rules-signal-head">
              <strong>{t("rules.overtrading")}</strong>
              {tilt.overtrading.on && pace !== undefined ? (
                <Badge tone={firing[2] ? "warn" : "ok"}>
                  {t("rules.pace", { factor: pace.toFixed(1) })}
                </Badge>
              ) : (
                onOff(tilt.overtrading.on)
              )}
            </div>
            <p>{t("rules.overtradingRule", { factor: tilt.overtrading.factor })}</p>
            {tilt.overtrading.on && status?.pace && (
              <div className="rules-pace">
                <div className="rules-pace-row">
                  <span>{t("rules.paceToday")}</span>
                  <b className="pd-num">{status.pace.today}</b>
                </div>
                <Bar
                  label={t("rules.paceToday")}
                  share={status.pace.today / Math.max(status.pace.today, status.pace.average, 1)}
                  tone={firing[2] ? "warn" : "ok"}
                />
                <div className="rules-pace-row">
                  <span>{t("rules.paceAverage")}</span>
                  <b className="pd-num">{formatNumber(status.pace.average, 1)}</b>
                </div>
                <Bar
                  label={t("rules.paceAverage")}
                  share={status.pace.average / Math.max(status.pace.today, status.pace.average, 1)}
                  tone="muted"
                />
              </div>
            )}
          </div>
        </section>

        <section className="rules-panel rules-day">
          <header className="rules-side-head">
            <h2>{t("rules.today")}</h2>
            {status && (
              <span className={`pd-num ${trendClass(status.dayPnl)}`}>
                {formatSigned(status.dayPnl)}
              </span>
            )}
          </header>
          {status && status.trades.length > 0 ? (
            <ul className="rules-trades">
              {status.trades.map((trade) => (
                <li key={`${trade.at}:${trade.coin}`}>
                  <time className="pd-num">{time.format(trade.at)}</time>
                  <strong>{trade.coin}</strong>
                  <span className={trade.side === "long" ? "pd-up" : "pd-down"}>
                    {t(trade.side === "long" ? "side.long" : "side.short")}
                  </span>
                  {trade.tag && (
                    <Badge tone={trade.tag === "revenge" ? "warn" : "info"}>
                      {t(trade.tag === "revenge" ? "rules.tag.revenge" : "rules.tag.open")}
                    </Badge>
                  )}
                  <span className={`pd-num rules-trade-pnl ${trendClass(trade.pnl)}`}>
                    {formatSigned(trade.pnl)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rules-day-empty">{t(status ? "rules.noTrades" : "rules.notTracked")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
