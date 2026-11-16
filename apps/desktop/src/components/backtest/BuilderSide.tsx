import type { Cond, RunResult } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import {
  clock,
  type FullRules,
  isGroup,
  longestLosing,
  minutesOf,
  streakCost,
} from "../../lib/rules";
import { InlineNum, InlineTime, Switch } from "./controls";
import { money } from "./parts";
import { condText } from "./ruleText";
import { SignalsChart } from "./SignalsChart";

/** The level an entry compares its oscillator with (RSI 14 below 60: 60). */
function levelOf(conds: readonly Cond[]): number | undefined {
  for (const c of conds) {
    for (const r of isGroup(c) ? c.conds : [c]) {
      if (r.left.kind === "rsi" && r.right.kind === "value") return r.right.value;
    }
  }
  return undefined;
}

function Status({ running, error, stale }: { running: boolean; error?: string; stale: boolean }) {
  if (error) return <span className="lab-warn lab-side-status">{error}</span>;
  if (running || stale)
    return <span className="lab-dim lab-side-status">{t("bt.side.updating")}</span>;
  return null;
}

/** Beside the entry and exit: what the conditions caught, how each filtered, and when to trade. */
export function RulesSide({
  rules: c,
  onChange,
  run,
  stale,
  running,
  error,
  where,
  period,
}: {
  rules: FullRules;
  onChange: (patch: Partial<FullRules>) => void;
  run?: RunResult;
  stale: boolean;
  running: boolean;
  error?: string;
  /** "BTC-USDT · 4h" */
  where: string;
  /** "Jan 1 – Nov 14" */
  period: string;
}) {
  const funnel = run?.funnel;
  const first = funnel?.entry[0] ?? 0;
  const trades = run?.trades.length ?? 0;
  const g = c.guards;
  return (
    <>
      <section className="lab-panel">
        <div className="lab-ph">
          <h2>{t("bt.side.caught")}</h2>
          <span className="lab-ph-r lab-dim">{where}</span>
        </div>
        <Status running={running} error={error} stale={stale} />
        {run ? (
          <SignalsChart run={run} level={levelOf(c.entry)} />
        ) : (
          !error && <p className="lab-dim lab-pad">{t("bt.side.firstRun")}</p>
        )}
      </section>

      <section className="lab-panel">
        <div className="lab-ph">
          <h2>{t("bt.side.filters")}</h2>
          <span className="lab-ph-r lab-dim">{period}</span>
        </div>
        {funnel && !stale ? (
          <div className="lab-funnel">
            {c.entry.map((cond, i) => {
              const n = funnel.entry[i] ?? 0;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids; order is the identity
                <div key={i} className="lab-funnel-row">
                  <span>
                    {i > 0 && c.entryMatch === "all" ? `${t("bt.say.and")} ` : ""}
                    {condText(cond)}
                  </span>
                  <b>{n}</b>
                  <span className="lab-funnel-bar">
                    <i style={{ width: `${first > 0 ? (n / first) * 100 : 0}%` }} />
                  </span>
                </div>
              );
            })}
            {funnel.blocked > 0 && (
              <p className="lab-dim">{t("bt.side.blocked", { n: funnel.blocked })}</p>
            )}
            {trades < 30 && (
              <div className="lab-note-box warn">
                <span>!</span>
                <p>
                  <b>{t("bt.side.thinTitle", { n: trades })}</b> {t("bt.side.thinBody")}
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="lab-dim lab-pad">{t("bt.side.countsWait")}</p>
        )}
      </section>

      <section className="lab-panel">
        <div className="lab-ph">
          <h2>{t("bt.side.only")}</h2>
          <span className="lab-ph-r lab-dim">{t("bt.side.onlyHint")}</span>
        </div>
        <div className="lab-only">
          <div className="lab-only-row">
            <Switch
              on={c.hours !== undefined}
              label={t("bt.side.hours")}
              onChange={(on) =>
                onChange({ hours: on ? { from: 7 * 60, to: 21 * 60, weekdays: true } : undefined })
              }
            />
            <span>
              {t("bt.side.between")}{" "}
              <InlineTime
                label={t("bt.side.from")}
                value={clock(c.hours?.from ?? 420)}
                parse={(s) => {
                  const m = minutesOf(s);
                  return m !== undefined && m < 1440 ? m : undefined;
                }}
                onChange={(from) => c.hours && onChange({ hours: { ...c.hours, from } })}
              />{" "}
              {t("bt.side.and")}{" "}
              <InlineTime
                label={t("bt.side.to")}
                value={clock(c.hours?.to ?? 1260)}
                parse={minutesOf}
                onChange={(to) => c.hours && onChange({ hours: { ...c.hours, to } })}
              />{" "}
              UTC,{" "}
              <button
                type="button"
                className="lab-inline-word"
                disabled={!c.hours}
                onClick={() =>
                  c.hours && onChange({ hours: { ...c.hours, weekdays: !c.hours.weekdays } })
                }
              >
                {c.hours?.weekdays === false ? t("bt.side.everyDay") : t("bt.side.weekdays")}
              </button>
            </span>
          </div>
          <div className="lab-only-row">
            <Switch
              on={g.coolOff !== undefined}
              label={t("bt.guard.cool")}
              onChange={(on) =>
                onChange({ guards: { ...g, coolOff: on ? { losses: 3, hours: 24 } : undefined } })
              }
            />
            <span>
              {t("bt.side.notAfter")}{" "}
              <InlineNum
                label={t("bt.guard.cool")}
                value={g.coolOff?.losses ?? 3}
                onChange={(v) =>
                  g.coolOff &&
                  v >= 1 &&
                  onChange({ guards: { ...g, coolOff: { ...g.coolOff, losses: Math.round(v) } } })
                }
              />{" "}
              {t("bt.side.lossesFor")}{" "}
              <InlineNum
                label={t("bt.guard.coolHours")}
                value={g.coolOff?.hours ?? 24}
                suffix="h"
                onChange={(v) =>
                  g.coolOff &&
                  v > 0 &&
                  onChange({ guards: { ...g, coolOff: { ...g.coolOff, hours: v } } })
                }
              />
            </span>
          </div>
          <p className="lab-dim">{t("bt.side.noNews")}</p>
        </div>
      </section>
    </>
  );
}

/** How the stop reads beside its line: "Stop · 2× ATR", "Stop · 3%". */
function stopName(c: FullRules): string {
  const st = c.stop ?? (c.stopLoss > 0 ? { kind: "fixed" as const, pct: c.stopLoss } : undefined);
  if (!st || st.kind === "none") return t("bt.shape.stop");
  if (st.kind === "atr") return t("bt.shape.stopAt", { x: `${st.mult}× ATR` });
  if (st.kind === "fixed")
    return t("bt.shape.stopAt", { x: `${Number((st.pct * 100).toFixed(2))}%` });
  return t("bt.shape.stop");
}

/**
 * Labels down the right edge at their lines, pushed apart where they'd
 * touch: the first pass from the top, then back up from the bottom.
 */
function spread<T extends { y: number }>(
  items: T[],
  gap: number,
  top: number,
  bottom: number,
): T[] {
  const out = [...items].sort((a, b) => a.y - b.y).map((x) => ({ ...x }));
  for (let i = 0; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (cur) cur.y = Math.max(cur.y, prev ? prev.y + gap : top);
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const next = out[i + 1];
    const cur = out[i];
    if (cur) cur.y = Math.min(cur.y, next ? next.y - gap : bottom);
  }
  return out;
}

/** One trade drawn from the settings: the entry, the stop, the targets and the trail. */
function TradeShape({ c }: { c: FullRules }) {
  const W = 480;
  const H = 300;
  const targets = c.targets;
  const topR = Math.max(2.5, ...targets.map((x) => x.atR + 0.6), (c.trail?.fromR ?? 0) + 1.5);
  const y = (r: number) => 24 + ((topR - r) / (topR + 1.5)) * (H - 48);
  const x0 = 70;
  const x1 = 330;
  const lx = x1 + 10;
  const stopped = c.stop?.kind !== "none" && (c.stop !== undefined || c.stopLoss > 0);
  // A path that dips, climbs through the targets, and gives some back.
  const peak = Math.max(1.6, ...targets.map((x) => x.atR + 0.4));
  const pts: [number, number][] = [
    [x0, 0],
    [x0 + 30, -0.4],
    [x0 + 80, 0.4],
    [x0 + 115, 1.2],
    [x0 + 140, 0.85],
    [x0 + 185, peak * 0.85],
    [x0 + 220, peak],
    [x0 + 245, peak * 0.85],
    [x1, peak * 0.7],
  ];
  const be = c.breakevenAt;
  const trailFrom = c.trail?.fromR;
  const trailY = peak - 0.65;
  const labels = spread(
    [
      ...(stopped ? [{ key: "stop", y: y(-1), text: stopName(c), cls: "dn" }] : []),
      { key: "entry", y: y(0), text: t("bt.shape.entry"), cls: "" },
      ...targets.map((x) => ({
        key: `t${x.atR}`,
        y: y(x.atR),
        text: t("bt.shape.take", { r: x.atR, pct: Math.round(x.close * 100) }),
        cls: "up",
      })),
      ...(c.trail && trailFrom !== undefined
        ? [
            {
              key: "trail",
              y: y(trailY),
              text: t("bt.shape.trail", { x: c.trail.atr }),
              cls: "brass",
            },
          ]
        : []),
    ],
    17,
    14,
    H - 6,
  );
  return (
    <svg className="lab-shape" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {stopped && (
        <>
          <rect
            className="lab-shape-win"
            x={x0}
            y={y(topR)}
            width={x1 - x0}
            height={y(0) - y(topR)}
          />
          <rect className="lab-shape-loss" x={x0} y={y(0)} width={x1 - x0} height={y(-1) - y(0)} />
          <line className="lab-shape-stop" x1={10} x2={x1} y1={y(-1)} y2={y(-1)} />
        </>
      )}
      <line className="lab-shape-entry" x1={10} x2={x1} y1={y(0)} y2={y(0)} />
      {targets.map((x) => (
        <line
          key={x.atR}
          className="lab-shape-target"
          x1={10}
          x2={x1}
          y1={y(x.atR)}
          y2={y(x.atR)}
        />
      ))}
      {c.trail && trailFrom !== undefined && (
        <path
          className="lab-shape-trail"
          d={`M${x0 + 150},${y(Math.max(0.3, Math.min(trailFrom, peak) - 1))} L${x0 + 185},${y(trailY)} L${x1},${y(trailY)}`}
        />
      )}
      {be !== undefined && stopped && (
        <text className="lab-shape-note" x={x1 - 4} y={y(0) + 16} textAnchor="end">
          {t("bt.shape.toEntry", { r: be })}
        </text>
      )}
      <polyline
        className="lab-shape-path"
        points={pts.map(([px, r]) => `${px},${y(r)}`).join(" ")}
      />
      {targets.map((x) => {
        // Where the path first reaches the target: between two points, in proportion.
        const i = pts.findIndex(([, r]) => r >= x.atR);
        const b = pts[i];
        const a = pts[i - 1];
        if (!b) return null;
        const px =
          a && b[1] !== a[1] ? a[0] + ((x.atR - a[1]) / (b[1] - a[1])) * (b[0] - a[0]) : b[0];
        return <circle key={x.atR} className="lab-shape-dot" cx={px} cy={y(x.atR)} r={4} />;
      })}
      <circle className="lab-shape-start" cx={x0} cy={y(0)} r={4} />
      {labels.map((l) => (
        <text key={l.key} className={`lab-shape-t ${l.cls}`} x={lx} y={l.y + 4}>
          {l.text}
        </text>
      ))}
    </svg>
  );
}

/** Beside the risk settings: one trade's shape, what it comes to in money, and runs of losses. */
export function RiskSide({
  rules: c,
  capital,
  risk,
  notional,
  fee,
  run,
  where,
}: {
  rules: FullRules;
  /** The market it's drawn for: "BTC-USDT". */
  where?: string;
  capital: number;
  /** The share of equity a trade loses at its stop. */
  risk: number;
  notional?: number;
  /** Taker fee, a fraction. */
  fee: number;
  run?: RunResult;
}) {
  const atRisk = capital * risk;
  const banked = c.targets.map((x) => x.close * x.atR * atRisk);
  const be = c.breakevenAt;
  const firstTarget = c.targets[0]?.atR;
  const worstAfter = be !== undefined && (firstTarget === undefined || be <= firstTarget);
  // The run's best winner, to name the trade the drawing stands for.
  const best = run?.trades.reduce<RunResult["trades"][number] | undefined>(
    (b, x) => (x.pnl > 0 && (!b || x.r > b.r) ? x : b),
    undefined,
  );
  const longest = run ? longestLosing(run.trades.map((x) => x.pnl)) : undefined;
  const streaks = [5, 10, 15, 20];
  const dd = c.guards.maxDrawdown;
  const stoppedAt = dd !== undefined ? streaks.find((n) => streakCost(risk, n) <= -dd) : undefined;
  const pctOf = (v: number) => `${(v * 100).toFixed(1)}%`;
  return (
    <>
      <section className="lab-panel">
        <div className="lab-ph">
          <h2>{t("bt.side.oneTrade")}</h2>
          {where && (
            <span className="lab-ph-r lab-dim">{best ? `#${best.n} · ${where}` : where}</span>
          )}
        </div>
        <TradeShape c={c} />
      </section>
      <section className="lab-panel">
        <div className="lab-ph">
          <h2>{t("bt.side.onCapital", { capital: money(capital) })}</h2>
        </div>
        <div className="lab-kv">
          <span>{t("bt.side.lostAtStop")}</span>
          <b className="dn">{risk > 0 ? money(-atRisk, true) : "–"}</b>
          {banked.length > 0 && (
            <>
              <span>
                {t("bt.side.bankedAt", { at: c.targets.map((x) => `${x.atR}R`).join(" & ") })}
              </span>
              <b className="up">{banked.map((v) => money(v, true)).join(" · ")}</b>
            </>
          )}
          {worstAfter && (
            <>
              <span>{t("bt.side.worstAfter", { r: be })}</span>
              <b>{t("bt.side.zeroAtEntry")}</b>
            </>
          )}
          <span>{t("bt.side.fees")}</span>
          <b className="lab-mut">{notional ? money(-notional * fee * 2, true, 2) : "–"}</b>
        </div>
      </section>
      <section className="lab-panel">
        <div className="lab-ph">
          <h2>{t("bt.side.streaks", { pct: pctOf(risk) })}</h2>
          <span className="lab-ph-r lab-dim">{t("bt.side.streaksHint")}</span>
        </div>
        <div className="lab-streaks">
          {streaks.map((n) => {
            const v = streakCost(risk, n);
            return (
              <div key={n} className={`lab-tile${dd !== undefined && v <= -dd ? " hit" : ""}`}>
                <span>{n === 5 ? t("bt.side.inARow", { n }) : n}</span>
                <b className={v < -0.1 ? "dn" : undefined}>{pctOf(v)}</b>
              </div>
            );
          })}
        </div>
        <p className="lab-streak-note">
          {stoppedAt !== undefined && dd !== undefined
            ? t("bt.side.guardStops", { n: stoppedAt, pct: Math.round(dd * 100) })
            : null}{" "}
          {longest !== undefined ? t("bt.side.longest", { n: longest }) : null}
        </p>
      </section>
    </>
  );
}
