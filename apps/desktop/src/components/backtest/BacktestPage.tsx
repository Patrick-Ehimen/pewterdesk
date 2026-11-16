import type { Market, VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LuFlaskConical, LuPlay } from "react-icons/lu";
import { venueClient } from "../../api/venueClient";
import {
  type LabStrategy,
  lastRunOf,
  loadStrategies,
  newId,
  type Part,
  runBacktest,
  saveStrategies,
  setParam,
  type Template,
} from "../../lib/backtestLab";
import type { RulesView } from "../../lib/tradingRules";
import { VENUES } from "../../lib/venues";
import { BuilderView, defaultConfig, problems } from "./BuilderView";
import { LibraryView } from "./LibraryView";
import { OptimizeView } from "./OptimizeView";
import { PartsView } from "./PartsView";
import { StartView } from "./StartView";

const TABS = ["library", "builder", "results", "report", "optimize"] as const;
type Tab = (typeof TABS)[number];

const PLACE_KEY = "pd.backtest.place";
function loadPlace(): { tab?: string; selectedId?: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "{}") as unknown;
    if (typeof raw === "object" && raw !== null) {
      const { tab, selectedId } = raw as Record<string, unknown>;
      return {
        tab: typeof tab === "string" ? tab : undefined,
        selectedId: typeof selectedId === "string" ? selectedId : undefined,
      };
    }
  } catch {
    // Unreadable: the library.
  }
  return {};
}
function savePlace(place: { tab: string; selectedId?: string }) {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    // Full or off: kept for this session.
  }
}

type RunState =
  | { status: "running"; at: number }
  | { status: "done"; at: number; parts: Part[]; version: number }
  | { status: "error"; at: number; error: string };

/**
 * The Backtest page: a library of strategies, a builder for them, and the
 * engine's backtests of them - results on the market's own chart, a report,
 * and an optimizer over their settings. It reads candles and places nothing.
 */
export function BacktestPage({
  venue,
  markets,
  priceOf,
}: {
  /** The venue on screen: new strategies start on it. */
  venue: VenueId;
  /** Its markets, for a new strategy's first market. */
  markets: readonly Market[];
  priceOf: (venue: VenueId, market: string) => number | undefined;
}) {
  const [strategies, setStrategies] = useState<LabStrategy[]>(loadStrategies);
  useEffect(() => saveStrategies(strategies), [strategies]);
  // Where the trader was: the tab and the strategy, kept between sessions too.
  const [selectedId, setSelectedId] = useState<string | undefined>(() => {
    const kept = loadPlace().selectedId;
    return strategies.some((s) => s.id === kept)
      ? kept
      : (strategies.find((s) => s.active)?.id ?? strategies[0]?.id);
  });
  const [tab, setTab] = useState<Tab>(() => {
    const kept = loadPlace().tab;
    return TABS.find((x) => x === kept) ?? "library";
  });
  useEffect(() => savePlace({ tab, selectedId }), [tab, selectedId]);
  const [draft, setDraft] = useState<LabStrategy>();
  // The accounts' trading rules, for the builder's guard rails; none if they can't be read.
  const [ruleSets, setRuleSets] = useState<RulesView[]>([]);
  useEffect(() => {
    if (tab !== "builder") return;
    let live = true;
    venueClient.tradingRules().then(
      (list) => live && setRuleSets(list.filter((v) => v.on)),
      () => live && setRuleSets([]),
    );
    return () => {
      live = false;
    };
  }, [tab]);
  const [runs, setRuns] = useState<Record<string, RunState>>({});

  const selected = strategies.find((s) => s.id === selectedId);
  const running = useMemo(
    () => new Set(Object.entries(runs).flatMap(([id, r]) => (r.status === "running" ? [id] : []))),
    [runs],
  );

  const run = useCallback((s: LabStrategy, show = true) => {
    const at = Date.now();
    setRuns((r) => ({ ...r, [s.id]: { status: "running", at } }));
    setSelectedId(s.id);
    if (show) setTab("results");
    runBacktest(s).then(
      (parts) => {
        setRuns((r) => ({ ...r, [s.id]: { status: "done", at, parts, version: s.version } }));
        setStrategies((list) =>
          list.map((x) => (x.id === s.id ? { ...x, last: lastRunOf(s, parts, at) } : x)),
        );
      },
      (e: unknown) =>
        setRuns((r) => ({
          ...r,
          [s.id]: { status: "error", at, error: e instanceof Error ? e.message : String(e) },
        })),
    );
  }, []);

  /** The draft into the library: replaced in place, a new version when its strategy changed. */
  const commit = (d: LabStrategy): LabStrategy => {
    const was = strategies.find((s) => s.id === d.id);
    const changed =
      !was ||
      JSON.stringify({ ...was, last: undefined, updatedAt: 0, version: 0 }) !==
        JSON.stringify({ ...d, last: undefined, updatedAt: 0, version: 0 });
    const next: LabStrategy = was
      ? {
          ...d,
          version: changed ? was.version + 1 : was.version,
          updatedAt: changed ? Date.now() : was.updatedAt,
          last: changed ? undefined : was.last,
        }
      : { ...d, updatedAt: Date.now() };
    setStrategies((list) => (was ? list.map((s) => (s.id === d.id ? next : s)) : [next, ...list]));
    setDraft(next);
    setSelectedId(next.id);
    return next;
  };

  const edit = (id: string) => {
    const s = strategies.find((x) => x.id === id);
    if (!s) return;
    setDraft(s);
    setSelectedId(id);
    setTab("builder");
  };

  // The start screen: an empty library, or "New strategy".
  const [starting, setStarting] = useState(false);
  const startRun = (s: LabStrategy) => {
    setStrategies((list) => [s, ...list]);
    setStarting(false);
    run(s);
  };
  const startBuild = (s: LabStrategy) => {
    setDraft(s);
    setSelectedId(s.id);
    setStarting(false);
    setTab("builder");
  };

  // A fresh strategy for the builder when none is picked: BTC on the venue on
  // screen, an EMA cross to start from. Kept until the venue or its list changes.
  const btcId = (markets.find((m) => m.base.toUpperCase() === "BTC") ?? markets[0])?.id ?? "";
  const blank = useMemo<LabStrategy>(
    () => ({
      id: newId(),
      name: t("bt.builder.newName"),
      active: true,
      venue,
      market: btcId,
      interval: "4h",
      period: "1y",
      holdOutDays: 60,
      capital: 10_000,
      slippageBps: 5,
      strategy: defaultConfig("ema"),
      version: 1,
      updatedAt: Date.now(),
    }),
    [venue, btcId],
  );
  // The draft being edited, unless another saved strategy has been picked
  // since; else the picked strategy; else a fresh one.
  const builderDraft =
    (draft && (draft.id === selectedId || !strategies.some((s) => s.id === draft.id))
      ? draft
      : selected) ?? blank;
  const saved = strategies.find((s) => s.id === builderDraft.id);
  const dirty =
    !saved ||
    JSON.stringify({ ...saved, last: undefined }) !==
      JSON.stringify({ ...builderDraft, last: undefined });

  const state = selected ? runs[selected.id] : undefined;
  const result = state?.status === "done" ? state : undefined;
  const stale = result && selected && result.version !== selected.version;

  const runSelected = () => selected && problems(selected).length === 0 && run(selected);

  return (
    <div className="page lab-page">
      <div className="lab-bar">
        <h1>
          <LuFlaskConical size={17} aria-hidden />
          {t("bt.title")}
        </h1>
        <nav className="lab-tabs" aria-label={t("bt.title")}>
          {TABS.map((x) => (
            <button
              key={x}
              type="button"
              className={tab === x ? "on" : undefined}
              onClick={() => setTab(x)}
            >
              {t(`bt.tab.${x}`)}
              {x === "library" && <span className="lab-count">{strategies.length}</span>}
            </button>
          ))}
        </nav>
        <span className="lab-grow" />
        {tab === "builder" ? (
          <>
            <span className="lab-dim">
              {builderDraft.name} · v{builderDraft.version}
            </span>
            <button
              type="button"
              className="lab-btn"
              disabled={!dirty || problems(builderDraft).length > 0}
              title={dirty ? undefined : t("bt.builder.saved")}
              onClick={() => commit(builderDraft)}
            >
              {dirty ? t("bt.builder.save") : t("bt.builder.saved")}
            </button>
          </>
        ) : (
          selected && (
            <>
              <span className="lab-dim">
                {selected.name} · v{selected.version}
              </span>
              <button
                type="button"
                className="lab-btn primary"
                disabled={running.has(selected.id) || problems(selected).length > 0}
                onClick={runSelected}
              >
                <LuPlay size={12} aria-hidden />
                {running.has(selected.id) ? t("bt.running") : t("bt.runBacktest")}
              </button>
            </>
          )
        )}
      </div>

      <div className="lab-body">
        {tab === "library" && (strategies.length === 0 || starting) && (
          <StartView
            venue={venue}
            markets={markets}
            priceOf={priceOf}
            hasStrategies={strategies.length > 0}
            onRun={startRun}
            onBuild={startBuild}
            onBack={() => setStarting(false)}
          />
        )}
        {tab === "library" && strategies.length > 0 && !starting && (
          <LibraryView
            strategies={strategies}
            selectedId={selectedId}
            running={running}
            onSelect={setSelectedId}
            onRun={(id) => {
              const s = strategies.find((x) => x.id === id);
              if (s) run(s);
            }}
            onEdit={edit}
            onNew={() => setStarting(true)}
            onDuplicate={(id) => {
              const s = strategies.find((x) => x.id === id);
              if (!s) return;
              const copy = {
                ...s,
                id: newId(),
                name: t("bt.lib.copyOf", { name: s.name }),
                active: false,
                version: 1,
                last: undefined,
                updatedAt: Date.now(),
              };
              setStrategies((list) => [copy, ...list]);
              setSelectedId(copy.id);
            }}
            onDelete={(id) => {
              setStrategies((list) => list.filter((s) => s.id !== id));
              setSelectedId((cur) => (cur === id ? undefined : cur));
              if (draft?.id === id) setDraft(undefined);
            }}
            onToggleActive={(id) =>
              setStrategies((list) =>
                list.map((s) => (s.id === id ? { ...s, active: !s.active } : s)),
              )
            }
          />
        )}

        {tab === "builder" && (
          <BuilderView
            key={builderDraft.id}
            draft={builderDraft}
            onChange={setDraft}
            dirty={dirty}
            running={running.has(builderDraft.id)}
            lastPrice={priceOf(builderDraft.venue, builderDraft.market)}
            ruleSets={ruleSets}
            accountName={(v) =>
              v.name ||
              `${VENUES[v.account.venue].label} · ${v.account.id.length > 12 ? `${v.account.id.slice(0, 6)}…${v.account.id.slice(-4)}` : v.account.id}`
            }
            onRun={() => run(commit(builderDraft))}
          />
        )}

        {(tab === "results" || tab === "report") &&
          (!selected ? (
            <Empty onLibrary={() => setTab("library")} text={t("bt.empty.pick")} />
          ) : state?.status === "running" ? (
            <div className="lab-panel lab-empty lab-wait">
              <LuFlaskConical size={22} aria-hidden />
              <p>{t("bt.wait", { name: selected.name })}</p>
              <span className="lab-dim">{t("bt.waitHint")}</span>
            </div>
          ) : state?.status === "error" ? (
            <div className="lab-panel lab-empty">
              <p className="lab-warn">{state.error}</p>
              <button type="button" className="lab-btn" onClick={() => edit(selected.id)}>
                {t("bt.lib.edit")}
              </button>
            </div>
          ) : result ? (
            <>
              {stale && (
                <div className="lab-stale">
                  {t("bt.stale")}
                  <button type="button" className="lab-btn small" onClick={runSelected}>
                    {t("bt.runAgain")}
                  </button>
                </div>
              )}
              <PartsView
                key={`${selected.id}:${result.at}`}
                tab={tab}
                strategy={selected}
                parts={result.parts}
                ranAt={result.at}
                actions={{
                  onEdit: (patch) => commit({ ...selected, ...patch }),
                  onBuild: (patch) => {
                    setDraft({ ...selected, ...patch });
                    setTab("builder");
                  },
                  onRun: runSelected,
                  canRun: problems(selected).length === 0,
                  running: running.has(selected.id),
                  library: strategies,
                  onOpen: setSelectedId,
                  onLibrary: () => setTab("library"),
                }}
              />
            </>
          ) : (
            <div className="lab-panel lab-empty">
              <p>{t("bt.empty.notRun", { name: selected.name })}</p>
              <button type="button" className="lab-btn primary" onClick={runSelected}>
                <LuPlay size={12} aria-hidden />
                {t("bt.runBacktest")}
              </button>
            </div>
          ))}

        {tab === "optimize" &&
          (selected ? (
            <OptimizeView
              key={`${selected.id}:${selected.version}`}
              strategy={selected}
              onApply={(patch) => {
                let cfg = selected.strategy;
                for (const [k, v] of Object.entries(patch)) cfg = setParam(cfg, k, v);
                const next = commit({ ...selected, strategy: cfg });
                run(next);
              }}
            />
          ) : (
            <Empty onLibrary={() => setTab("library")} text={t("bt.empty.pick")} />
          ))}
      </div>
    </div>
  );
}

function Empty({ text, onLibrary }: { text: string; onLibrary: () => void }) {
  return (
    <div className="lab-panel lab-empty">
      <p>{text}</p>
      <button type="button" className="lab-btn" onClick={onLibrary}>
        {t("bt.toLibrary")}
      </button>
    </div>
  );
}
