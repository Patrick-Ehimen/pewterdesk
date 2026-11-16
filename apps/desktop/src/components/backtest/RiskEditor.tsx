import type { Sizing, StopRule, Target } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { LuPlus, LuX } from "react-icons/lu";
import type { FullRules, SizePreview } from "../../lib/rules";
import type { RulesView } from "../../lib/tradingRules";
import { InlineNum, Switch } from "./controls";
import { price as fmtPrice, money, NumField, Seg } from "./parts";

const SIZINGS = ["fixed", "equity", "risk", "volatility", "kelly"] as const;
type SizingKind = (typeof SIZINGS)[number];

/** A sizing of `kind`, keeping what it can of `was`. */
function sizingOf(kind: SizingKind, was: Sizing | undefined): Sizing {
  const risk = was?.kind === "risk" ? was.risk : was?.kind === "kelly" ? was.maxRisk : 0.01;
  switch (kind) {
    case "fixed":
      return { kind, amount: 2_500 };
    case "equity":
      return { kind, share: 1 };
    case "risk":
      return { kind, risk };
    case "volatility":
      return { kind, target: 0.01 };
    case "kelly":
      return { kind, fraction: 0.25, maxRisk: Math.max(0.01, risk) };
  }
}

const STOPS = ["fixed", "atr", "swing", "none"] as const;
function stopOf(kind: StopRule["kind"], was: StopRule | undefined): StopRule {
  switch (kind) {
    case "fixed":
      return { kind, pct: was?.kind === "fixed" ? was.pct : 0.03 };
    case "atr":
      return { kind, mult: was?.kind === "atr" ? was.mult : 2, period: 14 };
    case "swing":
      return { kind, lookback: 10 };
    case "none":
      return { kind };
  }
}

/** A rules set's limits as the backtest's guard rails. */
export function guardsFrom(view: RulesView): FullRules["guards"] {
  const r = view.rules;
  return {
    dailyLoss: r.challenge.dailyPct > 0 ? r.challenge.dailyPct / 100 : undefined,
    maxDrawdown: r.challenge.maxPct > 0 ? r.challenge.maxPct / 100 : undefined,
    tradesPerDay: r.tradesPerDay > 0 ? r.tradesPerDay : undefined,
    coolOff:
      r.coolOff.losses > 0 && r.coolOff.minutes > 0
        ? { losses: r.coolOff.losses, hours: r.coolOff.minutes / 60 }
        : undefined,
  };
}

const sameGuards = (a: FullRules["guards"], b: FullRules["guards"]) =>
  a.dailyLoss === b.dailyLoss &&
  a.maxDrawdown === b.maxDrawdown &&
  a.tradesPerDay === b.tradesPerDay &&
  a.coolOff?.losses === b.coolOff?.losses &&
  a.coolOff?.hours === b.coolOff?.hours;

/**
 * How big each trade is, where it's wrong, how it's taken off, and the
 * account's guard rails: the Risk step of the builder.
 */
export function RiskEditor({
  rules: c,
  onChange,
  capital,
  base,
  lastPrice,
  preview,
  ruleSets,
  accountName,
}: {
  rules: FullRules;
  onChange: (patch: Partial<FullRules>) => void;
  capital: number;
  /** The market's base asset ("BTC"). */
  base: string;
  lastPrice?: number;
  preview?: SizePreview;
  ruleSets: readonly RulesView[];
  accountName: (v: RulesView) => string;
}) {
  const sizing = c.sizing ?? { kind: "equity", share: c.size };
  const stop = c.stop ?? (c.stopLoss > 0 ? { kind: "fixed", pct: c.stopLoss } : { kind: "none" });
  const stopped = stop.kind !== "none";
  const g = c.guards;
  const setGuards = (patch: Partial<FullRules["guards"]>) =>
    onChange({ guards: { ...g, ...patch } });
  const synced = ruleSets.find((v) => sameGuards(guardsFrom(v), g));
  const firstSet = ruleSets[0];
  const closed = c.targets.reduce((a, x) => a + x.close, 0);
  const setTarget = (i: number, patch: Partial<Target>) =>
    onChange({ targets: c.targets.map((x, k) => (k === i ? { ...x, ...patch } : x)) });

  return (
    <>
      <div className="lab-sec">
        <div className="lab-sh">
          <h3>{t("bt.risk.size")}</h3>
          <p>{t("bt.risk.sizeHint")}</p>
        </div>
        <fieldset className="lab-size-cards" aria-label={t("bt.risk.size")}>
          {SIZINGS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={sizing.kind === k}
              className={sizing.kind === k ? "on" : undefined}
              onClick={() => onChange({ sizing: sizingOf(k, c.sizing) })}
            >
              <b>{t(`bt.sizing.${k}`)}</b>
              <span>{t(`bt.sizing.${k}Body`)}</span>
            </button>
          ))}
        </fieldset>
        <div className="lab-grid4">
          {sizing.kind === "risk" && (
            <NumField
              label={t("bt.risk.riskTrade")}
              value={Number((sizing.risk * 100).toFixed(3))}
              digits={2}
              step={0.25}
              unit={t("bt.unit.ofEquity")}
              onChange={(v) => onChange({ sizing: { kind: "risk", risk: v / 100 } })}
            />
          )}
          {sizing.kind === "fixed" && (
            <NumField
              label={t("bt.risk.amount")}
              value={sizing.amount}
              unit="$"
              onChange={(amount) => onChange({ sizing: { kind: "fixed", amount } })}
            />
          )}
          {sizing.kind === "equity" && (
            <NumField
              label={t("bt.risk.share")}
              value={Number((sizing.share * 100).toFixed(2))}
              unit={t("bt.unit.ofEquity")}
              onChange={(v) => onChange({ sizing: { kind: "equity", share: v / 100 } })}
            />
          )}
          {sizing.kind === "volatility" && (
            <NumField
              label={t("bt.risk.target")}
              value={Number((sizing.target * 100).toFixed(3))}
              step={0.25}
              unit={t("bt.risk.aCandle")}
              onChange={(v) => onChange({ sizing: { kind: "volatility", target: v / 100 } })}
            />
          )}
          {sizing.kind === "kelly" && (
            <NumField
              label={t("bt.risk.kellyAtMost")}
              value={Number((sizing.maxRisk * 100).toFixed(3))}
              step={0.25}
              unit={t("bt.unit.ofEquity")}
              onChange={(v) => onChange({ sizing: { ...sizing, maxRisk: v / 100 } })}
            />
          )}
          <NumField
            label={t("bt.p.maxLeverage")}
            value={c.maxLeverage ?? 1}
            unit="×"
            onChange={(v) => onChange({ maxLeverage: v > 0 ? v : undefined })}
          />
          <div className="lab-field">
            <span>{t("bt.risk.margin")}</span>
            <Seg<"isolated" | "cross">
              label={t("bt.risk.margin")}
              value={c.margin ?? "isolated"}
              onChange={(margin) => onChange({ margin })}
              options={[
                { value: "isolated", label: t("bt.risk.isolated") },
                { value: "cross", label: t("bt.risk.cross") },
              ]}
            />
          </div>
          <NumField
            label={t("bt.risk.neverAbove")}
            value={Number(((c.maxShare ?? 0) * 100).toFixed(2))}
            blankZero
            placeholder={t("bt.risk.noCap")}
            unit={t("bt.risk.ofEquityMarket")}
            onChange={(v) => onChange({ maxShare: v > 0 ? Math.min(1, v / 100) : undefined })}
          />
        </div>
        {sizing.kind === "kelly" && (
          <p className="lab-dim lab-note-line">
            {t("bt.risk.kellyNote", { fraction: sizing.fraction })}
          </p>
        )}
        <div className="lab-callout-line">
          {preview && lastPrice ? (
            <>
              {t("bt.risk.onCapital", { capital: money(capital) })}{" "}
              {preview.stopAt !== undefined &&
                t("bt.risk.stopAway", {
                  pct: ((Math.abs(lastPrice - preview.stopAt) / lastPrice) * 100).toFixed(1),
                })}
              :{" "}
              <b className="lab-num">
                {preview.size.toLocaleString("en-US", { maximumSignificantDigits: 4 })} {base}
              </b>
              , <b className="lab-num">{money(preview.notional)}</b>{" "}
              {t("bt.risk.ofBase", { base, x: preview.leverage.toFixed(2) })}
              {preview.liquidation !== undefined && (
                <>
                  {" "}
                  {t("bt.risk.liqAt")} <b className="lab-num">${fmtPrice(preview.liquidation)}</b>
                  {preview.further !== undefined &&
                    (preview.further > 1
                      ? t("bt.risk.liqSafe", { x: preview.further.toFixed(1) })
                      : t("bt.risk.liqFirst"))}
                </>
              )}
            </>
          ) : (
            <span className="lab-dim">{t("bt.risk.noPrice")}</span>
          )}
        </div>
      </div>

      <div className="lab-sec">
        <div className="lab-sh">
          <h3>{t("bt.risk.stop")}</h3>
          <p>{t("bt.risk.stopHint")}</p>
          <span className="lab-sh-r">
            <Seg<StopRule["kind"]>
              label={t("bt.risk.stop")}
              value={stop.kind}
              onChange={(k) =>
                onChange(
                  k === "none"
                    ? {
                        stop: stopOf(k, c.stop),
                        breakevenAt: undefined,
                        trail: undefined,
                        targets: [],
                      }
                    : { stop: stopOf(k, c.stop) },
                )
              }
              options={STOPS.map((k) => ({ value: k, label: t(`bt.stopKind.${k}`) }))}
            />
          </span>
        </div>
        {stopped && (
          <div className="lab-grid4">
            {stop.kind === "fixed" && (
              <NumField
                label={t("bt.risk.distance")}
                value={Number((stop.pct * 100).toFixed(3))}
                step={0.5}
                unit={t("bt.risk.fromEntry")}
                onChange={(v) => onChange({ stop: { kind: "fixed", pct: v / 100 } })}
              />
            )}
            {stop.kind === "atr" && (
              <NumField
                label={t("bt.risk.distance")}
                value={stop.mult}
                digits={1}
                step={0.25}
                unit={`× ATR ${stop.period}`}
                onChange={(mult) => onChange({ stop: { ...stop, mult } })}
              />
            )}
            {stop.kind === "swing" && (
              <NumField
                label={t("bt.risk.lookback")}
                value={stop.lookback}
                unit={t("bt.unit.candles")}
                onChange={(v) => onChange({ stop: { kind: "swing", lookback: Math.round(v) } })}
              />
            )}
            <div className="lab-field">
              <span>{t("bt.risk.moveToEntry")}</span>
              <span className="lab-input lab-switch-field">
                {t("bt.risk.after")}
                <InlineNum
                  label={t("bt.risk.moveToEntry")}
                  value={c.breakevenAt ?? 1}
                  suffix="R"
                  onChange={(v) => c.breakevenAt !== undefined && onChange({ breakevenAt: v || 1 })}
                />
                <Switch
                  on={c.breakevenAt !== undefined}
                  label={t("bt.risk.moveToEntry")}
                  onChange={(on) => onChange({ breakevenAt: on ? 1 : undefined })}
                />
              </span>
            </div>
            <div className="lab-field">
              <span>{t("bt.risk.trailBy")}</span>
              <span className="lab-input lab-switch-field">
                <InlineNum
                  label={t("bt.risk.trailBy")}
                  value={c.trail?.atr ?? 3}
                  suffix="× ATR"
                  onChange={(atr) => c.trail && onChange({ trail: { ...c.trail, atr } })}
                />
                <Switch
                  on={c.trail !== undefined}
                  label={t("bt.risk.trailBy")}
                  onChange={(on) => onChange({ trail: on ? { atr: 3, fromR: 2 } : undefined })}
                />
              </span>
            </div>
            <NumField
              label={t("bt.risk.trailFrom")}
              value={c.trail?.fromR ?? 2}
              unit="R"
              onChange={(fromR) => c.trail && onChange({ trail: { ...c.trail, fromR } })}
            />
          </div>
        )}
      </div>

      <div className="lab-sec">
        <div className="lab-sh">
          <h3>{t("bt.risk.takeProfit")}</h3>
          <p>{stopped ? t("bt.risk.takeProfitHint") : t("bt.risk.needsStop")}</p>
        </div>
        {stopped && (
          <div className="lab-tp">
            {c.targets.map((x, i) => {
              const before = c.targets.slice(0, i).reduce((a, y) => a + y.close, 0);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: targets are kept in order; it's their identity
                <div key={i} className="lab-tp-row">
                  <span className="lab-dim">{i + 1}</span>
                  <span>
                    {t("bt.risk.at")}{" "}
                    <InlineNum
                      label={t("bt.risk.at")}
                      value={x.atR}
                      suffix="R"
                      onChange={(atR) => atR > 0 && setTarget(i, { atR })}
                    />
                  </span>
                  <span className="lab-tp-bar">
                    <i style={{ left: `${before * 100}%`, width: `${x.close * 100}%` }} />
                  </span>
                  <span>
                    {t("bt.risk.close")}{" "}
                    <InlineNum
                      label={t("bt.risk.close")}
                      value={x.close}
                      scale={100}
                      suffix="%"
                      onChange={(v) => v > 0 && setTarget(i, { close: Math.min(1, v) })}
                    />
                  </span>
                  <button
                    type="button"
                    className="lab-x"
                    aria-label={t("bt.cond.remove")}
                    onClick={() => onChange({ targets: c.targets.filter((_, k) => k !== i) })}
                  >
                    <LuX size={12} />
                  </button>
                </div>
              );
            })}
            <div className="lab-tp-row rest">
              <span className="lab-dim">{c.targets.length + 1}</span>
              <span>{t("bt.risk.theRest")}</span>
              <span className="lab-tp-bar">
                <i
                  className="rest"
                  style={{
                    left: `${Math.min(1, closed) * 100}%`,
                    width: `${Math.max(0, 1 - closed) * 100}%`,
                  }}
                />
              </span>
              <span>{c.trail ? t("bt.risk.ridesTrail") : t("bt.risk.ridesStop")}</span>
              <span />
            </div>
            {closed > 1 + 1e-9 && <p className="lab-warn">{t("bt.problem.targets")}</p>}
            <button
              type="button"
              className="lab-add-btn"
              disabled={closed >= 1}
              onClick={() =>
                onChange({
                  targets: [
                    ...c.targets,
                    {
                      atR: (c.targets.at(-1)?.atR ?? 0) + 1,
                      close: Math.min(0.3, Math.max(0.05, Number((1 - closed).toFixed(2)))),
                    },
                  ],
                })
              }
            >
              <LuPlus size={13} aria-hidden /> {t("bt.risk.addTarget")}
            </button>
          </div>
        )}
      </div>

      <div className="lab-sec">
        <div className="lab-sh">
          <h3>{t("bt.risk.guards")}</h3>
          <p>{t("bt.risk.guardsHint")}</p>
        </div>
        {firstSet && (
          <div className="lab-sync">
            <Switch
              on={synced !== undefined}
              label={t("bt.risk.useRules")}
              onChange={(on) => onChange({ guards: on ? guardsFrom(synced ?? firstSet) : {} })}
            />
            <span>
              {t("bt.risk.useRulesOf")} <b>{accountName(synced ?? firstSet)}</b>
              {t("bt.risk.useRulesWhy")}
            </span>
            {synced && <span className="lab-info lab-sync-state">{t("bt.risk.synced")}</span>}
          </div>
        )}
        <div className="lab-guards">
          <div className="lab-guard">
            <Switch
              on={g.dailyLoss !== undefined}
              label={t("bt.guard.daily")}
              onChange={(on) => setGuards({ dailyLoss: on ? 0.03 : undefined })}
            />
            <span>
              <b>
                {t("bt.guard.daily")}{" "}
                <InlineNum
                  label={t("bt.guard.daily")}
                  value={g.dailyLoss ?? 0.03}
                  scale={100}
                  suffix="%"
                  onChange={(v) =>
                    g.dailyLoss !== undefined && v > 0 && setGuards({ dailyLoss: v })
                  }
                />
              </b>
              <small>{t("bt.guard.dailyHint")}</small>
            </span>
          </div>
          <div className="lab-guard">
            <Switch
              on={g.maxDrawdown !== undefined}
              label={t("bt.guard.drawdown")}
              onChange={(on) => setGuards({ maxDrawdown: on ? 0.12 : undefined })}
            />
            <span>
              <b>
                {t("bt.guard.drawdown")}{" "}
                <InlineNum
                  label={t("bt.guard.drawdown")}
                  value={g.maxDrawdown ?? 0.12}
                  scale={100}
                  suffix="%"
                  onChange={(v) =>
                    g.maxDrawdown !== undefined && v > 0 && setGuards({ maxDrawdown: v })
                  }
                />{" "}
                {t("bt.guard.fromHigh")}
              </b>
              <small>{t("bt.guard.drawdownHint")}</small>
            </span>
          </div>
          <div className="lab-guard">
            <Switch
              on={g.tradesPerDay !== undefined}
              label={t("bt.guard.trades")}
              onChange={(on) => setGuards({ tradesPerDay: on ? 3 : undefined })}
            />
            <span>
              <b>
                {t("bt.guard.atMost")}{" "}
                <InlineNum
                  label={t("bt.guard.trades")}
                  value={g.tradesPerDay ?? 3}
                  onChange={(v) =>
                    g.tradesPerDay !== undefined &&
                    v >= 1 &&
                    setGuards({ tradesPerDay: Math.round(v) })
                  }
                />{" "}
                {t("bt.guard.tradesADay")}
              </b>
              <small>{t("bt.guard.tradesHint")}</small>
            </span>
          </div>
          <div className="lab-guard">
            <Switch
              on={g.coolOff !== undefined}
              label={t("bt.guard.cool")}
              onChange={(on) => setGuards({ coolOff: on ? { losses: 3, hours: 24 } : undefined })}
            />
            <span>
              <b>
                {t("bt.guard.after")}{" "}
                <InlineNum
                  label={t("bt.guard.cool")}
                  value={g.coolOff?.losses ?? 3}
                  onChange={(v) =>
                    g.coolOff &&
                    v >= 1 &&
                    setGuards({ coolOff: { ...g.coolOff, losses: Math.round(v) } })
                  }
                />{" "}
                {t("bt.guard.lossesWait")}{" "}
                <InlineNum
                  label={t("bt.guard.coolHours")}
                  value={g.coolOff?.hours ?? 24}
                  suffix="h"
                  onChange={(v) =>
                    g.coolOff && v > 0 && setGuards({ coolOff: { ...g.coolOff, hours: v } })
                  }
                />
              </b>
              <small>{t("bt.guard.coolHint")}</small>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
