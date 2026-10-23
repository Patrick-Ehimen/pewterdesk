import type {
  AlgoSpec,
  AlgoView,
  Distribution,
  Market,
  SliceStyle,
  StopMode,
  Unfilled,
} from "@pewterdesk/core";
import {
  dateFormat,
  EmptyState,
  formatNumber,
  formatSigned,
  type MessageKey,
  Select,
  Switch,
  Tabs,
  t,
} from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { algoKind, algoReason } from "../../hooks/useAlgos";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import {
  type AlgoTarget,
  chaserSpec,
  formatDuration,
  isLive,
  parseDuration,
  previewSlices,
  progressOf,
  runsOnVenue,
  scaledSpec,
  slippageOf,
  specProblem,
  timeLeft,
  twapSpec,
} from "../../lib/algos";

// Algo orders - a chaser, a TWAP, a scaled ladder - as a workspace panel:
// what's running and how far along, what's over, and a form to start one on
// the market on screen. The engine runs them (`crates/engine`); every order
// goes through the same gate as the ticket's.

const ALGO_TABS = ["running", "history"] as const;

type AlgoKindId = "chaser" | "twap" | "scaled";
const KINDS: readonly AlgoKindId[] = ["chaser", "twap", "scaled"];
const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

interface AlgosPanelProps {
  algos: readonly AlgoView[];
  history: readonly AlgoView[];
  onLoadHistory: () => void;
  /** The market on screen: where a new algo goes. */
  market?: Market;
  symbolFor: (marketId: string) => string;
  /** Who it trades for; unset where nothing can trade (no account, or paper). */
  target?: AlgoTarget;
  /** Why there's no target, in words. */
  unavailable?: string;
  onStart: (spec: AlgoSpec) => Promise<unknown>;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onStop: (id: string, mode: StopMode) => Promise<void>;
  onHalt: () => Promise<unknown>;
}

/** Runs an action, saying in the panel why it failed if it does. */
function useAct() {
  const [error, setError] = useState<string>();
  const act = (run: () => Promise<unknown>) => {
    setError(undefined);
    run().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return { error, act };
}

function RunsOn({ view }: { view: Pick<AlgoView, "runsOn"> }) {
  const venue = view.runsOn === "venue";
  return (
    <span
      className="algo-where"
      data-where={view.runsOn}
      title={t(venue ? "algo.onVenueHint" : "algo.hereHint")}
    >
      {t(venue ? "algo.onVenue" : "algo.here")}
    </span>
  );
}

function Row({
  view,
  now,
  symbolFor,
  onPause,
  onResume,
  onStop,
}: {
  view: AlgoView;
  now: number;
  symbolFor: (marketId: string) => string;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onStop: (id: string, mode: StopMode) => Promise<void>;
}) {
  const { error, act } = useAct();
  const [stopping, setStopping] = useState(false);
  const progress = progressOf(view);
  const left = timeLeft(view, now);
  const slip = slippageOf(view);
  const live = isLive(view);
  return (
    <li className="algo-row" data-status={view.status}>
      <div className="algo-row-head">
        <span className="algo-kind">{algoKind(view)}</span>
        <span className="algo-side" data-side={view.spec.side}>
          {t(view.spec.side === "buy" ? "side.buy" : "side.sell")}
        </span>
        <span className="algo-market">
          {formatNumber(view.spec.size)} {symbolFor(view.spec.market)}
        </span>
        <RunsOn view={view} />
        <span className="algo-status" data-status={view.status}>
          {t(`algo.status.${view.status}` as MessageKey)}
          {view.reason && view.reason !== "user" ? ` · ${algoReason(view.reason)}` : ""}
        </span>
      </div>
      <div
        className="algo-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-label={t("algo.filled")}
      >
        <span className="algo-bar-fill" style={{ width: `${progress * 100}%` }} />
      </div>
      <dl className="algo-figures pd-num">
        <div className="algo-figure">
          <dt>{t("algo.filled")}</dt>
          <dd>
            {formatNumber(view.filled)} / {formatNumber(view.spec.size)} (
            {Math.round(progress * 100)}%)
          </dd>
        </div>
        {view.avgPrice && (
          <div className="algo-figure">
            <dt>{t("algo.avgPrice")}</dt>
            <dd>{formatNumber(view.avgPrice)}</dd>
          </div>
        )}
        {slip !== undefined && (
          <div className="algo-figure">
            <dt>{t("algo.slippage")}</dt>
            <dd>{t("algo.bps", { value: formatSigned(slip, 1) })}</dd>
          </div>
        )}
        {view.fees && (
          <div className="algo-figure">
            <dt>{t("algo.fees")}</dt>
            <dd>{formatNumber(view.fees)}</dd>
          </div>
        )}
        {live && left !== undefined && (
          <div className="algo-figure">
            <dt>{t("algo.timeLeft")}</dt>
            <dd>{formatDuration(left)}</dd>
          </div>
        )}
        {live && view.nextAt !== undefined && view.nextAt > now && (
          <div className="algo-figure">
            <dt>{t("algo.nextSlice")}</dt>
            <dd>{formatDuration(view.nextAt - now)}</dd>
          </div>
        )}
        {!live && (
          <div className="algo-figure">
            <dt>{t("algo.ended")}</dt>
            <dd>{dateFormat(CLOCK).format(view.updatedAt)}</dd>
          </div>
        )}
      </dl>
      {view.detail && <p className="algo-detail">{view.detail}</p>}
      {error && (
        <p className="algo-detail" role="alert">
          {error}
        </p>
      )}
      {live && (
        <div className="algo-actions">
          {view.status === "paused" ? (
            <button
              type="button"
              className="algo-button"
              onClick={() => act(() => onResume(view.id))}
            >
              {t("algo.resume")}
            </button>
          ) : (
            <button
              type="button"
              className="algo-button"
              onClick={() => act(() => onPause(view.id))}
            >
              {t("algo.pause")}
            </button>
          )}
          {stopping ? (
            <>
              <button
                type="button"
                className="algo-button"
                data-danger
                onClick={() => act(() => onStop(view.id, "cancel"))}
              >
                {t("algo.stopCancel")}
              </button>
              <button
                type="button"
                className="algo-button"
                data-danger
                onClick={() => act(() => onStop(view.id, "finishAtMarket"))}
              >
                {t("algo.stopMarket")}
              </button>
              <button type="button" className="algo-button" onClick={() => setStopping(false)}>
                {t("algo.cancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="algo-button"
              data-danger
              onClick={() => setStopping(true)}
            >
              {t("algo.stop")}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** A number field the form keeps as typed. */
function Field({
  label,
  value,
  onChange,
  suffix,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix?: string;
  invalid?: boolean;
}) {
  return (
    <label className="algo-field">
      <span>{label}</span>
      <span className="algo-field-input">
        <input
          className="pd-input pd-num"
          inputMode="decimal"
          value={value}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="algo-suffix">{suffix}</span>}
      </span>
    </label>
  );
}

function NewAlgo({
  market,
  target,
  onStart,
  onDone,
}: {
  market: Market;
  target: AlgoTarget;
  onStart: (spec: AlgoSpec) => Promise<unknown>;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<AlgoKindId>("twap");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [size, setSize] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  // Chaser.
  const [giveUp, setGiveUp] = useState("");
  const [finish, setFinish] = useState(false);
  // TWAP.
  const [duration, setDuration] = useState("30m");
  const [slices, setSlices] = useState("");
  const [style, setStyle] = useState<SliceStyle>("market");
  const [unfilled, setUnfilled] = useState<Unfilled>("market");
  const [randomize, setRandomize] = useState(true);
  const [native, setNative] = useState(true);
  // Scaled.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [count, setCount] = useState("5");
  const [distribution, setDistribution] = useState<Distribution>("flat");
  const { error, act } = useAct();

  const base = { side, market, size, reduceOnly };
  const durationMs = parseDuration(duration.trim()) ?? 0;
  const spec: AlgoSpec =
    kind === "chaser"
      ? chaserSpec(
          {
            ...base,
            giveUpPct: giveUp ? Number(giveUp) : undefined,
            finishAtMarket: Boolean(giveUp) && finish,
          },
          target,
        )
      : kind === "twap"
        ? twapSpec(
            {
              ...base,
              durationMs,
              slices: slices ? Number(slices) : undefined,
              style,
              unfilled,
              randomize,
              native,
            },
            target,
          )
        : scaledSpec({ ...base, from, to, count: Number(count) || 0, distribution }, target);
  const problem = specProblem(spec, market);
  const venueRun = runsOnVenue(spec);
  const parts = spec.kind === "twap" && !venueRun ? previewSlices(spec, market) : [];

  return (
    <form
      className="algo-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem) return;
        act(async () => {
          await onStart(spec);
          onDone();
        });
      }}
    >
      <div className="algo-form-row">
        <div className="pd-segmented" role="radiogroup" aria-label={t("algo.kindLabel")}>
          {KINDS.map((k) => (
            <label key={k} data-checked={kind === k || undefined}>
              <input
                type="radio"
                name="algo-kind"
                checked={kind === k}
                onChange={() => setKind(k)}
              />
              {t(`algo.kind.${k}` as MessageKey)}
            </label>
          ))}
        </div>
        <div className="pd-segmented algo-sides" role="radiogroup" aria-label={t("ticket.side")}>
          {(["buy", "sell"] as const).map((s) => (
            <label key={s} data-checked={side === s || undefined} data-side={s}>
              <input
                type="radio"
                name="algo-side"
                checked={side === s}
                onChange={() => setSide(s)}
              />
              {t(s === "buy" ? "side.buy" : "side.sell")}
            </label>
          ))}
        </div>
      </div>
      <div className="algo-form-grid">
        <Field label={t("algo.size")} value={size} onChange={setSize} suffix={market.base} />
        {kind === "chaser" && (
          <Field label={t("algo.giveUp")} value={giveUp} onChange={setGiveUp} suffix="%" />
        )}
        {kind === "twap" && (
          <>
            <Field
              label={t("algo.duration")}
              value={duration}
              onChange={setDuration}
              invalid={durationMs === 0}
            />
            {!venueRun && <Field label={t("algo.slices")} value={slices} onChange={setSlices} />}
          </>
        )}
        {kind === "scaled" && (
          <>
            <Field label={t("algo.from")} value={from} onChange={setFrom} suffix={market.quote} />
            <Field label={t("algo.to")} value={to} onChange={setTo} suffix={market.quote} />
            <Field label={t("algo.count")} value={count} onChange={setCount} />
          </>
        )}
      </div>
      <div className="algo-form-options">
        {kind === "chaser" && giveUp && (
          <span className="algo-option">
            <Switch checked={finish} onChange={setFinish} label={t("algo.finishAtMarket")} />
            {t("algo.finishAtMarket")}
          </span>
        )}
        {kind === "twap" && (
          <>
            <Select
              label={t("algo.style")}
              value={style}
              options={[
                { value: "market", label: t("algo.style.market") },
                { value: "chaser", label: t("algo.style.chaser") },
              ]}
              onChange={setStyle}
            />
            {style === "chaser" && (
              <Select
                label={t("algo.unfilled")}
                value={unfilled}
                options={[
                  { value: "market", label: t("algo.unfilled.market") },
                  { value: "skip", label: t("algo.unfilled.skip") },
                  { value: "stop", label: t("algo.unfilled.stop") },
                ]}
                onChange={setUnfilled}
              />
            )}
            <span className="algo-option">
              <Switch checked={randomize} onChange={setRandomize} label={t("algo.randomize")} />
              {t("algo.randomize")}
            </span>
            {target.venue === "hyperliquid" && (
              <span className="algo-option">
                <Switch checked={native} onChange={setNative} label={t("algo.native")} />
                {t("algo.native")}
              </span>
            )}
          </>
        )}
        {kind === "scaled" && (
          <Select
            label={t("algo.distribution")}
            value={distribution}
            options={[
              { value: "flat", label: t("algo.distribution.flat") },
              { value: "moreFar", label: t("algo.distribution.moreFar") },
              { value: "moreNear", label: t("algo.distribution.moreNear") },
            ]}
            onChange={setDistribution}
          />
        )}
        <span className="algo-option">
          <Switch checked={reduceOnly} onChange={setReduceOnly} label={t("ticket.reduceOnly")} />
          {t("ticket.reduceOnly")}
        </span>
      </div>
      <div className="algo-preview">
        <RunsOn view={{ runsOn: venueRun ? "venue" : "local" }} />
        <span>
          {problem
            ? t(`algo.problem.${problem}` as MessageKey)
            : spec.kind === "twap"
              ? venueRun
                ? t("algo.preview.nativeTwap", { duration: formatDuration(spec.durationMs) })
                : t("algo.preview.twap", {
                    count: parts.length,
                    size: formatNumber(parts[0] ?? 0),
                    base: market.base,
                    every: formatDuration(spec.durationMs / Math.max(1, parts.length)),
                  })
              : spec.kind === "scaled"
                ? t("algo.preview.scaled", {
                    count: spec.count,
                    from: formatNumber(spec.from),
                    to: formatNumber(spec.to),
                  })
                : t("algo.preview.chaser")}
        </span>
      </div>
      {error && (
        <p className="algo-detail" role="alert">
          {error}
        </p>
      )}
      <div className="algo-actions">
        <button type="submit" className="algo-button" data-primary disabled={Boolean(problem)}>
          {t("algo.start")}
        </button>
        <button type="button" className="algo-button" onClick={onDone}>
          {t("algo.cancel")}
        </button>
      </div>
    </form>
  );
}

/** The Algos panel: running and past algos, and a form to start one. */
export function AlgosPanel({
  algos,
  history,
  onLoadHistory,
  market,
  symbolFor,
  target,
  unavailable,
  onStart,
  onPause,
  onResume,
  onStop,
  onHalt,
}: AlgosPanelProps) {
  const [tab, setTab] = useStoredChoice("pd.algos.tab", ALGO_TABS, "running");
  const [adding, setAdding] = useState(false);
  const [halting, setHalting] = useState(false);
  const [now, setNow] = useState(Date.now);
  const { error, act } = useAct();
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (tab === "history") onLoadHistory();
  }, [tab, onLoadHistory]);

  const live = algos.filter(isLive);
  // This session's that are over, then older ones from the log, once each.
  const past = [
    ...algos.filter((a) => !isLive(a)),
    ...history.filter((h) => !algos.some((a) => a.id === h.id)),
  ];
  const shown = tab === "running" ? live : past;
  const local = live.some((a) => a.runsOn === "local");

  return (
    <div className="algos-panel">
      <Tabs
        variant="sub"
        label={t("panel.algos")}
        tabs={[
          { id: "running", label: `${t("algo.running")} (${live.length})` },
          { id: "history", label: t("algo.history") },
        ]}
        active={tab}
        onChange={setTab}
        aside={
          <span className="algo-tabs-aside">
            {live.length > 0 &&
              (halting ? (
                <button
                  type="button"
                  className="algo-button"
                  data-danger
                  data-armed
                  onClick={() => {
                    setHalting(false);
                    act(onHalt);
                  }}
                >
                  {t("algo.haltConfirm")}
                </button>
              ) : (
                <button
                  type="button"
                  className="algo-button"
                  data-danger
                  onClick={() => setHalting(true)}
                >
                  {t("algo.halt")}
                </button>
              ))}
            <button
              type="button"
              className="algo-button"
              data-primary
              disabled={!target || !market}
              title={unavailable}
              onClick={() => setAdding((a) => !a)}
            >
              {t("algo.new")}
            </button>
          </span>
        }
      />
      {error && (
        <p className="algo-detail" role="alert">
          {error}
        </p>
      )}
      {adding && target && market && (
        <NewAlgo
          market={market}
          target={target}
          onStart={onStart}
          onDone={() => setAdding(false)}
        />
      )}
      {!target && unavailable && <p className="algo-note">{unavailable}</p>}
      {shown.length === 0 ? (
        <EmptyState>{t(tab === "running" ? "algo.noneRunning" : "algo.noneOver")}</EmptyState>
      ) : (
        <ul className="algo-list">
          {shown.map((view) => (
            <Row
              key={view.id}
              view={view}
              now={now}
              symbolFor={symbolFor}
              onPause={onPause}
              onResume={onResume}
              onStop={onStop}
            />
          ))}
        </ul>
      )}
      {tab === "running" && local && <p className="algo-note">{t("algo.switchNote")}</p>}
    </div>
  );
}

/** Chips over the price chart: the algos running on the market on screen. */
export function AlgoChartChips({ algos, market }: { algos: readonly AlgoView[]; market?: Market }) {
  const [now, setNow] = useState(Date.now);
  const here = algos.filter((a) => isLive(a) && a.spec.market === market?.id);
  useEffect(() => {
    if (here.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [here.length]);
  if (here.length === 0) return null;
  return (
    <div className="algo-chips">
      {here.map((view) => {
        const left = timeLeft(view, now);
        return (
          <span
            key={view.id}
            className="algo-chip"
            data-status={view.status}
            data-side={view.spec.side}
          >
            <strong>{algoKind(view)}</strong>
            <span className="pd-num">{Math.round(progressOf(view) * 100)}%</span>
            {left !== undefined && <span className="pd-num">{formatDuration(left)}</span>}
            {view.status === "paused" && <span>{t("algo.status.paused")}</span>}
          </span>
        );
      })}
    </div>
  );
}
