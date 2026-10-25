import type { Market, VenueId } from "@pewterdesk/core";
import {
  atrShare,
  BOOK_SPANS,
  BookHeatmap,
  CORR_HOURS,
  CORR_SIZES,
  CORR_WINDOWS,
  type CoinRow,
  CorrelationMap,
  changeSince,
  correlationMatrix,
  decimalsOf,
  FUNDING_SORTS,
  FUNDING_UNITS,
  FundingMap,
  HEAT_INDEXES,
  HEAT_PERIODS,
  HEAT_TOPS,
  hourProfile,
  LIQ_WINDOWS,
  LiqHeatmap,
  type LiqMap,
  Liquidations,
  LONG_SHORT_SORTS,
  LongShortMap,
  liquidationMap,
  MAP_TOPS,
  MapSeg,
  MarketHeatmap,
  MarketSearch,
  type MessageKey,
  OI_HOURS,
  OI_WINDOWS,
  type OiPoint,
  OpenInterestMap,
  oiChangeOver,
  oiChangeSoFar,
  openInterestFromVolume,
  PERF_HOURS,
  PERF_WINDOWS,
  PerformanceMap,
  type PerfTile,
  RSI_FRAMES,
  RSI_SCOPES,
  RSI_VIEWS,
  RsiHeatmap,
  type RsiQuote,
  realisedVol,
  SeasonalityMap,
  SessionsMap,
  SPREAD_SORTS,
  SpreadMap,
  seasonality,
  sessionStats,
  Tabs,
  t,
  VOL_FILTERS,
  VOL_MEASURES,
  VOL_ROW_COUNTS,
  VolatilityMap,
  type VolRow,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { venueClient } from "../../api/venueClient";
import { useCoinSectors } from "../../hooks/useCoinSectors";
import { liveLiquidationSource, useLiquidations } from "../../hooks/useLiquidations";
import {
  BOOK_COLUMNS,
  BOOK_ROWS,
  longShortSource,
  OI_HISTORY_VENUES,
  SEASON_DAYS,
  useBookHeat,
  useCrossVenue,
  useLongShort,
  useMarketHistories,
  useOiHistory,
  useSeasonCandles,
} from "../../hooks/useMapData";
import { useRsiMap } from "../../hooks/useRsiMap";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import { useMarketSummaries } from "../../hooks/useVenueFeeds";
import { isTyping, plainKey } from "../../lib/hotkeys";
import {
  loadSaved,
  type SavedMapView,
  storeSaved,
  withoutSaved,
  withSaved,
} from "../../lib/mapViews";
import { loadOi } from "../../lib/oiStore";
import { loadRsiOrder, saveRsiOrder } from "../../lib/rsiStore";
import { VENUE_IDS, VENUES } from "../../lib/venues";
import { MapHelp } from "../maps/MapHelp";
import { SavedViews } from "../maps/SavedViews";
import { LoadingMark } from "../Splash";

const VIEWS = [
  "rsi",
  "perf",
  "vol",
  "funding",
  "oi",
  "ls",
  "liquidations",
  "liqmap",
  "book",
  "heatmap",
  "corr",
  "spread",
  "season",
  "sessions",
] as const;
type View = (typeof VIEWS)[number];
const GROUPS = ["momentum", "positioning", "liquidations", "market", "time"] as const;
type Group = (typeof GROUPS)[number];
/** Each group's views, in the order its chips show them. */
const GROUP_VIEWS: Record<Group, readonly View[]> = {
  momentum: ["rsi", "perf", "vol"],
  positioning: ["funding", "oi", "ls"],
  liquidations: ["liquidations", "liqmap", "book"],
  market: ["heatmap", "corr", "spread"],
  time: ["season", "sessions"],
};
const groupOf = (view: View) => GROUPS.find((g) => GROUP_VIEWS[g].includes(view)) ?? "momentum";
const VIEW_LABEL: Record<View, MessageKey> = {
  rsi: "maps.rsi",
  perf: "maps.perf",
  vol: "maps.vol",
  funding: "maps.funding",
  oi: "maps.oi",
  ls: "maps.ls",
  liquidations: "maps.liquidations",
  liqmap: "maps.liqHeatmap",
  book: "maps.book",
  heatmap: "maps.heatmap",
  corr: "maps.corr",
  spread: "maps.spread",
  season: "maps.season",
  sessions: "maps.sessions",
};
/** The views that read every market's hourly history. */
const HISTORY_VIEWS: readonly View[] = ["perf", "vol", "oi", "corr"];
/** Dots on the open-interest map: the biggest by open interest. */
const OI_POINTS = 60;

const GROUP_VIEW_KEY = "pd.maps.groupView";

/** The Crypto / All filter on the views that rank every market. */
const MAP_SCOPES = ["crypto", "all"] as const;
/** Crypto perps: stocks, ETFs, metals and forex carry a category. */
const isCrypto = (m: Market) => !m.category || m.category === "innovation";

/** The settings a saved view keeps, per view (by the names in `choices`). */
const VIEW_SETTINGS: Record<View, readonly string[]> = {
  rsi: ["frame", "scope", "rsiView"],
  perf: ["perfWindow", "perfTop", "mapScope"],
  vol: ["volMeasure", "volFilter", "volRows", "mapScope"],
  funding: ["fundingUnit", "fundingSort"],
  oi: ["oiWindow"],
  ls: ["lsSort"],
  liquidations: ["liqWindow"],
  liqmap: ["span"],
  book: ["bookSpan"],
  heatmap: ["heatIndex", "heatPeriod", "heatTop"],
  corr: ["corrWindow", "corrSize", "mapScope"],
  spread: ["spreadSort"],
  season: [],
  sessions: [],
};
/** The views about one market, whose saved views keep it. */
const MARKET_VIEWS: readonly View[] = ["liqmap", "book", "season", "sessions"];

/** A stored choice as a saved view sees it: its value, and a setter that checks. */
function choice<T extends string>(value: T, set: (v: T) => void, allowed: readonly T[]) {
  return {
    value: value as string,
    set: (v: string) => {
      const found = allowed.find((a) => a === v);
      if (found !== undefined) set(found);
    },
  };
}

/** The view last open in each group, so a group opens where it was left. */
function loadGroupViews(): Partial<Record<Group, View>> {
  try {
    const saved = JSON.parse(localStorage.getItem(GROUP_VIEW_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    const out: Partial<Record<Group, View>> = {};
    for (const g of GROUPS) {
      const v = saved[g];
      if (typeof v === "string" && GROUP_VIEWS[g].includes(v as View)) out[g] = v as View;
    }
    return out;
  } catch {
    return {};
  }
}
/** The liquidation heatmap's spans, in hours (Bybit serves 200 hours of open interest). */
const SPANS = ["48", "168"] as const;
type Span = (typeof SPANS)[number];
/** How often the heatmap's history is fetched again. */
const HEATMAP_REFRESH_MS = 5 * 60_000;

const EXCLUDED_KEY = "pd.maps.heatExcluded";

/** The coins left off the market heatmap, as last chosen. */
function loadExcluded(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

function saveExcluded(excluded: ReadonlySet<string>) {
  try {
    localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...excluded]));
  } catch {
    // Storage unavailable; the choice just won't survive a restart.
  }
}

interface MapsPageProps {
  venue: VenueId;
  venueLabel: string;
  markets: Market[];
  /** The market on screen, which the liquidation heatmap starts on. */
  selected?: string;
  /** Opens a market on the Trade page. */
  onTrade: (market: Market) => void;
}

/**
 * Whole-market views: the RSI heatmap (every market's RSI from its own
 * candles), the market heatmap (coins by sector, sized by market cap, from
 * CoinGecko), liquidations (treemap, totals and live list, from the venue's
 * public feed) and the estimated liquidation heatmap (from the venue's
 * hourly candles and open interest).
 */
export function MapsPage({ venue, venueLabel, markets, selected, onTrade }: MapsPageProps) {
  const [view, setView] = useStoredChoice<View>("pd.maps.view", VIEWS, "rsi");
  const [frame, setFrame] = useStoredChoice("pd.maps.rsiFrame", RSI_FRAMES, "4h");
  const [scope, setScope] = useStoredChoice("pd.maps.rsiScope", RSI_SCOPES, "all");
  const [rsiView, setRsiView] = useStoredChoice("pd.maps.rsiView", RSI_VIEWS, "chart");
  // V flips the RSI heatmap between its chart and its table.
  useEffect(() => {
    if (view !== "rsi") return;
    const onKey = (e: KeyboardEvent) => {
      if (plainKey(e, isTyping(e.target)) !== "v" || e.shiftKey) return;
      e.preventDefault();
      setRsiView(rsiView === "chart" ? "table" : "chart");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, rsiView, setRsiView]);
  const [heatIndex, setHeatIndex] = useStoredChoice("pd.maps.heatIndex", HEAT_INDEXES, "marketCap");
  const [heatPeriod, setHeatPeriod] = useStoredChoice("pd.maps.heatPeriod", HEAT_PERIODS, "24h");
  const [heatTop, setHeatTop] = useStoredChoice("pd.maps.heatTop", HEAT_TOPS, "20");
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(loadExcluded);
  const sectors = useCoinSectors(view === "heatmap");
  const [liqWindow, setLiqWindow] = useStoredChoice("pd.maps.liqWindow", LIQ_WINDOWS, "4h");
  const [span, setSpan] = useStoredChoice<Span>("pd.maps.liqSpan", SPANS, "48");
  const [heatMarket, setHeatMarket] = useState(selected);
  useEffect(() => setHeatMarket((m) => m ?? selected), [selected]);
  const [perfWindow, setPerfWindow] = useStoredChoice("pd.maps.perfWindow", PERF_WINDOWS, "24h");
  const [perfTop, setPerfTop] = useStoredChoice("pd.maps.perfTop", MAP_TOPS, "60");
  const [volMeasure, setVolMeasure] = useStoredChoice("pd.maps.volMeasure", VOL_MEASURES, "vol24h");
  const [volFilter, setVolFilter] = useStoredChoice("pd.maps.volFilter", VOL_FILTERS, "all");
  const [volRowCount, setVolRowCount] = useStoredChoice("pd.maps.volRows", VOL_ROW_COUNTS, "40");
  const [fundingUnit, setFundingUnit] = useStoredChoice("pd.maps.fundingUnit", FUNDING_UNITS, "8h");
  const [fundingSort, setFundingSort] = useStoredChoice(
    "pd.maps.fundingSort",
    FUNDING_SORTS,
    "volume",
  );
  const [oiWindow, setOiWindow] = useStoredChoice("pd.maps.oiWindow", OI_WINDOWS, "4h");
  const [lsSort, setLsSort] = useStoredChoice("pd.maps.lsSort", LONG_SHORT_SORTS, "long");
  const [corrWindow, setCorrWindow] = useStoredChoice("pd.maps.corrWindow", CORR_WINDOWS, "7d");
  const [corrSize, setCorrSize] = useStoredChoice("pd.maps.corrSize", CORR_SIZES, "20");
  const [spreadSort, setSpreadSort] = useStoredChoice("pd.maps.spreadSort", SPREAD_SORTS, "volume");
  const [bookSpan, setBookSpan] = useStoredChoice("pd.maps.bookSpan", BOOK_SPANS, "1");
  const [mapScope, setMapScope] = useStoredChoice("pd.maps.scope", MAP_SCOPES, "crypto");
  const [groupViews, setGroupViews] = useState(loadGroupViews);
  const group = groupOf(view);
  const openView = (next: View) => {
    setView(next);
    const saved = { ...groupViews, [groupOf(next)]: next };
    setGroupViews(saved);
    try {
      localStorage.setItem(GROUP_VIEW_KEY, JSON.stringify(saved));
    } catch {
      // Storage unavailable: the group opens on its first view next time.
    }
  };
  // A clock for the views that mark the hour now, ticking each minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // The status bar streams these anyway, so the page reads them on every view.
  const summaries = useMarketSummaries(venue, true);
  const summaryList =
    summaries.status === "live" || summaries.status === "closed" ? summaries.data : undefined;
  // Each market's column on the RSI heatmap, busiest first. Ranked once from
  // the first volumes to arrive and then kept (also across reloads), with
  // new listings joining at the end, so the chart never reshuffles.
  const [order, setOrder] = useState<string[] | undefined>(() => loadRsiOrder(venue));
  const orderVenue = useRef(venue);
  useEffect(() => {
    if (orderVenue.current === venue) return;
    orderVenue.current = venue;
    setOrder(loadRsiOrder(venue));
  }, [venue]);
  useEffect(() => {
    if (order || !summaryList || orderVenue.current !== venue) return;
    const ranked = [...summaryList]
      .sort((a, b) => Number(b.dayVolume) - Number(a.dayVolume))
      .map((s) => s.market);
    saveRsiOrder(venue, ranked);
    setOrder(ranked);
  }, [order, summaryList, venue]);
  const slots = useMemo(() => {
    if (!order) return [];
    const at = new Map(order.map((id, i) => [id, i]));
    return [...markets].sort(
      (a, b) =>
        (at.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (at.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    );
  }, [markets, order]);
  const quotes = useMemo(
    () =>
      new Map<string, RsiQuote>(
        (summaryList ?? []).map((s) => {
          const price = Number(s.markPrice);
          const prev = Number(s.prevDayPrice);
          return [
            s.market,
            { price, change24h: prev > 0 ? price / prev - 1 : 0, volume: Number(s.dayVolume) },
          ];
        }),
      ),
    [summaryList],
  );
  const slotIds = useMemo(() => slots.map((m) => m.id), [slots]);
  const rsi = useRsiMap(venue, slotIds, frame, view === "rsi");
  const byId = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);
  // The venue's own market for a coin on the heatmap: its crypto perp, the
  // USDT one first. Stocks and the like share tickers with unrelated coins.
  const byBase = useMemo(() => {
    const map = new Map<string, Market>();
    for (const m of markets) {
      if (m.category && m.category !== "innovation") continue;
      const had = map.get(m.base);
      if (!had || (m.quote === "USDT" && had.quote !== "USDT")) map.set(m.base, m);
    }
    return map;
  }, [markets]);
  const histories = useMarketHistories(venue, HISTORY_VIEWS.includes(view));
  const summaryById = useMemo(
    () => new Map((summaryList ?? []).map((s) => [s.market, s])),
    [summaryList],
  );
  const scoped = useMemo(
    () => (mapScope === "all" ? markets : markets.filter(isCrypto)),
    [markets, mapScope],
  );
  const historyProgress = {
    done: scoped.filter((m) => histories.has(m.id)).length,
    total: scoped.length,
  };
  const scopeSeg = (
    <MapSeg
      options={MAP_SCOPES}
      value={mapScope}
      onChange={setMapScope}
      label={t("mapx.scope")}
      text={(s) => t(`mapx.scope.${s}`)}
    />
  );
  const perfTiles = useMemo<PerfTile[]>(() => {
    if (view !== "perf") return [];
    return scoped.flatMap((m) => {
      const s = summaryById.get(m.id);
      if (!s) return [];
      const price = Number(s.markPrice);
      const prev = Number(s.prevDayPrice);
      const candles = histories.get(m.id)?.candles ?? [];
      const changes: PerfTile["changes"] = {};
      for (const w of PERF_WINDOWS) {
        changes[w] =
          changeSince(candles, PERF_HOURS[w], price) ??
          (w === "24h" && prev > 0 ? price / prev - 1 : undefined);
      }
      return [{ market: m, price, volume: Number(s.dayVolume), changes }];
    });
  }, [view, scoped, summaryById, histories]);
  const volRows = useMemo<VolRow[]>(() => {
    if (view !== "vol") return [];
    return scoped.flatMap((m) => {
      const candles = histories.get(m.id)?.candles;
      if (!candles) return [];
      const s = summaryById.get(m.id);
      const prev = Number(s?.prevDayPrice);
      return [
        {
          market: m,
          vol24h: realisedVol(candles, 24),
          vol7d: realisedVol(candles, 168),
          atr: atrShare(candles),
          change24h: s && prev > 0 ? Number(s.markPrice) / prev - 1 : undefined,
        },
      ];
    });
  }, [view, scoped, summaryById, histories]);

  const oiHistory = useOiHistory(venue, summaryList, view === "oi");
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again each minute, for the hour's new samples
  const oiSince = useMemo(
    () => (view === "oi" && !OI_HISTORY_VENUES.includes(venue) ? loadOi(venue) : undefined),
    [view, venue, now],
  );
  // The points over the window chosen; on a venue the app samples itself,
  // until the samples cover that window, the change over what's collected so
  // far instead (price from the samples too, so both cover the same span).
  const oiMap = useMemo<{ points: OiPoint[]; soFarMinutes?: number }>(() => {
    if (view !== "oi" || !summaryList) return { points: [] };
    const hours = OI_HOURS[oiWindow];
    const at = Date.now();
    const rows = [...summaryList]
      .map((s) => ({ s, value: Number(s.openInterest) * Number(s.markPrice) }))
      .filter(({ value }) => value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, OI_POINTS)
      .flatMap(({ s, value }) => {
        const market = byId.get(s.market);
        if (!market) return [];
        const stored = oiSince ? oiSince.markets[s.market] : oiHistory.get(s.market);
        const price = Number(s.markPrice);
        const samples = [...(stored ?? []), { time: at, oi: Number(s.openInterest), price }];
        const prev = Number(s.prevDayPrice);
        const priceChange =
          changeSince(histories.get(s.market)?.candles ?? [], hours, price) ??
          (hours === 24 && prev > 0 ? price / prev - 1 : undefined);
        return [
          {
            point: { market, priceChange, oiChange: oiChangeOver(samples, hours), oiValue: value },
            soFar: oiSince ? oiChangeSoFar(samples) : undefined,
          },
        ];
      });
    const covered = rows.filter((r) => r.point.oiChange !== undefined).length;
    if (!oiSince || covered >= rows.length / 2) return { points: rows.map((r) => r.point) };
    return {
      points: rows.map((r) => ({ ...r.point, priceChange: r.soFar?.price, oiChange: r.soFar?.oi })),
      soFarMinutes: Math.max(0, ...rows.map((r) => r.soFar?.minutes ?? 0)) || undefined,
    };
  }, [view, summaryList, oiWindow, byId, oiSince, oiHistory, histories]);

  const lsSource = longShortSource(venue);
  const longShort = useLongShort(view === "ls", lsSource);
  const lsRows = useMemo(
    () => longShort.rows.map((r) => ({ ...r, market: byBase.get(r.base) })),
    [longShort.rows, byBase],
  );

  const corr = useMemo(() => {
    if (view !== "corr") return { markets: [] as Market[], matrix: [] as (number | undefined)[][] };
    const hours = CORR_HOURS[corrWindow];
    const ranked = scoped
      .filter((m) => (histories.get(m.id)?.candles.length ?? 0) >= Math.min(hours, 48))
      .sort(
        (a, b) =>
          Number(summaryById.get(b.id)?.dayVolume ?? 0) -
          Number(summaryById.get(a.id)?.dayVolume ?? 0),
      )
      .slice(0, Number(corrSize));
    return {
      markets: ranked,
      matrix: correlationMatrix(
        ranked.map((m) => histories.get(m.id)?.candles ?? []),
        hours,
      ),
    };
  }, [view, scoped, histories, summaryById, corrWindow, corrSize]);

  const cross = useCrossVenue(view === "funding" || view === "spread");
  const crossByBase = useMemo(
    () => new Map<string, CoinRow>(cross.rows.map((r) => [r.base, r])),
    [cross.rows],
  );
  const mapVenues = VENUE_IDS.map((id) => ({ id, label: VENUES[id].label }));
  // A coin's logo: its market here, or on the first venue that lists it.
  const iconFor = (base: string): Market | undefined => {
    const own = byBase.get(base);
    if (own) return own;
    const row = crossByBase.get(base);
    const venueId = row && VENUE_IDS.find((v) => row.venues[v]);
    const quote = venueId && row?.venues[venueId];
    return quote ? ({ id: quote.market, venue: venueId, base, symbol: base } as Market) : undefined;
  };
  const tradeCoin = (base: string) => {
    const m = byBase.get(base);
    if (m) onTrade(m);
  };

  const season = useSeasonCandles(venue, heatMarket, view === "season" || view === "sessions");
  const seasonData = useMemo(() => {
    const candles = season.candles ?? [];
    const profile = hourProfile(candles);
    return { grid: seasonality(candles), profile, stats: sessionStats(profile) };
  }, [season.candles]);
  const book = useBookHeat(venue, heatMarket, Number(bookSpan) / 100, view === "book");
  const heatMarketInfo = heatMarket ? byId.get(heatMarket) : undefined;

  // Saved views: a view with its settings (and market), under a name.
  const choices: Record<string, ReturnType<typeof choice>> = {
    frame: choice(frame, setFrame, RSI_FRAMES),
    scope: choice(scope, setScope, RSI_SCOPES),
    rsiView: choice(rsiView, setRsiView, RSI_VIEWS),
    perfWindow: choice(perfWindow, setPerfWindow, PERF_WINDOWS),
    perfTop: choice(perfTop, setPerfTop, MAP_TOPS),
    mapScope: choice(mapScope, setMapScope, MAP_SCOPES),
    volMeasure: choice(volMeasure, setVolMeasure, VOL_MEASURES),
    volFilter: choice(volFilter, setVolFilter, VOL_FILTERS),
    volRows: choice(volRowCount, setVolRowCount, VOL_ROW_COUNTS),
    fundingUnit: choice(fundingUnit, setFundingUnit, FUNDING_UNITS),
    fundingSort: choice(fundingSort, setFundingSort, FUNDING_SORTS),
    oiWindow: choice(oiWindow, setOiWindow, OI_WINDOWS),
    lsSort: choice(lsSort, setLsSort, LONG_SHORT_SORTS),
    liqWindow: choice(liqWindow, setLiqWindow, LIQ_WINDOWS),
    span: choice(span, setSpan, SPANS),
    bookSpan: choice(bookSpan, setBookSpan, BOOK_SPANS),
    heatIndex: choice(heatIndex, setHeatIndex, HEAT_INDEXES),
    heatPeriod: choice(heatPeriod, setHeatPeriod, HEAT_PERIODS),
    heatTop: choice(heatTop, setHeatTop, HEAT_TOPS),
    corrWindow: choice(corrWindow, setCorrWindow, CORR_WINDOWS),
    corrSize: choice(corrSize, setCorrSize, CORR_SIZES),
    spreadSort: choice(spreadSort, setSpreadSort, SPREAD_SORTS),
  };
  const [saved, setSaved] = useState(loadSaved);
  const updateSaved = (next: SavedMapView[]) => {
    storeSaved(next);
    setSaved(next);
  };
  const aboutMarket = MARKET_VIEWS.includes(view);
  const saveView = (name: string) =>
    updateSaved(
      withSaved(saved, {
        id: crypto.randomUUID(),
        name,
        view,
        settings: Object.fromEntries(
          VIEW_SETTINGS[view].flatMap((k) => {
            const c = choices[k];
            return c ? [[k, c.value]] : [];
          }),
        ),
        market: aboutMarket ? heatMarket : undefined,
        venue: aboutMarket ? venue : undefined,
      }),
    );
  const applyView = (v: SavedMapView) => {
    const next = VIEWS.find((x) => x === v.view);
    if (!next) return;
    for (const [k, value] of Object.entries(v.settings)) choices[k]?.set(value);
    // A market id belongs to its venue; on another venue it's kept only if listed there.
    if (v.market && byId.has(v.market)) setHeatMarket(v.market);
    openView(next);
  };
  const viewLabel = (id: string) => {
    const known = VIEWS.find((x) => x === id);
    return known ? t(VIEW_LABEL[known]) : id;
  };
  const describeView = (v: SavedMapView) =>
    [viewLabel(v.view), v.market && (byId.get(v.market)?.symbol ?? v.market)]
      .filter(Boolean)
      .join(" · ");
  const suggestion = [t(VIEW_LABEL[view]), aboutMarket && heatMarketInfo?.symbol]
    .filter(Boolean)
    .join(" · ");
  const marketPicker = (
    <MarketSearch
      label={t("col.market")}
      markets={slots.length > 0 ? slots : markets}
      value={heatMarket}
      onChange={setHeatMarket}
    />
  );

  // OKX's liquidations join the venue's own market for the same coin where it
  // lists one, and are read busiest first (by the RSI heatmap's saved order).
  const rankOfId = useMemo(() => new Map((order ?? []).map((id, i) => [id, i])), [order]);
  const liqSource = liveLiquidationSource(venue);
  const liquidations = useLiquidations(
    view === "liquidations",
    (base) => byBase.get(base)?.id ?? base,
    (base) => rankOfId.get(byBase.get(base)?.id ?? "") ?? Number.MAX_SAFE_INTEGER,
    `${venue}:${markets.length}`,
    liqSource,
  );

  // The heatmap's history, fetched again every few minutes while it shows.
  // Tagged with what it's for, so a market or span just picked shows as
  // loading rather than the previous one's map.
  const [heat, setHeat] = useState<{
    key?: string;
    map?: LiqMap;
    /** Estimated from volume, for a venue with no open-interest history. */
    fromVolume?: boolean;
    loading: boolean;
    error?: string;
  }>({ loading: false });
  // The market's open interest now (base units), for that estimate; read
  // through a ref so a price tick doesn't refetch the history.
  const heatOi = useRef<number | undefined>(undefined);
  heatOi.current = Number(summaryList?.find((s) => s.market === heatMarket)?.openInterest);
  // Known or not: the volume estimate needs it, so the history is read
  // again once it arrives.
  const oiKnown = (heatOi.current ?? 0) > 0;
  const heatKey = `${venue}:${heatMarket}:${span}`;
  const heatNow = heat.key === heatKey ? heat : { loading: true };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `oiKnown` re-reads once the open interest the estimate needs has arrived
  useEffect(() => {
    if (view !== "liqmap" || !heatMarket) return;
    let live = true;
    const hours = Number(span);
    const key = `${venue}:${heatMarket}:${span}`;
    const load = async () => {
      setHeat((h) =>
        h.key === key ? { ...h, loading: true, error: undefined } : { key, loading: true },
      );
      try {
        const [candles, history] = await Promise.all([
          venueClient.candles(venue, heatMarket, "1h", Date.now() + 1, hours),
          // A venue without an open-interest history (Hyperliquid) is
          // estimated from volume and today's open interest instead.
          venueClient.openInterestHistory(venue, heatMarket, hours).catch(() => undefined),
        ]);
        const fromVolume = history === undefined;
        const openInterest = history ?? openInterestFromVolume(candles, heatOi.current ?? 0);
        if (live) {
          setHeat({
            key,
            map: liquidationMap(candles, openInterest),
            fromVolume,
            loading: false,
          });
        }
      } catch (err) {
        if (live)
          setHeat({
            key,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
      }
    };
    void load();
    const id = setInterval(load, HEATMAP_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [view, venue, heatMarket, span, oiKnown]);

  return (
    <div className="page maps">
      <header className="maps-head">
        <h1>{t("nav.maps")}</h1>
        <Tabs
          variant="sub"
          label={t("nav.maps")}
          tabs={GROUPS.map((g) => ({ id: g, label: t(`maps.group.${g}`) }))}
          active={group}
          onChange={(g) => openView(groupViews[g] ?? GROUP_VIEWS[g][0] ?? "rsi")}
        />
        <div className="maps-views" role="radiogroup" aria-label={t(`maps.group.${group}`)}>
          {GROUP_VIEWS[group].map((v) => (
            // biome-ignore lint/a11y/useSemanticElements: compact segmented control
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={v === view}
              className="maps-view"
              onClick={() => openView(v)}
            >
              {t(VIEW_LABEL[v])}
            </button>
          ))}
        </div>
        <SavedViews
          views={saved}
          describe={describeView}
          suggestion={suggestion}
          onApply={applyView}
          onSave={saveView}
          onRemove={(id) => updateSaved(withoutSaved(saved, id))}
        />
      </header>
      <section className="maps-body">
        {view === "perf" ? (
          <PerformanceMap
            tiles={perfTiles}
            window={perfWindow}
            onWindow={setPerfWindow}
            top={perfTop}
            onTop={setPerfTop}
            progress={historyProgress}
            loader={<LoadingMark size={44} />}
            extra={scopeSeg}
            onTrade={onTrade}
          />
        ) : view === "vol" ? (
          <VolatilityMap
            rows={volRows}
            measure={volMeasure}
            onMeasure={setVolMeasure}
            rowCount={volRowCount}
            onRowCount={setVolRowCount}
            filter={volFilter}
            onFilter={setVolFilter}
            progress={historyProgress}
            loader={<LoadingMark size={44} />}
            extra={scopeSeg}
            onTrade={onTrade}
          />
        ) : view === "funding" ? (
          <FundingMap
            rows={cross.rows}
            venues={mapVenues}
            unit={fundingUnit}
            onUnit={setFundingUnit}
            sort={fundingSort}
            onSort={setFundingSort}
            iconFor={iconFor}
            onTrade={tradeCoin}
            loading={cross.loading}
            loader={<LoadingMark size={44} />}
          />
        ) : view === "oi" ? (
          <OpenInterestMap
            points={oiMap.points}
            soFarMinutes={oiMap.soFarMinutes}
            window={oiWindow}
            onWindow={setOiWindow}
            history={OI_HISTORY_VENUES.includes(venue)}
            since={oiSince?.since}
            loader={<LoadingMark size={44} />}
            onTrade={onTrade}
          />
        ) : view === "ls" ? (
          <LongShortMap
            rows={lsRows}
            sort={lsSort}
            onSort={setLsSort}
            progress={{ done: longShort.done, total: longShort.total }}
            loader={<LoadingMark size={44} />}
            error={longShort.error}
            source={VENUES[lsSource].label}
            onTrade={(r) => r.market && onTrade(r.market)}
          />
        ) : view === "corr" ? (
          <CorrelationMap
            markets={corr.markets}
            matrix={corr.matrix}
            window={corrWindow}
            onWindow={setCorrWindow}
            size={corrSize}
            onSize={setCorrSize}
            progress={historyProgress}
            loader={<LoadingMark size={44} />}
            extra={scopeSeg}
            onTrade={onTrade}
          />
        ) : view === "spread" ? (
          <SpreadMap
            rows={cross.rows}
            venues={mapVenues}
            sort={spreadSort}
            onSort={setSpreadSort}
            iconFor={iconFor}
            onTrade={tradeCoin}
            loading={cross.loading}
            loader={<LoadingMark size={44} />}
          />
        ) : view === "book" ? (
          <BookHeatmap
            columns={book.columns}
            capacity={BOOK_COLUMNS}
            top={book.top}
            step={book.step}
            rows={BOOK_ROWS}
            decimals={heatMarketInfo ? decimalsOf(heatMarketInfo.tickSize) : 2}
            loader={<LoadingMark size={44} />}
            error={book.error}
            controls={
              <>
                {marketPicker}
                <MapSeg
                  options={BOOK_SPANS}
                  value={bookSpan}
                  onChange={setBookSpan}
                  label={t("mapx.book.span")}
                  text={(s) => `±${s}%`}
                />
              </>
            }
          />
        ) : view === "season" ? (
          <SeasonalityMap
            grid={seasonData.grid}
            profile={seasonData.profile}
            days={SEASON_DAYS}
            controls={marketPicker}
            loader={<LoadingMark size={44} />}
            error={season.error}
            now={now}
          />
        ) : view === "sessions" ? (
          <SessionsMap
            profile={seasonData.profile}
            stats={seasonData.stats}
            days={SEASON_DAYS}
            controls={marketPicker}
            loader={<LoadingMark size={44} />}
            error={season.error}
            now={now}
          />
        ) : view === "rsi" ? (
          <RsiHeatmap
            slots={slots}
            values={rsi.values}
            quotes={quotes}
            frame={frame}
            onFrame={setFrame}
            scope={scope}
            onScope={setScope}
            view={rsiView}
            onView={setRsiView}
            loading={rsi.loading}
            progress={{ done: rsi.done, total: rsi.total }}
            onRefresh={rsi.refresh}
            onTrade={onTrade}
          />
        ) : view === "heatmap" ? (
          <MarketHeatmap
            groups={sectors.groups}
            index={heatIndex}
            onIndex={setHeatIndex}
            colourBy={heatPeriod}
            onColourBy={setHeatPeriod}
            top={heatTop}
            onTop={setHeatTop}
            excluded={excluded}
            onExcluded={(next) => {
              saveExcluded(next);
              setExcluded(next);
            }}
            progress={{ done: sectors.done, total: sectors.total }}
            loader={<LoadingMark size={44} />}
            error={sectors.error}
            marketFor={(symbol) => byBase.get(symbol)}
            onTrade={onTrade}
          />
        ) : view === "liquidations" ? (
          <Liquidations
            events={liquidations.events}
            backfill={liquidations.okx.loading ? liquidations.okx : undefined}
            loader={<LoadingMark size={48} />}
            markets={byId}
            window={liqWindow}
            onWindow={setLiqWindow}
            onTrade={onTrade}
            error={liquidations.error}
          />
        ) : (
          <LiqHeatmap
            map={heatNow.map}
            loading={heatNow.loading}
            error={heatNow.error}
            loader={<LoadingMark size={48} />}
            note={t(heat.fromVolume ? "liqmap.noteVolume" : "liqmap.note")}
            controls={
              <>
                <h2 className="maps-liqmap-title">
                  {t("liqmap.title", {
                    venue: venueLabel,
                    market: (heatMarket && byId.get(heatMarket)?.symbol) ?? "",
                  })}
                </h2>
                {marketPicker}
                <div className="pd-map-seg" role="radiogroup" aria-label={t("liqmap.span")}>
                  {SPANS.map((s) => (
                    // biome-ignore lint/a11y/useSemanticElements: compact segmented control
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={s === span}
                      data-checked={s === span || undefined}
                      onClick={() => setSpan(s)}
                    >
                      {s === "48" ? "48H" : "7D"}
                    </button>
                  ))}
                </div>
              </>
            }
          />
        )}
        <MapHelp
          view={view}
          title={t(VIEW_LABEL[view])}
          vars={{
            venue: VENUES[view === "ls" ? lsSource : liqSource].label,
          }}
        />
      </section>
    </div>
  );
}
