import type { Market, VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useState } from "react";
import { LuInfo, LuPlus } from "react-icons/lu";
import type { RunSpec } from "../../lib/backtest";
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
export function BotsPage({ venue, venueLabel, markets, priceOf, marketLabel }: BotsPageProps) {
  const [state, setState] = useState<BotsState>(() => loadBots());
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
    change(bot, { state: "paused", event: { time: Date.now(), kind: "paused" } });
  const resume = (bot: Bot) =>
    change(bot, { state: "running", event: { time: Date.now(), kind: "started" } });
  const openRun = (run: number, tab: BacktestTab = "overview") =>
    setView({ kind: "backtest", run, tab });
  const addRun = (spec: Omit<RunSpec, "id">) => {
    const [next, run] = withRun(state, spec);
    update(next);
    openRun(run.id);
  };
  const paperTrade = (run: RunSpec) => {
    const [withIt, bot] = botForRun(state, run, now);
    update(startPaper(withIt, bot.id, now));
    toSection("paper");
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
          onSaveAsBot={(run) => {
            const [next] = botForRun(state, run, now);
            update(next);
            setFilter("backtest");
            toSection("bots");
          }}
          onPaperTrade={paperTrade}
          marketLabel={mLabel}
          venueLabel={vLabel}
        />
      </div>
    );
  }

  const paperBots = state.bots.filter((b) => b.mode === "paper");
  const count: Record<Section, number> = {
    bots: state.bots.length,
    backtests: state.runs.length,
    paper: paperBots.length,
  };
  const shown = state.bots.filter((b) => filter === "all" || b.mode === filter);
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
      {section === "bots" && state.bots.length === 0 && (
        <Guide fixed onStart={() => setView({ kind: "new" })} />
      )}
      {section === "bots" && state.bots.length > 0 && (
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
                  onStop={(flatten) =>
                    change(bot, {
                      state: "stopped",
                      ...(flatten ? { position: undefined } : {}),
                      event: { time: Date.now(), kind: "stopped" },
                    })
                  }
                  onStartPaper={() => {
                    update(startPaper(state, bot.id, Date.now()));
                    toSection("paper");
                  }}
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

/** Says, on every screen of the page, that none of it trades yet. */
function PreviewNote() {
  return (
    <p className="bt-preview" role="note">
      <LuInfo size={14} aria-hidden />
      {t("bots.preview")}
    </p>
  );
}
