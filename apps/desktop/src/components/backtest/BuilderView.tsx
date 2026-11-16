import { venueLogos } from "@pewterdesk/assets";
import type { StrategyConfig, VenueId } from "@pewterdesk/core";
import { PeriodChart, type PeriodSeries, Select, TokenIcon, t } from "@pewterdesk/ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { LuCheck, LuPlay, LuWandSparkles, LuX } from "react-icons/lu";
import { venueClient } from "../../api/venueClient";
import { useBacktestPreview } from "../../hooks/useBacktestPreview";
import {
  ACCOUNTS,
  type Account,
  allMarkets,
  INTERVAL_MS,
  LAB_INTERVALS,
  type LabInterval,
  type LabStrategy,
  MAX_MARKETS,
  maxDrawdown,
  PERIODS,
  type PeriodKind,
  periodRange,
  TEMPLATES,
  type Template,
  VENUE_FEES,
} from "../../lib/backtestLab";
import {
  defaultRules,
  emaAsRules,
  type FullRules,
  fullRules,
  isGroup,
  isRules,
  lastAtr,
  riskShare,
  sizePreview,
} from "../../lib/rules";
import type { RulesView } from "../../lib/tradingRules";
import { VENUE_IDS, VENUES } from "../../lib/venues";
import { RiskSide, RulesSide } from "./BuilderSide";
import { DatePicker } from "./DatePicker";
import {
  day,
  MarketPicker,
  money,
  NumField,
  pct,
  price,
  Seg,
  Sentence,
  useVenueMarkets,
} from "./parts";
import { RiskEditor } from "./RiskEditor";
import { RulesEditor } from "./RulesEditor";
import { condBrief } from "./ruleText";

const DAY = 86_400_000;

/** A template's first settings; a grid's around `near`, the market's price. */
export function defaultConfig(template: Template, near = 100): StrategyConfig {
  switch (template) {
    case "ema":
      return {
        template: "ema",
        fast: 9,
        slow: 21,
        stopAtr: 2,
        risk: 0.01,
        maxLeverage: 3,
        direction: "long",
      };
    case "grid": {
      const r = (v: number) => Number(v.toPrecision(5));
      return {
        template: "grid",
        lower: r(near * 0.92),
        upper: r(near * 1.08),
        levels: 10,
        sizePerLevel: r(1000 / near),
        stopBelow: r(near * 0.85),
        stopAbove: r(near * 1.15),
      };
    }
    case "dca":
      return { template: "dca", every: 6, amount: 250, takeProfit: 0.08, maxBuys: 12 };
    case "custom":
      return defaultRules();
  }
}

/** What would stop the engine running it, in words; none when it can run. */
export function problems(s: LabStrategy): string[] {
  const out: string[] = [];
  const c = s.strategy;
  if (!s.name.trim()) out.push(t("bt.problem.name"));
  if (!s.market) out.push(t("bt.problem.market"));
  if (!(s.capital > 0)) out.push(t("bt.problem.capital"));
  const { since, until } = periodRange(s);
  if (until <= since) out.push(t("bt.problem.period"));
  if ((until - since) / INTERVAL_MS[s.interval] > 40_000) out.push(t("bt.problem.tooLong"));
  if (s.holdOutDays * DAY >= until - since) out.push(t("bt.problem.holdOut"));
  if (c.template === "ema") {
    if (!(c.fast > 0 && c.slow > c.fast)) out.push(t("bt.problem.emaOrder"));
    if (!(c.risk > 0 && c.risk <= 0.1) || !(c.stopAtr > 0)) out.push(t("bt.problem.risk"));
    if (!(c.maxLeverage > 0 && c.maxLeverage <= 20)) out.push(t("bt.problem.leverage"));
  }
  if (c.template === "grid") {
    if (!(c.upper > c.lower && c.lower > 0) || c.levels < 2) out.push(t("bt.problem.gridRange"));
    if (!(c.stopBelow < c.lower && c.stopAbove > c.upper)) out.push(t("bt.problem.gridStops"));
  }
  if (c.template === "dca" && !(c.every >= 1 && c.amount > 0 && c.takeProfit > 0 && c.maxBuys >= 1))
    out.push(t("bt.problem.dca"));
  if (isRules(c)) out.push(...rulesProblems(fullRules(c)));
  return out;
}

/** A rules strategy's own problems, as the engine's check would find them. */
function rulesProblems(c: FullRules): string[] {
  const out: string[] = [];
  if (c.entry.length === 0) out.push(t("bt.problem.entry"));
  if ([...c.entry, ...c.exit].some((x) => isGroup(x) && x.conds.length === 0))
    out.push(t("bt.problem.emptyGroup"));
  const rules = [...c.entry, ...c.exit].flatMap((x) => (isGroup(x) ? x.conds : [x]));
  if (
    rules.some(
      (r) =>
        [r.left, r.right].some((s) => "period" in s && !(s.period >= 1 && s.period <= 500)) ||
        (r.right.kind === "value" && !Number.isFinite(r.right.value)),
    )
  )
    out.push(t("bt.problem.ruleNumbers"));
  const stopped = c.stop ? c.stop.kind !== "none" : c.stopLoss > 0;
  const s = c.sizing;
  if (s?.kind === "risk" && !(s.risk > 0 && s.risk <= 0.1)) out.push(t("bt.problem.risk"));
  if (s?.kind === "kelly" && !(s.maxRisk > 0 && s.maxRisk <= 0.1)) out.push(t("bt.problem.risk"));
  if (s?.kind === "fixed" && !(s.amount > 0)) out.push(t("bt.problem.amount"));
  if (s?.kind === "equity" && !(s.share > 0 && s.share <= 20)) out.push(t("bt.problem.share"));
  if (s?.kind === "volatility" && !(s.target > 0 && s.target <= 0.2))
    out.push(t("bt.problem.volTarget"));
  if ((s?.kind === "risk" || s?.kind === "kelly") && !stopped) out.push(t("bt.problem.needsStop"));
  if ((c.breakevenAt !== undefined || c.trail || c.targets.length > 0) && !stopped)
    out.push(t("bt.problem.needsStop"));
  if (c.maxLeverage !== undefined && !(c.maxLeverage > 0 && c.maxLeverage <= 100))
    out.push(t("bt.problem.leverageRules"));
  if (
    c.targets.some((x) => !(x.atR > 0 && x.close > 0)) ||
    c.targets.reduce((a, x) => a + x.close, 0) > 1 + 1e-9
  )
    out.push(t("bt.problem.targets"));
  if (c.stop?.kind === "fixed" && !(c.stop.pct > 0 && c.stop.pct < 1))
    out.push(t("bt.problem.stop"));
  if (c.stop?.kind === "atr" && !(c.stop.mult > 0)) out.push(t("bt.problem.stop"));
  if (c.stop?.kind === "swing" && !(c.stop.lookback >= 2 && c.stop.lookback <= 500))
    out.push(t("bt.problem.stop"));
  if (c.hours && c.hours.from === c.hours.to) out.push(t("bt.problem.hours"));
  return [...new Set(out)];
}

const STEPS = ["market", "entry", "exit", "risk", "costs", "review"] as const;

/** Periods worth testing a strategy through: sharp moves, either way. */
const STRESS = [
  { key: "aug24", from: Date.UTC(2024, 6, 25), to: Date.UTC(2024, 7, 20) },
  { key: "ftx", from: Date.UTC(2022, 10, 1), to: Date.UTC(2022, 10, 30) },
  { key: "may21", from: Date.UTC(2021, 4, 1), to: Date.UTC(2021, 5, 1) },
  { key: "etf24", from: Date.UTC(2024, 0, 1), to: Date.UTC(2024, 2, 31) },
] as const;

/** A strategy in a few words, for its step. */
function strategyBrief(c: StrategyConfig): string {
  switch (c.template) {
    case "ema":
      return `EMA ${c.fast} × ${c.slow} · ${c.stopAtr}× ATR · ${t(`bt.dir.${c.direction}`)}`;
    case "grid":
      return `${t("bt.tpl.grid")} · ${c.levels} · ${price(c.lower)}–${price(c.upper)}`;
    case "dca":
      return `${t("bt.tpl.dca")} · ${money(c.amount)} / ${c.every}`;
    case "custom":
      return `${t(`bt.side.${c.side}`)}: ${briefList(c.entry)}`;
  }
}

/** Conditions in a few words each, the first three, then how many more. */
function briefList(conds: readonly Parameters<typeof condBrief>[0][]): string {
  const words = conds.slice(0, 3).map(condBrief);
  if (conds.length > 3) words.push(t("bt.brief.more", { n: conds.length - 3 }));
  return words.join(", ");
}

/** A rules strategy's exits, in a few words. */
function exitBrief(c: FullRules): string {
  return c.exit.length > 0 ? briefList(c.exit) : t("bt.brief.noExit");
}

/** How long ago a time was, in the fewest words. */
function ago(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 1) return t("bt.builder.agoNow");
  if (min < 60) return t("bt.builder.agoMin", { n: min });
  if (min < 60 * 24) return t("bt.builder.agoHour", { n: Math.floor(min / 60) });
  return t("bt.builder.agoDay", { n: Math.floor(min / (60 * 24)) });
}

/** A rules strategy's size and exits in R, in a few words. */
function riskBrief(c: FullRules): string {
  const s = c.sizing;
  const size = !s
    ? t("bt.brief.sizeX", { x: c.size })
    : s.kind === "risk"
      ? t("bt.brief.risk", { pct: Number((s.risk * 100).toFixed(2)) })
      : t(`bt.sizing.${s.kind}`);
  return c.targets.length > 0
    ? `${size} · ${t("bt.brief.scale", { at: c.targets.map((x) => `${x.atR}R`).join(", ") })}`
    : size;
}

const PERIOD_TONES = ["line", "brass", "info", "warning", "muted"] as const;

/**
 * Each market's daily closes over the period, drawn by TradingView's chart,
 * and what each did. One market reads as tiles; several, as a legend.
 */
function PeriodPanel({
  venue,
  markets,
  since,
  until,
  holdOutDays,
}: {
  venue: VenueId;
  markets: readonly { id: string; name: string; base: string }[];
  since: number;
  until: number;
  holdOutDays: number;
}) {
  const [loaded, setLoaded] = useState<Record<string, { time: number; value: number }[]>>();
  const ids = markets.map((m) => m.id).join(",");
  useEffect(() => {
    const list = ids.split(",").filter(Boolean);
    if (list.length === 0) return;
    let live = true;
    setLoaded(undefined);
    const count = Math.min(1000, Math.ceil((until - since) / DAY) + 2);
    Promise.all(
      list.map((id) =>
        venueClient.candles(venue, id, "1d", until + DAY, count).then(
          (cs) =>
            [
              id,
              cs
                .filter((c) => c.openTime >= since - DAY)
                .map((c) => ({ time: c.openTime, value: Number(c.close) }))
                .filter((p) => Number.isFinite(p.value)),
            ] as const,
          () => [id, []] as const,
        ),
      ),
    ).then((rows) => live && setLoaded(Object.fromEntries(rows)));
    return () => {
      live = false;
    };
  }, [venue, ids, since, until]);

  const rows = useMemo(
    () =>
      markets.map((m, k) => {
        const points = loaded?.[m.id] ?? [];
        const first = points[0]?.value;
        const last = points.at(-1)?.value;
        return {
          ...m,
          tone:
            markets.length > 1
              ? (PERIOD_TONES[k % PERIOD_TONES.length] ?? "muted")
              : ("line" as const),
          points,
          change: first && last ? last / first - 1 : undefined,
          fall: points.length > 1 ? maxDrawdown(points.map((p) => p.value)) : undefined,
        };
      }),
    [markets, loaded],
  );
  const series = useMemo<PeriodSeries[]>(
    () =>
      rows
        .filter((r) => r.points.length > 1)
        .map((r) => ({ label: r.name, tone: r.tone, points: r.points })),
    [rows],
  );
  const split = holdOutDays > 0 ? until - holdOutDays * DAY : undefined;
  const one = rows[0];
  const kind = (change?: number, fall?: number) =>
    change === undefined || fall === undefined
      ? "–"
      : t(
          change > 0.15
            ? "bt.builder.kindUp"
            : change < -0.15
              ? "bt.builder.kindDown"
              : fall < -0.25
                ? "bt.builder.kindChoppy"
                : "bt.builder.kindFlat",
        );
  return (
    <>
      <div className="lab-period-chart">
        {loaded === undefined ? (
          <p className="lab-dim">{t("bt.loading")}</p>
        ) : series.length === 0 ? (
          <p className="lab-dim">{t("bt.builder.noHistory")}</p>
        ) : (
          <PeriodChart
            series={series}
            holdOutFrom={split}
            heldOutLabel={t("bt.chart.heldOutFrom")}
          />
        )}
      </div>
      {rows.length > 1 ? (
        <div className="lab-period-legend">
          <span className="lab-dim">{t("bt.builder.legendMarket")}</span>
          <span className="lab-dim">{t("bt.builder.legendChange")}</span>
          <span className="lab-dim">{t("bt.builder.worstFall")}</span>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <span className="lab-legend-name">
                <i className={`lab-swatch tone-${r.tone}`} />
                {r.name}
              </span>
              <b className={r.change === undefined ? undefined : r.change >= 0 ? "up" : "dn"}>
                {r.change === undefined ? "–" : pct(r.change, 0)}
              </b>
              <b className="dn">{r.fall === undefined ? "–" : pct(r.fall, 0)}</b>
            </Fragment>
          ))}
        </div>
      ) : one ? (
        <div className="lab-tiles three lab-pad">
          <div className="lab-tile">
            <span>{t("bt.builder.over", { symbol: one.base })}</span>
            <b className={one.change === undefined ? undefined : one.change >= 0 ? "up" : "dn"}>
              {one.change === undefined ? "–" : pct(one.change, 0)}
            </b>
          </div>
          <div className="lab-tile">
            <span>{t("bt.builder.worstFall")}</span>
            <b className="dn">{one.fall === undefined ? "–" : pct(one.fall, 0)}</b>
          </div>
          <div className="lab-tile">
            <span>{t("bt.builder.kind")}</span>
            <b className="lab-kind">{kind(one.change, one.fall)}</b>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function BuilderView({
  draft,
  onChange,
  onRun,
  running,
  dirty,
  lastPrice,
  ruleSets = [],
  accountName = (v) => v.name || v.account.id,
}: {
  draft: LabStrategy;
  onChange: (s: LabStrategy) => void;
  onRun: () => void;
  running: boolean;
  dirty: boolean;
  /** The market's price, for a grid's first range. */
  lastPrice?: number;
  /** The accounts' trading rules, to take the guard rails from. */
  ruleSets?: readonly RulesView[];
  accountName?: (v: RulesView) => string;
}) {
  const set = (patch: Partial<LabStrategy>) => onChange({ ...draft, ...patch });
  const setCfg = (patch: Record<string, unknown>) =>
    set({ strategy: { ...draft.strategy, ...patch } as StrategyConfig });
  const c = draft.strategy;
  const range = periodRange(draft);
  const issues = problems(draft);
  const fees = VENUE_FEES[draft.venue];
  const rules = isRules(c) ? fullRules(c) : undefined;
  const setRules = (patch: Partial<FullRules>) =>
    rules && set({ strategy: { ...rules, ...patch } as StrategyConfig });

  const pickTemplate = (tpl: Template) => {
    if (tpl === c.template) return;
    set({ strategy: defaultConfig(tpl, lastPrice) });
  };

  const [step, setStep] = useState(0);
  const [view, setView] = useState<"blocks" | "text">("blocks");
  // Entry and exit share a page; the Exit step brings the exit into view.
  const exitRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (step === 2) exitRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    else formRef.current?.scrollTo({ top: 0 });
  }, [step]);
  // The draft run on its first market as it changes, for the counts and charts.
  const showsPreview = rules !== undefined && step >= 1 && step <= 3 && issues.length === 0;
  const {
    preview,
    current,
    running: previewing,
    error: previewError,
  } = useBacktestPreview(draft, showsPreview);
  const previewRun = preview?.run;
  const atr = useMemo(() => (previewRun ? lastAtr(previewRun.bars) : undefined), [previewRun]);
  const nowPrice = previewRun?.bars.at(-1)?.close ?? lastPrice;
  const sized = rules && nowPrice ? sizePreview(rules, draft.capital, nowPrice, atr) : undefined;
  // The counts beside each condition, while the preview is the draft's.
  const funnel = current ? previewRun?.funnel : undefined;
  const entryCounts = rules?.entry.map((_, i) => {
    const n = funnel?.entry[i];
    if (n === undefined) return undefined;
    if (rules.entryMatch === "any" || i === 0) return t("bt.count.times", { n });
    return n === funnel?.entry[i - 1] ? t("bt.count.noChange") : t("bt.count.left", { n });
  });
  const exitCounts = rules?.exit.map((_, i) => {
    const n = funnel?.exits[i];
    return n === undefined ? undefined : t("bt.count.exits", { n });
  });
  const markets = useVenueMarkets(draft.venue);
  const marketInfo = markets?.find((m) => m.id === draft.market);
  const marketLabel = marketInfo?.symbol ?? (draft.market || "–");
  const days = Math.max(0, Math.round((range.until - range.since) / DAY));
  const candles = Math.round((range.until - range.since) / INTERVAL_MS[draft.interval]) + 1;
  const picked = allMarkets(draft);
  const setMarkets = (list: string[]) => set({ market: list[0] ?? "", extra: list.slice(1) });
  const pickedKey = picked.join(",");
  // The period's markets, kept the same between renders so its chart isn't redrawn.
  const periodMarkets = useMemo(
    () =>
      pickedKey
        .split(",")
        .filter(Boolean)
        .map((id) => {
          const m = markets?.find((x) => x.id === id);
          return { id, name: m?.symbol ?? id, base: m?.base ?? id };
        }),
    [pickedKey, markets],
  );
  const marketsSay = picked.length > 1 ? `${marketLabel} +${picked.length - 1}` : marketLabel;
  const stepSays = [
    `${marketsSay} · ${draft.interval} · ${day(range.since)} – ${day(range.until)}`,
    strategyBrief(c),
    rules ? exitBrief(rules) : t("bt.brief.byTemplate"),
    rules ? riskBrief(rules) : t("bt.brief.byTemplate"),
    `${money(draft.capital)} · ${(fees[0] * 100).toFixed(3)}% · ${draft.slippageBps} bps`,
    issues.length > 0 ? t("bt.builder.toFix", { n: issues.length }) : t("bt.builder.ready"),
  ];
  const custom = (from: number, to: number) => set({ period: "custom", from, to });

  return (
    <div className="lab-builder">
      <aside className="lab-panel lab-stepper">
        <div className="lab-stepper-head">
          <span className="lab-label">{t("bt.builder.strategyLabel")}</span>
          <input
            className="lab-title-input"
            value={draft.name}
            aria-label={t("bt.builder.name")}
            onChange={(e) => set({ name: e.target.value })}
          />
          <span className="lab-dim">
            v{draft.version} · {t("bt.builder.editedAgo", { ago: ago(draft.updatedAt) })} ·{" "}
            {(dirty ? t("bt.builder.unsaved") : t("bt.builder.saved")).toLowerCase()}
          </span>
        </div>
        <ol className="lab-steps">
          {STEPS.map((k, i) => (
            <li key={k}>
              <button
                type="button"
                className={i === step ? "on" : i < step ? "done" : undefined}
                aria-current={i === step ? "step" : undefined}
                onClick={() => setStep(i)}
              >
                <span className="lab-step-n">
                  {i < step ? <LuCheck size={12} aria-hidden /> : i + 1}
                </span>
                <span>
                  <b>{t(`bt.builder.step.${k}`)}</b>
                  <small>{stepSays[i]}</small>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="lab-stepper-foot">
          <button
            type="button"
            className="lab-btn primary big"
            disabled={issues.length > 0 || running}
            onClick={onRun}
          >
            <LuPlay size={13} aria-hidden />
            {running ? t("bt.running") : t("bt.runBacktest")}
            <kbd>⌘↵</kbd>
          </button>
          <div className="lab-stepper-row">
            <button
              type="button"
              className="lab-btn"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
            >
              {t("bt.builder.back")}
            </button>
            <button
              type="button"
              className="lab-btn"
              disabled={step === STEPS.length - 1}
              onClick={() => setStep(step + 1)}
            >
              {t("bt.builder.next")}
            </button>
          </div>
        </div>
      </aside>

      <section className="lab-panel lab-form" ref={formRef}>
        {step === 0 && (
          <>
            <div className="lab-sec">
              <div className="lab-sh">
                <h3>{t("bt.builder.market")}</h3>
                <p>{t("bt.builder.marketHint")}</p>
              </div>
              <div className="lab-market-row">
                <Select<VenueId>
                  className="lab-venue"
                  label={t("bt.builder.venue")}
                  value={draft.venue}
                  onChange={(venue) => set({ venue, market: "", extra: [] })}
                  options={VENUE_IDS.map((v) => ({
                    value: v,
                    label: VENUES[v].label,
                    icon: venueLogos[v],
                  }))}
                />
                <span className="lab-dim lab-market-count">
                  {t("bt.builder.marketsN", { n: picked.length, max: MAX_MARKETS })}
                </span>
              </div>
              <div className="lab-mchips">
                {picked.map((id) => (
                  <span key={id} className="lab-mchip">
                    <TokenIcon market={markets?.find((m) => m.id === id)} size={20} />
                    <b>{markets?.find((m) => m.id === id)?.symbol ?? id}</b>
                    <small>{VENUES[draft.venue].label}</small>
                    <button
                      type="button"
                      aria-label={t("bt.builder.removeMarket", { market: id })}
                      onClick={() => setMarkets(picked.filter((x) => x !== id))}
                    >
                      <LuX size={12} aria-hidden />
                    </button>
                  </span>
                ))}
                {picked.length < MAX_MARKETS && (
                  <span className="lab-madd">
                    <MarketPicker
                      venue={draft.venue}
                      value=""
                      list={markets}
                      compact
                      placeholder={
                        picked.length ? t("bt.builder.addMarket") : t("bt.builder.pickMarket")
                      }
                      onChange={(id) => !picked.includes(id) && setMarkets([...picked, id])}
                    />
                  </span>
                )}
              </div>
              {picked.length > 1 && (
                <div className="lab-account-pick">
                  <Seg<Account>
                    label={t("bt.builder.accountLabel")}
                    value={draft.account ?? "each"}
                    onChange={(account) => set({ account })}
                    options={ACCOUNTS.map((a) => ({
                      value: a,
                      label: t(`bt.builder.account.${a}`),
                    }))}
                  />
                  <p className="lab-dim">
                    {draft.account === "shared"
                      ? t("bt.builder.account.sharedHint", {
                          share: money(draft.capital / picked.length),
                        })
                      : t("bt.builder.account.eachHint", { capital: money(draft.capital) })}
                  </p>
                </div>
              )}
            </div>
            <div className="lab-sec">
              <div className="lab-sh">
                <h3>{t("bt.builder.candles")}</h3>
                <p>{t("bt.builder.candlesHint")}</p>
              </div>
              <div className="lab-field">
                <span>{t("bt.builder.timeframe")}</span>
                <Seg<LabInterval>
                  label={t("bt.builder.timeframe")}
                  value={draft.interval}
                  onChange={(interval) => set({ interval })}
                  options={LAB_INTERVALS.map((v) => ({ value: v, label: v }))}
                />
              </div>
            </div>
            <div className="lab-sec">
              <div className="lab-sh">
                <h3>{t("bt.builder.keepBack")}</h3>
                <p>{t("bt.builder.keepBackHint")}</p>
                <span className="lab-sh-r">
                  <Seg<"none" | "end">
                    label={t("bt.builder.keepBack")}
                    value={draft.holdOutDays > 0 ? "end" : "none"}
                    onChange={(v) =>
                      set({
                        holdOutDays:
                          v === "none" ? 0 : Math.max(1, Math.min(60, Math.round(days / 5))),
                      })
                    }
                    options={[
                      { value: "none", label: t("bt.builder.keepNone") },
                      { value: "end", label: t("bt.builder.keepEnd") },
                    ]}
                  />
                </span>
              </div>
              <div className="lab-split">
                <div style={{ flex: Math.max(1, days - draft.holdOutDays) }}>
                  {t("bt.builder.tuneOn", {
                    from: day(range.since),
                    n: Math.max(0, days - draft.holdOutDays),
                  })}
                </div>
                {draft.holdOutDays > 0 && (
                  <div className="out" style={{ flex: draft.holdOutDays }}>
                    {t("bt.builder.heldOutDays", { n: draft.holdOutDays })}
                  </div>
                )}
              </div>
              {draft.holdOutDays > 0 && (
                <div className="lab-holdout">
                  <NumField
                    label={t("bt.builder.holdOut")}
                    value={draft.holdOutDays}
                    unit={t("bt.unit.days")}
                    min={0}
                    onChange={(holdOutDays) =>
                      set({ holdOutDays: Math.max(0, Math.round(holdOutDays)) })
                    }
                  />
                  <p className="lab-dim">{t("bt.builder.holdOutWhy")}</p>
                </div>
              )}
            </div>
            <div className="lab-sec">
              <div className="lab-sh">
                <h3>{t("bt.builder.period")}</h3>
                <p>{t("bt.builder.periodHint")}</p>
              </div>
              <div className="lab-chips">
                {PERIODS.filter((p) => p !== "custom").map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`lab-chip${draft.period === p ? " on" : ""}`}
                    onClick={() => set({ period: p })}
                  >
                    {t(`bt.period.${p}`)}
                  </button>
                ))}
              </div>
              <div className="lab-chips">
                <span className="lab-dim">{t("bt.builder.stressOn")}</span>
                {STRESS.map((x) => (
                  <button
                    key={x.key}
                    type="button"
                    className={`lab-chip stress${draft.period === "custom" && draft.from === x.from && draft.to === x.to ? " on" : ""}`}
                    title={`${day(x.from)} – ${day(x.to)}`}
                    onClick={() => custom(x.from, x.to)}
                  >
                    {t(`bt.stress.${x.key}`)}
                  </button>
                ))}
              </div>
              <div className="lab-dates">
                <DatePicker
                  label={t("bt.builder.start")}
                  value={range.since - (range.since % DAY)}
                  max={range.until}
                  rangeFrom={range.since}
                  rangeTo={range.until}
                  onChange={(from) => custom(from, draft.to ?? range.until - (range.until % DAY))}
                />
                <span className="lab-dates-to">→</span>
                <DatePicker
                  label={t("bt.builder.end")}
                  value={range.until - (range.until % DAY)}
                  min={range.since}
                  max={Date.now()}
                  rangeFrom={range.since}
                  rangeTo={range.until}
                  onChange={(to) => custom(draft.from ?? range.since - (range.since % DAY), to)}
                />
              </div>
            </div>
          </>
        )}

        {(step === 1 || step === 2) && (
          <>
            <div className="lab-sec">
              <div className="lab-sh">
                <h3>{t("bt.builder.entry")}</h3>
                <p>{t("bt.builder.entryHint", { interval: draft.interval })}</p>
                <span className="lab-sh-r">
                  {rules && (
                    <>
                      <Seg<"long" | "short">
                        label={t("bt.p.direction")}
                        value={rules.side}
                        onChange={(side) => setRules({ side })}
                        options={(["long", "short"] as const).map((d) => ({
                          value: d,
                          label: t(`bt.side.${d}`),
                        }))}
                      />
                      <Seg<"blocks" | "text">
                        label={t("bt.builder.view")}
                        value={view}
                        onChange={setView}
                        options={[
                          { value: "blocks", label: t("bt.builder.blocks") },
                          { value: "text", label: t("bt.builder.text") },
                        ]}
                      />
                    </>
                  )}
                </span>
              </div>
              {!rules && (
                <div className="lab-kind-row">
                  <span className="lab-dim">{t("bt.builder.strategyKind")}</span>
                  <Seg<Template>
                    label={t("bt.builder.strategy")}
                    value={c.template}
                    onChange={pickTemplate}
                    options={TEMPLATES.map((tpl) => ({
                      value: tpl,
                      label: t(`bt.tplShort.${tpl}`),
                    }))}
                  />
                </div>
              )}
              {rules ? (
                <RulesEditor
                  kind="entry"
                  conds={rules.entry}
                  match={rules.entryMatch}
                  side={rules.side}
                  view={view}
                  counts={entryCounts}
                  onChange={(entry, entryMatch) => setRules({ entry, entryMatch })}
                />
              ) : (
                <>
                  {c.template === "ema" && (
                    <div className="lab-grid3">
                      <NumField
                        label={t("bt.p.fast")}
                        value={c.fast}
                        onChange={(fast) => setCfg({ fast: Math.round(fast) })}
                      />
                      <NumField
                        label={t("bt.p.slow")}
                        value={c.slow}
                        onChange={(slow) => setCfg({ slow: Math.round(slow) })}
                      />
                      <div className="lab-field">
                        <span>{t("bt.p.direction")}</span>
                        <Seg
                          label={t("bt.p.direction")}
                          value={c.direction}
                          onChange={(direction) => setCfg({ direction })}
                          options={(["long", "short", "both"] as const).map((d) => ({
                            value: d,
                            label: t(`bt.dir.${d}`),
                          }))}
                        />
                      </div>
                      <NumField
                        label={t("bt.p.stopAtr")}
                        value={c.stopAtr}
                        step={0.25}
                        unit="× ATR"
                        onChange={(stopAtr) => setCfg({ stopAtr })}
                      />
                      <NumField
                        label={t("bt.p.risk")}
                        value={Number((c.risk * 100).toFixed(3))}
                        step={0.25}
                        unit={t("bt.unit.ofEquity")}
                        onChange={(v) => setCfg({ risk: v / 100 })}
                      />
                      <NumField
                        label={t("bt.p.maxLeverage")}
                        value={c.maxLeverage}
                        unit="×"
                        onChange={(maxLeverage) => setCfg({ maxLeverage })}
                      />
                    </div>
                  )}
                  {c.template === "grid" && (
                    <div className="lab-grid3">
                      <NumField
                        label={t("bt.p.lower")}
                        value={c.lower}
                        onChange={(lower) => setCfg({ lower })}
                      />
                      <NumField
                        label={t("bt.p.upper")}
                        value={c.upper}
                        onChange={(upper) => setCfg({ upper })}
                      />
                      <NumField
                        label={t("bt.p.levels")}
                        value={c.levels}
                        onChange={(levels) => setCfg({ levels: Math.round(levels) })}
                      />
                      <NumField
                        label={t("bt.p.sizePerLevel")}
                        value={c.sizePerLevel}
                        onChange={(sizePerLevel) => setCfg({ sizePerLevel })}
                      />
                      <NumField
                        label={t("bt.p.stopBelow")}
                        value={c.stopBelow}
                        onChange={(stopBelow) => setCfg({ stopBelow })}
                      />
                      <NumField
                        label={t("bt.p.stopAbove")}
                        value={c.stopAbove}
                        onChange={(stopAbove) => setCfg({ stopAbove })}
                      />
                    </div>
                  )}
                  {c.template === "dca" && (
                    <div className="lab-grid3">
                      <NumField
                        label={t("bt.p.every")}
                        value={c.every}
                        unit={t("bt.unit.candles")}
                        onChange={(every) => setCfg({ every: Math.round(every) })}
                      />
                      <NumField
                        label={t("bt.p.amount")}
                        value={c.amount}
                        unit="$"
                        onChange={(amount) => setCfg({ amount })}
                      />
                      <NumField
                        label={t("bt.p.takeProfit")}
                        value={Number((c.takeProfit * 100).toFixed(3))}
                        unit="%"
                        onChange={(v) => setCfg({ takeProfit: v / 100 })}
                      />
                      <NumField
                        label={t("bt.p.maxBuys")}
                        value={c.maxBuys}
                        onChange={(maxBuys) => setCfg({ maxBuys: Math.round(maxBuys) })}
                      />
                    </div>
                  )}
                  <div className="lab-note-box">
                    <p>{t("bt.builder.templateNote")}</p>
                    <button
                      type="button"
                      className="lab-btn"
                      onClick={() =>
                        set({ strategy: c.template === "ema" ? emaAsRules(c) : defaultRules() })
                      }
                    >
                      <LuWandSparkles size={12} aria-hidden />
                      {c.template === "ema" ? t("bt.builder.asRules") : t("bt.builder.startRules")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {(step === 1 || step === 2) && (
          <div className="lab-sec" ref={exitRef}>
            <div className="lab-sh">
              <h3>{t("bt.builder.exit")}</h3>
              <p>{t("bt.builder.exitHint")}</p>
            </div>
            {rules ? (
              <RulesEditor
                kind="exit"
                conds={rules.exit}
                match={rules.exitMatch}
                side={rules.side}
                view={view}
                counts={exitCounts}
                onChange={(exit, exitMatch) => setRules({ exit, exitMatch })}
              />
            ) : (
              <p className="lab-dim">{t("bt.builder.byTemplate")}</p>
            )}
          </div>
        )}

        {step === 3 &&
          (rules ? (
            <RiskEditor
              rules={rules}
              onChange={setRules}
              capital={draft.capital}
              base={marketInfo?.base ?? marketLabel}
              lastPrice={nowPrice}
              preview={sized}
              ruleSets={ruleSets}
              accountName={accountName}
            />
          ) : (
            <div className="lab-sec">
              <div className="lab-sh">
                <h3>{t("bt.builder.step.risk")}</h3>
              </div>
              <p className="lab-dim">{t("bt.builder.byTemplate")}</p>
            </div>
          ))}

        {step === 4 && (
          <div className="lab-sec">
            <div className="lab-sh">
              <h3>{t("bt.builder.costs")}</h3>
              <p>{t("bt.builder.costsHint")}</p>
            </div>
            <div className="lab-grid3">
              <NumField
                label={t("bt.builder.capital")}
                value={draft.capital}
                unit="$"
                onChange={(capital) => set({ capital })}
              />
              <NumField
                label={t("bt.builder.slippage")}
                value={draft.slippageBps}
                unit="bps"
                min={0}
                onChange={(slippageBps) => set({ slippageBps: Math.max(0, slippageBps) })}
              />
              <div className="lab-field">
                <span>{t("bt.builder.fees", { venue: VENUES[draft.venue].label })}</span>
                <span className="lab-input lab-readonly">
                  {(fees[0] * 100).toFixed(3)}% / {(fees[1] * 100).toFixed(3)}%
                  <em>{t("bt.builder.takerMaker")}</em>
                </span>
              </div>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="lab-sec">
            <div className="lab-sh">
              <h3>{t("bt.builder.review")}</h3>
              <p>{t("bt.builder.reviewHint")}</p>
            </div>
            <p className="lab-sentence lab-review">
              <Sentence config={c} />
            </p>
            <div className="lab-review-kv">
              <span>{t("bt.builder.marketLabel")}</span>
              <b>
                {picked.map((id) => markets?.find((m) => m.id === id)?.symbol ?? id).join(", ")} ·{" "}
                {VENUES[draft.venue].label} · {draft.interval}
                {picked.length > 1
                  ? ` · ${t(`bt.builder.account.${draft.account ?? "each"}`)}`
                  : ""}
              </b>
              <span>{t("bt.builder.period")}</span>
              <b>
                {day(range.since)} – {day(range.until)} · {t("bt.builder.days", { n: days })}
              </b>
              <span>{t("bt.builder.keepBack")}</span>
              <b>
                {draft.holdOutDays > 0
                  ? t("bt.builder.heldOutDays", { n: draft.holdOutDays })
                  : t("bt.builder.keepNone")}
              </b>
              <span>{t("bt.builder.costs")}</span>
              <b>{stepSays[4]}</b>
            </div>
            {issues.length > 0 ? (
              <ul className="lab-issues">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <aside className="lab-builder-side">
        {step === 0 ? (
          <>
            <section className="lab-panel">
              <div className="lab-ph">
                <h2>{t("bt.builder.thePeriod")}</h2>
                <span className="lab-ph-r lab-dim">{marketsSay}</span>
              </div>
              <PeriodPanel
                venue={draft.venue}
                markets={periodMarkets}
                since={range.since}
                until={range.until}
                holdOutDays={draft.holdOutDays}
              />
            </section>
            <section className="lab-panel">
              <div className="lab-ph">
                <h2>{t("bt.builder.data")}</h2>
                <span className="lab-ph-r lab-dim">
                  {t("bt.builder.candlesN", { n: candles.toLocaleString("en-US") })}
                </span>
              </div>
              <div className="lab-notes">
                <div className="lab-note-row">
                  <span className="lab-info">i</span>
                  <span>
                    {t("bt.builder.dataFrom", {
                      venue: VENUES[draft.venue].label,
                      interval: draft.interval,
                    })}
                  </span>
                </div>
                {candles > 20_000 && (
                  <div className="lab-note-row">
                    <span className="lab-warn">!</span>
                    <span>{t("bt.builder.dataLong")}</span>
                  </div>
                )}
                <div className="lab-note-row">
                  <span className="lab-info">i</span>
                  <span>{t("bt.builder.dataFunding")}</span>
                </div>
              </div>
            </section>
          </>
        ) : rules && (step === 1 || step === 2) ? (
          <RulesSide
            rules={rules}
            onChange={setRules}
            run={previewRun}
            stale={!current}
            running={previewing}
            error={issues.length > 0 ? issues[0] : previewError}
            where={`${marketLabel} · ${draft.interval}`}
            period={`${day(range.since)} – ${day(range.until)}`}
          />
        ) : rules && step === 3 ? (
          <RiskSide
            rules={rules}
            capital={draft.capital}
            risk={nowPrice ? riskShare(rules, nowPrice, atr) : 0}
            notional={sized?.notional}
            fee={fees[0]}
            run={current ? previewRun : undefined}
            where={marketLabel}
          />
        ) : (
          <section className="lab-panel">
            <div className="lab-sec">
              <span className="lab-label">{t("bt.builder.reads")}</span>
              <p className="lab-sentence">
                <Sentence config={c} />
              </p>
              <span className="lab-dim">{stepSays[0]}</span>
            </div>
            {issues.length > 0 && (
              <div className="lab-sec">
                <span className="lab-label">{t("bt.builder.fix")}</span>
                <ul className="lab-issues">
                  {issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="lab-sec">
              <p className="lab-dim">{t("bt.builder.engineNote")}</p>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
