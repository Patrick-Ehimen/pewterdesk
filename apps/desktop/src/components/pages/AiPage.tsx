import type { CandleInterval, Market, MarketSummary, VenueId } from "@pewterdesk/core";
import {
  ALL_INTERVALS,
  type ChartAnalysis,
  dateFormat,
  decimalsOf,
  formatCompact,
  formatNumber,
  formatSigned,
  type MessageKey,
  OpenAlgoChart,
  Select,
  Switch,
  TokenIcon,
  t,
} from "@pewterdesk/ui";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LuArrowUp,
  LuBrain,
  LuChartCandlestick,
  LuCircleAlert,
  LuClock,
  LuKeyRound,
  LuLockKeyhole,
  LuMessageSquare,
  LuNewspaper,
  LuPanelLeftClose,
  LuPanelLeftOpen,
  LuPlus,
  LuSparkles,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import {
  type AiCatalystSource,
  type AiChartMarks,
  type AiContext,
  type AiFailure,
  type AiModel,
  type AiProvider,
  aiClient,
} from "../../api/venueClient";
import { useAiChats } from "../../hooks/useAiChats";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import {
  type AiChat,
  type ChatMessage,
  type ChatMode,
  marketPulse,
  snapshotOf,
} from "../../lib/aiChats";
import { blocksOf, type Span } from "../../lib/aiText";
import { venueBarSource } from "../../lib/barSource";
import { LoadingMark } from "../Splash";

const MODES: readonly ChatMode[] = ["chat", "chart"];
const SIDES = ["open", "closed"] as const;
const PROVIDERS: readonly AiProvider[] = ["claude", "gemini", "openai"];

/** Each provider's name, and where its keys are made. Names, not words to translate. */
const PROVIDER_INFO: Record<AiProvider, { name: string; site: string; placeholder: string }> = {
  claude: { name: "Claude", site: "console.anthropic.com", placeholder: "sk-ant-…" },
  gemini: { name: "Gemini", site: "aistudio.google.com/apikey", placeholder: "AIza…" },
  openai: { name: "ChatGPT", site: "platform.openai.com/api-keys", placeholder: "sk-…" },
};

/** Who runs each provider, for "Google refused the key". Names, not words to translate. */
const PROVIDER_COMPANY: Record<AiProvider, string> = {
  claude: "Anthropic",
  gemini: "Google",
  openai: "OpenAI",
};

/** What a failure card can do beyond trying again: the page's own actions. */
const FailureActions = createContext<{
  replaceKey: (provider: AiProvider) => void;
  newChat: () => void;
}>({ replaceKey: () => {}, newChat: () => {} });

const HELP_KEYS = {
  claude: "ai.key.help.claude",
  gemini: "ai.key.help.gemini",
  openai: "ai.key.help.openai",
} as const satisfies Record<AiProvider, MessageKey>;

/** The model picked for new chats, as "provider:model", kept on this machine. */
const CHOICE_KEY = "pd.ai.model";

function readChoice(): string {
  try {
    return localStorage.getItem(CHOICE_KEY) ?? "";
  } catch {
    return "";
  }
}

const choiceOf = (m: { provider: AiProvider; id: string }) => `${m.provider}:${m.id}`;

const TOOL_KEYS: Record<string, MessageKey> = {
  get_candles: "ai.tool.candles",
  get_order_book: "ai.tool.book",
  get_funding_history: "ai.tool.funding",
  find_markets: "ai.tool.markets",
  mark_chart: "ai.tool.mark",
  web_search: "ai.tool.web",
  get_open_interest: "ai.tool.oi",
  get_long_short_ratio: "ai.tool.longShort",
  search_x_posts: "ai.tool.x",
  search_headlines: "ai.tool.headlines",
  get_economic_calendar: "ai.tool.calendar",
  get_recent_trades: "ai.tool.trades",
  get_liquidations: "ai.tool.liquidations",
  get_account: "ai.tool.account",
  get_fills: "ai.tool.fills",
  get_closed_trades: "ai.tool.closedTrades",
};

const SOURCE_KEYS = {
  x: "ai.source.x",
  news: "ai.source.news",
  calendar: "ai.source.calendar",
  data: "ai.source.data",
  web: "ai.source.web",
} as const satisfies Record<AiCatalystSource, MessageKey>;

/** The home screen's starter questions, by tab. */
type SuggestionTab = "market" | "tokens" | "account";

const SUGGESTION_TABS: Record<SuggestionTab, readonly MessageKey[]> = {
  market: ["ai.suggest.today", "ai.suggest.narratives", "ai.suggest.events", "ai.suggest.levels"],
  tokens: ["ai.suggest.rise", "ai.suggest.technicals", "ai.suggest.momentum", "ai.suggest.funding"],
  account: ["ai.suggest.risk", "ai.suggest.review", "ai.suggest.liquidation"],
};

const TAB_KEYS = {
  market: "ai.tab.market",
  tokens: "ai.tab.tokens",
  account: "ai.tab.account",
} as const satisfies Record<SuggestionTab, MessageKey>;

const DEEP = ["off", "on"] as const;
/** Coin chips under the question box: the day's biggest movers. */
const COIN_CHIPS = 3;

/** What the question box offers besides the question: Deep Think and coin chips. */
interface ComposerControls {
  deep: boolean;
  onDeep: (on: boolean) => void;
  /** Markets to ask about in one click, with how they moved. */
  coins: readonly { market: Market; change: number }[];
  onCoin: (market: Market) => void;
}

interface AiPageProps {
  venue: VenueId;
  /** The venue's display name, e.g. "Hyperliquid". */
  venueLabel: string;
  markets: Market[];
  /** The market on screen. */
  market?: Market;
  /** Every market's price and funding; unset until they arrive. */
  summaries?: MarketSummary[];
  /** The connected account on each venue, for the analyst's account tools. */
  accounts: { venue: VenueId; account: string }[];
  /** Puts a market on screen (the app's own market, as the header's picker does). */
  onShowMarket: (venue: VenueId, marketId: string) => void;
  /** Opens a market on the Trade page. */
  onTrade: (marketId: string) => void;
}

/**
 * PewterDesk AI: a chat with a market analyst (Claude, through Rust with the
 * trader's own Anthropic key), and Agentic Charts, where the analyst reads
 * the chart on screen and marks its levels on it. It reads market data and
 * draws; it can't place an order.
 */
export function AiPage({
  venue,
  venueLabel,
  markets,
  market,
  summaries,
  accounts,
  onShowMarket,
  onTrade,
}: AiPageProps) {
  const ai = useAiChats();
  const [mode, setMode] = useStoredChoice("pd.ai.mode", MODES, "chat");
  // The side panel folds to a rail of icons, for more room to chat and chart.
  const [side, setSide] = useStoredChoice("pd.ai.side", SIDES, "open");
  const [interval, setChartInterval] = useStoredChoice<CandleInterval>(
    "pd.ai.interval",
    ALL_INTERVALS,
    "1h",
  );
  // The chat open in each view, kept with the chats.
  const chatIds = ai.open;
  const [shown, setShown] = useState<AiChartMarks>();
  const [models, setModels] = useState<AiModel[]>([]);
  // Which providers have a key; unset until read.
  const [keys, setKeys] = useState<Partial<Record<AiProvider, boolean>>>();
  const [choice, setChoice] = useState(readChoice);
  const [deep, setDeep] = useStoredChoice("pd.ai.deep", DEEP, "off");
  // Whether the analyst may read the account; Rust keeps and enforces it.
  const [accountAccess, setAccountAccess] = useState(false);
  const [accessError, setAccessError] = useState<string>();
  useEffect(() => {
    let live = true;
    aiClient.accountAccess().then(
      (on) => live && setAccountAccess(on),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  // Whether the Gemini key is on Google's paid plan; Rust keeps it, free by default.
  const [geminiPaid, setGeminiPaid] = useState(false);
  const [planError, setPlanError] = useState<string>();
  useEffect(() => {
    let live = true;
    aiClient.geminiPaid().then(
      (paid) => live && setGeminiPaid(paid),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const changePlan = (paid: boolean) => {
    setPlanError(undefined);
    aiClient.setGeminiPaid(paid).then(
      () => setGeminiPaid(paid),
      (e: unknown) => setPlanError(e instanceof Error ? e.message : String(e)),
    );
  };
  const changeAccess = (on: boolean) => {
    setAccessError(undefined);
    aiClient.setAccountAccess(on).then(
      () => setAccountAccess(on),
      (e: unknown) => setAccessError(e instanceof Error ? e.message : String(e)),
    );
  };

  const readKeys = () =>
    aiClient.keys().then(
      (k) => setKeys(k),
      () => setKeys({}),
    );
  useEffect(() => {
    let live = true;
    aiClient.models().then(
      (list) => live && setModels(list),
      () => {},
    );
    aiClient.keys().then(
      (k) => live && setKeys(k),
      () => live && setKeys({}),
    );
    return () => {
      live = false;
    };
  }, []);

  // The model for new chats: the one picked, or Claude's default, or the first.
  const picked =
    models.find((m) => choiceOf(m) === choice) ??
    models.find((m) => m.provider === "claude" && m.default) ??
    models[0];
  const pickModel = (value: string) => {
    setChoice(value);
    try {
      localStorage.setItem(CHOICE_KEY, value);
    } catch {
      // Storage is off: the pick lasts as long as the page.
    }
  };
  const modelLabel = (provider: AiProvider, id: string) =>
    models.find((m) => m.provider === provider && m.id === id)?.label ?? id;

  const pick = (m: ChatMode, id: string | undefined) => {
    ai.setOpen(m, id);
  };

  const chatOf = (id: string | undefined) => ai.chats.find((c) => c.id === id);
  const chat = chatOf(chatIds.chat);
  const chartChat = chatOf(chatIds.chart);
  const active = mode === "chat" ? chat : chartChat;

  const symbolOf = (id: string) => markets.find((m) => m.id === id)?.symbol ?? id;
  const context = (m: ChatMode): AiContext => ({
    venue,
    market: market?.id ?? null,
    interval: m === "chart" ? interval : null,
    snapshot: snapshotOf(summaries ?? [], symbolOf, market?.id),
    accounts,
    deep: deep === "on",
  });

  const ask = (question: string, m: ChatMode = mode) => {
    if (!picked) return;
    const id = ai.ask(chatIds[m], question, context(m), m, {
      provider: picked.provider,
      model: picked.id,
    });
    if (id) pick(m, id);
    if (m === "chart") setShown(undefined);
  };

  /** Asks in a new chat on the chat view, whatever is open. */
  const askNew = (question: string) => {
    if (!picked) return;
    const id = ai.ask(undefined, question, context("chat"), "chat", {
      provider: picked.provider,
      model: picked.id,
    });
    if (id) pick("chat", id);
    setMode("chat");
  };

  // The day's biggest movers, either way, as chips to ask about.
  const movers = useMemo(() => {
    const pulse = marketPulse(summaries ?? [], COIN_CHIPS);
    return [...pulse.gainers, ...pulse.losers]
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .flatMap((m) => {
        const found = markets.find((x) => x.id === m.market);
        return found ? [{ market: found, change: m.change }] : [];
      })
      .slice(0, COIN_CHIPS);
  }, [summaries, markets]);
  const controls = (m: ChatMode): ComposerControls => ({
    deep: deep === "on",
    onDeep: (on) => setDeep(on ? "on" : "off"),
    coins: m === "chat" ? movers : [],
    onCoin: (coin) => ask(t("ai.coin.ask", { coin: coin.base }), m),
  });

  const openChat = (c: AiChat) => {
    setMode(c.mode);
    pick(c.mode, c.id);
    if (c.mode === "chart" && c.market && (c.venue !== venue || c.market !== market?.id)) {
      onShowMarket(c.venue, c.market);
    }
    if (c.mode === "chart" && c.interval) setChartInterval(c.interval);
    setShown(undefined);
  };

  const showOnChart = (marks: AiChartMarks) => {
    setShown(marks);
    setChartInterval(marks.interval);
    setMode("chart");
    if (marks.venue !== venue || marks.market !== market?.id) {
      onShowMarket(marks.venue, marks.market);
    }
  };

  // A new answer in the chart chat that marked another market (or another
  // interval) takes the chart there, to draw it. Opening an older chat
  // doesn't: only an answer arriving while Agentic Charts is on screen.
  const lastChart = useRef<{ id?: string; count: number }>({ count: 0 });
  const chartId = chartChat?.id;
  const chartCount = chartChat?.messages.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chart chat gains a message, not on every render
  useEffect(() => {
    const before = lastChart.current;
    lastChart.current = { id: chartId, count: chartCount };
    if (mode !== "chart" || !chartChat || before.id !== chartId || chartCount <= before.count) {
      return;
    }
    const marks = chartChat.messages[chartCount - 1]?.marks;
    if (!marks) return;
    setShown(undefined);
    if (marks.interval !== interval) setChartInterval(marks.interval);
    if (marks.venue !== venue || marks.market !== market?.id) {
      onShowMarket(marks.venue, marks.market);
    }
  }, [chartId, chartCount]);

  // Who answers a view: its open chat's provider, or the pick for a new chat.
  const answerer = (c: AiChat | undefined) =>
    c
      ? { provider: c.provider, model: c.model }
      : picked && { provider: picked.provider, model: picked.id };
  const viewOf = (c: AiChat | undefined) => {
    const who = answerer(c);
    const ready = who !== undefined && keys?.[who.provider] === true;
    return {
      ready,
      label: who ? modelLabel(who.provider, who.model) : "",
      keyCard:
        who && keys && !ready ? (
          <KeySetup key={who.provider} provider={who.provider} onSaved={() => void readKeys()} />
        ) : null,
    };
  };
  const chatView = viewOf(chat);
  const chartView = viewOf(chartChat);

  return (
    <div className="page ai">
      {side === "closed" ? (
        <aside className="ai-side" data-collapsed aria-label={t("ai.title")}>
          <button
            type="button"
            className="pd-icon-button"
            title={t("ai.side.expand")}
            aria-label={t("ai.side.expand")}
            aria-expanded={false}
            onClick={() => setSide("open")}
          >
            <LuPanelLeftOpen size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="pd-icon-button"
            title={t("ai.newChat")}
            aria-label={t("ai.newChat")}
            onClick={() => pick(mode, undefined)}
          >
            <LuPlus size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="pd-icon-button ai-rail-mode"
            title={t("ai.mode.chat")}
            aria-label={t("ai.mode.chat")}
            aria-current={mode === "chat" ? "page" : undefined}
            onClick={() => setMode("chat")}
          >
            <LuMessageSquare size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="pd-icon-button ai-rail-mode"
            title={t("ai.mode.chart")}
            aria-label={t("ai.mode.chart")}
            aria-current={mode === "chart" ? "page" : undefined}
            onClick={() => setMode("chart")}
          >
            <LuChartCandlestick size={18} aria-hidden />
          </button>
        </aside>
      ) : (
        <aside className="ai-side" aria-label={t("ai.title")}>
          <div className="ai-brand">
            <LuSparkles size={18} aria-hidden />
            <strong>{t("ai.title")}</strong>
            <button
              type="button"
              className="pd-icon-button ai-side-toggle"
              title={t("ai.side.collapse")}
              aria-label={t("ai.side.collapse")}
              aria-expanded
              onClick={() => setSide("closed")}
            >
              <LuPanelLeftClose size={18} aria-hidden />
            </button>
          </div>
          <button type="button" className="ai-new" onClick={() => pick(mode, undefined)}>
            <LuPlus size={16} aria-hidden />
            {t("ai.newChat")}
          </button>
          <nav className="ai-modes">
            <button
              type="button"
              aria-current={mode === "chat" ? "page" : undefined}
              onClick={() => setMode("chat")}
            >
              <LuMessageSquare size={16} aria-hidden />
              {t("ai.mode.chat")}
            </button>
            <button
              type="button"
              aria-current={mode === "chart" ? "page" : undefined}
              onClick={() => setMode("chart")}
            >
              <LuChartCandlestick size={16} aria-hidden />
              {t("ai.mode.chart")}
            </button>
          </nav>
          <button
            type="button"
            className="ai-pulse"
            disabled={!chatView.ready}
            title={t("ai.pulse.help")}
            onClick={() => askNew(t("ai.pulse.prompt"))}
          >
            <LuNewspaper size={16} aria-hidden />
            {t("ai.pulse.title")}
          </button>
          <h2 className="ai-side-head">{t("ai.chats")}</h2>
          {ai.chats.length === 0 ? (
            <p className="ai-side-empty">{t("ai.chatsEmpty")}</p>
          ) : (
            <ul className="ai-chats">
              {ai.chats.map((c) => (
                <li key={c.id} data-active={c.id === active?.id || undefined}>
                  <button type="button" className="ai-chat-open" onClick={() => openChat(c)}>
                    {c.mode === "chart" ? (
                      <LuChartCandlestick size={14} aria-hidden />
                    ) : (
                      <LuMessageSquare size={14} aria-hidden />
                    )}
                    <span className="ai-chat-title">{c.title || t("ai.untitled")}</span>
                    <span className="ai-chat-when">{when(c.updated)}</span>
                  </button>
                  <button
                    type="button"
                    className="pd-icon-button ai-chat-delete"
                    title={t("ai.deleteChat")}
                    aria-label={t("ai.deleteChat")}
                    onClick={() => {
                      ai.remove(c.id);
                    }}
                  >
                    <LuTrash2 size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(ai.loadError || ai.saveError) && (
            <p className="ai-save-error" role="alert">
              {ai.loadError
                ? t("ai.store.loadFailed", { error: ai.loadError })
                : t("ai.store.saveFailed", { error: ai.saveError ?? "" })}
            </p>
          )}
          {models.length > 0 && picked && (
            <div className="ai-pick">
              <h2 className="ai-side-head">{t("ai.modelPick")}</h2>
              <Select
                value={choiceOf(picked)}
                label={t("ai.modelPick")}
                options={models.map((m) => ({
                  value: choiceOf(m),
                  label:
                    m.provider === "gemini" && !m.free && !geminiPaid
                      ? t("ai.gemini.paidOnly", { model: m.label })
                      : m.label,
                }))}
                onChange={pickModel}
              />
              <p className="ai-pick-note">{t("ai.modelNote")}</p>
              {picked.provider === "gemini" && (
                <>
                  <h2 className="ai-side-head">{t("ai.gemini.plan")}</h2>
                  <Select
                    value={geminiPaid ? "paid" : "free"}
                    label={t("ai.gemini.plan")}
                    options={[
                      { value: "free", label: t("ai.gemini.free") },
                      { value: "paid", label: t("ai.gemini.paid") },
                    ]}
                    onChange={(v) => changePlan(v === "paid")}
                  />
                  {!geminiPaid && <p className="ai-pick-note">{t("ai.gemini.freeNote")}</p>}
                  {planError && (
                    <p className="ai-error" role="alert">
                      {planError}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          <div className="ai-access" data-on={accountAccess || undefined}>
            <div className="ai-access-row">
              <LuLockKeyhole size={14} aria-hidden />
              <span>{t("ai.access.title")}</span>
              <Switch
                label={t("ai.access.title")}
                checked={accountAccess}
                onChange={changeAccess}
              />
            </div>
            <p>
              {accountAccess
                ? t("ai.access.on", {
                    provider: picked ? PROVIDER_INFO[picked.provider].name : "",
                  })
                : t("ai.access.off")}
            </p>
            {accessError && (
              <p className="ai-error" role="alert">
                {accessError}
              </p>
            )}
          </div>
          {keys && (
            <ul className="ai-key-list" aria-label={t("ai.keys")}>
              {PROVIDERS.map((p) => (
                <li key={p} data-on={keys[p] || undefined}>
                  <LuKeyRound size={13} aria-hidden />
                  <span>{PROVIDER_INFO[p].name}</span>
                  {keys[p] ? (
                    <button
                      type="button"
                      className="ai-link-button"
                      onClick={() => void aiClient.clearKey(p).then(readKeys, () => {})}
                    >
                      {t("ai.key.remove")}
                    </button>
                  ) : (
                    <span className="ai-key-off">{t("ai.key.none")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}

      <FailureActions.Provider
        value={{
          replaceKey: (p) => void aiClient.clearKey(p).then(readKeys, () => {}),
          newChat: () => pick(mode, undefined),
        }}
      >
        {mode === "chat" ? (
          <ChatView
            chat={chat}
            pending={chat !== undefined && ai.pending.has(chat.id)}
            failure={chat ? ai.failed[chat.id] : undefined}
            onDismissFailure={() => chat && ai.dismissFailure(chat.id)}
            ready={chatView.ready}
            keyCard={chatView.keyCard}
            modelLabel={chatView.label}
            controls={controls("chat")}
            accountAccess={accountAccess}
            summaries={summaries}
            symbolOf={symbolOf}
            market={market}
            venueLabel={venueLabel}
            onAsk={(q) => ask(q, "chat")}
            onShowOnChart={showOnChart}
            onTryCharts={() => setMode("chart")}
          />
        ) : (
          <ChartView
            chat={chartChat}
            pending={chartChat !== undefined && ai.pending.has(chartChat.id)}
            failure={chartChat ? ai.failed[chartChat.id] : undefined}
            onDismissFailure={() => chartChat && ai.dismissFailure(chartChat.id)}
            ready={chartView.ready}
            keyCard={chartView.keyCard}
            modelLabel={chartView.label}
            controls={controls("chart")}
            venue={venue}
            venueLabel={venueLabel}
            markets={markets}
            market={market}
            interval={interval}
            onInterval={setChartInterval}
            shown={shown}
            onAsk={(q) => ask(q, "chart")}
            onShowOnChart={showOnChart}
            onTrade={onTrade}
          />
        )}
      </FailureActions.Provider>
    </div>
  );
}

/** When a chat last changed: the time today, the date before. */
function when(time: number): string {
  const d = new Date(time);
  const today = new Date().toDateString() === d.toDateString();
  return dateFormat(
    today ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" },
  ).format(d);
}

function KeySetup({ provider, onSaved }: { provider: AiProvider; onSaved: () => void }) {
  const info = PROVIDER_INFO[provider];
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    aiClient.setKey(provider, key).then(
      () => {
        setKey("");
        setSaving(false);
        onSaved();
      },
      (err: unknown) => {
        setSaving(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  return (
    <form className="ai-key-card" onSubmit={submit}>
      <div className="ai-key-card-head">
        <LuKeyRound size={18} aria-hidden />
        <strong>{t("ai.key.title", { provider: info.name })}</strong>
      </div>
      <p>{t(HELP_KEYS[provider])}</p>
      <div className="ai-key-row">
        <input
          className="pd-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={info.placeholder}
          aria-label={t("ai.key.label", { provider: info.name })}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          type="submit"
          className="settings-button"
          data-primary
          disabled={saving || key.trim() === ""}
        >
          {t("ai.key.save")}
        </button>
      </div>
      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}
      <p className="ai-key-note">{t("ai.key.note", { site: info.site })}</p>
    </form>
  );
}

interface Failure {
  question: string;
  error: string;
  ai?: AiFailure;
  at: number;
}

interface ChatViewProps {
  chat?: AiChat;
  pending: boolean;
  failure?: Failure;
  onDismissFailure: () => void;
  ready: boolean;
  keyCard: ReactNode;
  /** The model that answers, by name. */
  modelLabel: string;
  controls: ComposerControls;
  /** The analyst may read the account: its suggestions are offered too. */
  accountAccess: boolean;
  summaries?: MarketSummary[];
  symbolOf: (id: string) => string;
  market?: Market;
  venueLabel: string;
  onAsk: (question: string) => void;
  onShowOnChart: (marks: AiChartMarks) => void;
  onTryCharts: () => void;
}

function ChatView({
  chat,
  pending,
  failure,
  onDismissFailure,
  ready,
  keyCard,
  modelLabel,
  controls,
  accountAccess,
  summaries,
  symbolOf,
  market,
  venueLabel,
  onAsk,
  onShowOnChart,
  onTryCharts,
}: ChatViewProps) {
  const started = chat !== undefined && (chat.messages.length > 0 || pending);
  const pulse = useMemo(() => marketPulse(summaries ?? []), [summaries]);
  const coin = market?.base ?? "BTC";

  if (!started) {
    return (
      <main className="ai-main ai-home">
        <div className="ai-home-inner">
          <button type="button" className="ai-banner" onClick={onTryCharts}>
            <LuChartCandlestick size={22} aria-hidden />
            <span className="ai-banner-text">
              <strong>
                {t("ai.banner.title")} <span className="ai-badge">{t("ai.banner.new")}</span>
              </strong>
              <span>{t("ai.banner.body")}</span>
            </span>
            <span className="ai-banner-cta">{t("ai.banner.cta")}</span>
          </button>
          <h1 className="ai-hero">{t("ai.hero")}</h1>
          {keyCard ?? (
            <Composer
              model={modelLabel}
              controls={controls}
              big
              disabled={!ready}
              busy={pending}
              placeholder={t("ai.placeholder", { venue: venueLabel })}
              onSend={onAsk}
            />
          )}
          {failure && <FailureRow failure={failure} onRetry={onAsk} onDismiss={onDismissFailure} />}
          <section className="ai-insights" aria-labelledby="ai-insights-head">
            <h2 id="ai-insights-head">{t("ai.insights", { venue: venueLabel })}</h2>
            <div className="ai-cards">
              <InsightCard
                label={t("ai.card.breadth")}
                value={
                  pulse.breadth === undefined ? "-" : `${formatNumber(pulse.breadth * 100, 0)}%`
                }
                note={t("ai.card.breadthNote")}
                meter={pulse.breadth}
              />
              <InsightCard
                label={t("ai.card.volume")}
                value={pulse.volume === undefined ? "-" : `$${formatCompact(pulse.volume)}`}
                note={t("ai.card.volumeNote")}
              />
              <InsightCard
                label={t("ai.card.funding")}
                value={
                  pulse.funding === undefined ? "-" : `${formatSigned(pulse.funding * 100, 4)}%`
                }
                note={t("ai.card.fundingNote")}
                tone={pulse.funding === undefined ? undefined : pulse.funding >= 0 ? "up" : "down"}
              />
              <InsightCard
                label={t("ai.card.mover")}
                value={pulse.gainers[0] ? symbolOf(pulse.gainers[0].market) : "-"}
                note={
                  pulse.gainers[0]
                    ? `${formatSigned(pulse.gainers[0].change, 2)}%`
                    : t("ai.card.moverNote")
                }
                tone={pulse.gainers[0] ? "up" : undefined}
              />
            </div>
            <Suggestions
              accountAccess={accountAccess}
              coin={coin}
              disabled={!ready || pending}
              onAsk={onAsk}
            />
          </section>
          <p className="ai-disclaimer">{t("ai.disclaimer")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="ai-main ai-thread-view">
      <header className="ai-thread-head">
        <h1>{chat.title || t("ai.untitled")}</h1>
      </header>
      <Thread
        messages={chat.messages}
        pending={pending}
        failure={failure}
        onRetry={onAsk}
        onDismissFailure={onDismissFailure}
        onShowOnChart={onShowOnChart}
        symbolOf={symbolOf}
      />
      <div className="ai-thread-foot">
        {keyCard ?? (
          <Composer
            model={modelLabel}
            controls={controls}
            disabled={!ready}
            busy={pending}
            placeholder={t("ai.placeholderMore")}
            onSend={onAsk}
          />
        )}
        <p className="ai-disclaimer">{t("ai.disclaimer")}</p>
      </div>
    </main>
  );
}

function InsightCard({
  label,
  value,
  note,
  tone,
  meter,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "up" | "down";
  meter?: number;
}) {
  return (
    <div className="ai-card">
      <span className="ai-card-label">{label}</span>
      <span className="ai-card-value" data-tone={tone}>
        {value}
      </span>
      {meter !== undefined ? (
        <span className="ai-meter" aria-hidden>
          <span style={{ width: `${Math.round(meter * 100)}%` }} />
        </span>
      ) : (
        <span className="ai-card-note">{note}</span>
      )}
    </div>
  );
}

interface ChartViewProps {
  chat?: AiChat;
  pending: boolean;
  failure?: Failure;
  onDismissFailure: () => void;
  ready: boolean;
  keyCard: ReactNode;
  modelLabel: string;
  controls: ComposerControls;
  venue: VenueId;
  venueLabel: string;
  markets: Market[];
  market?: Market;
  interval: CandleInterval;
  onInterval: (interval: CandleInterval) => void;
  /** Marks picked from a chat, shown over the chart chat's own. */
  shown?: AiChartMarks;
  onAsk: (question: string) => void;
  /** Draws an answer's marks again, on their own market and interval. */
  onShowOnChart: (marks: AiChartMarks) => void;
  onTrade: (marketId: string) => void;
}

function ChartView({
  chat,
  pending,
  failure,
  onDismissFailure,
  ready,
  keyCard,
  modelLabel,
  controls,
  venue,
  venueLabel,
  markets,
  market,
  interval,
  onInterval,
  shown,
  onAsk,
  onShowOnChart,
  onTrade,
}: ChartViewProps) {
  const source = useMemo(() => venueBarSource(venue), [venue]);
  const latest = useMemo(
    () => [...(chat?.messages ?? [])].reverse().find((m) => m.marks)?.marks,
    [chat],
  );
  const candidate = shown ?? latest;
  // Drawn only on the market they were made for.
  const marks =
    candidate && market && candidate.venue === venue && candidate.market === market.id
      ? candidate
      : undefined;
  const analysis = useMemo<ChartAnalysis | undefined>(
    () =>
      marks && {
        levels: marks.levels,
        zones: marks.zones,
        fibs: marks.fibs,
        trendLines: marks.trendLines,
      },
    [marks],
  );
  const decimals = market ? decimalsOf(market.tickSize) : 2;
  const symbol = market?.symbol ?? "";

  return (
    <main className="ai-main ai-charts">
      <section className="ai-chart-panel">
        {market ? (
          <OpenAlgoChart
            key={venue}
            source={source}
            venue={venue}
            markets={markets}
            market={market}
            title={`${symbol} · ${interval} · ${venueLabel}`}
            interval={interval}
            onInterval={onInterval}
            analysis={analysis}
            loading={
              <div className="chart-loader" role="status" aria-label={t("chart.loading")}>
                <LoadingMark size={56} />
              </div>
            }
          />
        ) : (
          <div className="chart-loader" role="status" aria-label={t("chart.loading")}>
            <LoadingMark size={56} />
          </div>
        )}
      </section>
      <section className="ai-analyst" aria-labelledby="ai-analyst-head">
        <header className="ai-analyst-head">
          <LuSparkles size={16} aria-hidden />
          <h1 id="ai-analyst-head">{t("ai.analyst")}</h1>
          {market && (
            <button type="button" className="ai-link-button" onClick={() => onTrade(market.id)}>
              {t("ai.trade", { market: symbol })}
            </button>
          )}
        </header>
        {keyCard ?? (
          <button
            type="button"
            className="settings-button ai-analyze"
            data-primary
            disabled={!ready || pending || !market}
            onClick={() =>
              onAsk(t("ai.chart.prompt", { market: symbol, interval, venue: venueLabel }))
            }
          >
            <LuSparkles size={15} aria-hidden />
            {pending ? t("ai.thinking") : t("ai.chart.analyze", { market: symbol, interval })}
          </button>
        )}
        {marks ? (
          <MarksCard marks={marks} decimals={decimals} symbol={symbol} />
        ) : (
          !pending && <p className="ai-analyst-empty">{t("ai.chart.empty")}</p>
        )}
        {chat && (chat.messages.length > 0 || pending) && (
          <Thread
            compact
            messages={chat.messages}
            pending={pending}
            failure={failure}
            onRetry={onAsk}
            onDismissFailure={onDismissFailure}
            onShowOnChart={onShowOnChart}
            drawn={marks}
            symbolOf={(id) => markets.find((m) => m.id === id)?.symbol ?? id}
          />
        )}
        {!chat && failure && (
          <FailureRow failure={failure} onRetry={onAsk} onDismiss={onDismissFailure} />
        )}
        {!keyCard && (
          <Composer
            model={modelLabel}
            controls={controls}
            disabled={!ready || !market}
            busy={pending}
            placeholder={t("ai.chart.placeholder", { market: symbol })}
            onSend={onAsk}
          />
        )}
      </section>
    </main>
  );
}

const BIAS_KEYS = {
  bullish: "ai.bias.bullish",
  bearish: "ai.bias.bearish",
  neutral: "ai.bias.neutral",
} as const satisfies Record<AiChartMarks["bias"], MessageKey>;

const KIND_KEYS = {
  support: "ai.level.support",
  resistance: "ai.level.resistance",
  entry: "ai.level.entry",
  target: "ai.level.target",
  invalidation: "ai.level.invalidation",
} as const satisfies Record<AiChartMarks["levels"][number]["kind"], MessageKey>;

function MarksCard({
  marks,
  decimals,
  symbol,
}: {
  marks: AiChartMarks;
  decimals: number;
  symbol: string;
}) {
  const levels = [...marks.levels].sort((a, b) => b.price - a.price);
  const zones = [...(marks.zones ?? [])].sort((a, b) => b.top - a.top);
  const fibs = marks.fibs?.length ?? 0;
  const lines = marks.trendLines?.length ?? 0;
  const drawnMore = [
    fibs > 0 ? t("ai.drawn.fibs", { count: fibs }) : "",
    lines > 0 ? t("ai.drawn.trendLines", { count: lines }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="ai-marks">
      <div className="ai-marks-head">
        <span className="ai-bias" data-bias={marks.bias}>
          {t(BIAS_KEYS[marks.bias])}
        </span>
        <span className="ai-marks-what">
          {symbol} · {marks.interval}
        </span>
      </div>
      {marks.summary && <p className="ai-marks-summary">{marks.summary}</p>}
      {marks.catalysts && marks.catalysts.length > 0 && (
        <div className="ai-catalysts">
          <h2>{t("ai.catalysts")}</h2>
          <ul>
            {marks.catalysts.map((c) => (
              <li key={`${c.source}:${c.text}`}>
                <span className="ai-source" data-source={c.source}>
                  {t(SOURCE_KEYS[c.source] ?? "ai.source.data")}
                </span>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {zones.length > 0 && (
        <ul className="ai-levels">
          {zones.map((z) => (
            <li key={`${z.kind}:${z.top}:${z.bottom}`} data-kind={z.kind}>
              <span className="ai-level-kind">
                {t(z.kind === "demand" ? "ai.zone.demand" : "ai.zone.supply")}
              </span>
              <span className="ai-level-label">{z.label}</span>
              <span className="ai-level-price">
                {formatNumber(z.bottom, decimals)} – {formatNumber(z.top, decimals)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {drawnMore && <p className="ai-marks-more">{drawnMore}</p>}
      {levels.length > 0 && (
        <ul className="ai-levels">
          {levels.map((l) => (
            <li key={`${l.kind}:${l.price}:${l.label}`} data-kind={l.kind}>
              <span className="ai-level-kind">{t(KIND_KEYS[l.kind])}</span>
              <span className="ai-level-label">{l.label}</span>
              <span className="ai-level-price">{formatNumber(l.price, decimals)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ThreadProps {
  messages: readonly ChatMessage[];
  pending: boolean;
  failure?: Failure;
  onRetry: (question: string) => void;
  onDismissFailure: () => void;
  /** With it, an answer that marked a chart offers to show it there. */
  onShowOnChart?: (marks: AiChartMarks) => void;
  /** The marks on the chart now: their answer says so, instead of offering them. */
  drawn?: AiChartMarks;
  symbolOf: (id: string) => string;
  compact?: boolean;
}

function Thread({
  messages,
  pending,
  failure,
  onRetry,
  onDismissFailure,
  onShowOnChart,
  drawn,
  symbolOf,
  compact = false,
}: ThreadProps) {
  const end = useRef<HTMLDivElement>(null);
  const count = messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when a message or the pending mark arrives
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [count, pending, failure]);
  return (
    <div className="ai-thread" data-compact={compact || undefined} aria-live="polite">
      {messages.map((m, i) =>
        m.role === "user" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: messages are only ever appended
          <div key={i} className="ai-msg" data-role="user">
            <p>{m.text}</p>
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: messages are only ever appended
          <div key={i} className="ai-msg" data-role="assistant">
            {m.tools && m.tools.length > 0 && <ToolTrail tools={m.tools} />}
            {m.note === "refused" ? (
              <p className="ai-note">{t("ai.refused")}</p>
            ) : (
              <RichText text={m.text} />
            )}
            {m.note === "cutShort" && <p className="ai-note">{t("ai.cutShort")}</p>}
            {m.marks && onShowOnChart && m.marks === drawn && (
              <p className="ai-on-chart">
                <LuChartCandlestick size={14} aria-hidden />
                {t("ai.onChart", { count: m.marks.levels.length })}
              </p>
            )}
            {m.marks && onShowOnChart && m.marks !== drawn && (
              <button
                type="button"
                className="ai-show-chart"
                onClick={() => m.marks && onShowOnChart(m.marks)}
              >
                <LuChartCandlestick size={14} aria-hidden />
                {t("ai.showOnChart", {
                  market: symbolOf(m.marks.market),
                  count: m.marks.levels.length,
                })}
              </button>
            )}
          </div>
        ),
      )}
      {pending && (
        <div className="ai-msg ai-pending" data-role="assistant" role="status">
          <span className="ai-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          {t("ai.thinking")}
        </div>
      )}
      {failure && <FailureRow failure={failure} onRetry={onRetry} onDismiss={onDismissFailure} />}
      <div ref={end} />
    </div>
  );
}

function ToolTrail({ tools }: { tools: readonly string[] }) {
  // Each tool once, in the order first used.
  const names = [...new Set(tools)];
  return (
    <p className="ai-tools">
      {names.map((name) => (
        <span key={name}>{TOOL_KEYS[name] ? t(TOOL_KEYS[name]) : name}</span>
      ))}
    </p>
  );
}

/** Seconds left of a wait the provider asked for, counting down; 0 once it's over. */
function useWaitLeft(failure: Failure): number {
  const until = failure.at + (failure.ai?.waitSecs ?? 0) * 1000;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (Date.now() >= until) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** When Google's free daily allowance comes back: midnight Pacific, in this machine's time. */
function pacificMidnight(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const left = 86_400 - (part("hour") * 3600 + part("minute") * 60 + part("second"));
  return dateFormat({ hour: "2-digit", minute: "2-digit" }).format(
    new Date(Date.now() + left * 1000),
  );
}

/** A failed question: what went wrong in words, what to do, and the provider's own text if wanted. */
function FailureRow({
  failure,
  onRetry,
  onDismiss,
}: {
  failure: Failure;
  onRetry: (question: string) => void;
  onDismiss: () => void;
}) {
  const actions = useContext(FailureActions);
  const waitLeft = useWaitLeft(failure);
  const ai = failure.ai;
  const company = ai ? PROVIDER_COMPANY[ai.provider] : "";
  const name = ai ? PROVIDER_INFO[ai.provider].name : "";
  const free = ai?.provider === "gemini";

  let title: string;
  let body: string;
  switch (ai?.kind) {
    case "rate":
      title = t("ai.fail.rate.title", { company });
      body = t(free ? "ai.fail.rate.free" : "ai.fail.rate.body");
      break;
    case "quota":
      title = t("ai.fail.quota.title", { company });
      body = free
        ? t("ai.fail.quota.free", { time: pacificMidnight() })
        : t("ai.fail.quota.body", { company });
      break;
    case "key":
      title = t("ai.fail.key.title", { company });
      body = t("ai.fail.key.body", { name });
      break;
    case "noKey":
      title = t("ai.fail.noKey.title", { name });
      body = t("ai.fail.noKey.body");
      break;
    case "paidModel":
      title = t("ai.fail.paidModel.title");
      body = t("ai.fail.paidModel.body");
      break;
    case "unavailable":
      title = t("ai.fail.unavailable.title", { company });
      body = t("ai.fail.unavailable.body");
      break;
    case "other":
      title = t("ai.fail.other.title", { company });
      body = t("ai.fail.other.body");
      break;
    default:
      title = t("ai.fail.app.title");
      body = failure.error;
  }
  // The provider's words, behind a toggle: useful to report, not to read first.
  const detail = ai?.detail ?? undefined;

  return (
    <div className="ai-failure" role="alert" data-kind={ai?.kind ?? "app"}>
      <LuCircleAlert className="ai-failure-icon" size={18} aria-hidden />
      <div className="ai-failure-main">
        <strong>{title}</strong>
        <p>{body}</p>
        {detail && (
          <details className="ai-failure-detail">
            <summary>{t("ai.fail.detail", { company })}</summary>
            <p>{detail}</p>
          </details>
        )}
        <div className="ai-failure-actions">
          {ai?.kind === "key" && (
            <button
              type="button"
              className="settings-button"
              data-primary
              onClick={() => actions.replaceKey(ai.provider)}
            >
              {t("ai.fail.replaceKey")}
            </button>
          )}
          {ai?.kind === "paidModel" && (
            <button
              type="button"
              className="settings-button"
              data-primary
              onClick={actions.newChat}
            >
              {t("ai.newChat")}
            </button>
          )}
          {ai?.kind !== "key" && ai?.kind !== "noKey" && ai?.kind !== "paidModel" && (
            <button
              type="button"
              className="settings-button"
              data-primary
              disabled={waitLeft > 0}
              onClick={() => onRetry(failure.question)}
            >
              {waitLeft > 0 ? (
                <>
                  <LuClock size={13} aria-hidden /> {t("ai.fail.retryIn", { secs: waitLeft })}
                </>
              ) : (
                t("ai.retry")
              )}
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        className="pd-icon-button"
        title={t("ai.dismiss")}
        aria-label={t("ai.dismiss")}
        onClick={onDismiss}
      >
        <LuX size={14} aria-hidden />
      </button>
    </div>
  );
}

function SpanText({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.kind === "bold" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
          <strong key={i}>{s.text}</strong>
        ) : s.kind === "code" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
          <code key={i}>{s.text}</code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** An answer, as text: headings, paragraphs and lists, never markup or links. */
function RichText({ text }: { text: string }) {
  const blocks = useMemo(() => blocksOf(text), [text]);
  return (
    <div className="ai-rich">
      {blocks.map((b, i) =>
        b.kind === "heading" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks don't move
          <h3 key={i}>
            <SpanText spans={b.spans} />
          </h3>
        ) : b.kind === "paragraph" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks don't move
          <p key={i}>
            <SpanText spans={b.spans} />
          </p>
        ) : b.ordered ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks don't move
          <ol key={i}>
            {b.items.map((item, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items don't move
              <li key={j}>
                <SpanText spans={item} />
              </li>
            ))}
          </ol>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks don't move
          <ul key={i}>
            {b.items.map((item, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items don't move
              <li key={j}>
                <SpanText spans={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** The starter questions, in tabs, as a list: Bybit TradeGPT's home, after its layout. */
function Suggestions({
  accountAccess,
  coin,
  disabled,
  onAsk,
}: {
  accountAccess: boolean;
  coin: string;
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  const tabs: SuggestionTab[] = accountAccess
    ? ["market", "tokens", "account"]
    : ["market", "tokens"];
  const [tab, setTab] = useState<SuggestionTab>("market");
  const shown = tabs.includes(tab) ? tab : "market";
  return (
    <div className="ai-suggest">
      <div className="ai-suggest-tabs" role="tablist" aria-label={t("ai.suggestions")}>
        {tabs.map((id) => (
          <button
            type="button"
            role="tab"
            key={id}
            aria-selected={id === shown}
            onClick={() => setTab(id)}
          >
            {t(TAB_KEYS[id])}
          </button>
        ))}
      </div>
      <ul className="ai-suggest-list" role="tabpanel">
        {SUGGESTION_TABS[shown].map((key) => {
          const text = t(key, { coin });
          return (
            <li key={key}>
              <button type="button" disabled={disabled} onClick={() => onAsk(text)}>
                <LuMessageSquare size={16} className="ai-suggest-icon" aria-hidden />
                <span>{text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Composer({
  model,
  controls,
  disabled,
  busy,
  placeholder,
  onSend,
  big = false,
}: {
  /** The model that answers, by name. */
  model: string;
  controls: ComposerControls;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  big?: boolean;
}) {
  const [text, setText] = useState("");
  const send = () => {
    if (disabled || busy || !text.trim()) return;
    onSend(text);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <form
      className="ai-composer"
      data-big={big || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        value={text}
        rows={big ? 3 : 2}
        maxLength={4000}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="ai-composer-foot">
        <span className="ai-deep" title={t("ai.deep.help")}>
          <LuBrain size={14} aria-hidden />
          <span>{t("ai.deep.title")}</span>
          <Switch label={t("ai.deep.title")} checked={controls.deep} onChange={controls.onDeep} />
        </span>
        {controls.coins.length > 0 && (
          <span className="ai-coins">
            {controls.coins.map(({ market, change }) => (
              <button
                type="button"
                key={market.id}
                className="ai-coin"
                disabled={disabled || busy}
                title={t("ai.coin.ask", { coin: market.base })}
                onClick={() => controls.onCoin(market)}
              >
                <TokenIcon market={market} size={16} />
                <span>{market.base}</span>
                <span className="ai-coin-change" data-tone={change >= 0 ? "up" : "down"}>
                  {formatSigned(change, 1)}%
                </span>
              </button>
            ))}
          </span>
        )}
        <span className="ai-composer-gap" />
        <span className="ai-model">{model}</span>
        <button
          type="submit"
          className="ai-send"
          disabled={disabled || busy || !text.trim()}
          title={t("ai.send")}
          aria-label={t("ai.send")}
        >
          <LuArrowUp size={18} aria-hidden />
        </button>
      </div>
    </form>
  );
}
