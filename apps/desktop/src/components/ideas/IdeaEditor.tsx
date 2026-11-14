import { venueLogos } from "@pewterdesk/assets";
import type { CandleInterval, VenueId } from "@pewterdesk/core";
import { MarketSearch, Select, t } from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { LuLock, LuPlus, LuX } from "react-icons/lu";
import { useMarketSummaries, useMarkets } from "../../hooks/useVenueFeeds";
import {
  BIASES,
  distance,
  ENTRY_NOW,
  type Idea,
  type IdeaLevel,
  type IdeaRisk,
  type IdeaScenario,
  keptRisk,
  MAX_LEVEL_NAME,
  MAX_LEVELS,
  MAX_SCENARIO_TEXT,
  MAX_SCENARIO_TITLE,
  MAX_SCENARIOS,
  MAX_TAGS,
  MAX_TEXT,
  nearest,
  nextColor,
  oddsTotal,
  pricesIn,
  rewardRisk,
  TIMEFRAMES,
} from "../../lib/ideas";
import { NumberField, Segmented } from "../rules/parts";
import {
  BiasPill,
  Conviction,
  IDEA_INTERVALS,
  IdeaChart,
  levelColor,
  price as priceText,
  RiskBar,
  signedPct,
} from "./parts";

/**
 * Writing an idea down, or changing one: the market and bias, the thesis,
 * the levels - each drawn on the preview chart as it's added, or dropped
 * there with a click - and the rest. Nothing is kept until it's saved.
 */
export function IdeaEditor({
  idea,
  isNew,
  venues,
  onSave,
  onCancel,
}: {
  idea: Idea;
  isNew: boolean;
  venues: readonly { id: VenueId; label: string }[];
  onSave: (idea: Idea) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(idea);
  const [interval, setChartInterval] = useState<CandleInterval>("4h");
  const [tags, setTags] = useState(idea.tags.join(", "));
  const set = (change: Partial<Idea>) => setDraft((d) => ({ ...d, ...change }));

  const markets = useMarkets(draft.venue);
  const list = markets.status === "live" || markets.status === "closed" ? markets.data : [];
  const market = list.find((m) => m.id === draft.market);
  const summaries = useMarketSummaries(draft.venue, true);
  const now =
    summaries.status === "live" || summaries.status === "closed"
      ? Number(summaries.data.find((s) => s.market === draft.market)?.markPrice)
      : undefined;
  const live = now !== undefined && now > 0 ? now : undefined;

  // Esc closes, as any dialog here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const setLevel = (id: string, change: Partial<IdeaLevel>) =>
    set({ levels: draft.levels.map((l) => (l.id === id ? { ...l, ...change } : l)) });
  // A level just added: its name field takes the cursor, to be named at once.
  const [naming, setNaming] = useState<string>();
  /** A new level at `price`, unnamed, in the first colour no other level has. */
  const addLevel = (price: number) => {
    if (draft.levels.length >= MAX_LEVELS || !(price > 0)) return;
    const level: IdeaLevel = {
      id: crypto.randomUUID(),
      name: "",
      price: Number(price.toPrecision(8)),
      color: nextColor(draft.levels),
    };
    set({ levels: [...draft.levels, level] });
    setNaming(level.id);
  };
  // Prices the thesis names that aren't levels yet.
  const offered = useMemo(
    () =>
      pricesIn(draft.thesis).filter(
        (p) => !draft.levels.some((l) => Math.abs(l.price - p) / p < 1e-6),
      ),
    [draft.thesis, draft.levels],
  );
  const near = nearest(draft, live);
  const rr = rewardRisk(draft, live);
  const setRisk = (change: Partial<IdeaRisk>) => set({ risk: { ...draft.risk, ...change } });
  /** The levels to pick from, by name and price (and "price now" for the entry). */
  const levelOptions = (withNow: boolean) => [
    { value: "", label: t("ideas.rr.pick") },
    ...(withNow ? [{ value: ENTRY_NOW, label: t("ideas.rr.now") }] : []),
    ...[...draft.levels]
      .sort((a, b) => b.price - a.price)
      .map((l) => ({
        value: l.id,
        label: `${l.name || t("ideas.unnamed")} · ${priceText(l.price, market?.tickSize)}`,
      })),
  ];
  const setScenario = (id: string, change: Partial<IdeaScenario>) =>
    set({ scenarios: draft.scenarios.map((sc) => (sc.id === id ? { ...sc, ...change } : sc)) });
  const total = oddsTotal(draft.scenarios);
  const tick = market?.tickSize;

  const save = () => {
    const chosen = list.find((m) => m.id === draft.market);
    onSave({
      ...draft,
      symbol: chosen?.symbol ?? draft.symbol,
      tags: tags
        .split(",")
        .map((s) => s.trim().slice(0, 32))
        .filter(Boolean)
        .slice(0, MAX_TAGS),
      levels: [...draft.levels].sort((a, b) => b.price - a.price),
      risk: keptRisk({ ...draft.risk }, draft.levels),
      scenarios: draft.scenarios
        .map((sc) => ({ ...sc, title: sc.title.trim() }))
        .filter((sc) => sc.title),
      notedPrice: isNew ? (live ?? draft.notedPrice) : draft.notedPrice,
      notedAt: isNew ? Date.now() : draft.notedAt,
    });
  };

  return (
    <div className="ideas-scrim">
      <div
        className="ideas-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t(isNew ? "ideas.editor.new" : "ideas.editor.edit")}
      >
        <header className="ideas-modal-head">
          <h2>{t(isNew ? "ideas.editor.new" : "ideas.editor.edit")}</h2>
          <span className="ideas-private">
            <LuLock size={12} aria-hidden />
            {t("ideas.editor.private")}
          </span>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("ideas.editor.cancel")}
            onClick={onCancel}
          >
            <LuX size={16} aria-hidden />
          </button>
        </header>

        <div className="ideas-modal-body">
          <div className="ideas-form">
            <div className="ideas-row2">
              <div className="ideas-f">
                <span className="ideas-label">{t("ideas.editor.market")}</span>
                <div className="ideas-market">
                  <Select
                    label={t("ideas.editor.venue")}
                    value={draft.venue}
                    options={venues.map((v) => ({
                      value: v.id,
                      label: v.label,
                      icon: venueLogos[v.id],
                    }))}
                    onChange={(venue) => set({ venue, market: "", symbol: "" })}
                  />
                  <MarketSearch
                    markets={list}
                    value={draft.market || undefined}
                    label={t("ideas.editor.market")}
                    onChange={(id) => {
                      const m = list.find((x) => x.id === id);
                      set({ market: id, symbol: m?.symbol ?? id });
                    }}
                  />
                </div>
              </div>
              <div className="ideas-f">
                <span className="ideas-label">{t("ideas.editor.bias")}</span>
                <div className="ideas-pick" role="radiogroup" aria-label={t("ideas.editor.bias")}>
                  {BIASES.map((b) => (
                    // biome-ignore lint/a11y/useSemanticElements: a row of choices, like the app's others
                    <button
                      key={b}
                      type="button"
                      role="radio"
                      aria-checked={draft.bias === b}
                      data-on={draft.bias === b || undefined}
                      onClick={() => set({ bias: b })}
                    >
                      <BiasPill bias={b} />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <label className="ideas-f">
              <span className="ideas-label">{t("ideas.editor.thesis")}</span>
              <textarea
                className="ideas-ta"
                rows={4}
                maxLength={MAX_TEXT}
                value={draft.thesis}
                onChange={(e) => set({ thesis: e.target.value })}
              />
            </label>
            {offered.length > 0 ? (
              <div className="ideas-offers">
                {offered.map((p) => (
                  <button key={p} type="button" className="ideas-offer" onClick={() => addLevel(p)}>
                    <LuPlus size={11} aria-hidden />
                    {t("ideas.editor.offer", { price: priceText(p, tick) })}
                  </button>
                ))}
              </div>
            ) : (
              <p className="ideas-hint">{t("ideas.editor.thesisHint")}</p>
            )}

            <div className="ideas-f">
              <span className="ideas-label ideas-label-row">
                {t("ideas.editor.levels")}
                <em>{t("ideas.editor.levelsHint")}</em>
              </span>
              {draft.levels.map((l) => (
                <div key={l.id} className="ideas-lvrow">
                  <span className="ideas-swatch" style={{ background: levelColor(l.color) }} />
                  <span className="rules-field" data-wide="text">
                    <input
                      ref={(el) => {
                        if (el && naming === l.id) {
                          el.focus();
                          setNaming(undefined);
                        }
                      }}
                      aria-label={t("ideas.editor.levelName")}
                      placeholder={t("ideas.editor.levelName")}
                      maxLength={MAX_LEVEL_NAME}
                      value={l.name}
                      onChange={(e) => setLevel(l.id, { name: e.target.value })}
                    />
                  </span>
                  <NumberField
                    label={t("ideas.editor.levelPrice")}
                    value={l.price}
                    onChange={(p) => p > 0 && setLevel(l.id, { price: p })}
                  />
                  <span className="ideas-dist pd-num">
                    {live ? signedPct(distance(live, l.price)) : "–"}
                  </span>
                  <button
                    type="button"
                    className="pd-icon-button"
                    aria-label={t("ideas.editor.removeLevel")}
                    onClick={() => {
                      const levels = draft.levels.filter((x) => x.id !== l.id);
                      // A pick for reward to risk goes with its level.
                      set({ levels, risk: keptRisk({ ...draft.risk }, levels) });
                    }}
                  >
                    <LuX size={13} aria-hidden />
                  </button>
                </div>
              ))}
              {draft.levels.length < MAX_LEVELS && (
                <button
                  type="button"
                  className="ideas-ghost"
                  disabled={live === undefined}
                  onClick={() => live && addLevel(live)}
                >
                  <LuPlus size={12} aria-hidden />
                  {t("ideas.editor.addLevel")}
                </button>
              )}
            </div>

            <div className="ideas-f">
              <span className="ideas-label ideas-label-row">
                {t("ideas.rr")}
                <em>{t("ideas.rr.hint")}</em>
              </span>
              <div className="ideas-rr-pick">
                {(
                  [
                    ["entry", true],
                    ["stop", false],
                    ["target", false],
                  ] as const
                ).map(([leg, withNow]) => (
                  <div key={leg} className="ideas-f">
                    <span className="ideas-hint">{t(`ideas.rr.${leg}`)}</span>
                    <Select
                      label={t(`ideas.rr.${leg}`)}
                      value={draft.risk[leg] ?? ""}
                      options={levelOptions(withNow)}
                      onChange={(id) => setRisk({ [leg]: id || undefined })}
                    />
                  </div>
                ))}
              </div>
              {rr ? (
                <RiskBar rr={rr} />
              ) : (
                draft.risk.entry &&
                draft.risk.stop &&
                draft.risk.target && <p className="ideas-hint ideas-warn">{t("ideas.rr.sides")}</p>
              )}
            </div>

            <div className="ideas-row2">
              <label className="ideas-f">
                <span className="ideas-label">{t("ideas.editor.wrongIf")}</span>
                <textarea
                  className="ideas-ta"
                  rows={2}
                  maxLength={MAX_TEXT}
                  value={draft.wrongIf}
                  onChange={(e) => set({ wrongIf: e.target.value })}
                />
              </label>
              <label className="ideas-f">
                <span className="ideas-label">{t("ideas.editor.catalysts")}</span>
                <textarea
                  className="ideas-ta"
                  rows={2}
                  maxLength={MAX_TEXT}
                  value={draft.catalysts}
                  onChange={(e) => set({ catalysts: e.target.value })}
                />
              </label>
            </div>

            <div className="ideas-row3">
              <div className="ideas-f">
                <span className="ideas-label">{t("ideas.timeframe")}</span>
                <Segmented
                  label={t("ideas.timeframe")}
                  value={draft.timeframe}
                  options={TIMEFRAMES.map((tf) => ({ value: tf, label: t(`ideas.tf.${tf}`) }))}
                  onChange={(timeframe) => set({ timeframe })}
                />
              </div>
              <div className="ideas-f">
                <span className="ideas-label">{t("ideas.conviction")}</span>
                <Conviction
                  value={draft.conviction}
                  onChange={(conviction) => set({ conviction })}
                />
              </div>
              <label className="ideas-f">
                <span className="ideas-label">
                  {t("ideas.editor.tags")} <em>{t("ideas.editor.tagsHint")}</em>
                </span>
                <span className="rules-field" data-wide="text">
                  <input
                    aria-label={t("ideas.editor.tags")}
                    value={tags}
                    maxLength={300}
                    onChange={(e) => setTags(e.target.value)}
                  />
                </span>
              </label>
            </div>

            <div className="ideas-f">
              <span className="ideas-label ideas-label-row">
                {t("ideas.scenarios")}
                {draft.scenarios.length > 0 && (
                  <em className={total === 100 ? undefined : "ideas-warn"}>
                    {t(total === 100 ? "ideas.odds.total" : "ideas.odds.off", { total })}
                  </em>
                )}
              </span>
              {draft.scenarios.map((sc) => (
                <div key={sc.id} className="ideas-scrow">
                  <span className="rules-field" data-wide="text">
                    <input
                      aria-label={t("ideas.scenario.title")}
                      placeholder={t("ideas.scenario.title")}
                      maxLength={MAX_SCENARIO_TITLE}
                      value={sc.title}
                      onChange={(e) => setScenario(sc.id, { title: e.target.value })}
                    />
                  </span>
                  <NumberField
                    whole
                    label={t("ideas.scenario.odds")}
                    value={sc.odds}
                    unit="%"
                    onChange={(odds) => setScenario(sc.id, { odds: Math.min(100, odds) })}
                  />
                  <span className="rules-field" data-wide="text">
                    <input
                      aria-label={t("ideas.scenario.text")}
                      placeholder={t("ideas.scenario.text")}
                      maxLength={MAX_SCENARIO_TEXT}
                      value={sc.text}
                      onChange={(e) => setScenario(sc.id, { text: e.target.value })}
                    />
                  </span>
                  <button
                    type="button"
                    className="pd-icon-button"
                    aria-label={t("ideas.scenario.remove")}
                    onClick={() =>
                      set({ scenarios: draft.scenarios.filter((x) => x.id !== sc.id) })
                    }
                  >
                    <LuX size={13} aria-hidden />
                  </button>
                </div>
              ))}
              {draft.scenarios.length < MAX_SCENARIOS && (
                <button
                  type="button"
                  className="ideas-ghost"
                  onClick={() =>
                    set({
                      scenarios: [
                        ...draft.scenarios,
                        {
                          id: crypto.randomUUID(),
                          title: "",
                          odds: Math.max(0, 100 - total),
                          text: "",
                        },
                      ],
                    })
                  }
                >
                  <LuPlus size={12} aria-hidden />
                  {t("ideas.scenario.add")}
                </button>
              )}
            </div>
          </div>

          <aside className="ideas-preview">
            <div className="ideas-preview-head">
              <span>{t("ideas.editor.preview", { interval })}</span>
              <Segmented
                label={t("ideas.timeframe")}
                value={interval}
                options={IDEA_INTERVALS.map((i) => ({ value: i, label: i.toUpperCase() }))}
                onChange={setChartInterval}
              />
            </div>
            {draft.market ? (
              <IdeaChart
                venue={draft.venue}
                market={draft.market}
                symbol={draft.symbol}
                interval={interval}
                levels={draft.levels}
                onPick={(p) => addLevel(p)}
                className="pd-levels-chart ideas-preview-chart"
              />
            ) : (
              <p className="ideas-chart-note ideas-preview-empty">{t("ideas.editor.needMarket")}</p>
            )}
            <p className="ideas-hint">{t("ideas.editor.pickHint")}</p>
            <div className="ideas-calc">
              <div>
                <span>{t("ideas.rr")}</span>
                <b className="pd-num">{rr ? `${rr.ratio.toFixed(1)} : 1` : "–"}</b>
              </div>
              <div>
                <span>{t("ideas.nearest")}</span>
                <b className="pd-num">
                  {near ? (
                    <>
                      <i
                        className="ideas-swatch"
                        style={{ background: levelColor(near.level.color) }}
                      />
                      {near.level.name || t("ideas.unnamed")} · {signedPct(near.share)}
                    </>
                  ) : (
                    "–"
                  )}
                </b>
              </div>
            </div>
          </aside>
        </div>

        <footer className="ideas-modal-foot">
          <div style={{ flex: 1 }} />
          <button type="button" className="rules-button" onClick={onCancel}>
            {t("ideas.editor.cancel")}
          </button>
          <button
            type="button"
            className="rules-button rules-primary"
            disabled={!draft.market}
            onClick={save}
          >
            {t("ideas.editor.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
