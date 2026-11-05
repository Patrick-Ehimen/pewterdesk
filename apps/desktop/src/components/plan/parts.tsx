import { formatNumber, formatSignedMoney, t, trendClass } from "@pewterdesk/ui";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  LuArrowLeft,
  LuChevronDown,
  LuInfo,
  LuPencil,
  LuPlus,
  LuSmile,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import {
  type Break,
  expandMarkets,
  isMarketRule,
  MOODS,
  type Mood,
  ruleQuote,
} from "../../lib/journal";
import type { CurvePoint, Group } from "../../lib/journalStats";
import { avgR, winRate } from "../../lib/journalStats";

// The Plan page's building blocks. One page head per view, one strip of
// figures under it, then sections - so each view reads top to bottom, most
// important first.

/** Hues for tags: blue to rose and gold, none of green, red or the warning orange. */
const TAG_HUES = [205, 235, 265, 295, 325, 355, 95, 185] as const;

/** Each state-of-mind and review score's own hue, so a row of them reads at a glance. */
export const SCORE_HUES = {
  sleep: 265,
  energy: 85,
  focus: 205,
  adherence: 235,
  process: 185,
  outcome: 295,
  energyLeft: 95,
  tilt: 325,
  confidence: 245,
  conviction: 85,
} as const;
export type ScoreHue = keyof typeof SCORE_HUES;
const hueStyle = (hue?: ScoreHue) =>
  hue === undefined ? undefined : ({ "--rate-h": SCORE_HUES[hue] } as CSSProperties);

/**
 * State that outlives the page: the Plan & journal page unmounts when the
 * app moves to another page, and this brings back where the trader was (the
 * tab, what was open, a draft half written) when they come back. For as long
 * as the app runs; a restart starts afresh.
 */
const kept = new Map<string, unknown>();
export function useKept<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const read = (k: string) => (kept.has(k) ? (kept.get(k) as T) : initial);
  const [state, setState] = useState(() => ({ key, value: read(key) }));
  // Another key (another account): that one's own value, not this one's carried over.
  let value = state.value;
  if (state.key !== key) {
    value = read(key);
    setState({ key, value });
  }
  useEffect(() => {
    kept.set(key, value);
  }, [key, value]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) =>
      setState((s) => ({
        key: s.key,
        value: typeof next === "function" ? (next as (prev: T) => T)(s.value) : next,
      })),
    [],
  );
  return [value, set];
}

/** A tag's own colour, the same for the same text everywhere. */
export function tagHue(text: string): number {
  let h = 2166136261;
  for (const ch of text.trim().toLowerCase()) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  return TAG_HUES[(h >>> 0) % TAG_HUES.length] ?? 235;
}

/**
 * A hue for each of a set of things (the playbooks), all different while
 * there are no more of them than hues: each keeps its own `tagHue` unless one
 * before it (by id) took it, and then takes the next free one. Adding one
 * moves another only if the two would have shared.
 */
export function distinctHues(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of [...ids].sort()) {
    let at = TAG_HUES.indexOf(tagHue(id) as (typeof TAG_HUES)[number]);
    for (let i = 0; i < TAG_HUES.length && taken.has(TAG_HUES[at] ?? -1); i++)
      at = (at + 1) % TAG_HUES.length;
    const hue = TAG_HUES[at] ?? 235;
    if (taken.size < TAG_HUES.length) taken.add(hue);
    else taken.clear();
    out.set(id, hue);
  }
  return out;
}

/** The style that colours a tag (`.jr-tag`, or a chip with `data-hue`). */
export const tagStyle = (text: string) => ({ "--tag-h": tagHue(text) }) as CSSProperties;

/** The trading plan's sessions: each weekday (Mon to Sun) a hue of its own. */
export const WEEKDAY_HUES = [205, 235, 265, 295, 325, 355, 185] as const;
/** A playbook's status, each a hue of its own (labels, as tags are). */
export const STATUS_HUES = { draft: 85, active: 185, retired: 355 } as const;

/** The trading plan's headings, each a soft, cool hue of its own. */
export const PLAN_HUES = {
  basics: 205,
  rules: 235,
  limits: 235,
  routine: 185,
  ownWords: 295,
  sessions: 265,
  markets: 205,
  playbooks: 325,
  changes: 250,
} as const;

/** A playbook's parts, each titled in a hue of its own. */
export const SECTION_HUES = {
  basics: 205,
  context: 235,
  trigger: 185,
  invalidIf: 355,
  risk: 325,
  checklist: 265,
  management: 95,
  changes: 295,
} as const;

/** The timeframes a playbook can trade, each with a hue of its own. */
export const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
const TIMEFRAME_HUES: Record<string, number> = {
  "1m": 205,
  "5m": 235,
  "15m": 265,
  "30m": 295,
  "1h": 325,
  "4h": 95,
  "1d": 185,
};
export const timeframeHue = (tf: string) => TIMEFRAME_HUES[tf] ?? 235;

/** A playbook's timeframes, kept as one line ("15m, 1h, 4h"), in order. */
export function timeframesOf(text: string): string[] {
  const set = new Set(text.split(/[\s,]+/).filter(Boolean));
  return [
    ...TIMEFRAMES.filter((tf) => set.has(tf)),
    ...[...set].filter((x) => !TIMEFRAMES.includes(x as never)),
  ];
}

/** The routine's two lists: a hue each. */
export const ROUTINE_HUES = { before: 205, after: 325 } as const;

/** A market's own hue, the same for the same market everywhere. */
export function marketHue(id: string): number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  return TAG_HUES[(h >>> 0) % TAG_HUES.length] ?? 235;
}

/**
 * Picked markets, with every quote asset whose markets are all picked folded
 * into one ("all USDT pairs"), so a plan of hundreds reads as a line.
 */
export function groupByQuote(
  ids: readonly string[],
  markets: readonly { id: string; quote: string }[],
): { whole: { quote: string; ids: string[] }[]; rest: string[] } {
  const picked = new Set(ids);
  const byQuote = new Map<string, string[]>();
  for (const m of markets) byQuote.set(m.quote, [...(byQuote.get(m.quote) ?? []), m.id]);
  const whole = [...byQuote.entries()]
    .filter(([, list]) => list.length > 1 && list.every((id) => picked.has(id)))
    .map(([quote, list]) => ({ quote, ids: list }));
  const folded = new Set(whole.flatMap((w) => w.ids));
  return { whole, rest: ids.filter((id) => !folded.has(id)) };
}

/**
 * A plan's markets in one short line: a quote asset picked whole as "All USDT
 * pairs (412)", a long run of one as "380 USDT pairs", a few by name.
 */
export function marketsLine(
  list: readonly string[],
  markets: readonly { id: string; quote: string }[],
  symbolFor: (id: string) => string,
  few = 6,
): string {
  let ids = list;
  // Rules first ("all USDT pairs"), counted against the venue's list; then
  // the markets picked by name that no rule already takes in.
  const rules = ids.filter(isMarketRule);
  const ruleParts = rules.map((r) => {
    const quote = ruleQuote(r);
    const n = expandMarkets([r], markets).length;
    const name = quote === "*" ? t("plan.plan.allMarkets") : t("plan.plan.allPairs", { quote });
    return n ? `${name} (${n})` : name;
  });
  if (rules.length) {
    const quoteOfId = new Map(markets.map((m) => [m.id, m.quote]));
    ids = ids.filter(
      (id) =>
        !isMarketRule(id) &&
        !rules.some((r) => ruleQuote(r) === "*" || ruleQuote(r) === quoteOfId.get(id)),
    );
    if (!ids.length) return ruleParts.join(", ");
  }
  const picked = new Set(ids);
  if (!rules.length && markets.length > 1 && markets.every((m) => picked.has(m.id)))
    return `${t("plan.plan.allMarkets")} (${ids.length})`;
  const listed = new Map(markets.map((m) => [m.id, m.quote]));
  // A market this venue doesn't list (the plan was written on another): its
  // quote from its own name ("BTCUSDT", "BTC-USDC"), where that says.
  const quoteOf = (id: string) =>
    listed.get(id) ??
    /(USDT|USDC|USDE|USDH|USD)$/.exec(symbolFor(id).replace(/-?PERP$/, ""))?.[1] ??
    "";
  const { whole, rest } = groupByQuote(ids, markets);
  const byQuote = new Map<string, string[]>();
  for (const id of rest) {
    const q = quoteOf(id);
    byQuote.set(q, [...(byQuote.get(q) ?? []), id]);
  }
  const parts = whole.map(
    (w) => `${t("plan.plan.allPairs", { quote: w.quote })} (${w.ids.length})`,
  );
  for (const [quote, list] of byQuote) {
    if (list.length <= few) parts.push(...list.map(symbolFor));
    else if (quote) parts.push(t("plan.plan.nPairs", { n: list.length, quote }));
    else parts.push(t("plan.plan.nMarkets", { n: list.length }));
  }
  return [...ruleParts, ...parts].join(", ");
}

/** The style that colours anything by a hue (`--tag-h`). */
export const hueOf = (hue: number) => ({ "--tag-h": hue }) as CSSProperties;

/** A signed R figure, "+2.11R". */
export function formatR(r: number | undefined, digits = 2): string {
  if (r === undefined || !Number.isFinite(r)) return "-";
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(digits)}R`;
}

export const pct = (share: number, digits = 0) => `${(share * 100).toFixed(digits)}%`;

export function RText({ r, digits }: { r: number | undefined; digits?: number }) {
  return (
    <span className={`pd-num ${r === undefined ? "" : trendClass(r)}`}>{formatR(r, digits)}</span>
  );
}

export function Money({ value, quote = "" }: { value: number; quote?: string }) {
  return <span className={`pd-num ${trendClass(value)}`}>{formatSignedMoney(value, quote)}</span>;
}

/** A view's head: where you are, what it's about, and its one or two actions. */
export function PageHead({
  back,
  eyebrow,
  title,
  meta,
  actions,
}: {
  back?: { label: string; onClick: () => void };
  eyebrow?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="jr-head">
      <div className="jr-head-main">
        {back && (
          <button type="button" className="jr-back" onClick={back.onClick}>
            <LuArrowLeft size={13} aria-hidden /> {back.label}
          </button>
        )}
        {eyebrow && !back && <span className="jr-eyebrow">{eyebrow}</span>}
        <h2 className="jr-title">{title}</h2>
        {meta && <div className="jr-meta">{meta}</div>}
      </div>
      {actions && <div className="jr-head-actions">{actions}</div>}
    </header>
  );
}

/** A panel: a title row and its body. `flush` lets a table reach the edges. */
export function Card({
  title,
  sub,
  aside,
  children,
  className,
  foot,
  flush,
  icon,
  "data-hue": hue,
  titleHue,
}: {
  /** A rail card's own label hue (see `.jr-rc` in plan.css). */
  "data-hue"?: string;
  /** Colours the card's title (a soft label hue, `PLAN_HUES`). */
  titleHue?: number;
  title?: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  foot?: ReactNode;
  flush?: boolean;
  icon?: ReactNode;
}) {
  return (
    <section
      className={`jr-card ${className ?? ""}`}
      data-hue={hue}
      data-title-hue={titleHue === undefined ? undefined : ""}
      style={titleHue === undefined ? undefined : hueOf(titleHue)}
    >
      {(title || aside) && (
        <header className="jr-card-head">
          {icon && <span className="jr-card-icon">{icon}</span>}
          {title && <h3>{title}</h3>}
          {sub && <span className="jr-card-sub">{sub}</span>}
          {aside && <span className="jr-card-aside">{aside}</span>}
        </header>
      )}
      <div className="jr-card-body" data-flush={flush || undefined}>
        {children}
      </div>
      {foot && <footer className="jr-card-foot">{foot}</footer>}
    </section>
  );
}

/** A strip of figures, divided by hairlines: the view's numbers at a glance. */
export function Kpis({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`jr-kpis ${className ?? ""}`}>{children}</div>;
}

/** A figure: a label, the value, a line under it. */
export function Stat({
  label,
  value,
  note,
  aside,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="jr-stat">
      <span className="jr-label">{label}</span>
      <span className="jr-stat-row">
        <strong className="jr-stat-value">{value}</strong>
        {aside}
      </span>
      {note !== undefined && <span className="jr-stat-note">{note}</span>}
    </div>
  );
}

/** Two figures side by side, as "followed vs skipped". */
export function Compare({
  items,
}: {
  items: readonly { label: string; value: ReactNode; note?: ReactNode }[];
}) {
  return (
    <div className="jr-compare">
      {items.map((x) => (
        <div key={x.label} className="jr-compare-item">
          <span className="jr-label">{x.label}</span>
          <strong className="jr-stat-value">{x.value}</strong>
          {x.note && <span className="jr-stat-note">{x.note}</span>}
        </div>
      ))}
    </div>
  );
}

/** A small label in a rounded outline. */
export function Pill({
  children,
  tone,
  icon,
  title,
}: {
  children: ReactNode;
  tone?: "warn" | "up" | "down" | "strong";
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <span className="jr-pill" data-tone={tone} title={title}>
      {icon}
      {children}
    </span>
  );
}

/** A playbook's status, in its own hue. */
export function StatusPill({ status }: { status: keyof typeof STATUS_HUES }) {
  return (
    <span className="jr-pill jr-hued" style={hueOf(STATUS_HUES[status])}>
      {t(`plan.pb.status.${status}` as const)}
    </span>
  );
}

/** How much of a limit is used, as a bar that turns to the warning colour near it. */
export function Meter({
  label,
  value,
  max,
  shown,
  note,
}: {
  label: string;
  value: number;
  max: number | undefined;
  shown: ReactNode;
  note?: ReactNode;
}) {
  const share = max ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className="jr-meter" data-tone={max && share >= 0.75 ? "warn" : undefined}>
      <div className="jr-meter-row">
        <span>{label}</span>
        <span className="pd-num">{shown}</span>
      </div>
      <span className="jr-meter-track" aria-hidden>
        <span className="jr-meter-fill" style={{ width: `${share * 100}%` }} />
      </span>
      {note && <span className="jr-hint">{note}</span>}
    </div>
  );
}

/** An empty page or section: what's missing, why it matters, and the way to start. */
export function Blank({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="jr-blank">
      {icon && <span className="jr-blank-icon">{icon}</span>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/**
 * A small pop-up of our own that asks before an action goes through: what it
 * does, Cancel (focused, so Enter or Escape backs out) and the action. The
 * desktop webview doesn't show `window.confirm` (it returns false), so
 * nothing here may rely on it.
 */
export function ConfirmDialog({
  title,
  body,
  action,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  /** The action button's words, e.g. "Delete". */
  action: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="jr-dialog jr-confirm"
      data-danger={danger || undefined}
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-b`}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      // Keys stay in here: Escape or Cmd+Enter mean this question, not a dialog behind it.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="jr-confirm-main">
        <span className="jr-confirm-icon" aria-hidden>
          {danger ? <LuTrash2 size={18} /> : <LuInfo size={18} />}
        </span>
        <div>
          <h2 id={`${id}-t`}>{title}</h2>
          <div id={`${id}-b`} className="jr-confirm-body">
            {body}
          </div>
        </div>
      </div>
      <footer className="jr-confirm-foot">
        {/* biome-ignore lint/a11y/noAutofocus: backing out is the safe default */}
        <button type="button" className="jr-button" autoFocus onClick={onClose}>
          {t("plan.confirm.cancel")}
        </button>
        <button
          type="button"
          className={`jr-button ${danger ? "jr-danger-solid" : "jr-primary"}`}
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {action}
        </button>
      </footer>
    </dialog>
  );
}

/** A button whose action asks first, in a `ConfirmDialog`. */
export function ConfirmButton({
  children,
  onConfirm,
  className = "jr-button",
  label,
  disabled,
  title,
  body,
  action,
  danger,
}: {
  children: ReactNode;
  onConfirm: () => void;
  className?: string;
  /** For an icon-only button. */
  label?: string;
  disabled?: boolean;
  /** The pop-up's question, e.g. "Delete this playbook?". */
  title: string;
  /** What it will do, and what it won't. */
  body: ReactNode;
  /** The action button's words. */
  action: string;
  danger?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={label}
        title={label}
        disabled={disabled}
        aria-haspopup="dialog"
        onClick={() => setAsking(true)}
      >
        {children}
      </button>
      {asking && (
        <ConfirmDialog
          title={title}
          body={body}
          action={action}
          danger={danger}
          onConfirm={onConfirm}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}

/** The bar that stays at the foot of an editor: what saving does, and the buttons. */
export function ActionBar({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="jr-actionbar">
      {note && <span className="jr-actionbar-note">{note}</span>}
      <span className="jr-grow" />
      {children}
    </div>
  );
}

/** A form's section: its name and a line on the left, the controls on the right. */
export function FormSection({
  title,
  hint,
  children,
  hue,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  /** Colours the section's title (a label hue). */
  hue?: number;
}) {
  return (
    <section
      className="jr-formsec"
      data-hue={hue === undefined ? undefined : ""}
      style={hue === undefined ? undefined : hueOf(hue)}
    >
      <div className="jr-formsec-head">
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
      </div>
      <div className="jr-formsec-body">{children}</div>
    </section>
  );
}

export function Field({
  label,
  children,
  hint,
  hue,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  /** Colours the label (a label hue). */
  hue?: number;
}) {
  const id = useId();
  return (
    <div
      className="jr-field"
      data-hue={hue === undefined ? undefined : ""}
      style={hue === undefined ? undefined : hueOf(hue)}
    >
      <label className="jr-field-label" htmlFor={id}>
        {label}
      </label>
      <div id={id}>{children}</div>
      {hint && <span className="jr-hint">{hint}</span>}
    </div>
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 2,
  label,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <textarea
      className="pd-input jr-textarea"
      value={value}
      rows={rows}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Writing that reads as writing once it's there: the text as paragraphs (a
 * blank line starts a new one), a click or its Edit button to change it, and
 * back to paragraphs when the field loses focus. Empty, it's a field to type in.
 */
export function Prose({
  value,
  onChange,
  placeholder,
  rows = 3,
  label,
  single,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  label: string;
  /** One line (the lesson): an input, not a text area. */
  single?: boolean;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const written = value.trim() !== "";
  if (written && !editing)
    return (
      <div className="jr-prose" data-single={single || undefined}>
        <button
          type="button"
          className="jr-prose-text"
          aria-label={t("plan.prose.edit", { field: label })}
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          {value
            .trim()
            .split(/\n\s*\n/)
            .map((para, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs have no identity but their place
              <span key={i} className="jr-prose-para">
                {para}
              </span>
            ))}
        </button>
        {!disabled && (
          <button
            type="button"
            className="jr-icon jr-prose-edit"
            aria-label={t("plan.prose.edit", { field: label })}
            title={t("plan.prose.edit", { field: label })}
            onClick={() => setEditing(true)}
          >
            <LuPencil size={13} aria-hidden />
          </button>
        )}
      </div>
    );
  return single ? (
    <input
      className="pd-input jr-lesson-input"
      value={value}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      // biome-ignore lint/a11y/noAutofocus: opened to edit it
      autoFocus={editing}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
      }}
    />
  ) : (
    <textarea
      className="pd-input jr-textarea"
      value={value}
      rows={rows}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      // biome-ignore lint/a11y/noAutofocus: opened to edit it
      autoFocus={editing}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}

/** A number input that keeps what's typed and reports only numbers. */
export function NumberInput({
  value,
  onChange,
  label,
  unit,
  prefix,
  min,
  max,
  step = "any",
  placeholder,
  disabled,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  label: string;
  unit?: string;
  /** Shown before the figure, as "$". */
  prefix?: string;
  min?: number;
  max?: number;
  step?: number | "any";
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const shown =
    Number(text) === value || (text === "" && value === undefined)
      ? text
      : value === undefined
        ? ""
        : String(value);
  return (
    <span className="jr-number" data-disabled={disabled || undefined}>
      {prefix && <span className="jr-prefix">{prefix}</span>}
      <input
        className="pd-num"
        type="number"
        inputMode="decimal"
        aria-label={label}
        value={shown}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder ?? "-"}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          const n = e.target.value === "" ? undefined : Number(e.target.value);
          if (
            n === undefined ||
            (Number.isFinite(n) &&
              (min === undefined || n >= min) &&
              (max === undefined || n <= max))
          ) {
            onChange(n);
          }
        }}
      />
      {unit && <span className="jr-unit">{unit}</span>}
    </span>
  );
}

/** A labelled range with its value beside it, for continuous figures (sleep, adherence). */
export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 10,
  step = 1,
  format = (v: number) => `${v} / ${max}`,
  disabled,
  hue,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  disabled?: boolean;
  /** Its own colour (`SCORE_HUES`). */
  hue?: ScoreHue;
}) {
  const at = value === undefined ? 0 : ((value - min) / Math.max(1e-9, max - min)) * 100;
  return (
    <label className="jr-slider" data-hue={hue ? true : undefined} style={hueStyle(hue)}>
      <span className="jr-slider-head">
        <span>{label}</span>
        <span className="pd-num jr-slider-value">{value === undefined ? "-" : format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value ?? min}
        disabled={disabled}
        data-unset={value === undefined || undefined}
        style={{ "--at": `${at}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** A score out of a few (1-5, 1-10): one tap, the scale in plain sight. */
export function Rating({
  label,
  value,
  onChange,
  max = 5,
  disabled,
  showLabel = true,
  hue,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number) => void;
  max?: number;
  disabled?: boolean;
  showLabel?: boolean;
  /** Its own colour (`SCORE_HUES`). */
  hue?: ScoreHue;
}) {
  return (
    <div className="jr-rating-field" data-hue={hue ? true : undefined} style={hueStyle(hue)}>
      {showLabel && (
        <span className="jr-rating-head">
          <span>{label}</span>
          <span className="pd-num jr-muted">{value === undefined ? "-" : `${value} / ${max}`}</span>
        </span>
      )}
      <span className="jr-rating" role="radiogroup" aria-label={label} data-max={max}>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n}`}
            data-on={value !== undefined && n <= value ? true : undefined}
            disabled={disabled}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        ))}
      </span>
    </div>
  );
}

/** Pick one of a few, as a segmented row. */
export function Segment<V extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  size,
}: {
  value: V | undefined;
  options: readonly { value: V; label: ReactNode }[];
  onChange: (value: V) => void;
  label: string;
  disabled?: boolean;
  size?: "sm";
}) {
  return (
    <span className="jr-segment" role="radiogroup" aria-label={label} data-size={size}>
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-value={o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** A labelled group of controls (chips, lines), as a fieldset. */
export function ChipGroup({
  className,
  label,
  children,
  style,
  "data-hue": hue,
}: {
  className: string;
  label: string;
  children: ReactNode;
  style?: CSSProperties;
  "data-hue"?: string;
}) {
  return (
    <fieldset className={`jr-group ${className}`} style={style} data-hue={hue}>
      <legend className="pd-visually-hidden">{label}</legend>
      {children}
    </fieldset>
  );
}

/** Toggle chips: any number picked. */
export function ChipPicker<V extends string>({
  options,
  picked,
  onChange,
  label,
  render = (v) => v,
  tone,
  disabled,
  colored,
}: {
  options: readonly V[];
  picked: readonly V[];
  onChange: (picked: V[]) => void;
  label: string;
  render?: (value: V) => string;
  tone?: (value: V) => "warn" | undefined;
  disabled?: boolean;
  /** Picked chips take their tag colour (moods and tags). */
  colored?: boolean;
}) {
  return (
    <ChipGroup className="jr-chips" label={label}>
      {options.map((o) => {
        const on = picked.includes(o);
        return (
          <button
            key={o}
            type="button"
            className="jr-chip"
            aria-pressed={on}
            data-tone={tone?.(o)}
            data-hue={colored && on ? true : undefined}
            style={colored ? tagStyle(o) : undefined}
            disabled={disabled}
            onClick={() => onChange(on ? picked.filter((p) => p !== o) : [...picked, o])}
          >
            {render(o)}
          </button>
        );
      })}
    </ChipGroup>
  );
}

/** Free tags: the ones there, removable, and a field for a new one. */
export function TagEditor({
  tags,
  onChange,
  suggestions = [],
  label,
}: {
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  suggestions?: readonly string[];
  label: string;
}) {
  const [draft, setDraft] = useState("");
  const add = (tag: string) => {
    const clean = tag.trim().slice(0, 60);
    if (clean && !tags.includes(clean)) onChange([...tags, clean]);
    setDraft("");
  };
  const listId = useId();
  return (
    <div className="jr-chips">
      {tags.map((tag) => (
        <span key={tag} className="jr-chip" data-static data-hue style={tagStyle(tag)}>
          {tag}
          <button
            type="button"
            className="jr-chip-x"
            aria-label={t("plan.remove", { name: tag })}
            onClick={() => onChange(tags.filter((x) => x !== tag))}
          >
            <LuX size={11} aria-hidden />
          </button>
        </span>
      ))}
      <input
        className="jr-tag-input"
        aria-label={label}
        placeholder={t("plan.addTag")}
        value={draft}
        list={listId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft && add(draft)}
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !tags.includes(s))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}

/** An editable list of lines. */
export function LinesEditor({
  lines,
  onChange,
  label,
  placeholder,
  max = 30,
  hue,
}: {
  lines: readonly string[];
  onChange: (lines: string[]) => void;
  label: string;
  placeholder?: string;
  max?: number;
  /** Colours the list's numbers and edges (a label hue, as tags have). */
  hue?: number;
}) {
  return (
    <ChipGroup
      className="jr-lines"
      label={label}
      data-hue={hue === undefined ? undefined : ""}
      style={hue === undefined ? undefined : hueOf(hue)}
    >
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place
        <div className="jr-line" key={i}>
          <span className="jr-line-n pd-num" aria-hidden>
            {i + 1}
          </span>
          <input
            className="pd-input"
            value={line}
            aria-label={`${label} ${i + 1}`}
            onChange={(e) => onChange(lines.map((l, j) => (j === i ? e.target.value : l)))}
          />
          <button
            type="button"
            className="jr-icon"
            aria-label={t("plan.remove", { name: line || String(i + 1) })}
            onClick={() => onChange(lines.filter((_, j) => j !== i))}
          >
            <LuX size={13} aria-hidden />
          </button>
        </div>
      ))}
      {lines.length < max && (
        <button type="button" className="jr-add" onClick={() => onChange([...lines, ""])}>
          <LuPlus size={12} aria-hidden /> {placeholder ?? t("plan.addLine")}
        </button>
      )}
    </ChipGroup>
  );
}

/** The discipline score in a ring. */
export function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const stroke = size >= 72 ? 6 : 3.5;
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const tone = score >= 90 ? "good" : score >= 70 ? "fair" : "poor";
  return (
    <svg
      className="jr-ring"
      data-tone={tone}
      data-size={size >= 72 ? "lg" : undefined}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t("plan.score", { score })}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="jr-ring-track"
        style={{ strokeWidth: stroke }}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="jr-ring-fill"
        style={{ strokeWidth: stroke }}
        strokeDasharray={`${(c * score) / 100} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
        {score}
      </text>
    </svg>
  );
}

/** A horizontal bar scaled to `max`, in the sign's colour. */
export function Bar({ value, max, neutral }: { value: number; max: number; neutral?: boolean }) {
  const width = max > 0 ? Math.min(100, (Math.abs(value) / max) * 100) : 0;
  return (
    <span className="jr-bar">
      <span
        className="jr-bar-fill"
        data-tone={neutral ? "neutral" : value >= 0 ? "up" : "down"}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

/** A group's line: trades, win rate, average R. */
export function groupLine(g: Group): string {
  return t("plan.groupLine", {
    trades: g.trades,
    win: pct(winRate(g)),
    avg: formatR(avgR(g)),
  });
}

/** Cumulative R as a small line, for a playbook's card. */
export function Sparkline({ points }: { points: readonly CurvePoint[] }) {
  const W = 120;
  const H = 32;
  if (points.length < 2) return <span className="jr-spark jr-spark-empty" aria-hidden />;
  const values = [0, ...points.map((p) => p.r)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(0.5, hi - lo);
  const x = (i: number) => (W * i) / (values.length - 1);
  const y = (r: number) => 2 + ((H - 4) * (hi - r)) / span;
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = values[values.length - 1] ?? 0;
  return (
    <svg className="jr-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="jr-spark-zero" />
      <path d={d} className="jr-spark-line" data-tone={last >= 0 ? "up" : "down"} />
    </svg>
  );
}

/** Cumulative R as a line, each trade a dot marked by how it was taken. */
export function CumulativeChart({
  points,
  height = 260,
  width = 800,
}: {
  points: readonly CurvePoint[];
  height?: number;
  /** The drawing's own width: about the width it's shown at, so its labels stay legible. */
  width?: number;
}) {
  const W = width;
  const H = height;
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  if (points.length === 0) return <p className="jr-empty">{t("plan.noR")}</p>;
  const values = [0, ...points.map((p) => p.r)];
  const lo = Math.floor(Math.min(...values));
  const hi = Math.ceil(Math.max(...values));
  const span = Math.max(1, hi - lo);
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, points.length);
  const y = (r: number) => pad.t + ((H - pad.t - pad.b) * (hi - r)) / span;
  const path = [`M${x(0)},${y(0)}`, ...points.map((p, i) => `L${x(i + 1)},${y(p.r)}`)].join(" ");
  const area = `${path} L${x(points.length)},${y(0)} L${x(0)},${y(0)} Z`;
  const step = Math.max(1, Math.ceil(span / 6));
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  return (
    <svg
      className="jr-curve"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t("plan.cumulativeR")}
    >
      {ticks.map((v) => (
        <g key={v}>
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={y(v)}
            y2={y(v)}
            className={v === 0 ? "jr-axis-zero" : "jr-grid"}
          />
          <text
            x={pad.l - 8}
            y={y(v)}
            textAnchor="end"
            dominantBaseline="central"
            className="jr-tick"
          >
            {formatR(v, 0)}
          </text>
        </g>
      ))}
      <path d={area} className="jr-curve-area" />
      <path d={path} className="jr-curve-line" />
      {points.map((p, i) =>
        p.kind === "break" ? (
          <rect
            key={p.at}
            x={x(i + 1) - 4}
            y={y(p.r) - 4}
            width={8}
            height={8}
            className="jr-dot"
            data-kind={p.kind}
          >
            <title>{formatR(p.r)}</title>
          </rect>
        ) : (
          <circle
            key={p.at}
            cx={x(i + 1)}
            cy={y(p.r)}
            r={3.5}
            className="jr-dot"
            data-kind={p.kind}
          >
            <title>{formatR(p.r)}</title>
          </circle>
        ),
      )}
    </svg>
  );
}

export function CurveLegend() {
  return (
    <span className="jr-legend">
      <span data-kind="followed">{t("plan.kind.followed")}</span>
      <span data-kind="skipped">{t("plan.kind.skipped")}</span>
      <span data-kind="break">{t("plan.kind.break")}</span>
    </span>
  );
}

export const moodLabel = (m: Mood) => t(`plan.mood.${m}` as const);
export const breakLabel = (b: Break) => t(`plan.break.${b}` as const);

/** A UTC "HH:MM" time. */
export function utcTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** How long, "6 h 39 m". */
export function heldText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return t("plan.heldDh", { d, h });
  if (h > 0) return t("plan.heldHm", { h, m: m % 60 });
  return t("plan.heldM", { m });
}

export const num = (v: number | undefined, digits?: number) =>
  v === undefined ? "-" : formatNumber(v, digits);

/** Monday of the week `ms` falls in, as a UTC day. */
export function weekStartOf(ms: number): string {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(ms - back * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A mood to go with a note: a button showing the one picked (in its tag
 * colour), opening the moods as chips. Picking the same one again clears it.
 */
export function MoodSelect({
  value,
  onChange,
}: {
  value: Mood | undefined;
  onChange: (mood: Mood | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the panel as focus leaves it or on Escape; its buttons do the rest
    <div
      className="jr-moodselect"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="jr-moodselect-button"
        aria-expanded={open}
        aria-controls={panelId}
        data-hue={value ? true : undefined}
        style={value ? tagStyle(value) : undefined}
        onClick={() => setOpen(!open)}
      >
        {value ? (
          <span className="jr-moodselect-dot" aria-hidden />
        ) : (
          <LuSmile size={14} aria-hidden />
        )}
        <span>{value ? moodLabel(value) : t("plan.today.mood")}</span>
        <LuChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="jr-moodselect-panel" id={panelId}>
          <span className="jr-label">{t("plan.j.moodNow")}</span>
          <div className="jr-chips">
            {MOODS.map((m) => (
              <button
                key={m}
                type="button"
                className="jr-chip"
                aria-pressed={value === m}
                data-hue
                style={tagStyle(m)}
                onClick={() => {
                  onChange(value === m ? undefined : m);
                  setOpen(false);
                }}
              >
                {moodLabel(m)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Text written as one run with numbered points ("Basic identifiers: 1. Peak
 * of a rally 2.Bottom of a dump ...") split into its lead and the points. A
 * number in a price ("81.450") isn't a point: the dot must not be followed by
 * a digit.
 */
export function textPoints(text: string): { lead: string; points: string[] } {
  const marks = [...text.matchAll(/(?:^|\s)(\d{1,2})\.(?!\d)\s*/g)];
  if (marks.length < 2) return { lead: text.trim(), points: [] };
  const first = marks[0]?.index ?? 0;
  const points = marks
    .map((m, i) => {
      const from = (m.index ?? 0) + m[0].length;
      const to = marks[i + 1]?.index ?? text.length;
      return text.slice(from, to).trim();
    })
    .filter(Boolean);
  return { lead: text.slice(0, first).trim(), points };
}

/**
 * A long piece of the trader's own writing (a plan's goal, a playbook's
 * thesis), the full width of the page: a coloured label, the lead, and its
 * numbered points one to a row.
 */
export function SpreadText({ label, hue, text }: { label: string; hue: number; text: string }) {
  const { lead, points } = textPoints(text);
  return (
    <div className="jr-pbthesis" style={hueOf(hue)}>
      <span className="jr-pbthesis-label">{label}</span>
      {lead && <p>{lead}</p>}
      {points.length > 0 && (
        <ol className="jr-pbthesis-points">
          {points.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: points have no identity but their place
            <li key={i}>{x}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
