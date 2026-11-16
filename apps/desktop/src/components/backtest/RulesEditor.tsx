import type { Cond, Match, PositionSide, Rule, Source } from "@pewterdesk/core";
import { type MessageKey, t } from "@pewterdesk/ui";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { LuEllipsis, LuGripVertical, LuPlus } from "react-icons/lu";
import {
  type Category,
  FRAMES,
  isChange,
  isGroup,
  OPS,
  presetsFor,
  rulesOf,
  SOURCE_KINDS,
  sourceOf,
  valueUnit,
} from "../../lib/rules";
import { condText, opText, rightText, ruleText, sourceName, sourceNote } from "./ruleText";

/** A small panel that opens under its button and closes on a click outside. */
function Pop({
  label,
  className,
  children,
  wide,
}: {
  label: ReactNode;
  className?: string;
  children: (close: () => void) => ReactNode;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span className="lab-pop-root" ref={ref}>
      <button
        type="button"
        className={className}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div className={`lab-pop${wide ? " wide" : ""}`} role="dialog">
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}

/** A number typed in place; kept as text while it's typed. */
function Num({
  value,
  onChange,
  label,
  unit,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  unit?: string;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  const was = useRef(value);
  if (was.current !== value) {
    was.current = value;
    if (Number(text) !== value) setText(String(value));
  }
  return (
    <label className="lab-pop-field">
      <span>{label}</span>
      <span className="lab-input">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
          }}
        />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

/** Picks what a side of a rule reads, and its settings. */
function SourceChip({
  source,
  onChange,
  allowValue,
}: {
  source: Source;
  onChange: (s: Source) => void;
  allowValue: boolean;
}) {
  const note = sourceNote(source);
  return (
    <Pop
      className="lab-chip-src"
      label={
        <>
          {sourceName(source)}
          {note && <small>{note}</small>}
        </>
      }
    >
      {() => (
        <div className="lab-pop-body">
          <div className="lab-pop-list">
            {SOURCE_KINDS.filter((k) => allowValue || k !== "value").map((k) => (
              <button
                key={k}
                type="button"
                className={source.kind === k ? "on" : undefined}
                onClick={() => onChange(sourceOf(k, source))}
              >
                {t(`bt.srcKind.${k}`)}
              </button>
            ))}
          </div>
          {"period" in source && (
            <Num
              label={t("bt.cond.period")}
              value={source.period}
              unit={t("bt.unit.candles")}
              onChange={(v) => onChange({ ...source, period: Math.max(1, Math.round(v)) })}
            />
          )}
          {(source.kind === "ema" || source.kind === "sma" || source.kind === "rsi") && (
            <div className="lab-pop-field">
              <span>{t("bt.cond.on")}</span>
              <span className="lab-seg">
                <button
                  type="button"
                  className={!source.on ? "on" : undefined}
                  onClick={() => onChange({ kind: source.kind, period: source.period })}
                >
                  {t("bt.cond.theseCandles")}
                </button>
                {FRAMES.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={source.on === f ? "on" : undefined}
                    onClick={() => onChange({ ...source, on: f })}
                  >
                    {f}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
    </Pop>
  );
}

/** The right-hand side: a number in the rule's unit, or another source. */
function RightChip({ rule, onChange }: { rule: Rule; onChange: (r: Rule) => void }) {
  const unit = valueUnit(rule);
  const change = isChange(rule.op);
  if (rule.right.kind !== "value" && !change) {
    return (
      <SourceChip
        source={rule.right}
        allowValue
        onChange={(right) => onChange({ ...rule, right })}
      />
    );
  }
  const v = rule.right.kind === "value" ? rule.right.value : 0;
  const shown = unit === "pct" ? Number((v * 100).toFixed(6)) : v;
  return (
    <Pop className="lab-chip-val" label={rightText(rule)}>
      {() => (
        <div className="lab-pop-body">
          <Num
            label={change ? t("bt.cond.byMore") : t("bt.cond.value")}
            value={shown}
            step={unit === "pct" ? 0.01 : undefined}
            unit={unit === "pct" ? "%" : unit === "hours" ? t("bt.unit.hours") : undefined}
            onChange={(n) =>
              onChange({ ...rule, right: { kind: "value", value: unit === "pct" ? n / 100 : n } })
            }
          />
          {change && (
            <Num
              label={t("bt.cond.within")}
              value={rule.hours ?? 24}
              unit={t("bt.unit.hours")}
              onChange={(hours) => onChange({ ...rule, hours: Math.max(1, hours) })}
            />
          )}
          {!change && (
            <div className="lab-pop-list">
              {SOURCE_KINDS.filter((k) => k !== "value" && k !== "heldHours").map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => onChange({ ...rule, right: sourceOf(k) })}
                >
                  {t(`bt.srcKind.${k}`)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Pop>
  );
}

function OpChip({ rule, onChange }: { rule: Rule; onChange: (r: Rule) => void }) {
  return (
    <Pop className="lab-chip-op" label={opText(rule)}>
      {(close) => (
        <div className="lab-pop-list col">
          {OPS.map((op) => (
            <button
              key={op}
              type="button"
              className={rule.op === op ? "on" : undefined}
              onClick={() => {
                const next: Rule = { ...rule, op };
                // A rise or fall compares with a share; a crossing with a value or a line.
                if (isChange(op) && rule.right.kind !== "value")
                  next.right = { kind: "value", value: 0.05 };
                if (isChange(op)) next.hours = rule.hours ?? 24;
                else delete next.hours;
                onChange(next);
                close();
              }}
            >
              {t(`bt.op.${op}`)}
            </button>
          ))}
        </div>
      )}
    </Pop>
  );
}

function RowMenu({ items }: { items: { label: string; run: () => void }[] }) {
  return (
    <Pop className="lab-row-menu" label={<LuEllipsis size={14} aria-label={t("bt.cond.more")} />}>
      {(close) => (
        <div className="lab-pop-list col right">
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              onClick={() => {
                i.run();
                close();
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </Pop>
  );
}

function RuleRow({
  rule,
  count,
  onChange,
  menu,
  drag,
}: {
  rule: Rule;
  count?: string;
  onChange: (r: Rule) => void;
  menu: { label: string; run: () => void }[];
  drag?: {
    onDragStart: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: () => void;
  };
}) {
  return (
    <fieldset
      className="lab-cond"
      aria-label={ruleText(rule)}
      draggable={drag !== undefined}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      title={ruleText(rule)}
    >
      <span className="lab-grip" aria-hidden>
        <LuGripVertical size={13} />
      </span>
      <SourceChip
        source={rule.left}
        allowValue={false}
        onChange={(left) => onChange({ ...rule, left })}
      />
      <OpChip rule={rule} onChange={onChange} />
      <RightChip rule={rule} onChange={onChange} />
      <span className="lab-cond-count">{count}</span>
      <RowMenu items={menu} />
    </fieldset>
  );
}

function MatchSeg({ value, onChange }: { value: Match; onChange: (m: Match) => void }) {
  return (
    <span className="lab-match">
      {(["all", "any"] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={value === m}
          className={value === m ? "on" : undefined}
          onClick={() => onChange(m)}
        >
          {t(`bt.match.${m}`)}
        </button>
      ))}
    </span>
  );
}

const newRule = (): Rule => ({
  left: { kind: "rsi", period: 14 },
  op: "below",
  right: { kind: "value", value: 60 },
});

/**
 * One side of a rules strategy: conditions as blocks (each a source, a
 * comparison and a value or another source), a group of them, and the
 * conditions to start from; or the same read as text.
 */
export function RulesEditor({
  kind,
  conds,
  match,
  onChange,
  side,
  counts,
  view,
}: {
  kind: "entry" | "exit";
  conds: readonly Cond[];
  match: Match;
  onChange: (conds: Cond[], match: Match) => void;
  side: PositionSide;
  /** Per top-level condition: what the last preview counted. */
  counts?: readonly (string | undefined)[];
  view: "blocks" | "text";
}) {
  const [dragging, setDragging] = useState<number>();
  const set = (next: Cond[]) => onChange(next, match);
  const replace = (i: number, c: Cond | undefined) =>
    set(conds.flatMap((x, k) => (k === i ? (c ? [c] : []) : [x])));
  const presets = presetsFor(kind === "exit");
  const total = [...presets.values()].reduce((a, l) => a + l.length, 0);

  if (view === "text") {
    return (
      <div className="lab-rules-box">
        <p className="lab-sentence lab-rules-text">
          {kind === "entry"
            ? t("bt.rules.goWhen", { side: t(`bt.dir.${side}`) })
            : t("bt.rules.closeWhen")}{" "}
          <b>{t(`bt.match.${match}`)}</b> {t("bt.rules.ofThese")}:
        </p>
        <ol className="lab-rules-list">
          {conds.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids; order is the identity
            <li key={i}>{condText(c)}</li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="lab-rules-box">
      <div className="lab-rules-head">
        {kind === "entry"
          ? t("bt.rules.goWhen", { side: t(`bt.dir.${side}`) })
          : t("bt.rules.closeWhen")}
        <MatchSeg value={match} onChange={(m) => onChange([...conds], m)} />
        {t("bt.rules.ofThese")}
      </div>
      {conds.map((c, i) => {
        const drag = {
          onDragStart: () => setDragging(i),
          onDragOver: (e: DragEvent) => e.preventDefault(),
          onDrop: () => {
            if (dragging === undefined || dragging === i) return;
            const next = [...conds];
            const [moved] = next.splice(dragging, 1);
            if (moved) next.splice(i, 0, moved);
            setDragging(undefined);
            set(next);
          },
        };
        if (!isGroup(c)) {
          return (
            <RuleRow
              // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids; order is the identity
              key={i}
              rule={c}
              count={counts?.[i]}
              drag={drag}
              onChange={(r) => replace(i, r)}
              menu={[
                { label: t("bt.cond.duplicate"), run: () => set([...conds, c]) },
                {
                  label: t("bt.cond.toGroup"),
                  run: () => replace(i, { match: "any", conds: [c] }),
                },
                { label: t("bt.cond.remove"), run: () => replace(i, undefined) },
              ]}
            />
          );
        }
        return (
          <fieldset
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids; order is the identity
            key={i}
            className="lab-group"
            aria-label={condText(c)}
            onDragOver={drag.onDragOver}
            onDrop={drag.onDrop}
          >
            <div className="lab-group-head">
              {match === "all" ? t("bt.say.and") : t("bt.say.or")}
              <MatchSeg value={c.match} onChange={(m) => replace(i, { ...c, match: m })} />
              {t("bt.rules.of")}
              <span className="lab-cond-count">{counts?.[i]}</span>
              <RowMenu
                items={[
                  {
                    label: t("bt.cond.add"),
                    run: () => replace(i, { ...c, conds: [...c.conds, newRule()] }),
                  },
                  {
                    label: t("bt.cond.ungroup"),
                    run: () => set(conds.flatMap((x, k) => (k === i ? rulesOf(c) : [x]))),
                  },
                  { label: t("bt.cond.removeGroup"), run: () => replace(i, undefined) },
                ]}
              />
            </div>
            {c.conds.map((r, j) => (
              <RuleRow
                // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids; order is the identity
                key={j}
                rule={r}
                onChange={(next) =>
                  replace(i, { ...c, conds: c.conds.map((x, k) => (k === j ? next : x)) })
                }
                menu={[
                  {
                    label: t("bt.cond.remove"),
                    run: () => {
                      const rest = c.conds.filter((_, k) => k !== j);
                      replace(i, rest.length ? { ...c, conds: rest } : undefined);
                    },
                  },
                ]}
              />
            ))}
          </fieldset>
        );
      })}
      <div className="lab-rules-add">
        <button
          type="button"
          className="lab-add-btn primary"
          onClick={() => set([...conds, newRule()])}
        >
          <LuPlus size={13} aria-hidden /> {t("bt.cond.condition")}
        </button>
        <button
          type="button"
          className="lab-add-btn"
          onClick={() => set([...conds, { match: "any", conds: [newRule()] }])}
        >
          <LuPlus size={13} aria-hidden /> {t("bt.cond.group")}
        </button>
        <span className="lab-dim lab-rules-fill">
          {kind === "entry" ? t("bt.rules.fillEntry") : t("bt.rules.fillExit")}
        </span>
      </div>
      <div className="lab-pick-chips">
        <span className="lab-dim">{t("bt.rules.toPick", { n: total })}</span>
        {[...presets.entries()].map(([cat, list]) => (
          <Pop
            key={cat}
            wide
            className={`lab-preset-chip${cat === "derivatives" ? " brass" : ""}`}
            label={
              <>
                {t(`bt.cat.${cat as Category}`)} {list.length}
                {cat === "derivatives" && (
                  <span className="lab-preset-hint"> · {t("bt.cat.derivativesHint")}</span>
                )}
              </>
            }
          >
            {(close) => (
              <div className="lab-pop-list col">
                {list.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      set([...conds, p.rule]);
                      close();
                    }}
                  >
                    <b>{t(`bt.preset.${p.key}` as MessageKey)}</b>
                    <small>{ruleText(p.rule)}</small>
                  </button>
                ))}
              </div>
            )}
          </Pop>
        ))}
      </div>
    </div>
  );
}
