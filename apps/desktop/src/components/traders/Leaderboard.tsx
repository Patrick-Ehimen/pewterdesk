import {
  EmptyState,
  formatCompact,
  formatPercent,
  MapSeg,
  Select,
  StarButton,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { LuSearch } from "react-icons/lu";
import {
  type TraderPeriod,
  type TraderRow,
  type TraderSort,
  type TraderSource,
  tradersClient,
} from "../../api/venueClient";
import { traderName } from "../../hooks/useTraderWatch";
import { followedKeys, isFollowed, MAX_FOLLOWED, traderKey, useTraders } from "../../lib/traders";
import { PnlLine } from "./PnlLine";
import { BoardSkeletonRows } from "./Skeletons";
import { TraderAvatar } from "./TraderAvatar";

export const PERIODS: readonly TraderPeriod[] = ["day", "week", "month", "allTime"];
const SORTS: Record<TraderSource, readonly TraderSort[]> = {
  hyperliquid: ["pnl", "roi", "accountValue", "volume"],
  okx: ["volume", "pnl", "roi", "winRate", "accountValue"],
};
/** Hyperliquid's floors: a big ROI on a tiny account says little. */
const MIN_ACCOUNTS = [100_000, 1_000_000, 10_000_000] as const;
const LIMIT: Record<TraderSource, number> = { hyperliquid: 300, okx: 100 };

export interface BoardView {
  source: TraderSource;
  period: TraderPeriod;
  sort: TraderSort;
  minAccount: number;
}

export const DEFAULT_BOARD: BoardView = {
  source: "hyperliquid",
  period: "month",
  sort: "pnl",
  minAccount: 100_000,
};

const sortLabel = (source: TraderSource, sort: TraderSort) =>
  source === "okx" && sort === "volume" ? t("traders.sort.overview") : t(`traders.sort.${sort}`);

const pct = (v: number) => `${v > 0 ? "+" : ""}${formatPercent(v, 1)}`;
const money = (v: number) => `${v > 0 ? "+" : ""}${formatCompact(v)}`;

interface Props {
  view: BoardView;
  onView: (view: BoardView) => void;
  onOpen: (row: TraderRow) => void;
}

export function Leaderboard({ view, onView, onOpen }: Props) {
  const { state, toggleFollow } = useTraders();
  const [rows, setRows] = useState<TraderRow[]>();
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { source, period, sort, minAccount } = view;

  useEffect(() => {
    let live = true;
    setRows(undefined);
    setError(undefined);
    // `attempt` re-reads after an error.
    void attempt;
    tradersClient
      .leaderboard(source, period, sort, minAccount, LIMIT[source])
      .then((r) => live && setRows(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [source, period, sort, minAccount, attempt]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!rows || !q) return rows;
    return rows.filter((r) => r.id.toLowerCase().includes(q) || r.name?.toLowerCase().includes(q));
  }, [rows, search]);

  const full = followedKeys(state).length >= MAX_FOLLOWED;
  const ranks = useMemo(() => new Map(rows?.map((r, i) => [r, i + 1])), [rows]);
  const okx = source === "okx";

  return (
    <section className="tr-panel tr-board">
      <div className="tr-toolbar">
        <label className="tr-search">
          <LuSearch size={14} aria-hidden />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("traders.search")}
            aria-label={t("traders.search")}
            spellCheck={false}
          />
        </label>
        <Select
          value={sort}
          options={SORTS[source].map((s) => ({ value: s, label: sortLabel(source, s) }))}
          onChange={(s) => onView({ ...view, sort: s })}
          label={t("traders.sort")}
        />
        {!okx && (
          <Select
            value={String(minAccount)}
            options={MIN_ACCOUNTS.map((m) => ({
              value: String(m),
              label: `≥ $${formatCompact(m)}`,
            }))}
            onChange={(m) => onView({ ...view, minAccount: Number(m) })}
            label={t("traders.minAccount")}
          />
        )}
        <span className="app-spacer" />
        {rows ? (
          <span className="tr-muted">
            {t("traders.shown", { shown: shown?.length ?? 0, total: rows.length })}
          </span>
        ) : (
          !error && (
            <span className="tr-muted" role="status">
              {t(okx ? "traders.loading" : "traders.loadingHl")}
            </span>
          )
        )}
      </div>
      {error ? (
        <div className="tr-state">
          <EmptyState error>{error}</EmptyState>
          <button type="button" className="tr-following" onClick={() => setAttempt((a) => a + 1)}>
            {t("traders.retry")}
          </button>
        </div>
      ) : shown && shown.length === 0 ? (
        <EmptyState>{t("traders.none")}</EmptyState>
      ) : (
        <div className="tr-scroll" aria-busy={!shown || undefined}>
          <table className="tr-table">
            <thead>
              <tr>
                <th className="tr-rank">{t("traders.col.rank")}</th>
                <th>{t("traders.col.trader")}</th>
                <th className="num">{t("traders.col.pnl")}</th>
                <th className="num">{t("traders.col.roi")}</th>
                {okx && <th className="num">{t("traders.col.winRate")}</th>}
                <th className="num">{t(okx ? "traders.col.aum" : "traders.col.account")}</th>
                {okx ? (
                  <>
                    <th className="num">{t("traders.col.copiers")}</th>
                    <th className="num">{t("traders.col.leadDays")}</th>
                    <th>{t("traders.col.roi")}</th>
                  </>
                ) : (
                  <>
                    <th className="num">{t("traders.col.volume")}</th>
                    <th title={t("traders.col.streakHint")}>{t("traders.col.streak")}</th>
                  </>
                )}
                <th aria-label={t("traders.follow")} />
              </tr>
            </thead>
            {!shown ? (
              <BoardSkeletonRows okx={okx} />
            ) : (
              <tbody>
                {shown.map((r) => {
                  const key = traderKey(r.source, r.id);
                  const name = traderName(r.source, r.id, r.name);
                  const followed = isFollowed(state, key);
                  return (
                    <tr key={key} onClick={() => onOpen(r)} data-followed={followed || undefined}>
                      <td className="tr-rank">{ranks.get(r)}</td>
                      <td>
                        <button
                          type="button"
                          className="tr-who"
                          aria-label={t("traders.open", { name })}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(r);
                          }}
                        >
                          <TraderAvatar id={key} />
                          <span className="tr-who-name">
                            <b>{name}</b>
                            {r.name && !okx && <small>{traderName(r.source, r.id, null)}</small>}
                          </span>
                        </button>
                      </td>
                      <td className={`num ${trendClass(r.pnl)}`}>{money(r.pnl)}</td>
                      <td className={`num ${trendClass(r.roi)}`}>{pct(r.roi)}</td>
                      {okx && (
                        <td className="num">
                          {r.winRate == null ? "–" : formatPercent(r.winRate, 0)}
                        </td>
                      )}
                      <td className="num">{formatCompact(r.accountValue)}</td>
                      {okx ? (
                        <>
                          <td className="num">{r.copiers ?? "–"}</td>
                          <td className="num">
                            {r.leadDays == null ? "–" : t("traders.days", { days: r.leadDays })}
                          </td>
                          <td className="tr-spark">
                            <PnlLine
                              points={r.roiCurve.map((v, i) => [i, v])}
                              height={22}
                              label={t("traders.col.roi")}
                            />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="num">
                            {r.volume == null ? "–" : formatCompact(r.volume)}
                          </td>
                          <td>
                            <Streak positive={r.positive} />
                          </td>
                        </>
                      )}
                      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the star inside is the control */}
                      <td className="tr-star" onClick={(e) => e.stopPropagation()}>
                        <StarButton
                          starred={followed}
                          name={name}
                          onToggle={() => toggleFollow(key, r.name)}
                          size={15}
                          className={!followed && full ? "tr-star-full" : undefined}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
      )}
      <div className="tr-foot">
        {full && <span>{t("traders.full", { max: MAX_FOLLOWED })}</span>}
        <span className="app-spacer" />
        <span>{t("traders.disclaimer", { source: t(`traders.source.${source}`) })}</span>
      </div>
    </section>
  );
}

/** Four pips: up over the day, week, month and all time. */
function Streak({ positive }: { positive: TraderRow["positive"] }) {
  if (!positive) return <span className="tr-muted">–</span>;
  const names = ["day", "week", "month", "allTime"] as const;
  return (
    <span className="tr-streak">
      {names.map((n, i) => (
        <i key={n} data-on={positive[i] || undefined} title={t(`traders.period.${n}`)}>
          {t(`traders.streak.${n}`)}
        </i>
      ))}
    </span>
  );
}

/** The source and period switches, for the page's header. */
export function BoardSwitches({
  view,
  onView,
}: {
  view: BoardView;
  onView: (v: BoardView) => void;
}) {
  return (
    <>
      <MapSeg
        options={["hyperliquid", "okx"] as const}
        value={view.source}
        onChange={(source) =>
          onView({
            ...view,
            source,
            sort: SORTS[source].includes(view.sort) ? view.sort : (SORTS[source][0] ?? "pnl"),
          })
        }
        label={t("traders.source")}
        text={(s) => t(`traders.source.${s}`)}
      />
      {view.source === "hyperliquid" && (
        <MapSeg
          options={PERIODS}
          value={view.period}
          onChange={(period) => onView({ ...view, period })}
          label={t("traders.period")}
          text={(p) => t(`traders.period.${p}`)}
        />
      )}
    </>
  );
}
