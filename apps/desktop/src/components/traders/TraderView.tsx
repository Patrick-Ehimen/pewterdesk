import {
  EmptyState,
  formatCompact,
  formatNumber,
  formatPercent,
  MapSeg,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { LuArrowLeft, LuCopy, LuStar } from "react-icons/lu";
import {
  type TraderDetail,
  type TraderPeriod,
  type TraderRow,
  type TraderSource,
  type TraderSwept,
  tradersClient,
} from "../../api/venueClient";
import { traderName } from "../../hooks/useTraderWatch";
import { trades30d } from "../../lib/traderHabits";
import {
  alertsFor,
  CHANGE_KINDS,
  followedKeys,
  isFollowed,
  MAX_FOLLOWED,
  traderKey,
  useTraders,
} from "../../lib/traders";
import { PERIODS } from "./Leaderboard";
import { PnlLine } from "./PnlLine";
import {
  BarsSkeleton,
  LineSkeleton,
  TableSkeletonRows,
  ValueSkeleton,
  WeeksSkeleton,
} from "./Skeletons";
import { TraderAvatar } from "./TraderAvatar";
import { AgainstYou, AlertsCard, HowTheyTrade, type MyBook } from "./TraderSide";

interface Props {
  source: TraderSource;
  id: string;
  /** Their leaderboard line, when opened from one. */
  row?: TraderRow;
  period: TraderPeriod;
  /** Your positions on the venue on screen, to compare with theirs. */
  mine?: MyBook;
  onBack: () => void;
}

const price = (v: number) => formatNumber(v, v < 1 ? 5 : v < 100 ? 3 : 1);
const size = (v: number) => formatNumber(v, v < 10 ? 4 : v < 1000 ? 2 : 0);
const signedMoney = (v: number) => `${v > 0 ? "+" : ""}${formatCompact(v)}`;
const when = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function TraderView({ source, id, row, period: startPeriod, mine, onBack }: Props) {
  const { state, toggleFollow } = useTraders();
  const [period, setPeriod] = useState<TraderPeriod>(startPeriod);
  const [detail, setDetail] = useState<TraderDetail>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  /** Their record and positions as the leaderboard reads them; null if it couldn't be read. */
  const [record, setRecord] = useState<TraderSwept | null>();
  const key = traderKey(source, id);
  const name = traderName(source, id, row?.name);
  const followed = isFollowed(state, key);
  const okx = source === "okx";

  useEffect(() => {
    let live = true;
    setRecord(undefined);
    tradersClient
      .sweep(source, [id])
      .then((r) => live && setRecord(r[0] ?? null))
      .catch(() => live && setRecord(null));
    return () => {
      live = false;
    };
  }, [source, id]);

  useEffect(() => {
    let live = true;
    setError(undefined);
    void attempt;
    tradersClient
      .detail(source, id, period)
      .then((d) => live && setDetail(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [source, id, period, attempt]);

  /** Still reading this trader (not after an error). */
  const loading = !detail && !error;
  const open = detail?.holdings ?? [];
  const history = detail?.pnlHistory ?? [];
  const periodPnl =
    history.length > 1 ? (history.at(-1)?.[1] ?? 0) - (history[0]?.[1] ?? 0) : undefined;
  const full = !followed && followedKeys(state).length >= MAX_FOLLOWED;
  // Their record (win days, drawdown): the leaderboard's read, kept 30 minutes in Rust.
  const win = okx ? row?.winRate : record?.stats?.winDays;
  const dd = record?.stats?.maxDrawdown;
  const levered = open.filter((h) => h.leverage != null);
  const leverage =
    levered.length > 0
      ? levered.reduce((s, h) => s + h.value * (h.leverage ?? 0), 0) /
        Math.max(
          1,
          levered.reduce((s, h) => s + h.value, 0),
        )
      : undefined;
  const recent = detail ? trades30d(detail.closed, 100) : undefined;
  /** Their markets, for the alerts card: what they hold, then what they trade most. */
  const markets = [
    ...new Set([
      ...[...open].sort((a, b) => b.value - a.value).map((h) => h.market),
      ...(detail?.preferred.map(([coin]) => coin) ?? []),
    ]),
  ].filter((m) => /^[0-9A-Za-z]{1,20}$/.test(m));

  const copy = () => {
    void navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="tr-profile">
      <section className="tr-panel tr-hero">
        <div className="tr-hero-top">
          <button type="button" className="tr-back" onClick={onBack} aria-label={t("traders.back")}>
            <LuArrowLeft size={16} aria-hidden />
          </button>
          <TraderAvatar id={key} size={48} />
          <div className="tr-hero-name">
            <h2>{name}</h2>
            <span className="tr-hero-id">
              <span className="tr-src">{t(`traders.source.short.${source}`)}</span>
              <span>{id}</span>
              <button
                type="button"
                className="tr-copy"
                onClick={copy}
                aria-label={t("traders.copyId")}
              >
                <LuCopy size={12} aria-hidden />
                {copied && <span>{t("traders.copied")}</span>}
              </button>
            </span>
          </div>
          <span className="app-spacer" />
          <button
            type="button"
            className={followed ? "tr-following" : "tr-primary"}
            onClick={() => toggleFollow(key, row?.name)}
            disabled={full}
            title={full ? t("traders.full", { max: MAX_FOLLOWED }) : undefined}
          >
            <LuStar size={14} fill={followed ? "currentColor" : "none"} aria-hidden />
            {t(followed ? "traders.following" : "traders.follow")}
          </button>
        </div>
        <div className="tr-kpis">
          <Kpi
            label={`${t("traders.kpi.pnl")} ${okx ? "" : t(`traders.period.${period}`)}`}
            value={
              periodPnl === undefined ? (row ? signedMoney(row.pnl) : "–") : signedMoney(periodPnl)
            }
            trend={periodPnl ?? row?.pnl}
            note={okx ? t("traders.kpi.sinceLeading") : undefined}
            loading={loading && !row}
          />
          <Kpi
            label={t("traders.kpi.roi")}
            value={row ? (row.roi > 0 ? "+" : "") + formatPercent(row.roi, 1) : "–"}
            trend={row?.roi}
          />
          <Kpi
            label={t(okx ? "traders.kpi.winRate" : "traders.col.winDays")}
            value={win == null ? "–" : formatPercent(win, 0)}
            note={t(okx ? "traders.kpi.winOkx" : "traders.kpi.winDaysHint")}
            loading={!okx && record === undefined}
          />
          <Kpi
            label={t("traders.kpi.dd")}
            value={dd == null ? "–" : dd > 0 ? `−${formatPercent(dd, 1)}` : "0%"}
            trend={dd ? -dd : undefined}
            note={t("traders.kpi.ddHint")}
            loading={record === undefined}
          />
          <Kpi
            label={t(okx ? "traders.kpi.aum" : "traders.kpi.account")}
            value={formatCompact(detail?.accountValue || row?.accountValue || 0)}
            note={
              leverage === undefined
                ? undefined
                : t("traders.kpi.leverage", { x: formatNumber(leverage, 1) })
            }
            loading={loading && !row}
          />
          <Kpi
            label={t("traders.kpi.trades")}
            value={recent ? `${recent.count}${recent.more ? "+" : ""}` : "–"}
            note={
              recent && recent.count > 0
                ? t("traders.kpi.perDay", { n: formatNumber(recent.count / 30, 1) })
                : undefined
            }
            loading={loading}
          />
        </div>
      </section>

      {error ? (
        <section className="tr-panel tr-state">
          <EmptyState error>{t("traders.detailError", { error })}</EmptyState>
          <button type="button" className="tr-following" onClick={() => setAttempt((a) => a + 1)}>
            {t("traders.retry")}
          </button>
        </section>
      ) : (
        <div className="tr-profile-body">
          <div className="tr-profile-main">
            <section className="tr-panel">
              <header className="tr-panel-head">
                <h3>{t("traders.pnlChart")}</h3>
                <span className="app-spacer" />
                <MapSeg
                  options={okx ? (["week", "month", "allTime"] as const) : PERIODS}
                  value={period}
                  onChange={setPeriod}
                  label={t("traders.period")}
                  text={(p) => t(`traders.period.${p}`)}
                />
              </header>
              {!detail ? (
                <div className="tr-chart">
                  <LineSkeleton height={220} />
                </div>
              ) : history.length < 2 ? (
                <EmptyState>{t("traders.noHistory")}</EmptyState>
              ) : (
                <div className="tr-chart">
                  <PnlLine points={history} height={220} axis label={t("traders.pnlChart")} />
                </div>
              )}
            </section>

            <section className="tr-panel">
              <header className="tr-panel-head">
                <h3>{t("traders.holdings")}</h3>
                {detail && <span className="tr-count">{open.length}</span>}
              </header>
              {detail && open.length === 0 ? (
                <EmptyState>{t("traders.noHoldings")}</EmptyState>
              ) : (
                <div className="tr-scroll" aria-busy={loading || undefined}>
                  <table className="tr-table tr-table-plain">
                    <thead>
                      <tr>
                        <th>{t("traders.h.market")}</th>
                        <th>{t("traders.h.side")}</th>
                        <th className="num">{t("traders.h.size")}</th>
                        <th className="num">{t("traders.h.value")}</th>
                        <th className="num">{t("traders.h.entry")}</th>
                        <th className="num">{t("traders.h.mark")}</th>
                        <th className="num">{t("traders.h.leverage")}</th>
                        <th className="num">{t("traders.h.liq")}</th>
                        <th className="num">{t("traders.h.unrealized")}</th>
                        {okx && <th className="num">{t("traders.h.opened")}</th>}
                      </tr>
                    </thead>
                    {loading ? (
                      <TableSkeletonRows cols={okx ? 10 : 9} rows={4} />
                    ) : (
                      <tbody>
                        {[...open]
                          .sort((a, b) => b.value - a.value)
                          .map((h) => (
                            <tr key={`${h.market}-${h.side}-${h.entry}-${h.openedAt ?? 0}`}>
                              <td>{h.market}</td>
                              <td>
                                <Side side={h.side} />
                              </td>
                              <td className="num">{size(h.size)}</td>
                              <td className="num">{formatCompact(h.value)}</td>
                              <td className="num">{price(h.entry)}</td>
                              <td className="num">{h.mark == null ? "–" : price(h.mark)}</td>
                              <td className="num">
                                {h.leverage == null ? "–" : `${formatNumber(h.leverage, 0)}×`}
                              </td>
                              <td className="num tr-warn">
                                {h.liquidation == null ? "–" : price(h.liquidation)}
                              </td>
                              <td className={`num ${trendClass(h.unrealized)}`}>
                                {signedMoney(h.unrealized)}
                              </td>
                              {okx && (
                                <td className="num tr-muted">
                                  {h.openedAt ? when.format(h.openedAt) : "–"}
                                </td>
                              )}
                            </tr>
                          ))}
                      </tbody>
                    )}
                  </table>
                </div>
              )}
            </section>

            <section className="tr-panel">
              <header className="tr-panel-head">
                <h3>{t("traders.closed")}</h3>
                {detail && <span className="tr-count">{detail.closed.length}</span>}
              </header>
              {detail && detail.closed.length === 0 ? (
                <EmptyState>{t("traders.noClosed")}</EmptyState>
              ) : (
                <div className="tr-scroll tr-closed" aria-busy={loading || undefined}>
                  <table className="tr-table tr-table-plain">
                    <thead>
                      <tr>
                        <th>{t("traders.h.closedAt")}</th>
                        <th>{t("traders.h.market")}</th>
                        <th>{t("traders.h.side")}</th>
                        <th className="num">{t("traders.h.size")}</th>
                        <th className="num">{t("traders.h.price")}</th>
                        <th className="num">{t("traders.h.closedPnl")}</th>
                      </tr>
                    </thead>
                    {loading ? (
                      <TableSkeletonRows cols={6} rows={6} sideAt={2} />
                    ) : (
                      <tbody>
                        {detail?.closed.map((c) => (
                          <tr key={`${c.time}-${c.market}-${c.size}`}>
                            <td className="tr-muted">{when.format(c.time)}</td>
                            <td>{c.market}</td>
                            <td>
                              <Side side={c.side} />
                            </td>
                            <td className="num">{size(c.size)}</td>
                            <td className="num">{price(c.price)}</td>
                            <td className={`num ${trendClass(c.pnl)}`}>{signedMoney(c.pnl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    )}
                  </table>
                </div>
              )}
            </section>
          </div>

          <aside className="tr-profile-side">
            <AlertsCard traderKey={key} markets={markets} />
            <HowTheyTrade detail={detail} />
            {okx && (
              <section className="tr-panel" aria-busy={loading || undefined}>
                <header className="tr-panel-head">
                  <h3>{t("traders.weekly")}</h3>
                </header>
                {loading ? (
                  <WeeksSkeleton />
                ) : detail && detail.weeklyPnl.length > 0 ? (
                  <Weekly weeks={detail.weeklyPnl.slice(-12)} />
                ) : (
                  <p className="tr-note tr-pad">{t("traders.noHistory")}</p>
                )}
              </section>
            )}
            <AgainstYou detail={detail} mine={mine} />
          </aside>
        </div>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
  trend,
  loading = false,
}: {
  label: string;
  value: string;
  note?: string;
  trend?: number;
  /** Not read yet: a shimmer where the value goes. */
  loading?: boolean;
}) {
  return (
    <div className="tr-kpi" aria-busy={loading || undefined}>
      <span>{label}</span>
      {loading ? (
        <b className="tr-skel">
          <ValueSkeleton />
        </b>
      ) : (
        <b className={trend === undefined ? undefined : trendClass(trend)}>{value}</b>
      )}
      {note && !loading && <small>{note}</small>}
    </div>
  );
}

export function Side({ side }: { side: "long" | "short" }) {
  return (
    <span className="tr-side" data-side={side}>
      {t(side === "long" ? "traders.side.long" : "traders.side.short")}
    </span>
  );
}

/** A bar a week, up green and down red, around a middle line. */
function Weekly({ weeks }: { weeks: [number, number][] }) {
  const most = Math.max(...weeks.map(([, v]) => Math.abs(v)), 1);
  return (
    <div className="tr-weeks">
      {weeks.map(([at, v]) => (
        <span
          key={at}
          className="tr-week"
          title={`${new Date(at).toLocaleDateString()} ${signedMoney(v)}`}
        >
          <i data-up={v >= 0 || undefined} style={{ height: `${(Math.abs(v) / most) * 50}%` }} />
        </span>
      ))}
    </div>
  );
}
