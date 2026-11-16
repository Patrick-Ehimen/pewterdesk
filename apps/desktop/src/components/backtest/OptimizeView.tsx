import type { Cell } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import { LuCheck, LuSlidersHorizontal } from "react-icons/lu";
import {
  getParam,
  type LabStrategy,
  type ParamSpec,
  paramSpecs,
  type Rank,
  runOptimize,
  score,
  steps,
} from "../../lib/backtestLab";
import { pct, Seg, Sentence, tone } from "./parts";

interface AxisDraft {
  param: string;
  from: number;
  to: number;
  by: number;
}

const shown = (spec: ParamSpec | undefined, v: number) =>
  spec?.kind === "pct" ? `${Number((v * 100).toFixed(2))}%` : String(Number(v.toFixed(4)));

function axisFor(spec: ParamSpec, current: number): AxisDraft {
  const [from, to, by] = spec.range(current);
  return {
    param: spec.name,
    from: Number(from.toFixed(6)),
    to: Number(to.toFixed(6)),
    by: Number(by.toFixed(6)),
  };
}

function AxisForm({
  label,
  specs,
  axis,
  onChange,
  current,
}: {
  label: string;
  specs: ParamSpec[];
  axis: AxisDraft;
  onChange: (a: AxisDraft) => void;
  current: (name: string) => number;
}) {
  const spec = specs.find((s) => s.name === axis.param);
  const k = spec?.kind === "pct" ? 100 : 1;
  const values = steps(axis.from, axis.to, axis.by);
  return (
    <div className="lab-axis">
      <div className="lab-axis-head">
        <b>{label}</b>
        <select
          className="lab-input"
          value={axis.param}
          onChange={(e) => {
            const next = specs.find((s) => s.name === e.target.value);
            if (next) onChange(axisFor(next, current(next.name)));
          }}
        >
          {specs.map((s) => (
            <option key={s.name} value={s.name}>
              {t(`bt.p.${s.name}` as "bt.p.fast")}
            </option>
          ))}
        </select>
      </div>
      <div className="lab-grid3 tight">
        {(["from", "to", "by"] as const).map((f) => (
          <label key={f} className="lab-field">
            <span>{t(`bt.opt.${f}`)}</span>
            <span className="lab-input">
              <input
                type="number"
                value={Number((axis[f] * k).toFixed(4))}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) onChange({ ...axis, [f]: n / k });
                }}
              />
              {spec?.kind === "pct" && <em>%</em>}
            </span>
          </label>
        ))}
      </div>
      <div className="lab-vals">
        {values.map((v) => (
          <i key={v} className={Math.abs(v - current(axis.param)) < 1e-9 ? "on" : undefined}>
            {shown(spec, v)}
          </i>
        ))}
        {values.length === 0 && <span className="lab-warn">{t("bt.opt.badRange")}</span>}
      </div>
    </div>
  );
}

export function OptimizeView({
  strategy,
  onApply,
}: {
  strategy: LabStrategy;
  /** Takes the cell's settings into the strategy, and runs it. */
  onApply: (patch: Record<string, number>) => void;
}) {
  const specs = useMemo(() => paramSpecs(strategy.strategy), [strategy.strategy]);
  const current = (name: string) => getParam(strategy.strategy, name);
  const [x, setX] = useState<AxisDraft>(() => {
    const first = specs[0] as ParamSpec;
    return axisFor(first, getParam(strategy.strategy, first.name));
  });
  const [useY, setUseY] = useState(specs.length > 1);
  const [y, setY] = useState<AxisDraft>(() => {
    const second = (specs[1] ?? specs[0]) as ParamSpec;
    return axisFor(second, getParam(strategy.strategy, second.name));
  });
  const [rank, setRank] = useState<Rank>("ret");
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "running" }
    | { status: "done"; cells: Cell[]; x: AxisDraft; y?: AxisDraft }
    | { status: "error"; error: string }
  >({ status: "idle" });

  const xs = steps(x.from, x.to, x.by);
  const ys = useY ? steps(y.from, y.to, y.by) : [];
  const count = xs.length * (useY ? ys.length : 1);
  const tooMany = count > 400;
  const sameParam = useY && x.param === y.param;

  const go = () => {
    if (!xs.length || (useY && !ys.length) || tooMany || sameParam) return;
    setState({ status: "running" });
    runOptimize(strategy, {
      x: { param: x.param, values: xs },
      y: useY ? { param: y.param, values: ys } : undefined,
    }).then(
      (cells) => setState({ status: "done", cells, x, y: useY ? y : undefined }),
      (e: unknown) =>
        setState({ status: "error", error: e instanceof Error ? e.message : String(e) }),
    );
  };

  const done = state.status === "done" ? state : undefined;
  const ranked = useMemo(
    () =>
      done
        ? done.cells
            .filter((c) => c.summary)
            .sort((a, b) => (score(b, rank) ?? -Infinity) - (score(a, rank) ?? -Infinity))
        : [],
    [done, rank],
  );
  const best = ranked[0];
  const colored = (c: Cell) => {
    const v = strategy.holdOutDays > 0 ? c.summary?.retOut : c.summary?.ret;
    if (v === undefined) return undefined;
    const k = Math.min(1, Math.abs(v) / 0.1);
    return `color-mix(in srgb, var(${v >= 0 ? "--pd-buy" : "--pd-sell"}) ${Math.round(12 + k * 55)}%, transparent)`;
  };
  const xSpec = specs.find((s) => s.name === done?.x.param);
  const ySpec = specs.find((s) => s.name === done?.y?.param);
  const isCurrent = (c: Cell) =>
    done &&
    Math.abs(c.x - current(done.x.param)) < 1e-9 &&
    (!done.y || Math.abs((c.y ?? 0) - current(done.y.param)) < 1e-9);
  const profitable = done ? done.cells.filter((c) => (c.summary?.retOut ?? -1) > 0).length : 0;
  const neighbours = useMemo(() => {
    if (!done || !best) return undefined;
    const xi = done.cells.map((c) => c.x);
    const xv = [...new Set(xi)].sort((a, b) => a - b);
    const yv = [...new Set(done.cells.map((c) => c.y ?? 0))].sort((a, b) => a - b);
    const bx = xv.indexOf(best.x);
    const by = yv.indexOf(best.y ?? 0);
    const near = done.cells.filter((c) => {
      const cx = xv.indexOf(c.x);
      const cy = yv.indexOf(c.y ?? 0);
      return c !== best && Math.abs(cx - bx) <= 1 && Math.abs(cy - by) <= 1 && c.summary;
    });
    const vals = near.map((c) => c.summary?.retIn ?? 0);
    return vals.length
      ? { min: Math.min(...vals), max: Math.max(...vals), n: vals.length }
      : undefined;
  }, [done, best]);

  const apply = (c: Cell) => {
    if (!done) return;
    const patch: Record<string, number> = { [done.x.param]: c.x };
    if (done.y && c.y !== undefined) patch[done.y.param] = c.y;
    onApply(patch);
  };

  return (
    <div className="lab-opt">
      <section className="lab-panel lab-opt-setup">
        <div className="lab-sec">
          <span className="lab-label">{t("bt.opt.optimizing")}</span>
          <b>{strategy.name}</b>
          <p className="lab-sentence small">
            <Sentence config={strategy.strategy} />
          </p>
        </div>
        <div className="lab-sec">
          <AxisForm
            label={t("bt.opt.across")}
            specs={specs}
            axis={x}
            onChange={setX}
            current={current}
          />
          {specs.length > 1 && (
            <label className="lab-switch">
              <input type="checkbox" checked={useY} onChange={(e) => setUseY(e.target.checked)} />
              <span>{t("bt.opt.second")}</span>
            </label>
          )}
          {useY && (
            <AxisForm
              label={t("bt.opt.down")}
              specs={specs}
              axis={y}
              onChange={setY}
              current={current}
            />
          )}
        </div>
        <div className="lab-sec">
          <span className="lab-label">{t("bt.opt.rankBy")}</span>
          <Seg<Rank>
            label={t("bt.opt.rankBy")}
            value={rank}
            onChange={setRank}
            options={[
              { value: "ret", label: t("bt.opt.rank.ret") },
              { value: "calmar", label: t("bt.opt.rank.calmar") },
              { value: "pf", label: t("bt.opt.rank.pf") },
              { value: "retOut", label: t("bt.opt.rank.retOut") },
            ]}
          />
          <p className="lab-note">
            {rank === "retOut"
              ? t("bt.opt.peekWarn")
              : t("bt.opt.honest", { n: strategy.holdOutDays })}
          </p>
        </div>
        <div className="lab-sec lab-side-actions">
          {sameParam && <p className="lab-warn">{t("bt.opt.same")}</p>}
          {tooMany && <p className="lab-warn">{t("bt.opt.tooMany", { n: count })}</p>}
          <button
            type="button"
            className="lab-btn primary"
            disabled={state.status === "running" || !count || tooMany || sameParam}
            onClick={go}
          >
            <LuSlidersHorizontal size={13} aria-hidden />
            {state.status === "running"
              ? t("bt.opt.running", { n: count })
              : t("bt.opt.run", { n: count })}
          </button>
          <p className="lab-dim">{t("bt.opt.note")}</p>
        </div>
      </section>

      <section className="lab-panel lab-opt-grid">
        <div className="lab-ph">
          <h2>{t("bt.opt.results")}</h2>
          {done && (
            <span className="lab-dim">
              {strategy.holdOutDays > 0 ? t("bt.opt.colourOut") : t("bt.opt.colourAll")}
            </span>
          )}
        </div>
        {state.status === "idle" && <div className="lab-empty">{t("bt.opt.idle")}</div>}
        {state.status === "running" && (
          <div className="lab-empty">{t("bt.opt.runningBody", { n: count })}</div>
        )}
        {state.status === "error" && <div className="lab-empty lab-warn">{state.error}</div>}
        {done && (
          <div className="lab-heat-wrap">
            <table className="lab-heat">
              <thead>
                <tr>
                  <th>
                    {done.y
                      ? `${t(`bt.p.${done.y.param}` as "bt.p.fast")} ↓ / ${t(`bt.p.${done.x.param}` as "bt.p.fast")} →`
                      : ""}
                  </th>
                  {[...new Set(done.cells.map((c) => c.x))].map((v) => (
                    <th key={v}>{shown(xSpec, v)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...new Set(done.cells.map((c) => c.y))].map((yv) => (
                  <tr key={String(yv)}>
                    <th>
                      {yv === undefined
                        ? t(`bt.p.${done.x.param}` as "bt.p.fast")
                        : shown(ySpec, yv)}
                    </th>
                    {done.cells
                      .filter((c) => c.y === yv)
                      .map((c) => (
                        <td key={`${c.x}:${String(c.y)}`}>
                          <button
                            type="button"
                            className={`lab-cell${isCurrent(c) ? " current" : ""}${c === best ? " best" : ""}`}
                            style={{ background: colored(c) }}
                            title={c.error ?? undefined}
                            disabled={!c.summary}
                            onClick={() => apply(c)}
                          >
                            {c.summary ? (
                              <>
                                <b>
                                  {pct(strategy.holdOutDays > 0 ? c.summary.retOut : c.summary.ret)}
                                </b>
                                <small>
                                  {pct(c.summary.retIn, 0)} · {c.summary.trades}t
                                </small>
                              </>
                            ) : (
                              <small>–</small>
                            )}
                          </button>
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="lab-dim lab-pad">{t("bt.opt.cellHint")}</p>
          </div>
        )}
      </section>

      <section className="lab-panel lab-opt-top">
        <div className="lab-ph">
          <h2>{t("bt.opt.best")}</h2>
          <span className="lab-dim">{t(`bt.opt.rank.${rank}`)}</span>
        </div>
        {done ? (
          <>
            <div className="lab-table-wrap">
              <table className="lab-table">
                <thead>
                  <tr>
                    <th className="l">{t("bt.opt.settings")}</th>
                    <th>{t("bt.opt.tunedOn")}</th>
                    <th>{t("bt.opt.heldOut")}</th>
                    <th>{t("bt.v.maxDd")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ranked.slice(0, 10).map((c) => (
                    <tr key={`${c.x}:${String(c.y)}`} className={isCurrent(c) ? "sel" : undefined}>
                      <td className="l">
                        {shown(xSpec, c.x)}
                        {c.y !== undefined ? ` / ${shown(ySpec, c.y)}` : ""}
                      </td>
                      <td className={tone(c.summary?.retIn ?? 0)}>{pct(c.summary?.retIn ?? 0)}</td>
                      <td className={tone(c.summary?.retOut ?? 0)}>
                        {strategy.holdOutDays > 0 ? pct(c.summary?.retOut ?? 0) : "–"}
                      </td>
                      <td>{pct(c.summary?.maxDrawdown ?? 0)}</td>
                      <td>
                        {isCurrent(c) ? (
                          <span className="lab-dim">
                            <LuCheck size={12} aria-hidden /> {t("bt.opt.yours")}
                          </span>
                        ) : (
                          <button type="button" className="lab-btn small" onClick={() => apply(c)}>
                            {t("bt.opt.apply")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="lab-pad lab-opt-read">
              <p>{t("bt.opt.heldUpCount", { n: profitable, total: done.cells.length })}</p>
              {best && neighbours && (
                <p>
                  {neighbours.min > 0
                    ? t("bt.opt.plateau", { min: pct(neighbours.min), max: pct(neighbours.max) })
                    : t("bt.opt.spike", { min: pct(neighbours.min), max: pct(neighbours.max) })}
                </p>
              )}
              {best?.summary && strategy.holdOutDays > 0 && best.summary.retOut < 0 && (
                <p className="lab-warn">{t("bt.opt.bestFailed")}</p>
              )}
            </div>
          </>
        ) : (
          <div className="lab-empty">{t("bt.opt.topIdle")}</div>
        )}
      </section>
    </div>
  );
}
