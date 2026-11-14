import type { Candle, CandleInterval, Fill } from "@pewterdesk/core";
import { dateFormat, formatMoney, formatNumber, INTERVAL_MS, t } from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuCheck,
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuImagePlus,
  LuLock,
  LuSearch,
  LuX,
} from "react-icons/lu";
import { cloudClient } from "../../api/cloudClient";
import { venueClient } from "../../api/venueClient";
import {
  BREAKS,
  type Break,
  detectedBreaks,
  excursions,
  gradeOf,
  levelPrice,
  MOODS,
  type Playbook,
  plannedRR,
  rOf,
  skippedItems,
  type TradeNote,
  tradeFills,
  utcDay,
} from "../../lib/journal";
import { avgR, groupOf, winRate } from "../../lib/journalStats";
import { type JournalTrade, nthOfDay, openedAtOf } from "../../lib/journalTrades";
import { paperAccount } from "../../lib/paperStore";
import { useNoteDraft } from "./drafts";
import type { PlanContext } from "./PlanPage";
import {
  Blank,
  breakLabel,
  Card,
  ChipPicker,
  distinctHues,
  Field,
  formatR,
  heldText,
  hueOf,
  Kpis,
  Money,
  moodLabel,
  NumberInput,
  PageHead,
  Pill,
  Prose,
  pct,
  Rating,
  RText,
  Segment,
  Slider,
  Stat,
  StatusPill,
  TagEditor,
  timeframesOf,
  utcTime,
} from "./parts";
import { FillsSkeleton, TradeChartSkeleton } from "./Skeletons";
import { TradePnlChart } from "./TradeChart";

const FRAMES: readonly CandleInterval[] = ["1m", "5m", "15m", "1h", "4h"];
const MAX_CANDLES = 400;
const EXCURSION_FRAMES: readonly CandleInterval[] = ["1m", "5m", "15m", "1h", "4h"];
const LONG_DATE: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
};

/** The smallest of `FRAMES` that shows the whole trade, with room either side, in `MAX_CANDLES`. */
function frameFor(span: number): CandleInterval {
  return (
    FRAMES.find((f) => (span * 2 + INTERVAL_MS[f] * 40) / INTERVAL_MS[f] <= MAX_CANDLES) ?? "4h"
  );
}

/**
 * One trade in full, after the Trade detail mockup (84): what the venue
 * recorded (fills, fees, funding, the candles it was held over, and so MFE
 * and MAE), and what the trader wrote - the plan before it, the checklist,
 * notes and screenshots, the reflection, the rule breaks. It reads only.
 */
export function TradeDetail({
  ctx,
  trade,
  prev,
  next,
  onOpen,
  onBack,
}: {
  ctx: PlanContext;
  trade?: JournalTrade;
  prev?: string;
  next?: string;
  onOpen: (key: string) => void;
  onBack: () => void;
}) {
  if (!trade)
    return (
      <Blank
        title={t("plan.td.gone")}
        action={
          <button type="button" className="jr-button" onClick={onBack}>
            {t("plan.back")}
          </button>
        }
      />
    );
  return (
    <Detail
      key={trade.key}
      ctx={ctx}
      trade={trade}
      prev={prev}
      next={next}
      onOpen={onOpen}
      onBack={onBack}
    />
  );
}

function Detail({
  ctx,
  trade,
  prev,
  next,
  onOpen,
  onBack,
}: {
  ctx: PlanContext;
  trade: JournalTrade;
  prev?: string;
  next?: string;
  onOpen: (key: string) => void;
  onBack: () => void;
}) {
  const { note, update } = useNoteDraft(ctx, trade);
  const open = trade.open;
  // An open trade: when it opened, from the account's fills (a position doesn't say).
  const [openedAt, setOpenedAt] = useState<number>();
  // Keyed by which position it is, not the object: the account's feed hands
  // over a new one on every refresh, and each would ask the venue again.
  const openId = open ? `${open.venue}:${open.market}:${open.side}` : undefined;
  const openRef = useRef(open);
  openRef.current = open;
  const known = note.trade.openedAt !== undefined;
  const paperAccountOpen = ctx.accountKey?.startsWith("paper:") ?? false;
  useEffect(() => {
    const position = openRef.current;
    if (!openId || !position || known) return;
    // A paper position keeps its own opening time; a venue's is read from its fills.
    if (paperAccountOpen) {
      const kept = paperAccount(position.venue).positions.find(
        (x) => x.market === position.market && x.side === position.side,
      );
      setOpenedAt(kept?.openedAt);
      return;
    }
    if (!ctx.address) return;
    let live = true;
    venueClient.fills(position.venue, ctx.address).then(
      (all) => live && setOpenedAt(openedAtOf(position, all)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [openId, known, ctx.address, paperAccountOpen]);
  // An open trade runs to "now", moved on once a minute: not on every render,
  // or each one would ask the venue for its candles again (and hit its limit).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!openId) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [openId]);
  // While open, the position's own figures as they come in (the draft holds
  // what was there when the page opened).
  const live = trade.note.trade;
  const f = {
    ...note.trade,
    ...(open && {
      size: live.size,
      entryPrice: live.entryPrice,
      exitPrice: live.exitPrice,
      pnl: live.pnl,
      entryValue: live.entryValue,
      leverage: live.leverage,
      closedAt: now,
    }),
    openedAt: note.trade.openedAt ?? openedAt,
  };
  const span = f.closedAt - (f.openedAt ?? f.closedAt);
  const [frame, setFrame] = useState<CandleInterval>(() => frameFor(span));
  const picked = useRef(false);
  const knownSpan = f.openedAt !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the opening time is first known
  useEffect(() => {
    if (knownSpan && !picked.current) setFrame(frameFor(span));
  }, [knownSpan]);
  const [candles, setCandles] = useState<Candle[]>();
  const [fills, setFills] = useState<Fill[]>();
  const [funding, setFunding] = useState<number>();
  const [error, setError] = useState<string>();
  const paper = ctx.accountKey?.startsWith("paper:") ?? false;

  // The candles around the trade; from them, its best and worst prices.
  useEffect(() => {
    let live = true;
    const ms = INTERVAL_MS[frame];
    const padding = Math.max(span * 0.5, ms * 20);
    const before = Math.min(Date.now(), f.closedAt + padding);
    const count = Math.min(MAX_CANDLES, Math.ceil((span + padding * 2) / ms) + 1);
    venueClient.candles(f.venue, f.market, frame, before, count).then(
      (list) => live && setCandles(list),
      (e: unknown) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [f.venue, f.market, f.closedAt, span, frame]);

  // Its fills (and so its fees) and funding: a closed trade's are the fills
  // that opened and closed it; an open one's every fill on its market since it
  // opened. A paper account's from its own record, a venue's from the venue.
  useEffect(() => {
    const opened = f.openedAt;
    const closed = trade.closed;
    const own = (all: readonly Fill[]) =>
      closed
        ? tradeFills(closed, all)
        : opened === undefined
          ? []
          : all.filter((x) => x.market === f.market && x.time >= opened - 1000);
    if (paper) {
      setFills(own(paperAccount(f.venue).fills));
      return;
    }
    if (!ctx.address || (!closed && !openId)) return;
    let live = true;
    venueClient.fills(f.venue, ctx.address).then(
      (all) => live && setFills(own(all)),
      () => live && setFills([]),
    );
    if (f.openedAt !== undefined)
      venueClient.fundingPayments(f.venue, ctx.address, f.openedAt).then(
        (all) =>
          live &&
          setFunding(
            all
              .filter(
                (p) => p.market === f.market && p.time >= (f.openedAt ?? 0) && p.time <= f.closedAt,
              )
              .reduce((s, p) => s + Number(p.amount), 0),
          ),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [paper, ctx.address, trade.closed, f.venue, f.market, f.openedAt, f.closedAt, openId]);

  // MFE and MAE from candles of their own: the finest interval that covers
  // the trade, and only the candles wholly inside it (the one it opened in
  // holds prices from before the entry, the one it closed in from after the
  // exit), with the entry and the exit (or the price now) themselves.
  const exFrame = EXCURSION_FRAMES.find((x) => span / INTERVAL_MS[x] <= MAX_CANDLES - 2) ?? "4h";
  const [exCandles, setExCandles] = useState<Candle[]>();
  useEffect(() => {
    if (f.openedAt === undefined) return;
    let live = true;
    const ms = INTERVAL_MS[exFrame];
    const count = Math.min(MAX_CANDLES, Math.ceil(span / ms) + 2);
    venueClient
      .candles(f.venue, f.market, exFrame, Math.min(Date.now(), f.closedAt + ms), count)
      .then(
        (list) => live && setExCandles(list),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [f.venue, f.market, exFrame, f.openedAt, f.closedAt, span]);

  // Keep what the venue told us with the note, so the analytics have it later.
  const extremes = useMemo(() => {
    if (!exCandles || f.openedAt === undefined) return undefined;
    const ms = INTERVAL_MS[exFrame];
    const from = f.openedAt;
    const to = f.closedAt;
    const inside = exCandles.filter(
      (c) => c.openTime >= from && (open ? c.openTime <= to : c.openTime + ms <= to),
    );
    const highs = [...inside.map((c) => Number(c.high)), f.entryPrice, f.exitPrice];
    const lows = [...inside.map((c) => Number(c.low)), f.entryPrice, f.exitPrice];
    const long = f.side === "long";
    return {
      best: long ? Math.max(...highs) : Math.min(...lows),
      worst: long ? Math.min(...lows) : Math.max(...highs),
    };
  }, [exCandles, exFrame, open, f.openedAt, f.closedAt, f.side, f.entryPrice, f.exitPrice]);
  const fees = fills?.length ? fills.reduce((s, x) => s + Number(x.fee), 0) : undefined;
  const learned = useRef(false);
  useEffect(() => {
    if (learned.current || !trade.written) return;
    const change: Partial<TradeNote["trade"]> = {};
    // Kept with the note once it's closed; while open they keep moving.
    if (!open && extremes && (f.best === undefined || f.worst === undefined))
      Object.assign(change, extremes);
    if (!open && fees !== undefined && f.fees === undefined) change.fees = fees;
    if (funding !== undefined && f.funding === undefined) change.funding = funding;
    if (open && openedAt !== undefined && note.trade.openedAt === undefined)
      change.openedAt = openedAt;
    if (Object.keys(change).length) {
      learned.current = true;
      update((n) => ({ ...n, trade: { ...n.trade, ...change } }));
    }
  }, [
    extremes,
    fees,
    funding,
    f.best,
    f.worst,
    f.fees,
    f.funding,
    trade.written,
    update,
    open,
    openedAt,
    note.trade.openedAt,
  ]);

  const figures = {
    ...f,
    ...((open || f.best === undefined) && extremes),
    // While open, the fees so far keep growing with each fill.
    fees: open ? (fees ?? f.fees) : (f.fees ?? fees),
    funding: f.funding ?? funding,
  };
  const shown: TradeNote = { ...note, trade: figures };
  const r = rOf(shown);
  const { mfe, mae } = excursions(shown);
  // In money too, so they read without a stop: how far it went for and against.
  const dir = f.side === "long" ? 1 : -1;
  const moneyAt = (price: number | undefined) =>
    price === undefined ? undefined : (price - f.entryPrice) * f.size * dir;
  const mfeMoney = moneyAt(figures.best);
  const maeMoney = moneyAt(figures.worst);
  const playbook = note.playbookId ? ctx.playbooks.get(note.playbookId) : undefined;
  // An open trade's stop loss and take profit, as set on the position: they
  // fill empty fields, and follow the position while a field still holds
  // what was filled in (a value typed here is the trader's and stays).
  const venueStop = open?.stopLoss === undefined ? undefined : Number(open.stopLoss);
  const venueTarget = open?.takeProfit === undefined ? undefined : Number(open.takeProfit);
  const seen = useRef<{ stop?: number; target?: number }>({});
  useEffect(() => {
    if (!openId) return;
    const change: Partial<TradeNote> = {};
    const follows = (mine: number | undefined, last: number | undefined) =>
      mine === undefined || mine === last;
    if (
      venueStop &&
      venueStop > 0 &&
      venueStop !== note.plannedStop &&
      follows(note.plannedStop, seen.current.stop)
    )
      change.plannedStop = venueStop;
    if (
      venueTarget &&
      venueTarget > 0 &&
      venueTarget !== note.plannedTarget &&
      follows(note.plannedTarget, seen.current.target)
    )
      change.plannedTarget = venueTarget;
    seen.current = { stop: venueStop, target: venueTarget };
    if (Object.keys(change).length) update((n) => ({ ...n, ...change }));
  }, [openId, venueStop, venueTarget, note.plannedStop, note.plannedTarget, update]);

  // The day's pre-market intent for this market (its watchlist card), where
  // the trade was planned: its thesis, stop and target fill an empty note once.
  const intent = ctx.journal.data.days.get(utcDay(f.openedAt ?? f.closedAt))?.data.markets[
    f.market
  ];
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || !intent) return;
    filled.current = true;
    const level = (kind: string) =>
      intent.levelList?.find((l) => l.kind === kind && levelPrice(l.price))?.price;
    const stop = level("stop");
    const target = level("target");
    const change: Partial<TradeNote> = {};
    if (!note.thesis.trim() && intent.note.trim()) change.thesis = intent.note.trim();
    // The position's own stop and take profit, where set, come first (above).
    if (note.plannedStop === undefined && stop && !venueStop) change.plannedStop = levelPrice(stop);
    if (note.plannedTarget === undefined && target && !venueTarget)
      change.plannedTarget = levelPrice(target);
    if (Object.keys(change).length) update((n) => ({ ...n, ...change }));
  }, [intent, note.thesis, note.plannedStop, note.plannedTarget, update, venueStop, venueTarget]);
  const nth = nthOfDay(ctx.trades, trade.key);
  const detected = detectedBreaks(shown, ctx.plan, nth);
  const breaks = [...new Set([...note.breaks, ...detected])];
  const grade = gradeOf({ ...shown, breaks });
  const checked = note.checklist.filter((c) => c.checked).length;

  const choosePlaybook = (id: string) => {
    const p = ctx.playbooks.get(id);
    update((n) => ({
      ...n,
      playbookId: id || undefined,
      playbookVersion: p?.version,
      invalidIf: n.invalidIf || p?.invalidIf || "",
      riskAmount: n.riskAmount ?? (ctx.equity && p ? (ctx.equity * p.riskPct) / 100 : undefined),
      checklist: p
        ? p.checklist.map((c) => ({
            ...c,
            checked: n.checklist.find((x) => x.id === c.id)?.checked ?? false,
          }))
        : [],
      breaks: n.breaks.filter((b) => b !== "noPlaybook"),
    }));
  };
  const setReflection = (change: Partial<TradeNote["reflection"]>) =>
    update((n) => ({ ...n, reflection: { ...n.reflection, ...change, savedAt: Date.now() } }));
  const quote = ctx.quote ? ` ${ctx.quote}` : "";

  const similar = ctx.trades
    .filter(
      (x) => x.key !== trade.key && x.note.playbookId && x.note.playbookId === note.playbookId,
    )
    .slice(0, 5);
  const pbGroup = groupOf(
    ctx.trades
      .filter((x) => x.note.playbookId && x.note.playbookId === note.playbookId)
      .map((x) => x.note),
  );
  const news = ctx.calendar.filter(
    (e) =>
      e.impact === "high" &&
      f.openedAt !== undefined &&
      e.time >= f.openedAt - span * 0.5 &&
      e.time <= f.closedAt + span * 0.5,
  );

  const held = f.openedAt !== undefined ? heldText(span) : "-";
  const rr = plannedRR(shown);

  return (
    <div className="jr-view">
      <PageHead
        back={{
          label: `${t("plan.tab.journal")} · ${dateFormat(LONG_DATE).format(f.closedAt)}`,
          onClick: onBack,
        }}
        title={
          <span className="jr-trade-title">
            {ctx.symbolFor(f.market)}
            <span className={`jr-side ${f.side === "long" ? "pd-up" : "pd-down"}`}>
              {t(f.side === "long" ? "side.long" : "side.short")}
            </span>
            {open ? (
              <Pill tone="strong">
                <span className="jr-live-dot" aria-hidden /> {t("plan.td.open")}
              </Pill>
            ) : (
              <Pill tone={f.pnl > 0 ? "up" : "down"}>
                {f.pnl > 0 ? t("plan.td.win") : t("plan.td.loss")}
              </Pill>
            )}
          </span>
        }
        meta={
          <>
            {f.openedAt !== undefined && (
              <span className="pd-num">
                {open
                  ? t("plan.td.openedAt", { time: utcTime(f.openedAt) })
                  : `${utcTime(f.openedAt)} → ${utcTime(f.closedAt)} UTC`}
              </span>
            )}
            <span>
              {open ? t("plan.td.runningFor", { held }) : t("plan.td.closedHeld", { held })}
            </span>
            {fills && <span>{t("plan.td.fillsN", { n: fills.length })}</span>}
            {playbook && <Pill>{playbook.name}</Pill>}
          </>
        }
        actions={
          <>
            <span className="jr-grade jr-grade-lg" title={t("plan.td.gradeHint")}>
              {grade}
            </span>
            <span className="jr-pager">
              <button
                type="button"
                className="jr-icon jr-icon-lg"
                disabled={!prev}
                aria-label={t("plan.prev")}
                title={t("plan.prev")}
                onClick={() => prev && onOpen(prev)}
              >
                <LuChevronLeft size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="jr-icon jr-icon-lg"
                disabled={!next}
                aria-label={t("plan.next")}
                title={t("plan.next")}
                onClick={() => next && onOpen(next)}
              >
                <LuChevronRight size={16} aria-hidden />
              </button>
            </span>
          </>
        }
      />

      <Kpis>
        <Stat
          label={open ? t("plan.j.unrealized") : t("plan.net")}
          value={<Money value={f.pnl} />}
          note={
            open
              ? t("plan.td.markNow", { v: formatNumber(open.markPrice) })
              : t("plan.td.afterFees")
          }
        />
        <Stat
          label={t("plan.td.rMultiple")}
          value={<RText r={r} />}
          note={rr ? t("plan.td.plannedRR", { v: rr.toFixed(1) }) : t("plan.td.setStop")}
        />
        <Stat
          label="MFE"
          value={mfeMoney === undefined ? "-" : <Money value={Math.max(0, mfeMoney)} />}
          note={
            figures.best !== undefined
              ? [
                  t("plan.td.best", { v: formatNumber(figures.best) }),
                  mfe !== undefined ? formatR(mfe) : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t("plan.td.excursionWait")
          }
        />
        <Stat
          label="MAE"
          value={maeMoney === undefined ? "-" : <Money value={Math.min(0, maeMoney)} />}
          note={
            figures.worst !== undefined
              ? [
                  t("plan.td.worst", { v: formatNumber(figures.worst) }),
                  mae !== undefined ? formatR(mae) : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : t("plan.td.excursionWait")
          }
        />
        <Stat
          label={t("plan.td.held")}
          value={held}
          note={
            <span className="jr-heldstate" data-open={open ? "" : undefined}>
              {open ? t("plan.td.running") : t("plan.td.closed")}
            </span>
          }
        />
        <Stat
          label={t("plan.td.fees")}
          value={figures.fees === undefined ? "-" : formatMoney(-Math.abs(figures.fees), quote)}
          note={
            figures.funding === undefined ? undefined : (
              <>
                {t("plan.td.funding")} <Money value={figures.funding} />
              </>
            )
          }
        />
      </Kpis>

      <div className="jr-split">
        <div className="jr-stack">
          <Card
            title={t("plan.td.pnlChart")}
            sub={`${ctx.symbolFor(f.market)} · ${frame}`}
            aside={
              <Segment
                size="sm"
                label={t("plan.td.interval")}
                value={frame}
                options={FRAMES.map((x) => ({ value: x, label: x }))}
                onChange={(v) => {
                  picked.current = true;
                  setFrame(v);
                }}
              />
            }
          >
            <div className="jr-chartbox">
              {error ? (
                <p className="jr-error">{error}</p>
              ) : candles ? (
                <TradePnlChart
                  candles={candles}
                  interval={INTERVAL_MS[frame]}
                  side={f.side}
                  size={f.size}
                  entryPrice={f.entryPrice}
                  exitPrice={f.exitPrice}
                  openedAt={f.openedAt}
                  closedAt={f.closedAt}
                  open={Boolean(open)}
                  events={news.map((e) => ({
                    at: e.time,
                    label: `${utcTime(e.time)} ${e.currency}`,
                  }))}
                />
              ) : (
                <TradeChartSkeleton />
              )}
            </div>
          </Card>

          <Card
            title={t("plan.td.preTrade")}
            aside={
              <>
                <span className="jr-plannedpill" data-planned={intent ? "" : undefined}>
                  {intent ? t("plan.td.planned") : t("plan.td.unplanned")}
                </span>
                {note.checklist.length > 0 && (
                  <Pill tone={skippedItems(note) ? "warn" : undefined}>
                    {t("plan.td.checklistN", { n: checked, of: note.checklist.length })}
                  </Pill>
                )}
              </>
            }
          >
            <Field label={t("plan.pb.playbook")}>
              <PlaybookPicker ctx={ctx} value={note.playbookId} onChange={choosePlaybook} />
            </Field>
            {note.checklist.length > 0 && (
              <div>
                <span className="jr-label">
                  {t("plan.td.checklistOf", {
                    name: playbook?.name ?? "",
                    v: note.playbookVersion ?? "",
                  })}
                </span>
                <ul className="jr-checks jr-checks-live">
                  {note.checklist.map((c) => (
                    <li key={c.id} data-tone={c.required && !c.checked ? "warn" : undefined}>
                      <label>
                        <input
                          type="checkbox"
                          checked={c.checked}
                          onChange={(e) =>
                            update((n) => ({
                              ...n,
                              checklist: n.checklist.map((x) =>
                                x.id === c.id ? { ...x, checked: e.target.checked } : x,
                              ),
                            }))
                          }
                        />
                        <span>{c.text}</span>
                      </label>
                      {!c.required && <span className="jr-muted">{t("plan.optional")}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Field
              label={t("plan.td.thesis")}
              hint={
                intent?.note.trim() && note.thesis === intent.note
                  ? t("plan.td.fromIntent")
                  : !intent
                    ? t("plan.td.unplannedHint")
                    : undefined
              }
            >
              <Prose
                value={note.thesis}
                rows={3}
                label={t("plan.td.thesis")}
                placeholder={intent ? undefined : t("plan.td.unplannedPh")}
                onChange={(thesis) => update((n) => ({ ...n, thesis }))}
              />
            </Field>
            <div className="jr-fields-4">
              <Field label={t("plan.td.entry")}>
                <input
                  className="pd-input pd-num jr-readonly"
                  readOnly
                  tabIndex={-1}
                  aria-label={t("plan.td.entry")}
                  value={formatNumber(f.entryPrice)}
                />
              </Field>
              <Field label={t("plan.td.stopLoss")}>
                <NumberInput
                  label={t("plan.td.stopLoss")}
                  min={0}
                  value={note.plannedStop}
                  onChange={(plannedStop) => update((n) => ({ ...n, plannedStop }))}
                />
              </Field>
              <Field label={t("plan.td.targetLabel")}>
                <NumberInput
                  label={t("plan.td.targetLabel")}
                  min={0}
                  value={note.plannedTarget}
                  onChange={(plannedTarget) => update((n) => ({ ...n, plannedTarget }))}
                />
              </Field>
              <Field label={t("plan.td.rr")}>
                <input
                  className="pd-input pd-num jr-readonly"
                  readOnly
                  tabIndex={-1}
                  aria-label={t("plan.td.rr")}
                  data-tone={rr === undefined ? undefined : rr >= 1 ? "up" : "warn"}
                  value={rr === undefined ? "-" : `1 : ${rr.toFixed(2)}`}
                />
              </Field>
            </div>
            <p className="jr-hint">
              {open && (venueStop || venueTarget) ? `${t("plan.td.fromPosition")} ` : ""}
              {t("plan.td.rrHint")}
            </p>
          </Card>

          <Card title={t("plan.td.notes")} sub={t("plan.td.notesSub")}>
            <Prose
              value={note.notes}
              rows={5}
              label={t("plan.td.notes")}
              onChange={(notes) => update((n) => ({ ...n, notes }))}
              placeholder={t("plan.td.notesPh")}
            />
            <Attachments
              paths={note.attachments}
              onChange={(attachments) => update((n) => ({ ...n, attachments }))}
            />
          </Card>

          <Card
            title={t("plan.td.reflection")}
            sub={open ? t("plan.td.reflectAfter") : undefined}
            aside={
              note.reflection.savedAt ? (
                <Pill icon={<LuCheck size={10} aria-hidden />}>
                  {t("plan.savedAt", { time: utcTime(note.reflection.savedAt) })}
                </Pill>
              ) : undefined
            }
          >
            <div className="jr-two">
              <Field label={t("plan.j.right")}>
                <Prose
                  value={note.reflection.right}
                  rows={2}
                  label={t("plan.j.right")}
                  onChange={(right) => setReflection({ right })}
                />
              </Field>
              <Field label={t("plan.j.wrong")}>
                <Prose
                  value={note.reflection.wrong}
                  rows={2}
                  label={t("plan.j.wrong")}
                  onChange={(wrong) => setReflection({ wrong })}
                />
              </Field>
            </div>
            <Field label={t("plan.j.lessonOne")}>
              <Prose
                single
                value={note.reflection.lesson}
                label={t("plan.lesson")}
                onChange={(lesson) => setReflection({ lesson })}
              />
            </Field>
            <div className="jr-ratings">
              <Slider
                label={t("plan.td.adherence")}
                hue="adherence"
                min={0}
                max={100}
                step={5}
                value={note.reflection.adherence}
                format={(v) => `${v}%`}
                onChange={(adherence) => setReflection({ adherence })}
              />
              <Rating
                label={t("plan.process")}
                hue="process"
                max={10}
                value={note.reflection.process}
                onChange={(process) => setReflection({ process })}
              />
              <Rating
                label={t("plan.outcome")}
                hue="outcome"
                max={10}
                value={note.reflection.outcome}
                onChange={(outcome) => setReflection({ outcome })}
              />
            </div>
          </Card>

          <Card
            title={t("plan.j.ruleEvents")}
            sub={String(breaks.length)}
            aside={
              <button type="button" className="jr-link" onClick={ctx.onOpenRules}>
                {t("plan.plan.tradingRules")}
              </button>
            }
          >
            {breaks.length === 0 ? (
              <p className="jr-quiet-note">
                <LuCheck size={14} aria-hidden /> {t("plan.td.noBreaks")}
              </p>
            ) : (
              <ul className="jr-breaks">
                {breaks.map((b) => (
                  <li key={b} data-tone={note.intended.includes(b) ? undefined : "warn"}>
                    <span>
                      <strong>{breakLabel(b)}</strong>
                      {detected.includes(b) && (
                        <span className="jr-muted"> · {t("plan.td.seenByApp")}</span>
                      )}
                      {note.intended.includes(b) && (
                        <span className="jr-muted"> · {t("plan.td.intended")}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="jr-button jr-quiet"
                      onClick={() =>
                        update((n) => ({
                          ...n,
                          breaks: [...new Set([...n.breaks, b])],
                          intended: n.intended.includes(b)
                            ? n.intended.filter((x) => x !== b)
                            : [...n.intended, b],
                        }))
                      }
                    >
                      {note.intended.includes(b) ? t("plan.td.unmark") : t("plan.td.markIntended")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Field label={t("plan.td.markBreaks")}>
              <ChipPicker
                label={t("plan.td.markBreaks")}
                options={BREAKS}
                picked={note.breaks}
                render={breakLabel}
                tone={() => "warn"}
                onChange={(picked: Break[]) => update((n) => ({ ...n, breaks: picked }))}
              />
            </Field>
          </Card>

          <details className="jr-card jr-disclosure">
            <summary className="jr-card-head">
              <h3>{t("plan.td.fills")}</h3>
              {fills && <span className="jr-card-sub">{fills.length}</span>}
              <span className="jr-card-aside">
                <Pill icon={<LuLock size={10} aria-hidden />}>
                  {t("plan.td.fromVenue", { venue: ctx.venueLabel })}
                </Pill>
                <LuChevronDown size={14} aria-hidden className="jr-disclosure-chev" />
              </span>
            </summary>
            <div className="jr-card-body" data-flush>
              {paper ? (
                <p className="jr-quiet-note jr-pad">{t("plan.td.paperFills")}</p>
              ) : !trade.closed ? (
                <p className="jr-quiet-note jr-pad">{t("plan.td.fillsGone")}</p>
              ) : !fills ? (
                <FillsSkeleton />
              ) : fills.length === 0 ? (
                <p className="jr-quiet-note jr-pad">{t("plan.td.noFills")}</p>
              ) : (
                <table className="pd-table jr-table">
                  <thead>
                    <tr>
                      <th>{t("plan.td.timeUtc")}</th>
                      <th>{t("col.side")}</th>
                      <th className="pd-num">{t("col.size")}</th>
                      <th className="pd-num">{t("col.price")}</th>
                      <th className="pd-num">{t("plan.td.notional")}</th>
                      <th className="pd-num">{t("plan.td.fee")}</th>
                      <th>{t("plan.td.role")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fills.map((x) => (
                      <tr key={x.id}>
                        <td className="pd-num">{new Date(x.time).toISOString().slice(11, 23)}</td>
                        <td className={x.side === "buy" ? "pd-up" : "pd-down"}>
                          {t(x.side === "buy" ? "side.buy" : "side.sell")}
                        </td>
                        <td className="pd-num">{formatNumber(x.size)}</td>
                        <td className="pd-num">{formatNumber(x.price)}</td>
                        <td className="pd-num">{formatMoney(Number(x.price) * Number(x.size))}</td>
                        <td className="pd-num">{formatNumber(x.fee)}</td>
                        <td>
                          {t(x.effect.startsWith("open") ? "plan.td.entry" : "plan.td.exit")} ·{" "}
                          {t(x.taker ? "plan.td.taker" : "plan.td.maker")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {figures.funding !== undefined && (
                <p className="jr-hint jr-pad">
                  {t("plan.td.fundingNote", { v: formatMoney(figures.funding) })}
                </p>
              )}
            </div>
          </details>
        </div>

        <aside className="jr-rail">
          <Card title={t("plan.td.summary")}>
            <dl className="jr-kv">
              <dt>{t("plan.td.result")}</dt>
              <dd>
                <RText r={r} />
              </dd>
              <dt>{t("plan.td.account")}</dt>
              <dd>{ctx.venueLabel}</dd>
              <dt>{t("plan.pb.playbook")}</dt>
              <dd>
                {playbook ? `${playbook.name} v${note.playbookVersion ?? playbook.version}` : "-"}
              </dd>
              <dt>{t("plan.td.day")}</dt>
              <dd>{dateFormat({ weekday: "long", timeZone: "UTC" }).format(f.closedAt)}</dd>
              <dt>{t("plan.td.nthToday")}</dt>
              <dd className="pd-num">{nth}</dd>
            </dl>
          </Card>
          <Card title={t("plan.td.state")} sub={t("plan.td.atEntry")}>
            <Rating
              label={t("plan.td.conviction")}
              hue="conviction"
              max={5}
              value={note.conviction}
              onChange={(conviction) => update((n) => ({ ...n, conviction }))}
            />
            <Field label={t("plan.today.mood")}>
              <ChipPicker
                label={t("plan.today.mood")}
                colored
                options={MOODS}
                picked={note.moods}
                render={moodLabel}
                onChange={(moods) => update((n) => ({ ...n, moods }))}
              />
            </Field>
            <Slider
              label={t("plan.sleep")}
              hue="sleep"
              min={0}
              max={12}
              step={0.1}
              value={
                note.sleep ?? ctx.journal.data.days.get(utcDay(f.closedAt))?.data.checkin.sleep
              }
              format={(v) => `${v.toFixed(1)} h`}
              onChange={(sleep) => update((n) => ({ ...n, sleep }))}
            />
            <Rating
              label={t("plan.energy")}
              hue="energy"
              max={10}
              value={note.energy}
              onChange={(energy) => update((n) => ({ ...n, energy }))}
            />
            <Rating
              label={t("plan.focus")}
              hue="focus"
              max={10}
              value={note.focus}
              onChange={(focus) => update((n) => ({ ...n, focus }))}
            />
          </Card>
          {playbook && (
            <Card title={playbook.name} sub={t("plan.pb.playbook")}>
              {playbook.thesis && <p className="jr-muted">{playbook.thesis}</p>}
              <div className="jr-minis">
                <Stat label={t("plan.trades")} value={pbGroup.trades} />
                <Stat label={t("plan.win")} value={pct(winRate(pbGroup))} />
                <Stat label={t("plan.avgR")} value={<RText r={avgR(pbGroup)} />} />
              </div>
            </Card>
          )}
          <Card title={t("plan.tags")}>
            <TagEditor
              tags={note.tags}
              label={t("plan.tags")}
              onChange={(tags) => update((n) => ({ ...n, tags }))}
              suggestions={[...new Set(ctx.trades.flatMap((x) => x.note.tags))]}
            />
          </Card>
          {similar.length > 0 && (
            <Card title={t("plan.td.similar")} sub={t("plan.td.samePlaybook")} flush>
              <ul className="jr-recent">
                {similar.map((x) => (
                  <li key={x.key}>
                    <button type="button" onClick={() => onOpen(x.key)}>
                      <span>
                        {dateFormat({ month: "short", day: "numeric", timeZone: "UTC" }).format(
                          x.note.trade.closedAt,
                        )}{" "}
                        · {ctx.symbolFor(x.note.trade.market)}
                      </span>
                      <span data-tone={skippedItems(x.note) ? "warn" : undefined}>
                        {skippedItems(x.note) ? t("plan.td.skipped") : t("plan.td.followed")}
                      </span>
                      <RText r={rOf(x.note)} />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Screenshots on the trade: pasted, dropped or picked; stored in the cloud, shown from it. */
export function Attachments({
  paths,
  onChange,
}: {
  paths: string[];
  onChange: (paths: string[]) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    for (const path of paths) {
      if (urls[path]) continue;
      cloudClient.attachment(path).then(
        (url) => live && setUrls((u) => ({ ...u, [path]: url })),
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [paths, urls]);

  const add = async (files: Iterable<File>) => {
    setBusy(true);
    setError(undefined);
    try {
      const added: string[] = [];
      for (const file of files) {
        if (!/^image\/(png|jpeg)$/.test(file.type)) continue;
        added.push(await cloudClient.upload(new Uint8Array(await file.arrayBuffer())));
      }
      if (added.length) onChange([...paths, ...added].slice(0, 20));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="jr-attachments">
      <h4 className="jr-label">{t("plan.td.attachments", { n: paths.length })}</h4>
      <div className="jr-thumbs">
        {paths.map((p) => (
          <figure key={p} className="jr-thumb">
            {urls[p] ? (
              <img src={urls[p]} alt={t("plan.td.screenshot")} />
            ) : (
              <span className="pd-skel" role="status" aria-label={t("plan.loading")} />
            )}
            <button
              type="button"
              className="jr-icon"
              aria-label={t("plan.remove", { name: t("plan.td.screenshot") })}
              onClick={() => {
                onChange(paths.filter((x) => x !== p));
                void cloudClient.removeAttachment(p).catch(() => {});
              }}
            >
              <LuX size={12} aria-hidden />
            </button>
          </figure>
        ))}
        <button
          type="button"
          className="jr-thumb jr-drop"
          disabled={busy}
          onClick={() => input.current?.click()}
          onPaste={(e) => void add([...e.clipboardData.files])}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void add([...e.dataTransfer.files]);
          }}
        >
          <LuImagePlus size={18} aria-hidden />
          <span>{busy ? t("plan.saving") : t("plan.td.dropShot")}</span>
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          multiple
          hidden
          onChange={(e) => e.target.files && void add([...e.target.files])}
        />
      </div>
      {error && <p className="jr-error">{error}</p>}
    </div>
  );
}

/**
 * The trade's playbook, as our own menu: each playbook in its colour, with
 * its status, direction and timeframes, and a search once there are many.
 */
function PlaybookPicker({
  ctx,
  value,
  onChange,
}: {
  ctx: PlanContext;
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const hues = useMemo(() => distinctHues([...ctx.playbooks.keys()]), [ctx.playbooks]);
  const current = value ? ctx.playbooks.get(value) : undefined;
  const q = query.trim().toLowerCase();
  const list = [...ctx.playbooks.entries()]
    .filter(([, p]) => p.status !== "retired" || p === current)
    .filter(([, p]) => !q || (p.name || "").toLowerCase().includes(q));

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  const meta = (p: Playbook) =>
    [t(`plan.dir.${p.direction}` as const), ...timeframesOf(p.timeframe)].join(" · ");

  return (
    <div className="jr-pbpick" ref={box}>
      <button
        type="button"
        className="jr-pbpick-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("plan.pb.playbook")}
        style={value && current ? hueOf(hues.get(value) ?? 235) : undefined}
        data-set={current ? "" : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {current ? (
          <>
            <span className="jr-pbpick-dot" aria-hidden />
            <span className="jr-pbpick-name">{current.name || t("plan.playbook.untitled")}</span>
            <span className="jr-muted jr-pbpick-meta">{meta(current)}</span>
          </>
        ) : (
          <span className="jr-muted">{t("plan.pb.choose")}</span>
        )}
        <LuChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="jr-pbpick-menu">
          {ctx.playbooks.size > 6 && (
            <label className="jr-search jr-pbpick-search">
              <LuSearch size={13} aria-hidden />
              <input
                value={query}
                // biome-ignore lint/a11y/noAutofocus: the menu was opened to pick from it
                autoFocus
                placeholder={t("plan.pb.searchPb")}
                aria-label={t("plan.pb.searchPb")}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          )}
          <div role="listbox" aria-label={t("plan.pb.playbook")}>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              className="jr-pbpick-opt"
              onClick={() => pick("")}
            >
              <span className="jr-pbpick-dot" data-none="" aria-hidden />
              <span className="jr-pbpick-name">{t("plan.pb.noneLabel")}</span>
              {!value && <LuCheck size={13} aria-hidden />}
            </button>
            {list.map(([id, p]) => (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={value === id}
                className="jr-pbpick-opt"
                style={hueOf(hues.get(id) ?? 235)}
                onClick={() => pick(id)}
              >
                <span className="jr-pbpick-dot" aria-hidden />
                <span className="jr-pbpick-text">
                  <span className="jr-pbpick-name">{p.name || t("plan.playbook.untitled")}</span>
                  <span className="jr-muted jr-pbpick-meta">{meta(p)}</span>
                </span>
                <StatusPill status={p.status} />
                {value === id && <LuCheck size={13} aria-hidden />}
              </button>
            ))}
            {list.length === 0 && (
              <p className="jr-hint jr-pbpick-empty">{t("plan.pb.noMatchPb")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
