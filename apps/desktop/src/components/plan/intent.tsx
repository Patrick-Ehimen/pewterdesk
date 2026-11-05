import type { Market } from "@pewterdesk/core";
import { formatNumber, TokenIcon, t } from "@pewterdesk/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { LuChevronDown, LuPlus, LuShieldAlert, LuStar, LuTrash2 } from "react-icons/lu";
import type { Allocation, Issue } from "../../lib/dayIntent";
import type { Bias, DayBias } from "../../lib/journal";
import { Field, Money, NumberInput, Prose, Segment, tagStyle } from "./parts";

// The pieces of a day's pre-market intent: conviction stars, the session map,
// how the day's risk is shared out, and each market's own plan.

const BIASES: readonly Bias[] = ["long", "neutral", "short"];

/** Conviction, 1 to 5 stars; `onChange` makes it editable. */
export function Stars({
  value,
  onChange,
  label,
  size = 16,
  disabled,
}: {
  value: number | undefined;
  onChange?: (value: number) => void;
  label: string;
  size?: number;
  disabled?: boolean;
}) {
  if (!onChange)
    return (
      <span className="jr-stars" role="img" aria-label={`${label} ${value ?? 0} / 5`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <LuStar
            key={n}
            size={size}
            data-on={value !== undefined && n <= value ? true : undefined}
          />
        ))}
      </span>
    );
  return (
    <span className="jr-stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        // biome-ignore lint/a11y/useSemanticElements: a rating, like the app's other segmented choices
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} / 5`}
          disabled={disabled}
          onClick={() => onChange(n)}
        >
          <LuStar size={size} data-on={value !== undefined && n <= value ? true : undefined} />
        </button>
      ))}
    </span>
  );
}

const SESSIONS = [
  { id: "asia", from: 0, to: 8 },
  { id: "eu", from: 8, to: 16 },
  { id: "us", from: 14, to: 24 },
] as const;

const hhmm = (h: number) =>
  `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

/** The day's three sessions on one track, the plan's window over them, and the time now (today only). */
export function SessionMap({
  today,
  window,
}: {
  today: boolean;
  /** The plan's session, UTC hours. */
  window?: { from: number; to: number };
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!today) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [today]);
  const d = new Date(now);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const active = SESSIONS.filter((s) => hour >= s.from && hour < s.to).map((s) => s.id);
  const next = SESSIONS.find((s) => s.from > hour);
  const mins = next ? Math.round((next.from - hour) * 60) : 0;
  const pct = (h: number) => `${(h / 24) * 100}%`;
  const spans: [number, number][] = window
    ? window.to > window.from
      ? [[window.from, window.to]]
      : [
          [window.from, 24],
          [0, window.to],
        ]
    : [];
  return (
    <div className="jr-sessionmap">
      <div className="jr-sessionmap-head">
        <span className="jr-label">{t("plan.sm.title")}</span>
        {today && <span className="jr-sessionmap-now pd-num">{hhmm(hour)} UTC</span>}
        <span className="jr-grow" />
        {today &&
          active.map((id) => (
            <span key={id} className="jr-pill" data-tone="strong">
              <span className="jr-live-dot" aria-hidden /> {t(`plan.sm.${id}` as const)} ·{" "}
              {t("plan.sm.active")}
            </span>
          ))}
        {today && next && (
          <span className="jr-pill">
            {t(`plan.sm.${next.id}` as const)} · {hhmm(next.from)} UTC ·{" "}
            {t("plan.sm.in", { h: Math.floor(mins / 60), m: mins % 60 })}
          </span>
        )}
      </div>
      <div className="jr-sessionmap-track">
        {/* One row: EU's own hours, the EU/US overlap, then US's own; each labelled with its real hours. */}
        {(
          [
            { id: "asia", from: 0, to: 8, label: SESSIONS[0] },
            { id: "eu", from: 8, to: 14, label: SESSIONS[1] },
            { id: "overlap", from: 14, to: 16 },
            { id: "us", from: 16, to: 24, label: SESSIONS[2] },
          ] as const
        ).map((b) => (
          <span
            key={b.id}
            className="jr-sessionmap-band"
            data-overlap={b.id === "overlap" || undefined}
            data-session={b.id === "overlap" ? undefined : b.id}
            data-active={
              today &&
              (b.id === "overlap"
                ? active.includes("eu") && active.includes("us")
                : active.includes(b.id))
                ? true
                : undefined
            }
            title={b.id === "overlap" ? t("plan.sm.overlap") : undefined}
            style={{ left: pct(b.from), width: pct(b.to - b.from) }}
          >
            {"label" in b && (
              <>
                <strong>{t(`plan.sm.${b.label.id}` as const)}</strong>
                <span className="pd-num">
                  {hhmm(b.label.from)}–{hhmm(b.label.to % 24)}
                </span>
              </>
            )}
          </span>
        ))}
        {spans.map(([a, b]) => (
          <span
            key={a}
            className="jr-sessionmap-window"
            title={t("plan.sm.yours")}
            style={{ left: pct(a), width: pct(b - a) }}
          />
        ))}
        {today && <span className="jr-sessionmap-marker" style={{ left: pct(hour) }} />}
      </div>
      <div className="jr-sessionmap-hours pd-num" aria-hidden>
        {["00", "04", "08", "12", "16", "20", "24"].map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      {window && (
        <span className="jr-sessionmap-legend">
          <span aria-hidden /> {t("plan.sm.yours")}
        </span>
      )}
    </div>
  );
}

/** How the day's risk cap is shared between the markets, and what's left of it. */
export function AllocationBar({
  a,
  symbolFor,
  marketFor,
  tradesUsed,
}: {
  a: Allocation;
  symbolFor: (market: string) => string;
  marketFor: (market: string) => Market | undefined;
  tradesUsed: number;
}) {
  const total = Math.max(a.cap ?? 0, a.allocated);
  const over = a.remaining !== undefined && a.remaining < 0;
  const share = (v: number) => (total > 0 ? `${(v / total) * 100}%` : "0%");
  return (
    <div className="jr-alloc" data-over={over || undefined}>
      <div className="jr-alloc-head">
        <div>
          <h4>{t("plan.in.allocTitle")}</h4>
          <span className="jr-muted">
            {a.maxTrades !== undefined
              ? t("plan.in.tradesUsedOf", { n: tradesUsed, of: a.maxTrades })
              : t("plan.in.tradesUsedN", { n: tradesUsed })}
          </span>
        </div>
        <div className="jr-alloc-total">
          <strong className="pd-num" data-tone={over ? "warn" : undefined}>
            {formatNumber(a.allocated)}%
          </strong>
          <span className="jr-muted">
            {a.cap !== undefined
              ? t("plan.in.ofCap", { v: formatNumber(a.cap) })
              : t("plan.in.noCap")}
          </span>
        </div>
      </div>
      <div className="jr-alloc-bar" role="img" aria-label={t("plan.in.allocTitle")}>
        {a.markets
          .filter((m) => (m.risk ?? 0) > 0)
          .map((m) => (
            <span
              key={m.market}
              className="jr-alloc-seg"
              style={{ ...tagStyle(m.market), width: share(m.risk ?? 0) }}
              title={`${symbolFor(m.market)} · ${formatNumber(m.risk ?? 0)}%`}
            />
          ))}
      </div>
      <ul className="jr-alloc-legend">
        {a.markets.map((m) => (
          <li key={m.market} style={tagStyle(m.market)}>
            <TokenIcon market={marketFor(m.market)} size={18} />
            <span className="jr-alloc-name">{symbolFor(m.market)}</span>
            <span className="jr-alloc-dot" aria-hidden />
            <span className="pd-num">
              {m.risk === undefined ? "–" : `${formatNumber(m.risk)}%`}
            </span>
            <span className="pd-num jr-muted">
              {m.risk === undefined || !a.cap ? "" : `${Math.round((m.risk / a.cap) * 100)}%`}
            </span>
          </li>
        ))}
        {a.remaining !== undefined && (
          <li className="jr-alloc-left" data-over={over || undefined}>
            <span className="jr-alloc-swatch" aria-hidden />
            <span className="jr-alloc-name">
              {over ? t("plan.in.over") : t("plan.in.remaining")}
            </span>
            <span />
            <span className="pd-num">{formatNumber(Math.abs(a.remaining))}%</span>
            <span />
          </li>
        )}
      </ul>
    </div>
  );
}

/** What in the intent goes past a limit, in words. */
export function IntentIssues({
  issues,
  symbolFor,
  onOpenRules,
}: {
  issues: readonly Issue[];
  symbolFor: (market: string) => string;
  onOpenRules: () => void;
}) {
  if (issues.length === 0) return null;
  const from = (f: "rules" | "plan") => t(f === "rules" ? "plan.in.fromRules" : "plan.in.fromPlan");
  const n = (v: number) => formatNumber(v);
  return (
    <div className="jr-issues" role="status">
      <LuShieldAlert size={15} aria-hidden />
      <ul>
        {issues.map((i) => (
          <li key={i.kind + ("market" in i ? i.market : "")}>
            {i.kind === "capOverDaily"
              ? t("plan.in.i.capOverDaily", {
                  cap: n(i.cap),
                  limit: n(i.limit),
                  from: from(i.from),
                })
              : i.kind === "tradesOverRule"
                ? t("plan.in.i.tradesOverRule", { n: i.trades, limit: i.limit, from: from(i.from) })
                : i.kind === "overCap"
                  ? t("plan.in.i.overCap", { a: n(i.allocated), cap: n(i.cap) })
                  : i.kind === "tradesOverDay"
                    ? t("plan.in.i.tradesOverDay", { n: i.planned, max: i.max })
                    : t("plan.in.i.perTrade", {
                        market: symbolFor(i.market),
                        r: n(i.risk),
                        limit: n(i.limit),
                        from: from(i.from),
                      })}
          </li>
        ))}
      </ul>
      <button type="button" className="jr-link" onClick={onOpenRules}>
        {t("plan.plan.tradingRules")}
      </button>
    </div>
  );
}

/** One market's plan for the day; opens to edit. */
export function TokenCard({
  symbol,
  value,
  onChange,
  onRemove,
  locked,
  traded,
  pnl,
  perTrade,
  open,
  onToggle,
  market,
}: {
  /** The venue's market, for its logo; unset for a symbol the venue doesn't list. */
  market?: Market;
  symbol: string;
  value: DayBias;
  onChange: (change: Partial<DayBias>) => void;
  onRemove: () => void;
  locked: boolean;
  /** Trades closed on this market today, and their result. */
  traded: number;
  pnl: number;
  /** The rule's most per trade, % (to show beside the input). */
  perTrade?: number;
  open: boolean;
  onToggle: () => void;
}) {
  const over = value.maxTrades !== undefined && traded > value.maxTrades;
  const bodyId = `jr-token-${symbol}`;
  return (
    <div className="jr-token" data-bias={value.bias} data-open={open || undefined}>
      <div className="jr-token-head">
        <button
          type="button"
          className="jr-token-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="jr-token-avatar" aria-hidden style={tagStyle(symbol)}>
            {market ? <TokenIcon market={market} size={30} /> : symbol.slice(0, 1)}
          </span>
          <span className="jr-token-title">
            <span className="jr-token-name">
              <strong>{symbol}</strong>
              <span
                className="jr-pill"
                data-tone={
                  value.bias === "long" ? "up" : value.bias === "short" ? "down" : undefined
                }
              >
                {t(`plan.bias.${value.bias}` as const)}
              </span>
            </span>
            <span className="jr-token-meta">
              <Stars value={value.conviction} label={t("plan.td.conviction")} size={11} />
              {value.riskPct !== undefined && (
                <span>{t("plan.in.riskN", { v: formatNumber(value.riskPct) })}</span>
              )}
              {value.maxTrades !== undefined && (
                <span>{t("plan.in.maxN", { n: value.maxTrades })}</span>
              )}
              {traded > 0 && (
                <span data-tone={over ? "warn" : undefined}>
                  {t("plan.in.tradedN", { n: traded })} · <Money value={pnl} />
                </span>
              )}
            </span>
          </span>
          <LuChevronDown size={15} aria-hidden className="jr-token-chev" />
        </button>
        {!locked && (
          <button
            type="button"
            className="jr-icon"
            aria-label={t("plan.remove", { name: symbol })}
            title={t("plan.remove", { name: symbol })}
            onClick={onRemove}
          >
            <LuTrash2 size={14} aria-hidden />
          </button>
        )}
      </div>
      {open && (
        <div className="jr-token-body" id={bodyId}>
          <div className="jr-token-grid">
            <Field label={t("plan.j.bias")}>
              <Segment
                size="sm"
                label={t("plan.today.biasFor", { market: symbol })}
                value={value.bias}
                disabled={locked}
                options={BIASES.map((b) => ({ value: b, label: t(`plan.bias.${b}` as const) }))}
                onChange={(bias) => onChange({ bias })}
              />
            </Field>
            <Field label={t("plan.td.conviction")}>
              <Stars
                value={value.conviction}
                label={t("plan.td.conviction")}
                disabled={locked}
                onChange={(conviction) => onChange({ conviction })}
              />
            </Field>
            <Field
              label={t("plan.in.riskPct")}
              hint={
                perTrade !== undefined
                  ? t("plan.in.perTradeHint", { v: formatNumber(perTrade) })
                  : undefined
              }
            >
              <NumberInput
                label={t("plan.in.riskPct")}
                unit="%"
                min={0}
                max={100}
                value={value.riskPct}
                disabled={locked}
                onChange={(riskPct) => onChange({ riskPct })}
              />
            </Field>
            <Field label={t("plan.in.maxTrades")}>
              <NumberInput
                label={t("plan.in.maxTrades")}
                min={0}
                max={1000}
                step={1}
                value={value.maxTrades}
                disabled={locked}
                onChange={(maxTrades) => onChange({ maxTrades })}
              />
            </Field>
          </div>
          <Field label={t("plan.in.thesis")}>
            <Prose
              value={value.note}
              rows={3}
              disabled={locked}
              label={t("plan.in.thesis")}
              placeholder={t("plan.in.thesisPh")}
              onChange={(note) => onChange({ note })}
            />
          </Field>
          <Field label={t("plan.today.keyLevels")}>
            <input
              className="pd-input"
              value={value.levels}
              disabled={locked}
              placeholder={t("plan.today.levelsHint")}
              onChange={(e) => onChange({ levels: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

/**
 * Adding a market to the day: the venue's markets with their logos, matched
 * as you type, or any symbol as typed when the venue doesn't list it.
 */
export function MarketPicker({
  markets,
  taken,
  onPick,
}: {
  markets: readonly Market[];
  /** Markets already in the day, shown as added. */
  taken: ReadonlySet<string>;
  /** A market id, or a typed symbol the venue doesn't list. */
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const query = q.trim().toLowerCase();
  const options = useMemo(() => {
    if (!query) return markets.slice(0, 8);
    const starts: Market[] = [];
    const has: Market[] = [];
    for (const m of markets) {
      const s = m.symbol.toLowerCase();
      const b = m.base.toLowerCase();
      if (s.startsWith(query) || b.startsWith(query)) starts.push(m);
      else if (s.includes(query) || m.id.toLowerCase().includes(query)) has.push(m);
      if (starts.length >= 8) break;
    }
    return [...starts, ...has].slice(0, 8);
  }, [markets, query]);
  const exact = options.some(
    (m) => m.symbol.toLowerCase() === query || m.id.toLowerCase() === query,
  );
  const typed =
    query && !exact ? q.trim().toUpperCase().replace(/\s+/g, "").slice(0, 30) : undefined;
  const rows = options.length + (typed ? 1 : 0);
  const pick = (i: number) => {
    const m = options[i];
    const id = m ? m.id : typed;
    if (!id || (m && taken.has(m.id))) return;
    onPick(id);
    setQ("");
    setActive(0);
    setOpen(false);
  };
  return (
    <div className="jr-picker">
      <div className="jr-addtoken">
        <LuPlus size={14} aria-hidden />
        <input
          aria-controls={listId}
          autoComplete="off"
          spellCheck={false}
          value={q}
          aria-label={t("plan.in.addToken")}
          placeholder={t("plan.in.addTokenPh")}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(rows - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(active);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          className="jr-button"
          disabled={rows === 0 || !q.trim()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(active)}
        >
          {t("plan.in.addToken")}
        </button>
      </div>
      {open && rows > 0 && (
        <div className="jr-picker-list" id={listId}>
          {options.map((m, i) => {
            const added = taken.has(m.id);
            return (
              <button
                key={m.id}
                type="button"
                tabIndex={-1}
                data-active={i === active || undefined}
                disabled={added}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
              >
                <TokenIcon market={m} size={24} />
                <span className="jr-picker-name">
                  <strong>{m.symbol}</strong>
                  <span>
                    {m.base} / {m.quote}
                  </span>
                </span>
                {added ? (
                  <span className="jr-pill">{t("plan.in.added")}</span>
                ) : (
                  <span className="jr-picker-lev pd-num">{m.maxLeverage}×</span>
                )}
              </button>
            );
          })}
          {typed && (
            <button
              type="button"
              tabIndex={-1}
              className="jr-picker-typed"
              data-active={active === options.length || undefined}
              onMouseEnter={() => setActive(options.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(options.length)}
            >
              <span
                className="jr-token-avatar jr-picker-avatar"
                style={tagStyle(typed)}
                aria-hidden
              >
                {typed.slice(0, 1)}
              </span>
              <span className="jr-picker-name">
                <strong>{t("plan.in.addTyped", { symbol: typed })}</strong>
                <span>{t("plan.in.notListed")}</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
