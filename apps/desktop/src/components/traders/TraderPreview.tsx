import { formatCompact, formatNumber, formatPercent, t, trendClass } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { LuStar, LuX } from "react-icons/lu";
import {
  type TraderDetail,
  type TraderPeriod,
  type TraderRow,
  tradersClient,
} from "../../api/venueClient";
import { sizeText, traderName } from "../../hooks/useTraderWatch";
import { winRateOf } from "../../lib/traderHabits";
import {
  FOLLOWING,
  followedKeys,
  isFollowed,
  MAX_FOLLOWED,
  traderKey,
  useTraders,
} from "../../lib/traders";
import { ago } from "./Following";
import { PnlLine } from "./PnlLine";
import { Bar, LineSkeleton, ValueSkeleton } from "./Skeletons";
import { TraderAvatar } from "./TraderAvatar";
import { Side } from "./TraderView";

// The leaderboard's side panel (after design/screens/93): a trader at a
// glance - their PnL, figures, what they hold and last closed - with Follow,
// and the way to their full page. It reads only.

interface Props {
  row: TraderRow;
  rank: number;
  period: TraderPeriod;
  onClose: () => void;
  onOpen: () => void;
}

const money = (v: number) => `${v > 0 ? "+" : ""}${formatCompact(v)}`;
const price = (v: number) => formatNumber(v, v < 1 ? 5 : v < 100 ? 3 : 1);

export function TraderPreview({ row, rank, period, onClose, onOpen }: Props) {
  const { state, toggleFollow } = useTraders();
  const [detail, setDetail] = useState<TraderDetail>();
  const [error, setError] = useState<string>();
  const key = traderKey(row.source, row.id);
  const name = traderName(row.source, row.id, row.name);
  const followed = isFollowed(state, key);
  const full = !followed && followedKeys(state).length >= MAX_FOLLOWED;
  const okx = row.source === "okx";
  const loading = !detail && !error;

  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError(undefined);
    tradersClient
      .detail(row.source, row.id, okx ? "month" : period)
      .then((d) => live && setDetail(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [row.source, row.id, period, okx]);

  const open = [...(detail?.holdings ?? [])].sort((a, b) => b.value - a.value);
  const openValue = open.reduce((s, h) => s + h.value, 0);
  const levered = open.filter((h) => h.leverage != null);
  const leverage =
    levered.length > 0
      ? levered.reduce((s, h) => s + h.value * (h.leverage ?? 0), 0) /
        Math.max(
          1,
          levered.reduce((s, h) => s + h.value, 0),
        )
      : undefined;
  const list = state.lists.find((l) => l.id === state.active);
  const listName = !list || list.id === FOLLOWING ? t("traders.list.following") : list.name;
  const now = Date.now();

  const figures: [string, string | undefined, number | undefined][] = [
    [
      `${t("traders.kpi.pnl")} ${okx ? "" : t(`traders.period.${period}`)}`,
      money(row.pnl),
      row.pnl,
    ],
    [t("traders.kpi.roi"), (row.roi > 0 ? "+" : "") + formatPercent(row.roi, 1), row.roi],
    [
      // OKX's own; on Hyperliquid, their recent round trips, once there are enough.
      t("traders.kpi.winRate"),
      !okx && !detail
        ? undefined
        : (() => {
            const w = winRateOf(okx, row, detail);
            return w == null ? "–" : formatPercent(w, 0);
          })(),
      undefined,
    ],
    [
      t(okx ? "traders.kpi.aum" : "traders.kpi.account"),
      formatCompact(row.accountValue),
      undefined,
    ],
    [t("traders.kpi.open"), detail ? `$${formatCompact(openValue)}` : undefined, undefined],
    [
      t("traders.preview.leverage"),
      detail ? (leverage === undefined ? "–" : `${formatNumber(leverage, 1)}×`) : undefined,
      undefined,
    ],
  ];

  return (
    <aside className="tr-panel tr-preview" aria-label={name}>
      <header className="tr-preview-head">
        <TraderAvatar id={key} size={44} />
        <span className="tr-preview-name">
          <b>{name}</b>
          <span>
            <span className="tr-src">{t(`traders.source.short.${row.source}`)}</span>
            {row.leadDays != null && (
              <span>{t("traders.preview.leading", { days: row.leadDays })}</span>
            )}
          </span>
        </span>
        <span className="app-spacer" />
        {/* Opened from elsewhere (a card, the feed), they may not be on this board. */}
        {rank > 0 && <span className="tr-muted">#{rank}</span>}
        <button
          type="button"
          className="tr-icon"
          onClick={onClose}
          aria-label={t("traders.preview.close")}
        >
          <LuX size={15} aria-hidden />
        </button>
      </header>

      <div className="tr-preview-chart">
        {loading ? (
          <LineSkeleton height={100} />
        ) : detail && detail.pnlHistory.length > 1 ? (
          <PnlLine points={detail.pnlHistory} height={100} axis label={t("traders.pnlChart")} />
        ) : (
          <p className="tr-note">
            {error ? t("traders.detailError", { error }) : t("traders.noHistory")}
          </p>
        )}
      </div>

      <div className="tr-preview-kpis">
        {figures.map(([label, value, trend]) => (
          <div key={label}>
            <span>{label}</span>
            {value === undefined ? (
              <b className="tr-skel">
                <ValueSkeleton />
              </b>
            ) : (
              <b className={trend === undefined ? undefined : trendClass(trend)}>{value}</b>
            )}
          </div>
        ))}
      </div>

      {/* Every open position, biggest first, scrolling in the room left;
          what's below it (last closed, Follow) stays put. */}
      <section className="tr-preview-open" aria-label={t("traders.holdings")}>
        <header className="tr-panel-head">
          <h3>{t("traders.holdings")}</h3>
          {detail && <span className="tr-count">{open.length}</span>}
        </header>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area, reached by keyboard to scroll it */}
        <div className="tr-preview-list" tabIndex={0}>
          {loading ? (
            <PreviewRowsSkeleton rows={3} />
          ) : open.length === 0 ? (
            <p className="tr-note tr-pad">{t("traders.noHoldings")}</p>
          ) : (
            open.map((h, i) => (
              <div
                key={`${h.market}-${h.side}-${h.entry}-${h.openedAt ?? i}`}
                className="tr-preview-row"
              >
                <span className="tr-preview-what">
                  <b>
                    {h.market} <Side side={h.side} />
                  </b>
                  <small>
                    {sizeText(h.size)} · {t("traders.h.entry")} {price(h.entry)}
                    {h.leverage != null && ` · ${formatNumber(h.leverage, 0)}×`}
                  </small>
                </span>
                <span className="tr-muted">${formatCompact(h.value)}</span>
                <span className={trendClass(h.unrealized)}>{money(h.unrealized)}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="tr-preview-closed" aria-label={t("traders.preview.lastClosed")}>
        <header className="tr-panel-head tr-sub">
          <h3>{t("traders.preview.lastClosed")}</h3>
        </header>
        {loading ? (
          <PreviewRowsSkeleton rows={2} />
        ) : !detail || detail.closed.length === 0 ? (
          <p className="tr-note tr-pad">{t("traders.noClosed")}</p>
        ) : (
          detail.closed.slice(0, 2).map((c) => (
            <div key={`${c.time}-${c.market}`} className="tr-preview-row">
              <span className="tr-preview-what">
                <b>
                  {c.market} <Side side={c.side} />
                </b>
                <small>{ago(c.time, now)}</small>
              </span>
              <span />
              <span className={trendClass(c.pnl)}>{money(c.pnl)}</span>
            </div>
          ))
        )}
      </section>

      <p className="tr-note tr-preview-note">
        {followed
          ? t("traders.preview.followingNote")
          : t("traders.preview.followNote", { list: listName })}
      </p>
      <footer className="tr-preview-foot">
        <button
          type="button"
          className={followed ? "tr-following" : "tr-primary"}
          onClick={() => toggleFollow(key, row.name)}
          disabled={full}
          title={full ? t("traders.full", { max: MAX_FOLLOWED }) : undefined}
        >
          <LuStar size={14} fill={followed ? "currentColor" : "none"} aria-hidden />
          {t(followed ? "traders.following" : "traders.follow")}
        </button>
        <button type="button" className="tr-following" onClick={onOpen}>
          {t("traders.preview.open")}
        </button>
      </footer>
    </aside>
  );
}

function PreviewRowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="tr-skel" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
        <div key={i} className="tr-preview-row">
          <span className="tr-preview-what">
            <Bar width={60 + (i % 2) * 20} px />
            <Bar width={120} px height={7} />
          </span>
          <Bar width={44} px />
          <Bar width={50} px />
        </div>
      ))}
    </div>
  );
}
