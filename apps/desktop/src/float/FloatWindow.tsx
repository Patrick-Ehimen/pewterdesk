import type { Candle, Market, OrderRequest, Position, VenueId } from "@pewterdesk/core";
import {
  decimalsOf,
  formatNumber,
  formatSigned,
  orderText,
  Sparkline,
  sizeFromPercent,
  t,
  ticketOrder,
  trendClass,
} from "@pewterdesk/ui";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  LuChevronDown,
  LuEye,
  LuEyeOff,
  LuGripVertical,
  LuMaximize2,
  LuMinus,
  LuRows3,
  LuSquareArrowOutUpRight,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import { appClient } from "../api/appClient";
import { venueClient } from "../api/venueClient";
import { useStoredChoice } from "../hooks/useStoredChoice";
import { useTradeSettings } from "../hooks/useTradeSettings";
import { useAccount, useMarketSummaries, useMarkets } from "../hooks/useVenueFeeds";
import { parseWatchlist } from "../hooks/useWatchlist";
import { accountsState, activeAccount, canTrade, subscribeAccounts } from "../lib/account";
import {
  closeRequest,
  HOLD_MS,
  liquidationDistance,
  positionKey,
  riskiest,
  SNOOZE_MS,
  slippageBps,
} from "../lib/float";
import { loadMarket } from "../lib/selectedMarket";
import { loadVenue, VENUES } from "../lib/venues";

/** The widget's sizes: everything, one line, or a strip of tickers. */
const MODES = ["full", "pill", "strip"] as const;
type Mode = (typeof MODES)[number];
const ON_OFF = ["on", "off"] as const;
/** Presets for the size: this much of what's available, at the leverage in use. */
const PRESETS = [10, 25, 50, 100];
/** Markets offered while searching. */
const PICKS = 8;
/** Tickers in the strip. */
const STRIP = 3;
/** The price line: the last 24 hours in 15-minute closes. */
const SPARK_CANDLES = 96;
/** How long an order's outcome stays in the widget. */
const RESULT_MS = 5000;
/** A drag has ended once the window has been still this long. */
const SETTLE_MS = 350;
const POSITION_KEY = "pd.float.position";

/**
 * A button that acts only after being held for `HOLD_MS`, filling as it
 * goes; letting go early cancels. So a stray click on a window that floats
 * over everything can't place an order.
 */
function HoldButton({
  className,
  disabled,
  label,
  onDone,
  children,
}: {
  className: string;
  disabled?: boolean;
  /** For screen readers, and the tooltip. */
  label: string;
  onDone: () => void;
  children: ReactNode;
}) {
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;
  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    setProgress(0);
  }, []);
  useEffect(() => stop, [stop]);
  const start = () => {
    if (disabled) return;
    const began = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - began) / HOLD_MS);
      setProgress(p);
      if (p < 1) {
        frame.current = requestAnimationFrame(tick);
      } else {
        setProgress(0);
        done.current();
      }
    };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(tick);
  };
  return (
    <button
      type="button"
      className={`float-hold ${className}`}
      aria-disabled={disabled || undefined}
      aria-label={label}
      title={disabled ? undefined : t("float.holdHint")}
      data-holding={progress > 0 || undefined}
      style={{ ["--hold" as string]: progress }}
      onPointerDown={(e) => e.button === 0 && start()}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !e.repeat && start()}
      onKeyUp={stop}
      onBlur={stop}
    >
      {children}
    </button>
  );
}

/** The venue the main window is on; the widget follows it. */
function useVenue(): VenueId {
  const [venue, setVenue] = useState(loadVenue);
  useEffect(() => {
    const on = () => setVenue(loadVenue());
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  return venue;
}

/** The last 24 hours of `market`, for the price line. */
function useCloses(venue: VenueId, market: string | undefined): number[] {
  const [closes, setCloses] = useState<{ key: string; values: number[] }>();
  const key = market ? `${venue}:${market}` : undefined;
  useEffect(() => {
    if (!key || !market) return;
    let live = true;
    venueClient.candles(venue, market, "15m", Date.now(), SPARK_CANDLES).then(
      (candles: Candle[]) =>
        live && setCloses({ key, values: candles.map((c) => Number(c.close)) }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key, venue, market]);
  return closes && closes.key === key ? closes.values : [];
}

/**
 * The floating window, after the design: a small widget that stays over
 * other apps. Full, it's a market's price, a ticket whose buttons must be
 * held, the open positions with a close on each, and "Flatten all". It
 * folds to a one-line pill or a ticker strip, and a position near its
 * liquidation price takes it over with an alert.
 *
 * It calls the same Rust commands as the main window and nothing more: no
 * key reaches it, and where the main window can't trade, neither can it.
 */
export function FloatWindow() {
  const rootRef = useRef<HTMLElement>(null);
  const venue = useVenue();
  const info = VENUES[venue];
  const accounts = useSyncExternalStore(subscribeAccounts, accountsState);
  const active = activeAccount(accounts, venue);
  const trading = canTrade(active) ? active : undefined;
  const account = useAccount(venue, active?.id);
  const snapshot =
    account.status === "live" || account.status === "closed" ? account.data : undefined;
  const positions = snapshot?.positions ?? [];
  const orders = snapshot?.openOrders ?? [];

  const marketsFeed = useMarkets(venue);
  const markets = marketsFeed.status === "live" ? marketsFeed.data : undefined;
  const summariesFeed = useMarketSummaries(venue, true);
  const summaries =
    summariesFeed.status === "live" || summariesFeed.status === "closed"
      ? summariesFeed.data
      : undefined;
  const summaryOf = useCallback(
    (id: string) => summaries?.find((s) => s.market === id),
    [summaries],
  );
  const marketOf = useCallback((id: string) => markets?.find((m) => m.id === id), [markets]);

  const [mode, setMode] = useStoredChoice<Mode>("pd.float.mode", MODES, "full");
  const [shared, setShared] = useStoredChoice("pd.float.shared", ON_OFF, "off");
  useEffect(() => {
    void appClient.setFloatProtected(shared === "off");
  }, [shared]);

  // The market: the main window's to begin with, then whatever is picked here.
  const [picked, setPicked] = useState<{ venue: VenueId; id: string }>();
  const marketId =
    (picked?.venue === venue ? picked.id : undefined) ?? loadMarket(venue) ?? info.defaultMarket;
  const market = marketOf(marketId);
  const summary = summaryOf(marketId);
  const mark = summary ? Number(summary.markPrice) : undefined;
  const dayChange =
    summary && Number(summary.prevDayPrice) > 0
      ? {
          abs: Number(summary.markPrice) - Number(summary.prevDayPrice),
          pct: (Number(summary.markPrice) / Number(summary.prevDayPrice) - 1) * 100,
        }
      : undefined;
  const closes = useCloses(venue, market?.id);
  const position = positions.find((p) => p.market === marketId);
  const { settings, setLeverage } = useTradeSettings(venue, active?.id, market?.id, trading);
  const leverage = settings ? Number(settings.leverage) : Number(position?.leverage) || 10;
  const maxLeverage = Math.max(
    1,
    Math.floor(Number(settings?.maxLeverage ?? market?.maxLeverage ?? leverage)),
  );
  // The leverage editor, opened from the chip beside the size.
  const [levOpen, setLevOpen] = useState(false);
  const [levText, setLevText] = useState("");
  const [levError, setLevError] = useState<string>();

  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState("");
  const picks = useMemo(() => {
    if (!markets) return [];
    const q = search.trim().toLowerCase();
    const held = new Set(positions.map((p) => p.market));
    return markets
      .filter((m) => !q || m.symbol.toLowerCase().includes(q) || m.base.toLowerCase().includes(q))
      .sort((a, b) => Number(held.has(b.id)) - Number(held.has(a.id)))
      .slice(0, PICKS);
  }, [markets, search, positions]);

  // The ticket.
  const [type, setType] = useState<"market" | "limit" | "half">("market");
  const [size, setSize] = useState("");
  const [limit, setLimit] = useState("");
  const kind = type === "half" && !position ? "market" : type;
  const price = kind === "limit" && Number(limit) > 0 ? Number(limit) : mark;
  const value = Number(size) > 0 && price ? Number(size) * price : undefined;
  const available = snapshot ? Number(snapshot.availableMargin) : 0;
  const bps = slippageBps(info.maxSlippage);
  // A new market starts a fresh ticket.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on the market only
  useEffect(() => {
    setSize("");
    setLimit("");
    setLevOpen(false);
  }, [marketId]);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; title: string; body?: string }>();
  useEffect(() => {
    if (!result) return;
    const id = setTimeout(() => setResult(undefined), RESULT_MS);
    return () => clearTimeout(id);
  }, [result]);

  /** Sends orders one after another; says how the last one went. */
  const send = async (requests: OrderRequest[], title: string) => {
    if (!trading || busy || requests.length === 0) return;
    setBusy(true);
    setResult(undefined);
    let last = "";
    try {
      for (const request of requests) {
        last = orderText(request, marketOf(request.market)?.base ?? "");
        await venueClient.placeOrder(trading.venue, trading.id, request);
      }
      setResult({ ok: true, title, body: requests.length === 1 ? last : undefined });
      setSize("");
    } catch (err) {
      const why = err instanceof Error ? err.message : t("ticket.failed");
      setResult({ ok: false, title: t("toast.orderRejected"), body: `${last} · ${why}` });
    } finally {
      setBusy(false);
    }
  };

  const saveLeverage = async () => {
    const next = Number(levText);
    if (!Number.isInteger(next) || next < 1 || next > maxLeverage) {
      setLevError(t("ticket.leverageRange", { max: maxLeverage }));
      return;
    }
    if (!setLeverage || busy) return;
    if (next === leverage) return setLevOpen(false);
    setBusy(true);
    setLevError(undefined);
    try {
      await setLeverage(next);
      setLevOpen(false);
      setResult({
        ok: true,
        title: t("toast.leverageSet"),
        body: t("toast.leverageBody", { symbol: market?.symbol ?? marketId, leverage: next }),
      });
    } catch (err) {
      // The venue's reason stays beside the box, to fix and try again.
      setLevError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const order = (side: "buy" | "sell") => {
    if (!market) return;
    const built = ticketOrder({
      market,
      type: kind === "limit" ? "limit" : "market",
      side,
      sizeBase: Number(size) || 0,
      limitPrice: limit,
      trigger: "",
      reduceOnly: false,
      tpsl: false,
      maxSlippage: info.maxSlippage,
    });
    if (!("request" in built)) {
      setResult({
        ok: false,
        title: t(built.blocked === "price" ? "ticket.needPrice" : "ticket.needSize"),
      });
      return;
    }
    void send([built.request], t("toast.orderPlaced"));
  };
  const close = (p: Position, fraction: number) =>
    void send([closeRequest(p, marketOf(p.market), fraction, bps)], t("toast.orderPlaced"));
  const flatten = () =>
    void send(
      positions.map((p) => closeRequest(p, marketOf(p.market), 1, bps)),
      t("float.flattened"),
    );
  const cancelAll = async () => {
    if (!trading || busy) return;
    setBusy(true);
    try {
      for (const o of orders) {
        await venueClient.cancelOrder(trading.venue, trading.id, o.market, o.id);
      }
      setResult({ ok: true, title: t("float.cancelled", { count: orders.length }) });
    } catch (err) {
      setResult({
        ok: false,
        title: t("toast.cancelFailed"),
        body: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  // A position near its liquidation price takes the widget over, and brings
  // it up if it was hidden.
  const [snoozed, setSnoozed] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const risk = riskiest(positions, snoozed, now);
  const riskKey = risk ? positionKey(risk.position) : undefined;
  useEffect(() => {
    if (riskKey) void appClient.showFloat();
  }, [riskKey]);

  // Shift+B and Shift+S buy and sell at once, while the widget has the keys.
  const hotkey = useRef<(side: "buy" | "sell") => void>(() => {});
  hotkey.current = order;
  const armed = mode === "full" && !risk && trading !== undefined && kind !== "half";
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      // Not while typing a market's name.
      if ((e.target as HTMLElement | null)?.dataset?.text !== undefined) return;
      const side = e.code === "KeyB" ? "buy" : e.code === "KeyS" ? "sell" : undefined;
      if (!side) return;
      e.preventDefault();
      hotkey.current(side);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  // The window is as big as the widget: follow its size.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const fitWindow = () => void appClient.resizeFloat(el.offsetWidth, el.offsetHeight);
    fitWindow();
    const observer = new ResizeObserver(fitWindow);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Back where it was left; then, after each drag, snapped and remembered.
  useEffect(() => {
    if (!isTauri()) return;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
      if (Array.isArray(saved) && saved.every((n) => Number.isInteger(n)) && saved.length === 2) {
        void appClient.placeFloat(saved[0] as number, saved[1] as number);
      }
    } catch {
      // Nothing saved, or unreadable: it opens in the corner.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = getCurrentWindow().onMoved(() => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const at = await appClient.snapFloat();
        if (!at) return;
        try {
          localStorage.setItem(POSITION_KEY, JSON.stringify(at));
        } catch {
          // Storage full or off: it's remembered for this session only.
        }
      }, SETTLE_MS);
    });
    return () => {
      clearTimeout(timer);
      void unlisten.then((stop) => stop());
    };
  }, []);

  const base = market?.base ?? "";
  const quote = market?.quote ?? "";
  const priceText = (v: number | undefined, id = marketId) => {
    const s = summaryOf(id);
    return v === undefined ? "-" : formatNumber(v, s ? decimalsOf(s.markPrice) : 2);
  };
  const upnl = positions.reduce((sum, p) => sum + Number(p.unrealizedPnl), 0);
  const why = !active
    ? t("float.connect")
    : !trading
      ? venue === "bybit"
        ? t("ticket.demoOnly")
        : t("quick.unavailable")
      : undefined;
  const sizeLabel =
    Number(size) > 0
      ? `${formatNumber(Number(size), decimalsOf(market?.sizeStep ?? "0"))} ${base}`
      : base;

  const grip = (
    <span className="float-grip" data-tauri-drag-region aria-hidden>
      <LuGripVertical size={14} />
    </span>
  );
  const iconButton = (label: string, onClick: () => void, icon: ReactNode, pressed?: boolean) => (
    <button
      type="button"
      className="float-icon"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  if (risk && mode !== "strip") {
    const p = risk.position;
    const symbol = marketOf(p.market)?.symbol ?? p.market;
    return (
      <main ref={rootRef} className="float float-alert" data-tauri-drag-region>
        <h1 className="float-alert-title" data-tauri-drag-region>
          <LuTriangleAlert size={16} aria-hidden />
          {t("float.riskTitle", {
            symbol,
            side: t(p.side === "long" ? "side.long" : "side.short").toLowerCase(),
            pct: formatNumber(risk.distance * 100, 1),
          })}
        </h1>
        <p className="float-muted" data-tauri-drag-region>
          {t("float.riskBody", {
            mark: priceText(Number(p.markPrice), p.market),
            liq: priceText(Number(p.liquidationPrice), p.market),
          })}
        </p>
        {result && (
          <p className="float-result" data-ok={result.ok || undefined} role="status">
            {result.title}
          </p>
        )}
        <div className="float-alert-actions">
          {trading && (
            <HoldButton
              className="float-button"
              disabled={busy}
              label={t("float.closeHalf")}
              onDone={() => close(p, 0.5)}
            >
              {t("float.closeHalf")}
            </HoldButton>
          )}
          <button
            type="button"
            className="float-link"
            onClick={() => setSnoozed((s) => ({ ...s, [positionKey(p)]: Date.now() + SNOOZE_MS }))}
          >
            {t("float.snooze")}
          </button>
        </div>
      </main>
    );
  }

  if (mode === "pill") {
    return (
      <main ref={rootRef} className="float float-pill" data-tauri-drag-region>
        <span
          className="float-dot"
          data-trend={dayChange && dayChange.abs < 0 ? "down" : "up"}
          aria-hidden
        />
        <strong data-tauri-drag-region>{base || marketId}</strong>
        <span
          className={`float-num ${dayChange ? trendClass(dayChange.abs) : ""}`}
          data-tauri-drag-region
        >
          {priceText(mark)}
        </span>
        <span className="float-sep" aria-hidden />
        <span className="float-muted" data-tauri-drag-region>
          {t("float.upnl")}
        </span>
        <span className={`float-num ${trendClass(upnl)}`} data-tauri-drag-region>
          {formatSigned(upnl)}
        </span>
        <span className="float-sep" aria-hidden />
        <span className="float-muted" data-tauri-drag-region>
          {t("float.pos", { count: positions.length })}
        </span>
        {iconButton(t("float.strip"), () => setMode("strip"), <LuRows3 size={14} aria-hidden />)}
        {iconButton(
          t("float.expand"),
          () => setMode("full"),
          <LuMaximize2 size={14} aria-hidden />,
        )}
      </main>
    );
  }

  if (mode === "strip") {
    const watched = (() => {
      try {
        return parseWatchlist(localStorage.getItem("pd.watchlist"))
          .filter((k) => k.startsWith(`${venue}:`))
          .map((k) => k.slice(venue.length + 1));
      } catch {
        return [];
      }
    })();
    const ids = [...new Set([marketId, ...watched, ...positions.map((p) => p.market)])].slice(
      0,
      STRIP,
    );
    return (
      <main ref={rootRef} className="float float-pill float-strip" data-tauri-drag-region>
        {ids.map((id) => {
          const s = summaryOf(id);
          const change =
            s && Number(s.prevDayPrice) > 0
              ? (Number(s.markPrice) / Number(s.prevDayPrice) - 1) * 100
              : undefined;
          return (
            <span key={id} className="float-tick" data-tauri-drag-region>
              <strong data-tauri-drag-region>{marketOf(id)?.base ?? id}</strong>
              <span className="float-num" data-tauri-drag-region>
                {priceText(s ? Number(s.markPrice) : undefined, id)}
              </span>
              {change !== undefined && (
                <span className={`float-num ${trendClass(change)}`} data-tauri-drag-region>
                  {formatSigned(change)}%
                </span>
              )}
            </span>
          );
        })}
        {iconButton(t("float.collapse"), () => setMode("pill"), <LuMinus size={14} aria-hidden />)}
        {iconButton(
          t("float.expand"),
          () => setMode("full"),
          <LuMaximize2 size={14} aria-hidden />,
        )}
      </main>
    );
  }

  return (
    <main ref={rootRef} className="float float-full">
      <header className="float-head" data-tauri-drag-region>
        {grip}
        <button
          type="button"
          className="float-market"
          aria-expanded={picking}
          onClick={() => {
            setPicking((p) => !p);
            setSearch("");
          }}
        >
          {market?.symbol ?? marketId}
          <LuChevronDown size={13} aria-hidden />
        </button>
        <span className="float-head-fill" data-tauri-drag-region />
        {iconButton(
          t(shared === "off" ? "float.shareHidden" : "float.shareShown"),
          () => setShared(shared === "off" ? "on" : "off"),
          shared === "off" ? <LuEyeOff size={14} aria-hidden /> : <LuEye size={14} aria-hidden />,
          shared === "off",
        )}
        {iconButton(
          t("tray.open"),
          () => void appClient.openMainFromTray(),
          <LuSquareArrowOutUpRight size={14} aria-hidden />,
        )}
        {iconButton(t("float.collapse"), () => setMode("pill"), <LuMinus size={14} aria-hidden />)}
        {iconButton(
          t("float.hide"),
          () => void appClient.hideFloat(),
          <LuX size={14} aria-hidden />,
        )}
      </header>

      {picking && (
        <div className="float-picker">
          <input
            // biome-ignore lint/a11y/noAutofocus: opened to type a market's name
            autoFocus
            data-text
            value={search}
            placeholder={t("float.search")}
            aria-label={t("float.search")}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setPicking(false)}
          />
          {picks.length === 0 ? (
            <p className="float-muted">{t("float.noMatch")}</p>
          ) : (
            picks.map((m: Market) => (
              <button
                key={m.id}
                type="button"
                className="float-pick"
                onClick={() => {
                  setPicked({ venue, id: m.id });
                  setPicking(false);
                }}
              >
                <strong>{m.symbol}</strong>
                <span className="float-num">
                  {priceText(Number(summaryOf(m.id)?.markPrice) || undefined, m.id)}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      <section className="float-price">
        <div>
          <strong className={`float-last ${dayChange ? trendClass(dayChange.abs) : ""}`}>
            {priceText(mark)}
          </strong>
          {dayChange && (
            <span className="float-muted float-num">
              {formatSigned(dayChange.abs, summary ? decimalsOf(summary.markPrice) : 2)} ·{" "}
              {formatSigned(dayChange.pct)}% · 24h
            </span>
          )}
        </div>
        <Sparkline values={closes} width={150} height={36} />
      </section>

      <section className="float-ticket">
        <div className="float-types" role="radiogroup" aria-label={t("ticket.orderType")}>
          {(["market", "limit", "half"] as const).map((k) => (
            // biome-ignore lint/a11y/useSemanticElements: segmented control, like the app's others
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              disabled={k === "half" && !position}
              onClick={() => {
                setType(k);
                if (k === "limit" && !limit && mark && market) {
                  setLimit(mark.toFixed(decimalsOf(market.tickSize)));
                }
              }}
            >
              {t(
                k === "market"
                  ? "ticket.market"
                  : k === "limit"
                    ? "ticket.limit"
                    : "float.closeHalf",
              )}
            </button>
          ))}
        </div>

        {kind === "half" && position ? (
          <HoldButton
            className="float-side"
            disabled={!trading || busy}
            label={t("float.closeHalf")}
            onDone={() => close(position, 0.5)}
          >
            <strong>
              {t("float.closeHalf")} · {market?.symbol ?? marketId}
            </strong>
            <span>{t("float.hold")}</span>
          </HoldButton>
        ) : (
          <>
            {kind === "limit" && (
              <label className="float-field">
                <span className="float-muted">{t("ticket.price")}</span>
                <input
                  inputMode="decimal"
                  value={limit}
                  onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setLimit(e.target.value)}
                />
              </label>
            )}
            <div className="float-size">
              <label className="float-field">
                <input
                  inputMode="decimal"
                  value={size}
                  placeholder={t("ticket.size")}
                  aria-label={t("quick.qtyLabel", { base })}
                  onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setSize(e.target.value)}
                />
                <span className="float-muted float-num">
                  {base}
                  {value !== undefined && ` · ≈ ${formatNumber(value, 2)}`}
                </span>
              </label>
              <button
                type="button"
                className="float-lev float-num"
                aria-expanded={levOpen}
                disabled={!setLeverage}
                title={setLeverage ? t("ticket.changeLeverage") : why}
                onClick={() => {
                  setLevText(String(Math.round(leverage)));
                  setLevError(undefined);
                  setLevOpen((open) => !open);
                }}
              >
                {formatNumber(leverage, Number.isInteger(leverage) ? 0 : 2)}x
              </button>
            </div>
            {levOpen && (
              <div className="float-leverage">
                <div className="float-size">
                  <label className="float-field">
                    <span className="float-muted">{t("ticket.leverage")}</span>
                    <input
                      // biome-ignore lint/a11y/noAutofocus: opened to type a leverage
                      autoFocus
                      inputMode="numeric"
                      value={levText}
                      aria-label={t("ticket.leverage")}
                      onChange={(e) => setLevText(e.target.value.replace(/[^0-9]/g, ""))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveLeverage();
                        if (e.key === "Escape") setLevOpen(false);
                      }}
                    />
                    <span className="float-muted float-num">x</span>
                  </label>
                  <button
                    type="button"
                    className="float-button float-confirm"
                    disabled={busy}
                    onClick={() => void saveLeverage()}
                  >
                    {t("protect.confirm")}
                  </button>
                </div>
                <div className="float-presets float-leverage-presets">
                  {[...new Set([1, 5, 10, 25, maxLeverage].filter((v) => v <= maxLeverage))].map(
                    (v) => (
                      <button key={v} type="button" onClick={() => setLevText(String(v))}>
                        {v}x
                      </button>
                    ),
                  )}
                </div>
                {levError && <p className="float-muted float-warn">{levError}</p>}
              </div>
            )}
            <div className="float-presets">
              {PRESETS.map((pct) => (
                <button
                  key={pct}
                  type="button"
                  disabled={!snapshot || !price || !market}
                  onClick={() => {
                    if (!price || !market) return;
                    const step = Number(market.sizeStep);
                    const raw = sizeFromPercent(pct, available, leverage, price);
                    const sized = step > 0 ? Math.floor(raw / step) * step : raw;
                    setSize(sized > 0 ? sized.toFixed(decimalsOf(market.sizeStep)) : "");
                  }}
                >
                  {pct}%
                </button>
              ))}
            </div>
            <div className="float-sides">
              <HoldButton
                className="float-side"
                disabled={!trading || busy}
                label={t("float.buy", { size: sizeLabel })}
                onDone={() => order("buy")}
              >
                <strong data-side="buy">{t("float.buy", { size: sizeLabel })}</strong>
                <span>{t("float.hold")} ⇧B</span>
              </HoldButton>
              <HoldButton
                className="float-side"
                disabled={!trading || busy}
                label={t("float.sell", { size: sizeLabel })}
                onDone={() => order("sell")}
              >
                <strong data-side="sell">{t("float.sell", { size: sizeLabel })}</strong>
                <span>{t("float.hold")} ⇧S</span>
              </HoldButton>
            </div>
          </>
        )}
        {why && <p className="float-muted float-why">{why}</p>}
        {result && (
          <p className="float-result" data-ok={result.ok || undefined} role="status">
            <strong>{result.title}</strong>
            {result.body && <span>{result.body}</span>}
          </p>
        )}
      </section>

      <section className="float-positions">
        <h2 className="float-label">
          <span>{t("float.positions", { count: positions.length })}</span>
          {positions.length > 0 && (
            <span className={`float-num ${trendClass(upnl)}`}>
              {formatSigned(upnl)} {quote}
            </span>
          )}
        </h2>
        {positions.length === 0 ? (
          <p className="float-muted float-none">
            {t(active ? "positions.empty" : "float.connect")}
          </p>
        ) : (
          positions.map((p) => {
            const pnl = Number(p.unrealizedPnl);
            const near = liquidationDistance(p);
            return (
              <div key={positionKey(p)} className="float-position">
                <button
                  type="button"
                  className="float-position-main"
                  onClick={() => setPicked({ venue, id: p.market })}
                >
                  <strong>{marketOf(p.market)?.base ?? p.market}</strong>
                  <span className={p.side === "long" ? "pd-up" : "pd-down"}>
                    {t(p.side === "long" ? "side.long" : "side.short")}
                  </span>
                  <span className="float-muted float-num">{formatNumber(p.size)}</span>
                  {near !== undefined && near <= 0.2 && (
                    <span className="float-near float-num">{formatNumber(near * 100, 1)}%</span>
                  )}
                  <span className={`float-num float-pnl ${trendClass(pnl)}`}>
                    {formatSigned(pnl)}
                  </span>
                </button>
                {trading && (
                  <HoldButton
                    className="float-icon"
                    disabled={busy}
                    label={t("float.closePosition", {
                      symbol: marketOf(p.market)?.symbol ?? p.market,
                    })}
                    onDone={() => close(p, 1)}
                  >
                    <LuX size={14} aria-hidden />
                  </HoldButton>
                )}
              </div>
            );
          })
        )}
      </section>

      <footer className="float-foot">
        {trading && positions.length > 0 && (
          <HoldButton
            className="float-button"
            disabled={busy}
            label={t("float.flatten")}
            onDone={flatten}
          >
            <span data-danger>{t("float.flatten")}</span>
          </HoldButton>
        )}
        {trading && orders.length > 0 && (
          <HoldButton
            className="float-button"
            disabled={busy}
            label={t("float.cancelOrders", { count: orders.length })}
            onDone={() => void cancelAll()}
          >
            {t("float.cancelOrders", { count: orders.length })}
          </HoldButton>
        )}
        <span className="float-keys">
          <kbd>⌃⌥Space</kbd> {t("float.toggle")}
        </span>
      </footer>
    </main>
  );
}
