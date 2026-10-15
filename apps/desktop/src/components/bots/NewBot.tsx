import type { Market } from "@pewterdesk/core";
import { formatNumber, formatSigned, type MessageKey, Select, t } from "@pewterdesk/ui";
import { type ReactNode, useMemo, useState } from "react";
import { LuCheck } from "react-icons/lu";
import {
  type Bar,
  DEFAULT_EMA,
  type EmaParams,
  emaLine,
  type GridParams,
  gridLevels,
  holdOutFor,
  intervalMs,
  PERIODS,
  type RunSpec,
  ruleHolds,
  sampleBars,
  sourceLine,
  type Template,
} from "../../lib/backtest";
import { PAPER_DAYS } from "../../lib/bots";
import {
  type CustomDraft,
  CustomForm,
  customDefaults,
  customParams,
  customProblems,
} from "./CustomRules";
import { CandleChart, type Level, type Line, type Marker } from "./charts";
import { type Crumb, Crumbs, TEMPLATE_LABEL } from "./ui";

const HOUR = 3_600_000;
type EmaField = "fast" | "slow" | "stopAtr" | "risk" | "maxLeverage";
const CAPITAL = 10_000;
/** The period a template starts on: a grid's two weeks around today's price, a trend's quarter. */
const DEFAULT_DAYS: Record<Template, number> = { grid: 14, ema: 90, custom: 90 };
const TEMPLATES: readonly Template[] = ["grid", "ema", "custom"];
const TEMPLATE_TEXT: Record<Template, { desc: MessageKey; fit: MessageKey }> = {
  grid: { desc: "bots.template.gridDesc", fit: "bots.template.gridFit" },
  ema: { desc: "bots.template.emaDesc", fit: "bots.template.emaFit" },
  custom: { desc: "bots.template.customDesc", fit: "bots.template.customFit" },
};

/** A seed per market, so its sample series is always the same. */
const seedOf = (market: string) =>
  [...market].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2_166_136_261);

/** A number to about four significant figures, as a default reads best. */
const round = (v: number) => {
  const p = 10 ** (3 - Math.floor(Math.log10(Math.abs(v) || 1)));
  return Math.round(v * p) / p;
};
/** A market's sample candles, ending at its price now. */
function sampleEndingAt(market: string, count: number, step: number, price: number) {
  const end = Math.floor(Date.now() / step) * step;
  const unit = sampleBars(seedOf(market), count, end, step, 100);
  const scale = price / (unit.at(-1)?.close ?? 100);
  return {
    end,
    startPrice: 100 * scale,
    bars: unit.map((b) => ({
      time: b.time,
      open: b.open * scale,
      high: b.high * scale,
      low: b.low * scale,
      close: b.close * scale,
    })),
  };
}
const gridSample = (market: string, price: number, days = DEFAULT_DAYS.grid) =>
  sampleEndingAt(market, 24 * days, HOUR, price);

const priceDecimals = (v: number) => (v >= 1000 ? 1 : v >= 10 ? 2 : v >= 1 ? 3 : 5);

interface NewBotProps {
  /** The trail back: the page, its section, this. */
  crumbs: readonly Crumb[];
  venue: string;
  venueLabel: string;
  markets: readonly Market[];
  priceOf: (market: string) => number | undefined;
  marketLabel: (market: string) => string;
  onBack: () => void;
  /** Runs the settings' backtest (a new run, opened once made). */
  onRun: (spec: Omit<RunSpec, "id">) => void;
}

/** A new bot: a template, then its settings beside a preview and the bot's own limits. */
export function NewBot({
  crumbs,
  venue,
  venueLabel,
  markets,
  priceOf,
  marketLabel,
  onBack,
  onRun,
}: NewBotProps) {
  const [template, setTemplate] = useState<Template>();
  const [market, setMarket] = useState(markets[0]?.id ?? "BTC");
  const [interval, setInterval] = useState<RunSpec["interval"]>("1h");
  const price = priceOf(market) ?? 100;
  const [grid, setGrid] = useState<Record<keyof GridParams, string>>(() =>
    gridDefaults(gridSample(market, price).bars, price),
  );
  const [emaText, setEmaText] = useState<Record<EmaField, string>>({
    fast: String(DEFAULT_EMA.fast),
    slow: String(DEFAULT_EMA.slow),
    stopAtr: String(DEFAULT_EMA.stopAtr),
    risk: String(DEFAULT_EMA.risk * 100),
    maxLeverage: String(DEFAULT_EMA.maxLeverage),
  });
  const [periodChoice, setPeriodChoice] = useState<number>();
  // A range typed in is kept when the period changes; an untouched one follows it.
  const [rangeEdited, setRangeEdited] = useState(false);
  const editRange = (patch: Partial<Record<keyof GridParams, string>>) => {
    setGrid({ ...grid, ...patch });
    setRangeEdited(true);
  };
  const fitRange = (days: number, m = market) => {
    const p = priceOf(m) ?? 100;
    setGrid(gridDefaults(gridSample(m, p, days).bars, p));
    setRangeEdited(false);
  };
  const [direction, setDirection] = useState<EmaParams["direction"]>("both");
  const [custom, setCustom] = useState<CustomDraft>(customDefaults);
  const [name, setName] = useState("");
  const ema: EmaParams = {
    fast: Math.round(Number(emaText.fast)),
    slow: Math.round(Number(emaText.slow)),
    stopAtr: Number(emaText.stopAtr),
    risk: Number(emaText.risk) / 100,
    maxLeverage: Number(emaText.maxLeverage),
    direction,
  };
  const emaField = (field: EmaField, label: string, unit?: string) => (
    <NumberField
      label={label}
      unit={unit}
      value={emaText[field]}
      error={problems[field]}
      onChange={(v) => setEmaText({ ...emaText, [field]: v })}
    />
  );

  // Sample candles ending at the market's price: the preview's, and the run's. A grid
  // is set around today's price, so it's tested on the last two weeks, not on months
  // in which the price was somewhere else and the stop-out would end it at once.
  const step = intervalMs(template === "grid" ? "1h" : interval);
  const period = periodChoice ?? DEFAULT_DAYS[template ?? "ema"];
  const bars = Math.round((period * 24 * HOUR) / step);
  const seed = seedOf(market);
  const {
    end,
    startPrice,
    bars: series,
  } = useMemo(() => sampleEndingAt(market, bars, step, price), [market, bars, step, price]);

  const gridParams: GridParams = {
    lower: Number(grid.lower),
    upper: Number(grid.upper),
    levels: Math.round(Number(grid.levels)),
    sizePerLevel: Number(grid.sizePerLevel),
    stopBelow: Number(grid.stopBelow),
    stopAbove: Number(grid.stopAbove),
  };
  const problems: Partial<Record<string, string>> =
    template === "grid"
      ? gridProblems(gridParams)
      : template === "custom"
        ? customProblems(custom)
        : emaProblems(ema);
  const fieldsToFix = Object.keys(problems).length;
  const decimals = priceDecimals(price);

  const run = () =>
    onRun({
      template: template ?? "ema",
      ...(template === "grid"
        ? { grid: gridParams }
        : template === "custom"
          ? { custom: customParams(custom) }
          : { ema }),
      ...(name.trim() ? { name: name.trim().slice(0, 40) } : {}),
      venue,
      market,
      interval: template === "grid" ? "1h" : interval,
      bars,
      end,
      holdOutDays: holdOutFor(period),
      capital: CAPITAL,
      fee: 0.00045,
      slippageBps: 2,
      seed,
      startPrice,
    });

  const head = (
    <header className="bt-head">
      <Crumbs items={crumbs} />
      <ol className="bt-steps">
        <li
          data-done={template !== undefined || undefined}
          data-current={template === undefined || undefined}
        >
          {template !== undefined ? (
            <LuCheck size={12} className="bt-step-mark" aria-hidden />
          ) : (
            <span className="bt-step-mark">1</span>
          )}
          {t("bots.step.template")}
          {template && <em>{t(TEMPLATE_LABEL[template])}</em>}
        </li>
        <li data-current={template !== undefined || undefined}>
          <span className="bt-step-mark">2</span>
          {t("bots.step.settings")}
        </li>
      </ol>
      <span className="bt-spacer" />
      <span className="bt-muted">{t("bots.pathToLive", { days: PAPER_DAYS })}</span>
      {template && fieldsToFix > 0 && (
        <span className="bt-warn">{t("bots.fieldsToFix", { count: fieldsToFix })}</span>
      )}
      <button
        type="button"
        className="bt-button"
        onClick={template ? () => setTemplate(undefined) : onBack}
      >
        {t("bots.back")}
      </button>
      <button
        type="button"
        className="bt-button"
        data-primary
        disabled={!template || fieldsToFix > 0}
        onClick={run}
      >
        {t("bots.runBacktest")}
      </button>
    </header>
  );

  if (!template) {
    return (
      <>
        {head}
        <div className="bt-templates">
          {TEMPLATES.map((id) => (
            <button
              key={id}
              type="button"
              className="bt-template"
              onClick={() => {
                setTemplate(id);
                setPeriodChoice(undefined);
              }}
            >
              <strong>{t(TEMPLATE_LABEL[id])}</strong>
              <span>{t(TEMPLATE_TEXT[id].desc)}</span>
              <em className="bt-template-fit">{t(TEMPLATE_TEXT[id].fit)}</em>
            </button>
          ))}
        </div>
      </>
    );
  }

  const levels = template === "grid" ? gridLevels(gridParams) : [];
  // A grid's preview is its whole test window, so the range can be judged against it.
  const shown = template === "grid" ? series.length : template === "custom" ? 180 : 90;
  const preview = series.slice(-shown);
  const from = series.length - preview.length;
  // A custom bot's preview: its moving averages, and where every entry rule holds.
  const customLines: Line[] = [];
  const customMarkers: Marker[] = [];
  if (template === "custom" && Object.keys(problems).length === 0) {
    const p = customParams(custom);
    const averages = [...p.entry, ...p.exit]
      .flatMap((r) => [r.left, r.right])
      .filter((s) => s.kind === "ema" || s.kind === "sma")
      .filter((s, i, all) => all.findIndex((x) => JSON.stringify(x) === JSON.stringify(s)) === i)
      .slice(0, 2);
    averages.forEach((s, i) => {
      customLines.push({
        values: sourceLine(series, s).slice(from),
        className: i === 0 ? "bt-line-fast" : "bt-line-slow",
      });
    });
    const entry = p.entry.map((r) => ({
      op: r.op,
      left: sourceLine(series, r.left),
      right: sourceLine(series, r.right),
    }));
    for (let i = from; i < series.length; i++) {
      if (entry.every((r) => ruleHolds(r.op, r.left, r.right, i)))
        customMarkers.push({
          index: i - from,
          kind: p.side === "long" ? "entryLong" : "entryShort",
        });
    }
  }
  const below = levels.filter((l) => l < price);
  const above = levels.filter((l) => l >= price);
  const allBuys = below.length * gridParams.sizePerLevel;
  const base = markets.find((m) => m.id === market)?.base ?? market;
  const chartLevels: Level[] =
    template === "grid"
      ? [
          ...levels.map(
            (l): Level => ({
              price: l,
              tone: l < price ? "buy" : "sell",
              label: `${formatNumber(l, decimals)} ${t(l < price ? "bots.level.buy" : "bots.level.sell")}`,
            }),
          ),
          ...[gridParams.stopBelow, gridParams.stopAbove]
            .filter((p) => Number.isFinite(p) && p > 0)
            .map(
              (p): Level => ({
                price: p,
                tone: "stop",
                label: `${formatNumber(p, decimals)} ${t("bots.level.stop")}`,
              }),
            ),
        ]
      : [];
  const closes = preview.map((b) => b.close);

  return (
    <>
      {head}
      <div className="bt-new">
        <section className="bt-panel bt-form" aria-label={t("bots.strategy")}>
          <h2>
            {t("bots.strategy")}
            <span className="bt-chip">{t(TEMPLATE_LABEL[template])}</span>
          </h2>
          <div className="bt-fields">
            <label className="bt-field bt-field-wide">
              <span>{t("bots.name")}</span>
              <span className="bt-input bt-input-text">
                <input
                  value={name}
                  maxLength={40}
                  placeholder={t(TEMPLATE_LABEL[template])}
                  onChange={(e) => setName(e.target.value)}
                />
              </span>
            </label>
            <Field label={t("bots.venue")}>
              <span className="bt-static">{venueLabel}</span>
            </Field>
            <Field label={t("bots.market")}>
              <Select
                label={t("bots.market")}
                value={market}
                options={markets
                  .slice(0, 200)
                  .map((m) => ({ value: m.id, label: marketLabel(m.id) }))}
                onChange={(m) => {
                  setMarket(m);
                  fitRange(template === "grid" ? period : DEFAULT_DAYS.grid, m);
                }}
              />
            </Field>
            <Field label={t("bots.period")}>
              <span className="bt-seg" role="radiogroup" aria-label={t("bots.period")}>
                {PERIODS[template].map((d) => (
                  // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={period === d}
                    onClick={() => {
                      setPeriodChoice(d);
                      if (template === "grid" && !rangeEdited) fitRange(d);
                    }}
                  >
                    {t("bots.periodShort", { days: d })}
                  </button>
                ))}
              </span>
            </Field>
          </div>
          <p className="bt-hint">{t("bots.periodHint", { days: holdOutFor(period) })}</p>
          {template === "grid" ? (
            <>
              <h3 className="bt-h3-row">
                {t("bots.grid")}
                <button type="button" className="bt-link" onClick={() => fitRange(period)}>
                  {t("bots.fitRange")}
                </button>
              </h3>
              <div className="bt-fields">
                <NumberField
                  label={t("bots.grid.lower")}
                  unit="USD"
                  value={grid.lower}
                  error={problems.lower}
                  onChange={(v) => editRange({ lower: v })}
                />
                <NumberField
                  label={t("bots.grid.upper")}
                  unit="USD"
                  value={grid.upper}
                  error={problems.upper}
                  onChange={(v) => editRange({ upper: v })}
                />
                <NumberField
                  label={t("bots.grid.levels")}
                  value={grid.levels}
                  error={problems.levels}
                  onChange={(v) => setGrid({ ...grid, levels: v })}
                />
                <NumberField
                  label={t("bots.grid.size")}
                  unit={base}
                  value={grid.sizePerLevel}
                  error={problems.sizePerLevel}
                  onChange={(v) => setGrid({ ...grid, sizePerLevel: v })}
                />
              </div>
              <h3>{t("bots.grid.stopOut")}</h3>
              <div className="bt-fields">
                <NumberField
                  label={t("bots.grid.below")}
                  unit="USD"
                  value={grid.stopBelow}
                  error={problems.stopBelow}
                  onChange={(v) => editRange({ stopBelow: v })}
                />
                <NumberField
                  label={t("bots.grid.above")}
                  unit="USD"
                  value={grid.stopAbove}
                  error={problems.stopAbove}
                  onChange={(v) => editRange({ stopAbove: v })}
                />
              </div>
              {Object.values(problems).map((p) => (
                <p key={p} className="bt-error">
                  {p}
                </p>
              ))}
              <h3>{t("bots.summary")}</h3>
              <dl className="bt-rows">
                <Row label={t("bots.grid.step")}>
                  {levels.length > 1
                    ? `${formatNumber((levels[1] as number) - (levels[0] as number), decimals)} USD`
                    : "-"}
                </Row>
                <Row label={t("bots.grid.buyLevels")}>
                  {below.length
                    ? `${below.length} · ${formatNumber(below[0] as number, decimals)} – ${formatNumber(below.at(-1) as number, decimals)}`
                    : "0"}
                </Row>
                <Row label={t("bots.grid.sellLevels")}>
                  {above.length
                    ? `${above.length} · ${formatNumber(above[0] as number, decimals)} – ${formatNumber(above.at(-1) as number, decimals)}`
                    : "0"}
                </Row>
                <Row label={t("bots.grid.ifAllFill")}>
                  {`${formatNumber(allBuys, 4)} ${base} · ${formatNumber(allBuys * price, 2)} USD`}
                </Row>
                <Row label={t("bots.grid.leverage")}>
                  {t("bots.grid.leverageOn", {
                    leverage: formatNumber((allBuys * price) / CAPITAL, 2),
                    equity: formatNumber(CAPITAL, 2),
                  })}
                </Row>
              </dl>
            </>
          ) : template === "custom" ? (
            <>
              <div className="bt-fields">
                <Field label={t("bots.ema.interval")}>
                  <Select
                    label={t("bots.ema.interval")}
                    value={interval}
                    options={[
                      { value: "1h", label: "1h" },
                      { value: "4h", label: "4h" },
                    ]}
                    onChange={(v) => setInterval(v as RunSpec["interval"])}
                  />
                </Field>
              </div>
              <CustomForm draft={custom} problems={problems} onChange={setCustom} />
            </>
          ) : (
            <>
              <h3>{t("bots.ema")}</h3>
              <div className="bt-fields">
                {emaField("fast", t("bots.ema.fast"))}
                {emaField("slow", t("bots.ema.slow"))}
                {emaField("stopAtr", t("bots.ema.stop"), "× ATR")}
                {emaField("risk", t("bots.ema.risk"), "%")}
                {emaField("maxLeverage", t("bots.ema.leverage"), "×")}
                <Field label={t("bots.ema.interval")}>
                  <Select
                    label={t("bots.ema.interval")}
                    value={interval}
                    options={[
                      { value: "1h", label: "1h" },
                      { value: "4h", label: "4h" },
                    ]}
                    onChange={(v) => setInterval(v as RunSpec["interval"])}
                  />
                </Field>
                <Field label={t("bots.ema.direction")}>
                  <Select
                    label={t("bots.ema.direction")}
                    value={direction}
                    options={(["both", "long", "short"] as const).map((d) => ({
                      value: d,
                      label: t(`bots.direction.${d}`),
                    }))}
                    onChange={(v) => setDirection(v as EmaParams["direction"])}
                  />
                </Field>
              </div>
              {Object.values(problems).map((p) => (
                <p key={p} className="bt-error">
                  {p}
                </p>
              ))}
            </>
          )}
        </section>

        <section className="bt-panel bt-preview-chart" aria-label={t("bots.previewChart")}>
          <h2>
            {t("bots.previewChart")}
            <span className="bt-muted">
              {marketLabel(market)} · {template === "grid" ? "1h" : interval} ·{" "}
              {t("bots.lastDays", { days: Math.round((preview.length * step) / (24 * HOUR)) })}
            </span>
            <span className="bt-spacer" />
            <span className="bt-muted">
              {t(
                template === "grid"
                  ? "bots.previewGrid"
                  : template === "custom"
                    ? "bots.previewCustom"
                    : "bots.previewEma",
              )}
            </span>
          </h2>
          <div className="bt-chart-box">
            <CandleChart
              bars={preview}
              levels={chartLevels}
              last={price}
              decimals={decimals}
              markers={customMarkers}
              lines={
                template === "grid"
                  ? []
                  : template === "custom"
                    ? customLines
                    : [
                        { values: emaLine(closes, ema.fast), className: "bt-line-fast" },
                        { values: emaLine(closes, ema.slow), className: "bt-line-slow" },
                      ]
              }
            />
          </div>
          {template === "grid" && (
            <dl className="bt-preview-foot">
              <Row label={t("bots.currentPrice")}>{formatNumber(price, decimals)}</Row>
              <Row label={t("bots.toStopBelow")}>
                {`${formatSigned(((gridParams.stopBelow - price) / price) * 100)}% · ${formatNumber(gridParams.stopBelow, decimals)}`}
              </Row>
              <Row label={t("bots.toStopAbove")}>
                {`${formatSigned(((gridParams.stopAbove - price) / price) * 100)}% · ${formatNumber(gridParams.stopAbove, decimals)}`}
              </Row>
            </dl>
          )}
        </section>

        <BotLimits venueLabel={venueLabel} base={base} />
      </div>
    </>
  );
}

/** A grid over the range the price kept to in its test window, the stop-outs just outside it. */
function gridDefaults(bars: readonly Bar[], price: number): Record<keyof GridParams, string> {
  const lower = round(Math.min(...bars.map((b) => b.low), price) * 0.995);
  const upper = round(Math.max(...bars.map((b) => b.high), price) * 1.005);
  return {
    lower: String(lower),
    upper: String(upper),
    levels: "13",
    sizePerLevel: String(round(CAPITAL / 13 / price)),
    stopBelow: String(round(lower * 0.985)),
    stopAbove: String(round(upper * 1.015)),
  };
}

function gridProblems(p: GridParams): Partial<Record<keyof GridParams, string>> {
  const out: Partial<Record<keyof GridParams, string>> = {};
  if (!(p.lower > 0)) out.lower = t("bots.problem.positive", { field: t("bots.grid.lower") });
  if (!(p.upper > p.lower)) out.upper = t("bots.problem.upper");
  if (!(p.levels >= 2 && p.levels <= 100)) out.levels = t("bots.problem.levels");
  if (!(p.sizePerLevel > 0))
    out.sizePerLevel = t("bots.problem.positive", { field: t("bots.grid.size") });
  if (!(p.stopBelow < p.lower)) out.stopBelow = t("bots.problem.stopBelow");
  if (!(p.stopAbove > p.upper)) out.stopAbove = t("bots.problem.stopAbove");
  return out;
}

function emaProblems(p: EmaParams): Partial<Record<keyof EmaParams, string>> {
  const out: Partial<Record<keyof EmaParams, string>> = {};
  if (!(p.fast >= 2)) out.fast = t("bots.problem.fast");
  if (!(p.slow > p.fast)) out.slow = t("bots.problem.slow");
  if (!(p.stopAtr > 0)) out.stopAtr = t("bots.problem.positive", { field: t("bots.ema.stop") });
  if (!(p.risk > 0 && p.risk <= 0.05)) out.risk = t("bots.problem.risk");
  if (!(p.maxLeverage >= 1 && p.maxLeverage <= 20)) out.maxLeverage = t("bots.problem.leverage");
  return out;
}

/** The bot's own limits: on top of the account's trading rules, never instead. */
function BotLimits({ venueLabel, base }: { venueLabel: string; base: string }) {
  const [hours, setHours] = useState(true);
  const [limits, setLimits] = useState({
    maxPosition: "0.2",
    maxLeverage: "3",
    maxLossToday: "150",
    sinceStart: "600",
    maxOrders: "10",
    coolOff: "12",
    from: "06:00",
    to: "22:00",
  });
  const limit = (key: keyof typeof limits, label: string, unit?: string) => (
    <NumberField
      label={label}
      unit={unit}
      value={limits[key]}
      onChange={(v) => setLimits({ ...limits, [key]: v })}
    />
  );
  return (
    <section className="bt-panel bt-form" aria-label={t("bots.limits")}>
      <h2>
        {t("bots.limits")}
        <span className="bt-spacer" />
        <span className="bt-muted">{t("bots.limitsStop")}</span>
      </h2>
      <p className="bt-callout">{t("bots.limitsOnTop", { account: venueLabel })}</p>
      <div className="bt-fields">
        {limit("maxPosition", t("bots.limit.maxPosition"), base)}
        {limit("maxLeverage", t("bots.limit.maxLeverage"), "×")}
        {limit("maxLossToday", t("bots.limit.maxLossToday"), "USD")}
        {limit("sinceStart", t("bots.limit.sinceStart"), "USD")}
        {limit("maxOrders", t("bots.limit.maxOrders"), t("bots.perMinute"))}
        {limit("coolOff", t("bots.limit.coolOff"), "h")}
      </div>
      <h3>
        {t("bots.limit.hours")}
        <label className="bt-toggle">
          <input type="checkbox" checked={hours} onChange={(e) => setHours(e.target.checked)} />
          {t("bots.limit.limitHours")}
        </label>
      </h3>
      {hours && (
        <div className="bt-fields">
          {limit("from", t("bots.limit.from"), "UTC")}
          {limit("to", t("bots.limit.to"), "UTC")}
        </div>
      )}
      <p className="bt-muted">{t("bots.limit.hoursNote")}</p>
      <dl className="bt-rows">
        <Row label={t("bots.limit.ifHit")}>{t("bots.limit.ifHitValue")}</Row>
        <Row label={t("bots.limit.onStop")}>{t("bots.limit.onStopValue")}</Row>
      </dl>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
    <label className="bt-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  unit,
  value,
  error,
  onChange,
}: {
  label: string;
  unit?: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="bt-field" data-error={error ? "" : undefined}>
      <span>{label}</span>
      <span className="bt-input">
        <input
          className="pd-num"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(",", "."))}
        />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bt-row">
      <dt>{label}</dt>
      <dd className="pd-num">{children}</dd>
    </div>
  );
}
