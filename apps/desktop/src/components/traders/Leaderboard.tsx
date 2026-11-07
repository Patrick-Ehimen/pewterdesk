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
  type TraderSwept,
  tradersClient,
} from "../../api/venueClient";
import { TOP, useBoardInsights } from "../../hooks/useBoardInsights";
import { traderName } from "../../hooks/useTraderWatch";
import { BAND_RANGE, SIZE_BANDS, type SizeBand } from "../../lib/accountSize";
import {
  isOneHit,
  SCALPER_TURNOVER,
  STYLES,
  SWING_TURNOVER,
  stylesOf,
  type TraderStyle,
  WHALE,
} from "../../lib/traderStyles";
import { followedKeys, isFollowed, MAX_FOLLOWED, traderKey, useTraders } from "../../lib/traders";
import { Drawdown, GreenWeeks, Month, Now, type Read, WinDays } from "./BoardCells";
import { Insights } from "./Insights";
import { BoardSkeletonRows } from "./Skeletons";
import { TraderAvatar } from "./TraderAvatar";
import { TraderPreview } from "./TraderPreview";

export const PERIODS: readonly TraderPeriod[] = ["day", "week", "month", "allTime"];
const SORTS: Record<TraderSource, readonly TraderSort[]> = {
  hyperliquid: ["pnl", "roi", "accountValue", "volume"],
  okx: ["volume", "pnl", "roi", "winRate", "accountValue"],
};
/** Hyperliquid's floors: a big ROI on a tiny account says little. */
const LIMIT: Record<TraderSource, number> = { hyperliquid: 300, okx: 100 };
/** The cells after the trader, in order, for the loading rows. */
const CELLS: Record<TraderSource, ("num" | "weeks" | "now" | "spark")[]> = {
  hyperliquid: ["num", "num", "num", "num", "weeks", "num", "now", "spark"],
  okx: ["num", "num", "num", "num", "num", "weeks", "num", "num", "now", "spark"],
};

export interface BoardView {
  source: TraderSource;
  period: TraderPeriod;
  sort: TraderSort;
  /** The account sizes kept (on OKX, assets managed). */
  size: SizeBand;
}

export const DEFAULT_BOARD: BoardView = {
  source: "hyperliquid",
  period: "month",
  sort: "pnl",
  size: "100kUp",
};

const sortLabel = (source: TraderSource, sort: TraderSort) =>
  source === "okx" && sort === "volume" ? t("traders.sort.overview") : t(`traders.sort.${sort}`);

const pct = (v: number) => `${v > 0 ? "+" : ""}${formatPercent(v, 1)}`;
const money = (v: number) => `${v > 0 ? "+" : ""}${formatCompact(v)}`;

/** What each style means, for its chip. */
function styleHint(style: TraderStyle, source: TraderSource): string {
  if (style === "whale")
    return t("traders.style.whaleHint", { value: `$${formatCompact(WHALE[source])}` });
  if (style === "scalper") return t("traders.style.scalperHint", { times: SCALPER_TURNOVER });
  return t("traders.style.swingHint", { share: formatPercent(SWING_TURNOVER, 0) });
}

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
  /** The styles picked: a trader with any of them is shown. */
  const [styles, setStyles] = useState<ReadonlySet<TraderStyle>>(new Set());
  const [hideOneHit, setHideOneHit] = useState(false);
  /** The trader in the side panel. */
  const [selected, setSelected] = useState<TraderRow>();
  const { source, period, sort, size } = view;
  const okx = source === "okx";

  useEffect(() => {
    let live = true;
    setRows(undefined);
    setError(undefined);
    // `attempt` re-reads after an error.
    void attempt;
    tradersClient
      .leaderboard(source, period, sort, BAND_RANGE[size], LIMIT[source])
      .then((r) => live && setRows(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [source, period, sort, size, attempt]);

  const insights = useBoardInsights(rows, source);
  const ranks = useMemo(() => new Map(rows?.map((r, i) => [r, i + 1])), [rows]);
  /** Each read trader's positions and record, by id. */
  const reads = useMemo(
    () => new Map<string, TraderSwept>(insights.swept.map((s) => [s.id, s])),
    [insights.swept],
  );
  // Read, still to be read, or never read (below the top, or couldn't be read): a dash.
  const readOf = (r: TraderRow): Read =>
    reads.get(r.id) ?? (insights.pending(r.id) ? "pending" : undefined);

  const shown = useMemo(() => {
    if (!rows) return undefined;
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.id.toLowerCase().includes(q) && !r.name?.toLowerCase().includes(q)) return false;
      if (styles.size > 0 && !stylesOf(r, period).some((s) => styles.has(s))) return false;
      if (hideOneHit && isOneHit(reads.get(r.id)?.stats)) return false;
      return true;
    });
  }, [rows, search, styles, hideOneHit, reads, period]);

  const full = followedKeys(state).length >= MAX_FOLLOWED;
  const picked = selected?.source === source ? selected : undefined;
  const select = (r: TraderRow) =>
    setSelected((s) => (s?.source === r.source && s.id === r.id ? undefined : r));
  const toggleStyle = (s: TraderStyle) =>
    setStyles((before) => {
      const next = new Set(before);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  // OKX publishes no volume: whale is its one style.
  const styleChips = okx ? STYLES.filter((s) => s === "whale") : STYLES;

  return (
    <div className="tr-board-page">
      <Insights
        source={source}
        rows={rows}
        swept={insights.swept}
        total={insights.total}
        left={rows?.slice(0, TOP[source]).filter((r) => insights.pending(r.id)).length ?? 0}
        loading={insights.loading}
        onSelect={(r) => setSelected(r)}
      />
      <div className="tr-board-wrap" data-panel={picked ? true : undefined}>
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
            <Select
              value={size}
              options={SIZE_BANDS.map((b) => ({ value: b, label: t(`traders.size.${b}`) }))}
              onChange={(b) => onView({ ...view, size: b })}
              label={t(okx ? "traders.size.labelOkx" : "traders.size.label")}
            />
            {styleChips.map((s) => (
              <button
                key={s}
                type="button"
                className="tr-fchip"
                aria-pressed={styles.has(s)}
                onClick={() => toggleStyle(s)}
                title={styleHint(s, source)}
              >
                {t(`traders.style.${s}`)}
              </button>
            ))}
            <button
              type="button"
              className="tr-fchip"
              aria-pressed={hideOneHit}
              onClick={() => setHideOneHit((h) => !h)}
              title={t("traders.chip.oneHitHint")}
            >
              {t("traders.chip.oneHit")}
            </button>
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
              <button
                type="button"
                className="tr-following"
                onClick={() => setAttempt((a) => a + 1)}
              >
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
                    {okx && (
                      <th className="num" title={t("traders.col.winHint")}>
                        {t("traders.col.winRate")}
                      </th>
                    )}
                    <th className="num" title={t("traders.col.winDaysHint")}>
                      {t("traders.col.winDays")}
                    </th>
                    <th className="num" title={t("traders.col.ddHint")}>
                      {t("traders.col.dd")}
                    </th>
                    <th title={t("traders.col.weeksHint")}>{t("traders.col.weeks")}</th>
                    <th className="num">{t(okx ? "traders.col.aum" : "traders.col.account")}</th>
                    {okx && <th className="num">{t("traders.col.copiers")}</th>}
                    <th title={t("traders.col.nowHint")}>{t("traders.col.now")}</th>
                    <th>{t("traders.col.month")}</th>
                    <th aria-label={t("traders.follow")} />
                  </tr>
                </thead>
                {!shown ? (
                  <BoardSkeletonRows cells={CELLS[source]} />
                ) : (
                  <tbody>
                    {shown.map((r) => {
                      const key = traderKey(r.source, r.id);
                      const name = traderName(r.source, r.id, r.name);
                      const followed = isFollowed(state, key);
                      const read = readOf(r);
                      const tags = stylesOf(r, period);
                      return (
                        <tr
                          key={key}
                          onClick={() => select(r)}
                          data-followed={followed || undefined}
                          data-selected={picked?.id === r.id || undefined}
                        >
                          <td className="tr-rank">{ranks.get(r)}</td>
                          <td>
                            <button
                              type="button"
                              className="tr-who"
                              aria-label={t("traders.open", { name })}
                              onClick={(e) => {
                                e.stopPropagation();
                                select(r);
                              }}
                            >
                              <TraderAvatar id={key} />
                              <span className="tr-who-name">
                                <b>{name}</b>
                                {(tags.length > 0 || (r.name && !okx)) && (
                                  <small>
                                    {r.name && !okx && traderName(r.source, r.id, null)}
                                    {tags.map((s) => (
                                      <span key={s} className="tr-style">
                                        {t(`traders.style.${s}`)}
                                      </span>
                                    ))}
                                  </small>
                                )}
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
                          <td className="num">
                            <WinDays read={read} />
                          </td>
                          <td className="num">
                            <Drawdown read={read} />
                          </td>
                          <td>
                            <GreenWeeks read={read} />
                          </td>
                          <td className="num">{formatCompact(r.accountValue)}</td>
                          {okx && <td className="num">{r.copiers ?? "–"}</td>}
                          <td>
                            <Now read={read} />
                          </td>
                          <td className="tr-spark">
                            <Month read={read} fallback={r.roiCurve} />
                          </td>
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
            <span>
              {full
                ? t("traders.full", { max: MAX_FOLLOWED })
                : t("traders.legend", { top: TOP[source] })}
            </span>
            <span className="app-spacer" />
            <span>{t("traders.disclaimer", { source: t(`traders.source.${source}`) })}</span>
          </div>
        </section>
        {picked && (
          <TraderPreview
            key={`${picked.source}:${picked.id}`}
            row={picked}
            rank={ranks.get(rows?.find((r) => r.id === picked.id) ?? picked) ?? 0}
            period={period}
            onClose={() => setSelected(undefined)}
            onOpen={() => onOpen(picked)}
          />
        )}
      </div>
    </div>
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
