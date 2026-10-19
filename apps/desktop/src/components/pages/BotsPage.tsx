import type { Market, VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useState } from "react";
import { LuInfo, LuPlus } from "react-icons/lu";
import type { RunSpec } from "../../lib/backtest";
import { botEngine, botSpecOf, cardOf, engineHere, useEngineBots } from "../../lib/botEngine";
import {
  type Bot,
  type BotMode,
  type BotsState,
  botForRun,
  loadBots,
  saveBots,
  startPaper,
  withBot,
  withoutRuns,
  withRun,
} from "../../lib/bots";
import { Backtest, type BacktestTab, runName } from "../bots/Backtest";
import { BacktestList } from "../bots/BacktestList";
import { BotCard } from "../bots/BotCard";
import { NewBot } from "../bots/NewBot";
import { PaperList } from "../bots/PaperList";
import { type Crumb, Guide } from "../bots/ui";

type Section = "bots" | "backtests" | "paper";
const SECTIONS: readonly Section[] = ["bots", "backtests", "paper"];
type View =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "backtest"; run: number; tab: BacktestTab };
type Filter = "all" | BotMode;
const FILTERS: readonly Filter[] = ["all", "live", "paper", "backtest"];

/** Where the page was left, so coming back to it lands there again. */
interface Place {
  section: Section;
  view: View;
}
const PLACE_KEY = "pd.bots.place";
function loadPlace(): Place {
  try {
    const saved = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null") as Place | null;
    if (saved && SECTIONS.includes(saved.section) && saved.view?.kind) return saved;
  } catch {
    // Unreadable: the start.
  }
  return { section: "bots", view: { kind: "list" } };
}
function savePlace(place: Place) {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    // Storage unavailable: it's remembered for this visit only.
  }
}

interface BotsPageProps {
  /** The venue on screen: new bots start on it. */
  venue: VenueId;
  venueLabel: (venue: VenueId) => string;
  /** Its markets, for a new bot's market. */
  markets: readonly Market[];
  /** A market's mark price on the venue on screen, if it's known. */
  priceOf: (market: string) => number | undefined;
  /** A market's name as the app shows it, on any venue. */
  marketLabel: (venue: VenueId, market: string) => string;
  /** The account on the venue on screen: the one a bot goes live on. */
  account?: string;
}

/** Which backtest each engine bot came from, kept on this machine. */
const LINKS_KEY = "pd.bots.links";
function loadLinks(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LINKS_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function saveLinks(links: Record<string, number>) {
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(links));
  } catch {
    // Storage unavailable: the link to its backtest is lost with the visit.
  }
}

/**
 * Bots (after the Bots and Backtest mockups in `design/`): each bot goes from
 * a backtest to paper trading for a week, and only then live. Three sections
 * (bots, every backtest, the bots on paper), and a backtest or a new bot
 * opens over them with a trail back. A preview: the engine that will run bots
 * isn't built (`docs/bots/`), so the bots and runs here are samples and
 * simulations made in the page, and nothing reaches a venue. Kept in this
 * browser's storage.
 */
export function BotsPage({
  venue,
  venueLabel,
  markets,
  priceOf,
  marketLabel,
  account,
}: BotsPageProps) {
  const [state, setState] = useState<BotsState>(() => loadBots());
  // With the engine, bots are its own: running, on paper and live.
  const engine = engineHere();
  const engineBots = useEngineBots();
  const [links, setLinks] = useState(loadLinks);
  const [failed, setFailed] = useState<string>();
  const link = (botId: string, runId: number) => {
    const next = { ...links, [botId]: runId };
    setLinks(next);
    saveLinks(next);
  };
  const baseOf = (market: string) => markets.find((m) => m.id === market)?.base ?? market;
  const bots: Bot[] = engine
    ? engineBots.bots.map((view) => cardOf(view, baseOf(view.spec.market), links))
    : state.bots;
  /** Runs an engine command, its failure said on the page. */
  const act = async (task: () => Promise<unknown>) => {
    setFailed(undefined);
    try {
      await task();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : t("error.failed"));
    }
  };
  const [place, setPlace] = useState<Place>(loadPlace);
  const [filter, setFilter] = useState<Filter>("all");
  const { section, view } = place;
  const go = (next: Partial<Place>) => {
    const merged = { ...place, ...next };
    setPlace(merged);
    savePlace(merged);
  };
  const setView = (v: View) => go({ view: v });
  const toSection = (s: Section) => go({ section: s, view: { kind: "list" } });
  const update = (next: BotsState) => {
    setState(next);
    saveBots(next);
  };
  const now = Date.now();
  const change = (bot: Bot, patch: Partial<Bot>) => update(withBot(state, bot.id, patch));
  const pause = (bot: Bot) =>
    engine
      ? void act(() => botEngine.pause(bot.id))
      : change(bot, { state: "paused", event: { time: Date.now(), kind: "paused" } });
  const resume = (bot: Bot) =>
    engine
      ? void act(() =>
          bot.state === "paused" ? botEngine.resume(bot.id) : botEngine.start(bot.id),
        )
      : change(bot, { state: "running", event: { time: Date.now(), kind: "started" } });
  const stop = (bot: Bot, flatten: boolean) =>
    engine
      ? void act(() => botEngine.stop(bot.id, flatten))
      : change(bot, {
          state: "stopped",
          ...(flatten ? { position: undefined } : {}),
          event: { time: Date.now(), kind: "stopped" },
        });
  const goLive = (bot: Bot) => {
    if (!window.confirm(t("bots.engine.goLiveConfirm", { account: account ?? "" }))) return;
    void act(() => botEngine.goLive(bot.id));
  };
  const openRun = (run: number, tab: BacktestTab = "overview") =>
    setView({ kind: "backtest", run, tab });
  const addRun = (spec: Omit<RunSpec, "id">) => {
    // In the app, on the venue's own candles, run by the engine.
    const [next, run] = withRun(state, engine ? { ...spec, source: "venue" } : spec);
    update(next);
    openRun(run.id);
  };
  const paperTrade = (run: RunSpec) => {
    if (engine) {
      void act(async () => {
        const bot = await botEngine.create(botSpecOf(run, account));
        link(bot.id, run.id);
        await botEngine.start(bot.id);
        engineBots.refresh();
        toSection("paper");
      });
      return;
    }
    const [withIt, bot] = botForRun(state, run, now);
    update(startPaper(withIt, bot.id, now));
    toSection("paper");
  };
  const saveAsBot = (run: RunSpec) => {
    if (engine) {
      void act(async () => {
        const bot = await botEngine.create(botSpecOf(run, account));
        link(bot.id, run.id);
        engineBots.refresh();
        toSection("bots");
      });
      return;
    }
    const [next] = botForRun(state, run, now);
    update(next);
    setFilter("backtest");
    toSection("bots");
  };
  const sectionLabel = (s: Section) => t(`bots.section.${s}`);
  const home: Crumb = { label: t("nav.bots"), onClick: () => toSection("bots") };
  const sectionCrumb: Crumb = { label: sectionLabel(section), onClick: () => toSection(section) };
  const trail = section === "bots" ? [home] : [home, sectionCrumb];
  const vLabel = (v: string) => venueLabel(v as VenueId);
  const mLabel = (v: string, m: string) => marketLabel(v as VenueId, m);

  if (view.kind === "new") {
    return (
      <div className="page bots">
        <PreviewNote />
        <NewBot
          crumbs={[...trail, { label: t("bots.newBot") }]}
          venue={venue}
          venueLabel={venueLabel(venue)}
          markets={markets}
          priceOf={priceOf}
          marketLabel={(m) => marketLabel(venue, m)}
          onBack={() => setView({ kind: "list" })}
          onRun={addRun}
        />
      </div>
    );
  }

  if (view.kind === "backtest" && state.runs.length > 0) {
    const spec = state.runs.find((r) => r.id === view.run) ?? state.runs.at(-1);
    return (
      <div className="page bots">
        <PreviewNote />
        <Backtest
          crumbs={[
            home,
            { label: sectionLabel("backtests"), onClick: () => toSection("backtests") },
            { label: spec ? `#${spec.id} · ${runName(spec)}` : t("bots.backtest") },
          ]}
          runs={state.runs}
          run={view.run}
          tab={view.tab}
          onTab={(tab) => setView({ ...view, tab })}
          onRun={(run) => openRun(run, view.tab)}
          onBack={() => setView({ kind: "list" })}
          onNewRun={addRun}
          onDelete={(ids) => update(withoutRuns(state, ids))}
          onSaveAsBot={saveAsBot}
          onPaperTrade={paperTrade}
          marketLabel={mLabel}
          venueLabel={vLabel}
        />
      </div>
    );
  }

  const paperBots = bots.filter((b) => b.mode === "paper");
  const count: Record<Section, number> = {
    bots: bots.length,
    backtests: state.runs.length,
    paper: paperBots.length,
  };
  const shown = bots.filter((b) => filter === "all" || b.mode === filter);
  return (
    <div className="page bots">
      <header className="page-head bots-head">
        <h1>{t("nav.bots")}</h1>
        <nav className="bt-tabs bt-sections" aria-label={t("bots.sections")}>
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              aria-current={section === s ? "page" : undefined}
              onClick={() => toSection(s)}
            >
              {sectionLabel(s)}
              <span className="bt-count pd-num">{count[s]}</span>
            </button>
          ))}
        </nav>
        <span className="bt-spacer" />
        <button
          type="button"
          className="bt-button"
          data-primary
          onClick={() => setView({ kind: "new" })}
        >
          <LuPlus size={14} aria-hidden />
          {t("bots.new")}
        </button>
      </header>
      <PreviewNote />
      {failed && (
        <p className="settings-error" role="alert">
          {failed}
        </p>
      )}
      {section === "bots" && bots.length === 0 && (
        <Guide fixed onStart={() => setView({ kind: "new" })} />
      )}
      {section === "bots" && bots.length > 0 && (
        <>
          <Guide onStart={() => setView({ kind: "new" })} />
          <div className="bt-toolbar">
            <div className="bt-seg" role="radiogroup" aria-label={t("bots.filter")}>
              {FILTERS.map((f) => (
                // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {t(`bots.filter.${f}`)}
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="pd-empty">{t("bots.none")}</p>
          ) : (
            <div className="bt-cards">
              {shown.map((bot) => (
                <BotCard
                  key={bot.id}
                  bot={bot}
                  venueLabel={venueLabel(bot.venue)}
                  marketLabel={marketLabel(bot.venue, bot.market)}
                  onStart={() => resume(bot)}
                  onPause={() => pause(bot)}
                  onStop={(flatten) => stop(bot, flatten)}
                  onStartPaper={() => {
                    if (engine) void act(() => botEngine.start(bot.id));
                    else update(startPaper(state, bot.id, Date.now()));
                    toSection("paper");
                  }}
                  onGoLive={engine ? () => goLive(bot) : undefined}
                  onOpenBacktest={
                    bot.run === undefined ? undefined : () => openRun(bot.run as number)
                  }
                />
              ))}
            </div>
          )}
        </>
      )}
      {section === "bots" && <p className="bt-footnote">{t("bots.gateNote")}</p>}
      {section === "backtests" && (
        <BacktestList
          runs={state.runs}
          onOpen={(run) => openRun(run)}
          onNew={() => setView({ kind: "new" })}
          marketLabel={mLabel}
          venueLabel={vLabel}
        />
      )}
      {section === "paper" && (
        <PaperList
          bots={paperBots}
          runs={state.runs}
          onPause={pause}
          onResume={resume}
          onOpenRun={(run) => openRun(run)}
          onPick={() => toSection("backtests")}
          marketLabel={(b) => marketLabel(b.venue, b.market)}
          venueLabel={(b) => venueLabel(b.venue)}
        />
      )}
    </div>
  );
}

/**
 * Says, on every screen of the page, what runs where: in the app, the
 * engine (the venue's candles; paper, then live through the trading gate);
 * in a browser alone, a preview on sample candles that trades nothing.
 */
function PreviewNote() {
  return (
    <p className="bt-preview" role="note">
      <LuInfo size={14} aria-hidden />
      {engineHere() ? t("bots.engine.note") : t("bots.preview")}
    </p>
  );
}
