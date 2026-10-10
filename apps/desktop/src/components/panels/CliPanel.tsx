import type {
  AccountSnapshot,
  Market,
  MarketSummary,
  Order,
  OrderRequest,
  Position,
  PositionProtection,
} from "@pewterdesk/core";
import { formatNumber, formatSigned, type MessageKey, t } from "@pewterdesk/ui";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  actionFor,
  type CliAction,
  type CliLine,
  loadSession,
  parseLine,
  saveSession,
  withHistory,
} from "../../lib/cli";
import type { Intent } from "../../lib/commands";
import type { Page } from "../../lib/pages";
import { pageLabel } from "../preferences";

/** The most lines kept on screen. */
const MAX_LINES = 300;

type Line = CliLine;
type Tone = Line["tone"];

/** The column the help's explanations start at, in characters. */
const HELP_WIDTH = 34;
/** What "help" lists: a line to type, and what it does. */
const HELP: readonly [string, MessageKey][] = [
  ["buy 0.01 btc", "cli.help.order"],
  ["sell 0.01 btc at 82000", "cli.help.limit"],
  ["buy 0.01 btc sl 81000 tp 85000", "cli.help.withExits"],
  ["sell 50% eth", "cli.help.reduce"],
  ["tp eth 2600", "cli.help.protect"],
  ["sl eth 2400", "cli.help.protect"],
  ["close eth", "cli.help.close"],
  ["cancel all", "cli.help.cancel"],
  ["positions", "cli.help.positions"],
  ["orders", "cli.help.orders"],
  ["balance", "cli.help.balance"],
  ["price btc", "cli.help.price"],
  ["market btc", "cli.help.market"],
  ["go portfolio", "cli.help.go"],
  ["clear", "cli.help.clear"],
  ["positions ; balance", "cli.help.several"],
];

interface CliPanelProps {
  markets: readonly Market[];
  /** The market on screen: what a line without a coin means. */
  current?: Market;
  /** Where the lines go: the account's name, or its venue's. */
  where?: string;
  summaries?: readonly MarketSummary[];
  /** The connected account, for its positions, orders and balance. */
  account?: AccountSnapshot;
  /** The venue's bound on a market order, in basis points. */
  maxSlippageBps: number;
  /** Unset where orders can't be placed (no account that may trade). */
  place?: (request: OrderRequest) => Promise<void>;
  cancel?: (order: Order) => Promise<void>;
  protect?: (position: Position, protection: PositionProtection) => Promise<void>;
  onMarket: (marketId: string) => void;
  onPage: (page: Page) => void;
}

/**
 * A command line in a panel: the command palette's language (`buy 0.01 btc`,
 * `close eth`, `cancel all`) plus lines that read the account, show a market
 * or open a page. It adds no trading command: an order, close, cancel or exit
 * goes through the same `place`, `cancel` and `protect` as the ticket, and
 * only after the panel has printed what would be sent and Enter is pressed
 * again.
 */
export function CliPanel({
  markets,
  current,
  where,
  summaries,
  account,
  maxSlippageBps,
  place,
  cancel,
  protect,
  onMarket,
  onPage,
}: CliPanelProps) {
  // What was on the panel before it was last taken down (another page, a
  // reload), kept until the app closes.
  const [kept] = useState(loadSession);
  const [lines, setLines] = useState<Line[]>(() => {
    if (!kept) return [{ id: 0, tone: "dim", text: t("cli.welcome") }];
    // A line that was waiting on Enter didn't wait: say so, so it isn't
    // mistaken for one that still is.
    return kept.pending
      ? [...kept.lines, { id: kept.lines.length, tone: "dim", text: t("cli.cancelled") }]
      : kept.lines;
  });
  const nextId = useRef(lines.length + 1);
  const [input, setInput] = useState(kept?.input ?? "");
  // The trading line waiting on Enter, already spelled out above the prompt.
  const [pending, setPending] = useState<{
    action: CliAction;
    /** What it is, in a line, and the numbers worth a look before sending. */
    title: string;
    details: string[];
  }>();
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(kept?.history ?? []);
  // How far back in the history the up arrow has gone; unset at the prompt.
  const [recall, setRecall] = useState<number>();
  const inputRef = useRef<HTMLInputElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  const print = (...add: [Tone, string][]) =>
    setLines((now) =>
      [...now, ...add.map(([tone, text]) => ({ id: nextId.current++, tone, text }))].slice(
        -MAX_LINES,
      ),
    );
  // Kept as it changes, for the next time the panel is put up.
  const waiting = pending !== undefined;
  useEffect(() => {
    saveSession({ lines, history, input, pending: waiting });
  }, [lines, history, input, waiting]);
  // The newest line stays in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the lines as they're added
  useEffect(() => {
    const screen = screenRef.current;
    if (screen) screen.scrollTop = screen.scrollHeight;
  }, [lines]);

  const mark = summaries?.find((s) => s.market === current?.id)?.markPrice;
  const symbolOf = (id: string) => markets.find((m) => m.id === id)?.symbol ?? id;
  const sideWord = (side: "buy" | "sell") => t(side === "buy" ? "side.buy" : "side.sell");
  const positionSide = (p: Position) => t(p.side === "long" ? "side.long" : "side.short");

  /** A trading line in words, as the palette puts it. */
  const describe = (intent: Intent, action: CliAction): string => {
    switch (intent.kind) {
      case "order": {
        // By its symbol: a coin can have more than one market.
        const head = `${sideWord(intent.side)} ${formatNumber(intent.size)} ${intent.market.symbol}`;
        // The exits going on with it, as they'd be sent.
        const exits = [
          intent.stopLoss && `${t("drawer.sl")} ${formatNumber(intent.stopLoss)}`,
          intent.takeProfit && `${t("drawer.tp")} ${formatNumber(intent.takeProfit)}`,
        ]
          .filter(Boolean)
          .map((exit) => ` · ${exit}`)
          .join("");
        if (intent.to && action.kind === "orders") {
          return `${head} · ${t("cmd.scaled", {
            from: formatNumber(intent.price ?? ""),
            to: formatNumber(intent.to),
            count: action.requests.length,
          })}${exits}`;
        }
        // The venue's own figure, so a small price keeps its decimals.
        const mark = summaries?.find((s) => s.market === intent.market.id)?.markPrice;
        return `${head} · ${
          intent.price
            ? t("cmd.atLimit", { price: formatNumber(intent.price) })
            : mark !== undefined
              ? t("cmd.atMarket", { price: formatNumber(mark) })
              : t("ticket.market")
        }${exits}`;
      }
      case "reduce": {
        const request = action.kind === "orders" ? action.requests[0] : undefined;
        const how = intent.price
          ? t("cmd.atLimit", { price: formatNumber(intent.price) })
          : t("ticket.market");
        return `${sideWord(request?.side ?? "sell")} ${formatNumber(request?.size ?? "0")} ${intent.market.base} · ${how} · ${t("ticket.reduceOnly")}`;
      }
      case "close":
        return t("cmd.close", {
          size: formatNumber(intent.position.size),
          base: intent.market?.base ?? intent.position.market,
          side: positionSide(intent.position).toLowerCase(),
        });
      case "protect": {
        const exit = t(intent.exit === "tp" ? "drawer.tp" : "drawer.sl");
        return intent.price
          ? t("cmd.exitAt", { exit, base: intent.market.base, price: formatNumber(intent.price) })
          : t("cmd.exitOff", { exit, base: intent.market.base });
      }
      case "cancel":
        return intent.market
          ? t("cmd.cancelFor", { count: intent.orders.length, base: intent.market.base })
          : t("cmd.cancelAll", { count: intent.orders.length });
    }
  };

  /** The numbers worth a look before a trading line is sent. */
  const detailsOf = (intent: Intent, action: CliAction): string[] => {
    const out: string[] = [];
    const markOf = (id: string) => Number(summaries?.find((s) => s.market === id)?.markPrice);
    if (intent.kind === "order" && action.kind === "orders") {
      const { market } = intent;
      // What it's expected to fill at: its own price, else the mark.
      const entry = intent.price && !intent.to ? Number(intent.price) : markOf(market.id);
      const size = action.requests.reduce((sum, r) => sum + Number(r.size), 0);
      if (Number.isFinite(entry) && entry > 0) {
        out.push(t("cmd.value", { value: formatNumber(size * entry, 2), quote: market.quote }));
        const away = (price: string) => formatNumber(Math.abs(entry - Number(price)) * size, 2);
        if (intent.stopLoss) {
          out.push(
            `${t("drawer.sl")} ${formatNumber(intent.stopLoss)} · ${t("cli.risk", {
              amount: away(intent.stopLoss),
              quote: market.quote,
            })}`,
          );
        }
        if (intent.takeProfit) {
          out.push(
            `${t("drawer.tp")} ${formatNumber(intent.takeProfit)} · ${t("cli.reward", {
              amount: away(intent.takeProfit),
              quote: market.quote,
            })}`,
          );
        }
      }
      if (!intent.stopLoss) out.push(t("cli.noStop"));
    } else if (intent.kind === "close" || intent.kind === "reduce" || intent.kind === "protect") {
      const p = intent.position;
      out.push(
        t("cmd.onPosition", {
          size: formatNumber(p.size),
          side: positionSide(p).toLowerCase(),
          entry: formatNumber(p.entryPrice),
        }),
        `${t("account.upnl")} ${formatSigned(p.unrealizedPnl)}`,
      );
    } else if (intent.kind === "cancel") {
      out.push(
        ...intent.orders
          .slice(0, 5)
          .map(
            (o) =>
              `${symbolOf(o.market)}  ${sideWord(o.side)} ${formatNumber(o.size)}${
                o.price ? ` @ ${formatNumber(o.price)}` : ""
              }`,
          ),
      );
      if (intent.orders.length > 5) out.push("…");
    }
    return out;
  };

  /** Sends what was confirmed. Whoever places it says how it went as well. */
  const send = async (action: CliAction) => {
    setBusy(true);
    try {
      if (action.kind === "orders") {
        // One after another, so a ladder rests in the order it was priced.
        for (const request of action.requests) await place?.(request);
      } else if (action.kind === "cancel") {
        const done = await Promise.allSettled(action.orders.map((o) => cancel?.(o)));
        const failed = done.find((d) => d.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } else {
        await protect?.(action.position, action.protection);
      }
      print(["ok", t("cli.sent")]);
    } catch (e) {
      print(["err", t("cli.failed", { why: e instanceof Error ? e.message : String(e) })]);
    }
    setBusy(false);
  };

  /** Runs one command; true if it's a trading line now waiting on Enter. */
  const runOne = (text: string): boolean => {
    const line = parseLine(text, {
      markets,
      current,
      positions: account?.positions ?? [],
      orders: account?.openOrders ?? [],
    });
    if (!line) return false;
    print(["in", text.trim()]);
    if (line.kind !== "trade") {
      answer(line);
      return false;
    }
    const action = actionFor(line.intent, maxSlippageBps);
    const can = action.kind === "orders" ? place : action.kind === "cancel" ? cancel : protect;
    print(["out", describe(line.intent, action)]);
    if (!can) {
      print(["warn", t("cmd.noTrading")]);
      return false;
    }
    setPending({
      action,
      title: describe(line.intent, action),
      details: detailsOf(line.intent, action),
    });
    return true;
  };
  /**
   * A line as typed: one command, or several with ";" (or "·") between
   * them, run in turn up to the first that needs confirming.
   */
  const run = (text: string) => {
    setHistory((now) => withHistory(now, text));
    for (const part of text.split(/\s*[;·]\s*/)) {
      if (runOne(part)) break;
    }
  };
  /** The lines that only read or show something. */
  const answer = (line: Exclude<NonNullable<ReturnType<typeof parseLine>>, { kind: "trade" }>) => {
    switch (line.kind) {
      case "help":
        return print(
          ...HELP.map(([say, what]): [Tone, string] => [
            "out",
            `${say.padEnd(HELP_WIDTH)}${t(what)}`,
          ]),
        );
      case "clear":
        return setLines([]);
      case "positions": {
        const held = account?.positions ?? [];
        if (!account) return print(["warn", t("cli.noAccount")]);
        if (held.length === 0) return print(["dim", t("positions.empty")]);
        return print(
          ...held.map((p): [Tone, string] => [
            Number(p.unrealizedPnl) >= 0 ? "ok" : "err",
            `${t("tray.position", {
              market: symbolOf(p.market),
              side: positionSide(p),
              size: formatNumber(p.size),
              pnl: formatSigned(p.unrealizedPnl),
            })}  @ ${formatNumber(p.entryPrice)}`,
          ]),
        );
      }
      case "orders": {
        const open = account?.openOrders ?? [];
        if (!account) return print(["warn", t("cli.noAccount")]);
        if (open.length === 0) return print(["dim", t("orders.empty")]);
        return print(
          ...open.map((o): [Tone, string] => [
            "out",
            `${symbolOf(o.market)}  ${sideWord(o.side)} ${formatNumber(o.size)}${
              o.price ? ` @ ${formatNumber(o.price)}` : ""
            }`,
          ]),
        );
      }
      case "balance":
        return account
          ? print([
              "out",
              t("cli.balance", {
                equity: formatNumber(account.equity, 2),
                available: formatNumber(account.availableMargin, 2),
              }),
            ])
          : print(["warn", t("cli.noAccount")]);
      case "price": {
        const s = summaries?.find((x) => x.market === line.market.id);
        if (!s) return print(["dim", `${line.market.symbol}  –`]);
        const prev = Number(s.prevDayPrice);
        const change = prev > 0 ? (Number(s.markPrice) / prev - 1) * 100 : undefined;
        return print([
          change === undefined ? "out" : change >= 0 ? "ok" : "err",
          `${line.market.symbol}  ${formatNumber(s.markPrice)}${
            change === undefined ? "" : `  ${formatSigned(change)}%`
          }`,
        ]);
      }
      case "market":
        onMarket(line.market.id);
        return print(["dim", t("cli.nowOn", { market: line.market.symbol })]);
      case "page":
        onPage(line.page);
        return print(["dim", t("cli.opened", { page: pageLabel(line.page) })]);
      case "missing":
        return print([
          "warn",
          t(line.what === "market" ? "cli.noMarket" : "cli.noPage", { text: line.word }),
        ]);
      case "unknown":
        return print(["warn", t("cli.unknown")]);
    }
  };

  const cancelPending = () => {
    setPending(undefined);
    setInput("");
    print(["dim", t("cli.cancelled")]);
    inputRef.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (busy) return;
      const text = input;
      setInput("");
      setRecall(undefined);
      if (pending) {
        const { action } = pending;
        setPending(undefined);
        // As a shell asks [y/N]: only "y" sends. Enter on its own, "n" or
        // anything else calls it off; a new command is then run as usual.
        const answer = text.trim().toLowerCase();
        if (answer === "y" || answer === "yes") return void send(action);
        print(["dim", t("cli.cancelled")]);
        if (answer === "" || answer === "n" || answer === "no") return;
      }
      return run(text);
    }
    if (e.key === "Escape" && pending) {
      e.preventDefault();
      return cancelPending();
    }
    if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      return setLines([]);
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (history.length === 0) return;
      e.preventDefault();
      const at = recall ?? history.length;
      const next = e.key === "ArrowUp" ? Math.max(at - 1, 0) : at + 1;
      if (next >= history.length) {
        setRecall(undefined);
        return setInput("");
      }
      setRecall(next);
      setInput(history[next] ?? "");
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click anywhere in the panel goes to its prompt, as in a terminal
    // biome-ignore lint/a11y/useKeyWithClickEvents: the prompt itself takes the keys
    <div className="cli" onClick={() => inputRef.current?.focus()}>
      <div ref={screenRef} className="cli-screen" role="log" aria-live="polite">
        {lines.map((line) => (
          <p key={line.id} className="cli-line" data-tone={line.tone}>
            {line.tone === "in" && <span className="cli-mark">›</span>}
            {line.text}
          </p>
        ))}
      </div>
      {/* Where a line goes, as a shell's prompt says: the account and the market on screen. */}
      <p className="cli-status">
        {where && <span className="cli-where">:{where}</span>}
        {current && (
          <span>
            [{current.symbol}
            {mark !== undefined && ` $${formatNumber(mark)}`}]
          </span>
        )}
      </p>
      {/* What's about to be sent, spelled out, with the two ways to answer. */}
      {pending && (
        <div className="cli-confirm" role="alertdialog" aria-label={t("cli.confirmTitle")}>
          <p className="cli-confirm-head">
            <span className="cli-confirm-tag">{t("cli.confirmTitle")}</span>
            <strong>{pending.title}</strong>
          </p>
          {pending.details.map((detail) => (
            <p key={detail} className="cli-confirm-line">
              {detail}
            </p>
          ))}
          <p className="cli-confirm-ask">
            <span>{t("cli.confirm")}</span>
            <button
              type="button"
              className="cli-confirm-button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                cancelPending();
              }}
            >
              {t("protect.cancel")}
            </button>
            <button
              type="button"
              className="cli-confirm-button cli-confirm-send"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                const { action } = pending;
                setPending(undefined);
                void send(action);
              }}
            >
              {t("cli.send")}
            </button>
          </p>
        </div>
      )}
      <label className="cli-prompt" data-pending={pending ? true : undefined}>
        <span className="cli-mark" aria-hidden>
          {pending ? "?" : "→"}
        </span>
        <input
          ref={inputRef}
          className="cli-input"
          value={input}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={t("cli.prompt")}
          placeholder={pending ? "y / N" : t("cli.placeholder")}
          onChange={(e) => {
            setInput(e.target.value);
            setRecall(undefined);
          }}
          onKeyDown={onKey}
        />
      </label>
    </div>
  );
}
