import type {
  Market,
  MarketSummary,
  Order,
  OrderRequest,
  Position,
  PositionProtection,
  VenueId,
} from "@pewterdesk/core";
import {
  CommandPalette,
  closeOrder,
  currentLocale,
  formatNumber,
  formatSigned,
  type MessageKey,
  type PaletteItem,
  type PalettePreview,
  type PaletteSection,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import {
  LuArrowRight,
  LuBell,
  LuClock,
  LuLayoutGrid,
  LuPalette,
  LuPanelTop,
  LuPictureInPicture2,
  LuShield,
  LuStore,
  LuX,
} from "react-icons/lu";
import {
  type Intent,
  loadRecent,
  orderFor,
  parseCommand,
  protectionFor,
  saveRecent,
  scaledOrders,
  searchMarkets,
  withRecent,
} from "../lib/commands";
import { closeRequest } from "../lib/float";
import { PAGES, type Page } from "../lib/pages";

const PAGE_LABEL: Record<Page, MessageKey> = {
  trade: "nav.trade",
  portfolio: "nav.portfolio",
  charts: "nav.charts",
  rules: "nav.rules",
  venues: "nav.venues",
  journal: "nav.journal",
  news: "nav.news",
  maps: "nav.maps",
  settings: "settings.title",
};

/** "2 hr. ago", in the app's language. */
function ago(time: number, now: number): string {
  const format = new Intl.RelativeTimeFormat(currentLocale(), { style: "short", numeric: "auto" });
  const minutes = Math.round((time - now) / 60_000);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

interface CommandMenuProps {
  open: boolean;
  onClose: () => void;
  markets: Market[];
  /** The market on screen. */
  current?: Market;
  summaries?: MarketSummary[];
  positions: Position[];
  orders: Order[];
  /** The venue's bound on a market order, in basis points. */
  maxSlippageBps: number;
  /** Unset where orders can't be placed (no account that may trade). */
  place?: (request: OrderRequest) => Promise<void>;
  cancel?: (order: Order) => Promise<void>;
  /** Sets a position's exits; unset where they can't be. */
  protect?: (position: Position, protection: PositionProtection) => Promise<void>;
  /** The themes and venues that can be switched to, by name. */
  themes: readonly { value: string; label: string }[];
  onTheme: (theme: string) => void;
  venues: readonly { id: VenueId; label: string }[];
  onVenue: (venue: VenueId) => void;
  onMarket: (marketId: string) => void;
  onPage: (page: Page) => void;
  onAlerts: () => void;
  onFloat: () => void;
  onLayout: () => void;
}

/**
 * The command palette's contents: what the typed line means here (an order,
 * a close, a cancel), the markets and pages it matches, and what was run
 * before. Anything that trades takes two presses of Enter: the first shows
 * what would be sent, the second sends it, through the same `place` and
 * `cancel` as the ticket.
 */
export function CommandMenu({
  open,
  onClose,
  markets,
  current,
  summaries,
  positions,
  orders,
  maxSlippageBps,
  place,
  cancel,
  protect,
  themes,
  onTheme,
  venues,
  onVenue,
  onMarket,
  onPage,
  onAlerts,
  onFloat,
  onLayout,
}: CommandMenuProps) {
  const [query, setQuery] = useState("");
  // The action waiting on its second Enter.
  const [armed, setArmed] = useState<string>();
  const [recent, setRecent] = useState(loadRecent);
  // Opens empty each time.
  useEffect(() => {
    if (open) {
      setQuery("");
      setArmed(undefined);
    }
  }, [open]);

  if (!open) return null;

  const now = Date.now();
  const text = query.trim().toLowerCase();
  const intent = parseCommand(query, { markets, current, positions, orders });
  const markOf = (id: string) => Number(summaries?.find((s) => s.market === id)?.markPrice);
  const remember = () => {
    const next = withRecent(recent, query, Date.now());
    setRecent(next);
    saveRecent(next);
  };
  /** Runs on the second Enter; the first only arms it. */
  const twice = (id: string, act: () => Promise<unknown>) => () => {
    if (armed !== id) {
      setArmed(id);
      return false;
    }
    remember();
    // `place` and `cancel` say how it went themselves.
    act().catch(() => {});
    return undefined;
  };
  const noTrading = place ? undefined : t("cmd.noTrading");
  const sideWord = (side: "buy" | "sell") => t(side === "buy" ? "side.buy" : "side.sell");

  const actions: PaletteItem[] = [];
  let preview: PalettePreview | undefined;
  const describe = (id: string, shown: Omit<PalettePreview, "hint" | "armed">) => {
    // The armed action, or else the first, is the one spelled out.
    if (armed === id || (!preview && !armed)) {
      preview = {
        ...shown,
        hint: noTrading ? undefined : t(armed === id ? "cmd.confirm" : "cmd.review"),
        armed: armed === id,
      };
    }
  };
  const orderRows = (order: Extract<Intent, { kind: "order" }>) => {
    const { market, side, size, price } = order;
    const mark = markOf(market.id);
    const head = `${sideWord(side)} ${formatNumber(size)} ${market.base}`;
    const row = (atMarket: boolean) => {
      const id = atMarket ? "order:market" : "order:limit";
      const at = atMarket ? mark : Number(price);
      const how = atMarket
        ? Number.isFinite(mark)
          ? t("cmd.atMarket", { price: formatNumber(mark) })
          : t("ticket.market")
        : t("cmd.atLimit", { price: formatNumber(price ?? "") });
      describe(id, {
        badge: `${sideWord(side)} / ${t(side === "buy" ? "side.long" : "side.short")}`,
        tone: side,
        title: `${formatNumber(size)} ${market.base} · ${how}`,
        detail: Number.isFinite(at)
          ? t("cmd.value", { value: formatNumber(Number(size) * at, 2), quote: market.quote })
          : undefined,
      });
      actions.push({
        id,
        icon: <LuArrowRight size={15} />,
        label: (
          <>
            {head} <span className="pd-cmd-mono">{how}</span>
          </>
        ),
        disabled: noTrading,
        onRun: twice(id, () =>
          place ? place(orderFor(order, maxSlippageBps, atMarket)) : Promise.resolve(),
        ),
      });
    };
    const parts = order.to ? scaledOrders(order) : undefined;
    if (parts && order.to) {
      const how = t("cmd.scaled", {
        from: formatNumber(price ?? ""),
        to: formatNumber(order.to),
        count: parts.length,
      });
      // Every part is the same size, so the value is that size times the prices' sum.
      const prices = parts.reduce((sum, o) => sum + (o.type === "limit" ? Number(o.price) : 0), 0);
      describe("order:scaled", {
        badge: `${sideWord(side)} / ${t(side === "buy" ? "side.long" : "side.short")}`,
        tone: side,
        title: `${formatNumber(size)} ${market.base} · ${how}`,
        detail: t("cmd.value", {
          value: formatNumber(Number(parts[0]?.size) * prices, 2),
          quote: market.quote,
        }),
      });
      actions.push({
        id: "order:scaled",
        icon: <LuArrowRight size={15} />,
        label: (
          <>
            {head} <span className="pd-cmd-mono">{how}</span>
          </>
        ),
        disabled: noTrading,
        // One after another, so they rest in the order they were priced.
        onRun: twice("order:scaled", async () => {
          for (const part of parts) await place?.(part);
        }),
      });
    }
    if (price) row(false);
    row(true);
  };

  if (intent?.kind === "order") {
    orderRows(intent);
  } else if (intent?.kind === "reduce") {
    const { position, market, fraction, price } = intent;
    const base = closeRequest(position, market, fraction, maxSlippageBps);
    const request: OrderRequest = price
      ? {
          market: base.market,
          side: base.side,
          size: base.size,
          reduceOnly: true,
          type: "limit",
          price,
        }
      : base;
    const mark = markOf(market.id);
    const how = price
      ? t("cmd.atLimit", { price: formatNumber(price) })
      : Number.isFinite(mark)
        ? t("cmd.atMarket", { price: formatNumber(mark) })
        : t("ticket.market");
    const label = `${sideWord(request.side)} ${formatNumber(request.size)} ${market.base}`;
    describe("reduce", {
      badge: t("ticket.reduceOnly"),
      tone: request.side,
      title: `${label} · ${how}`,
      detail: t("cmd.ofPosition", {
        percent: formatNumber((Number(request.size) / Number(position.size)) * 100, 0),
        size: formatNumber(position.size),
        side: t(position.side === "long" ? "side.long" : "side.short").toLowerCase(),
      }),
    });
    actions.push({
      id: "reduce",
      icon: <LuArrowRight size={15} />,
      label: (
        <>
          {label} <span className="pd-cmd-mono">{how}</span>
        </>
      ),
      disabled: noTrading,
      onRun: twice("reduce", () => (place ? place(request) : Promise.resolve())),
    });
  } else if (intent?.kind === "protect") {
    const { position, market, exit, price } = intent;
    const name = t(exit === "tp" ? "drawer.tp" : "drawer.sl");
    const label = price
      ? t("cmd.exitAt", { exit: name, base: market.base, price: formatNumber(price) })
      : t("cmd.exitOff", { exit: name, base: market.base });
    describe("protect", {
      badge: t("col.tpsl"),
      tone: "plain",
      title: label,
      detail: t("cmd.onPosition", {
        size: formatNumber(position.size),
        side: t(position.side === "long" ? "side.long" : "side.short").toLowerCase(),
        entry: formatNumber(position.entryPrice),
      }),
    });
    actions.push({
      id: "protect",
      icon: <LuShield size={15} />,
      label,
      disabled: protect ? undefined : t("cmd.noTrading"),
      onRun: twice("protect", () =>
        protect ? protect(position, protectionFor(intent)) : Promise.resolve(),
      ),
    });
  } else if (intent?.kind === "close") {
    const { position, market } = intent;
    const base = market?.base ?? position.market;
    const label = t("cmd.close", {
      size: formatNumber(position.size),
      base,
      side: t(position.side === "long" ? "side.long" : "side.short").toLowerCase(),
    });
    describe("close", {
      badge: t("cmd.closeBadge"),
      tone: position.side === "long" ? "sell" : "buy",
      title: label,
      detail: `${t("account.upnl")} ${formatSigned(position.unrealizedPnl)}`,
    });
    actions.push({
      id: "close",
      icon: <LuX size={15} />,
      label,
      disabled: noTrading,
      onRun: twice("close", () =>
        place ? place(closeOrder(position, { type: "market", maxSlippageBps })) : Promise.resolve(),
      ),
    });
  } else if (intent?.kind === "cancel") {
    const label = intent.market
      ? t("cmd.cancelFor", { count: intent.orders.length, base: intent.market.base })
      : t("cmd.cancelAll", { count: intent.orders.length });
    describe("cancel", { badge: t("cmd.cancelBadge"), tone: "plain", title: label });
    actions.push({
      id: "cancel",
      icon: <LuX size={15} />,
      label,
      disabled: cancel ? undefined : t("cmd.noTrading"),
      onRun: twice("cancel", () =>
        cancel ? Promise.allSettled(intent.orders.map((o) => cancel(o))) : Promise.resolve(),
      ),
    });
  }

  const found =
    intent && "market" in intent && intent.market ? [intent.market] : searchMarkets(query, markets);
  const marketRows: PaletteItem[] = found.map((m) => {
    const s = summaries?.find((x) => x.market === m.id);
    const change =
      s && Number(s.prevDayPrice) > 0
        ? (Number(s.markPrice) / Number(s.prevDayPrice) - 1) * 100
        : undefined;
    return {
      id: `market:${m.id}`,
      icon: <span className="pd-cmd-letter">{m.base.slice(0, 1)}</span>,
      label: (
        <>
          {m.symbol} {s && <span className="pd-cmd-mono">{formatNumber(s.markPrice)}</span>}{" "}
          {change !== undefined && (
            <span className={`pd-cmd-mono ${trendClass(change)}`}>{formatSigned(change)}%</span>
          )}
        </>
      ),
      meta: t("cmd.go"),
      onRun: () => {
        onMarket(m.id);
        return undefined;
      },
    };
  });

  const matches = (label: string) => !intent && (!text || label.toLowerCase().includes(text));
  const pageRows: PaletteItem[] = PAGES.filter((p) => matches(t(PAGE_LABEL[p]))).map((p) => ({
    id: `page:${p}`,
    icon: <LuPanelTop size={15} />,
    label: t(PAGE_LABEL[p]),
    meta: t("cmd.go"),
    onRun: () => {
      onPage(p);
      return undefined;
    },
  }));
  const appRows: PaletteItem[] = [
    { id: "app:alerts", icon: <LuBell size={15} />, label: t("alerts.title"), run: onAlerts },
    {
      id: "app:float",
      icon: <LuPictureInPicture2 size={15} />,
      label: t("float.open"),
      run: onFloat,
    },
    {
      id: "app:layout",
      icon: <LuLayoutGrid size={15} />,
      label: t("layout.editor"),
      run: onLayout,
    },
  ]
    .filter((a) => matches(a.label))
    .map(({ run, ...row }) => ({
      ...row,
      onRun: () => {
        run();
        return undefined;
      },
    }));
  // Themes and venues show once asked for: by name, or after "theme" / "venue".
  const named = (word: string, label: string) =>
    !intent &&
    text.length > 0 &&
    (text === word ||
      (text.startsWith(`${word} `)
        ? label.toLowerCase().includes(text.slice(word.length + 1).trim())
        : label.toLowerCase().includes(text)));
  const themeRows: PaletteItem[] = themes
    .filter((th) => named("theme", th.label))
    .map((th) => ({
      id: `theme:${th.value}`,
      icon: <LuPalette size={15} />,
      label: th.label,
      meta: t("menu.theme"),
      onRun: () => {
        onTheme(th.value);
        return undefined;
      },
    }));
  const venueRows: PaletteItem[] = venues
    .filter((v) => named("venue", v.label))
    .map((v) => ({
      id: `venue:${v.id}`,
      icon: <LuStore size={15} />,
      label: v.label,
      meta: t("venues.switch"),
      onRun: () => {
        onVenue(v.id);
        return undefined;
      },
    }));
  const recentRows: PaletteItem[] = text
    ? []
    : recent.map((r) => ({
        id: `recent:${r.text}`,
        icon: <LuClock size={15} />,
        label: <span className="pd-cmd-mono">{r.text}</span>,
        meta: ago(r.time, now),
        // Back into the line, to look over before it's run again.
        onRun: () => {
          setQuery(r.text);
          return false;
        },
      }));

  const sections: PaletteSection[] = [
    { id: "actions", title: t("cmd.actions"), items: actions },
    { id: "markets", title: t("panel.markets"), items: marketRows },
    { id: "recent", title: t("cmd.recent"), items: recentRows },
    { id: "pages", title: t("nav.menu"), items: pageRows },
    { id: "app", title: t("cmd.app"), items: appRows },
    { id: "venues", title: t("nav.venues"), items: venueRows },
    { id: "themes", title: t("menu.theme"), items: themeRows },
  ];

  return (
    <CommandPalette
      open
      query={query}
      onQuery={(next) => {
        setArmed(undefined);
        setQuery(next);
      }}
      onClose={onClose}
      placeholder={t("cmd.placeholder")}
      preview={preview}
      sections={sections}
      tips={t("cmd.tips")}
      empty={t("cmd.empty")}
    />
  );
}
