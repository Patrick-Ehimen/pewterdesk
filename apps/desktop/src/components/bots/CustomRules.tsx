import { formatNumber, type MessageKey, Select, t } from "@pewterdesk/ui";
import { LuPlus, LuX } from "react-icons/lu";
import type { Compare, CustomParams, Rule, Source } from "../../lib/backtest";

type SourceKind = Source["kind"];
const SOURCES: readonly SourceKind[] = ["price", "ema", "sma", "rsi", "value"];
const OPS: readonly Compare[] = ["crossesAbove", "crossesBelow", "above", "below"];
const SOURCE_LABEL: Record<SourceKind, MessageKey> = {
  price: "bots.src.price",
  ema: "bots.src.ema",
  sma: "bots.src.sma",
  rsi: "bots.src.rsi",
  value: "bots.src.value",
};
const OP_LABEL: Record<Compare, MessageKey> = {
  crossesAbove: "bots.op.crossesAbove",
  crossesBelow: "bots.op.crossesBelow",
  above: "bots.op.above",
  below: "bots.op.below",
};
/** A new source's starting number: an indicator's period, or a level. */
const START: Record<SourceKind, string> = {
  price: "",
  ema: "20",
  sma: "50",
  rsi: "14",
  value: "30",
};

/** A source as typed: its kind, and its period or value as text. */
export interface SourceDraft {
  kind: SourceKind;
  n: string;
}
export interface RuleDraft {
  id: number;
  left: SourceDraft;
  op: Compare;
  right: SourceDraft;
}
/** The custom form as typed, before it's checked. */
export interface CustomDraft {
  side: CustomParams["side"];
  entry: RuleDraft[];
  exit: RuleDraft[];
  /** Percentages, as typed. */
  stopLoss: string;
  takeProfit: string;
  size: string;
}

let nextId = 1;
const rule = (left: SourceDraft, op: Compare, right: SourceDraft): RuleDraft => ({
  id: nextId++,
  left,
  op,
  right,
});

/** A first custom bot: in on a fast average crossing a slow one, out on the cross back. */
export function customDefaults(): CustomDraft {
  return {
    side: "long",
    entry: [rule({ kind: "ema", n: "20" }, "crossesAbove", { kind: "ema", n: "50" })],
    exit: [rule({ kind: "ema", n: "20" }, "crossesBelow", { kind: "ema", n: "50" })],
    stopLoss: "3",
    takeProfit: "6",
    size: "100",
  };
}

const toSource = (s: SourceDraft): Source =>
  s.kind === "price"
    ? { kind: "price" }
    : s.kind === "value"
      ? { kind: "value", value: Number(s.n) }
      : { kind: s.kind, period: Math.round(Number(s.n)) };

const toRule = (r: RuleDraft): Rule => ({
  left: toSource(r.left),
  op: r.op,
  right: toSource(r.right),
});

export function customParams(d: CustomDraft): CustomParams {
  return {
    side: d.side,
    entry: d.entry.map(toRule),
    exit: d.exit.map(toRule),
    stopLoss: Number(d.stopLoss) / 100,
    takeProfit: Number(d.takeProfit) / 100,
    size: Number(d.size) / 100,
  };
}

const sourceOk = (s: SourceDraft) => {
  if (s.kind === "price") return true;
  const n = Number(s.n);
  if (s.kind === "value") return s.n.trim() !== "" && Number.isFinite(n);
  return Number.isInteger(n) && n >= 2 && n <= 500;
};

/** What to fix before it can run, by field. */
export function customProblems(d: CustomDraft): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  if (d.entry.length === 0) out.entry = t("bots.problem.entry");
  const rules = [...d.entry, ...d.exit];
  if (rules.some((r) => !sourceOk(r.left) || !sourceOk(r.right)))
    out.rules = t("bots.problem.ruleNumbers");
  if (rules.some((r) => r.left.kind === "value" && r.right.kind === "value"))
    out.rules = t("bots.problem.twoValues");
  const stop = Number(d.stopLoss);
  if (!(stop >= 0 && stop <= 50)) out.stopLoss = t("bots.problem.stopLoss");
  const target = Number(d.takeProfit);
  if (!(target >= 0 && target <= 500)) out.takeProfit = t("bots.problem.takeProfit");
  const size = Number(d.size);
  if (!(size >= 1 && size <= 500)) out.size = t("bots.problem.size");
  return out;
}

/** "EMA 20", "Price", "30". */
export function sourceText(s: Source): string {
  if (s.kind === "value") return formatNumber(s.value, Number.isInteger(s.value) ? 0 : 2);
  if (s.kind === "price") return t("bots.src.price");
  return t(`bots.src.${s.kind}N`, { period: s.period });
}

/** "EMA 20 crosses above EMA 50". */
export function ruleText(r: Rule): string {
  return t("bots.ruleText", {
    left: sourceText(r.left),
    op: t(OP_LABEL[r.op]),
    right: sourceText(r.right),
  });
}

interface CustomFormProps {
  draft: CustomDraft;
  problems: Partial<Record<string, string>>;
  onChange: (draft: CustomDraft) => void;
}

/** The custom bot's rules: when to get in (all of them), when to get out (any), and the exits. */
export function CustomForm({ draft, problems, onChange }: CustomFormProps) {
  const set = (patch: Partial<CustomDraft>) => onChange({ ...draft, ...patch });
  const list = (which: "entry" | "exit") => {
    const rules = draft[which];
    const put = (next: RuleDraft[]) => set({ [which]: next });
    return (
      <>
        <h3 className="bt-h3-row">
          {t(which === "entry" ? "bots.custom.entry" : "bots.custom.exit")}
          <button
            type="button"
            className="bt-link"
            onClick={() =>
              put([
                ...rules,
                rule({ kind: "rsi", n: "14" }, which === "entry" ? "below" : "above", {
                  kind: "value",
                  n: which === "entry" ? "30" : "70",
                }),
              ])
            }
          >
            <LuPlus size={12} aria-hidden />
            {t("bots.custom.addRule")}
          </button>
        </h3>
        <p className="bt-hint">
          {t(which === "entry" ? "bots.custom.entryHint" : "bots.custom.exitHint")}
        </p>
        {rules.length === 0 && (
          <p className="bt-rule-none">
            {t(which === "entry" ? "bots.custom.noEntry" : "bots.custom.noExit")}
          </p>
        )}
        <ol className="bt-rules">
          {rules.map((r, i) => (
            <li key={r.id} className="bt-rule">
              <span className="bt-rule-join">
                {i === 0
                  ? t("bots.custom.if")
                  : t(which === "entry" ? "bots.custom.and" : "bots.custom.or")}
              </span>
              <RuleEditor
                rule={r}
                onChange={(next) => put(rules.map((x) => (x.id === r.id ? next : x)))}
              />
              <button
                type="button"
                className="pd-icon-button bt-rule-remove"
                aria-label={t("bots.custom.removeRule")}
                title={t("bots.custom.removeRule")}
                onClick={() => put(rules.filter((x) => x.id !== r.id))}
              >
                <LuX size={13} aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      </>
    );
  };
  const percent = (key: "stopLoss" | "takeProfit" | "size", label: string, hint: string) => (
    <label className="bt-field" data-error={problems[key] ? "" : undefined}>
      <span>{label}</span>
      <span className="bt-input">
        <input
          className="pd-num"
          inputMode="decimal"
          value={draft[key]}
          onChange={(e) => set({ [key]: e.target.value.replace(",", ".") })}
        />
        <em>%</em>
      </span>
      <small className="bt-field-hint">{hint}</small>
    </label>
  );
  return (
    <>
      <h3>{t("bots.custom.side")}</h3>
      <span className="bt-seg" role="radiogroup" aria-label={t("bots.custom.side")}>
        {(["long", "short"] as const).map((side) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
          <button
            key={side}
            type="button"
            role="radio"
            aria-checked={draft.side === side}
            onClick={() => set({ side })}
          >
            {t(side === "long" ? "side.long" : "side.short")}
          </button>
        ))}
      </span>
      {list("entry")}
      {list("exit")}
      <h3>{t("bots.custom.risk")}</h3>
      <div className="bt-fields">
        {percent("stopLoss", t("bots.custom.stopLoss"), t("bots.custom.zeroNone"))}
        {percent("takeProfit", t("bots.custom.takeProfit"), t("bots.custom.zeroNone"))}
        {percent("size", t("bots.custom.size"), t("bots.custom.sizeHint"))}
      </div>
      {Object.values(problems).map((p) => (
        <p key={p} className="bt-error">
          {p}
        </p>
      ))}
    </>
  );
}

function RuleEditor({ rule: r, onChange }: { rule: RuleDraft; onChange: (r: RuleDraft) => void }) {
  return (
    <div className="bt-rule-body">
      <SourceEditor
        label={t("bots.custom.left")}
        source={r.left}
        onChange={(left) => onChange({ ...r, left })}
      />
      <Select
        className="bt-rule-op"
        label={t("bots.custom.op")}
        value={r.op}
        options={OPS.map((op) => ({ value: op, label: t(OP_LABEL[op]) }))}
        onChange={(op) => onChange({ ...r, op: op as Compare })}
      />
      <SourceEditor
        label={t("bots.custom.right")}
        source={r.right}
        onChange={(right) => onChange({ ...r, right })}
      />
    </div>
  );
}

function SourceEditor({
  label,
  source,
  onChange,
}: {
  label: string;
  source: SourceDraft;
  onChange: (s: SourceDraft) => void;
}) {
  return (
    <span className="bt-source">
      <Select
        label={label}
        value={source.kind}
        options={SOURCES.map((k) => ({ value: k, label: t(SOURCE_LABEL[k]) }))}
        onChange={(k) => onChange({ kind: k as SourceKind, n: START[k as SourceKind] })}
      />
      {source.kind !== "price" && (
        <span className="bt-input bt-input-small">
          <input
            className="pd-num"
            inputMode="decimal"
            aria-label={
              source.kind === "value" ? t("bots.custom.valueLabel") : t("bots.custom.periodLabel")
            }
            value={source.n}
            onChange={(e) => onChange({ ...source, n: e.target.value.replace(",", ".") })}
          />
        </span>
      )}
    </span>
  );
}
