import type { Market, VenueId } from "@pewterdesk/core";
import {
  HEAT_INDEXES,
  HEAT_PERIODS,
  HEAT_TOPS,
  LIQ_WINDOWS,
  LiqHeatmap,
  type LiqMap,
  Liquidations,
  liquidationMap,
  MarketHeatmap,
  MarketSearch,
  openInterestFromVolume,
  RSI_FRAMES,
  RSI_SCOPES,
  RSI_VIEWS,
  RsiHeatmap,
  type RsiQuote,
  Tabs,
  t,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { venueClient } from "../../api/venueClient";
import { useCoinSectors } from "../../hooks/useCoinSectors";
import { useLiquidations } from "../../hooks/useLiquidations";
import { useRsiMap } from "../../hooks/useRsiMap";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import { useMarketSummaries } from "../../hooks/useVenueFeeds";
import { loadRsiOrder, saveRsiOrder } from "../../lib/rsiStore";
import { LoadingMark } from "../Splash";

const VIEWS = ["rsi", "heatmap", "liquidations", "liqmap"] as const;
type View = (typeof VIEWS)[number];
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
  const [heatIndex, setHeatIndex] = useStoredChoice("pd.maps.heatIndex", HEAT_INDEXES, "marketCap");
  const [heatPeriod, setHeatPeriod] = useStoredChoice("pd.maps.heatPeriod", HEAT_PERIODS, "24h");
  const [heatTop, setHeatTop] = useStoredChoice("pd.maps.heatTop", HEAT_TOPS, "20");
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(loadExcluded);
  const sectors = useCoinSectors(view === "heatmap");
  const [liqWindow, setLiqWindow] = useStoredChoice("pd.maps.liqWindow", LIQ_WINDOWS, "4h");
  const [span, setSpan] = useStoredChoice<Span>("pd.maps.liqSpan", SPANS, "48");
  const [heatMarket, setHeatMarket] = useState(selected);
  useEffect(() => setHeatMarket((m) => m ?? selected), [selected]);

  const summaries = useMarketSummaries(venue, view === "rsi" || view === "liqmap");
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
  // OKX's liquidations join the venue's own market for the same coin where it
  // lists one, and are read busiest first (by the RSI heatmap's saved order).
  const rankOfId = useMemo(() => new Map((order ?? []).map((id, i) => [id, i])), [order]);
  const liquidations = useLiquidations(
    view === "liquidations",
    (base) => byBase.get(base)?.id ?? base,
    (base) => rankOfId.get(byBase.get(base)?.id ?? "") ?? Number.MAX_SAFE_INTEGER,
    `${venue}:${markets.length}`,
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
          tabs={[
            { id: "rsi", label: t("maps.rsi") },
            { id: "heatmap", label: t("maps.heatmap") },
            { id: "liquidations", label: t("maps.liquidations") },
            { id: "liqmap", label: t("maps.liqHeatmap") },
          ]}
          active={view}
          onChange={setView}
        />
      </header>
      <section className="maps-body">
        {view === "rsi" ? (
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
                <MarketSearch
                  label={t("col.market")}
                  markets={slots.length > 0 ? slots : markets}
                  value={heatMarket}
                  onChange={setHeatMarket}
                />
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
      </section>
    </div>
  );
}
