import { dateFormat, Switch, t } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import {
  LuBookOpen,
  LuCopyPlus,
  LuGripVertical,
  LuPencil,
  LuPlus,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import {
  type Direction,
  newId,
  newPlaybook,
  type Playbook,
  skippedItems,
  type TradeNote,
} from "../../lib/journal";
import {
  avgR,
  byPlaybook,
  cumulativeR,
  emptyGroup,
  followedVsSkipped,
  groupOf,
  winRate,
} from "../../lib/journalStats";
import { MarketPicker } from "./MarketPicker";
import type { PlanContext } from "./PlanPage";
import {
  ActionBar,
  Bar,
  Blank,
  Card,
  ChipGroup,
  Compare,
  ConfirmButton,
  CumulativeChart,
  CurveLegend,
  distinctHues,
  Field,
  FormSection,
  formatR,
  groupLine,
  hueOf,
  Kpis,
  LinesEditor,
  marketsLine,
  NumberInput,
  PageHead,
  Pill,
  pct,
  RText,
  SECTION_HUES,
  Segment,
  Sparkline,
  SpreadText,
  Stat,
  StatusPill,
  TextArea,
  TIMEFRAMES,
  tagHue,
  timeframeHue,
  timeframesOf,
  useKept,
} from "./parts";

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
const DIRECTIONS: readonly Direction[] = ["long", "short", "both"];

/**
 * The trader's playbooks: where the R came from across them, then each one's
 * card - its record from the journal, its rules, and its curve.
 */
export function PlaybooksView({ ctx }: { ctx: PlanContext }) {
  const [editing, setEditing] = useKept<{ id: string; draft: Playbook } | undefined>(
    `plan.pbEdit:${ctx.accountKey}`,
    undefined,
  );
  const ids = [...ctx.playbooks.keys()];
  const hues = useMemo(() => distinctHues([...ctx.playbooks.keys()]), [ctx.playbooks]);
  const [picked, setPicked] = useKept<string | undefined>(
    `plan.pbPicked:${ctx.accountKey}`,
    ids[0],
  );
  const notes = useMemo(() => ctx.trades.map((x) => x.note), [ctx.trades]);
  const stats = useMemo(() => byPlaybook(notes), [notes]);

  if (editing)
    return (
      <PlaybookEditor
        ctx={ctx}
        id={editing.id}
        draft={editing.draft}
        onDraft={(draft) => setEditing({ ...editing, draft })}
        onDone={(saved) => {
          setEditing(undefined);
          if (saved) setPicked(editing.id);
        }}
      />
    );

  const startNew = () => setEditing({ id: newId(), draft: newPlaybook() });
  const inPlan = new Set(ctx.plan?.playbookIds ?? []);
  const none = stats.get("");
  const current = picked && ctx.playbooks.has(picked) ? picked : ids[0];
  const selected = current ? ctx.playbooks.get(current) : undefined;
  const maxR = Math.max(1, ...[...stats.values()].map((s) => Math.abs(s.group.totalR)));
  const split = followedVsSkipped(notes.filter((n) => n.playbookId));
  const newButton = (
    <button type="button" className="jr-button jr-primary" onClick={startNew}>
      <LuPlus size={13} aria-hidden /> {t("plan.pb.new")}
    </button>
  );

  if (ids.length === 0)
    return (
      <div className="jr-view">
        <PageHead eyebrow={t("plan.tab.playbooks")} title={t("plan.pb.yours")} />
        <Card className="jr-fill">
          <Blank
            icon={<LuBookOpen size={22} aria-hidden />}
            title={t("plan.pb.emptyTitle")}
            action={newButton}
          >
            {t("plan.pb.none")}
          </Blank>
        </Card>
      </div>
    );

  return (
    <div className="jr-view">
      <PageHead
        eyebrow={t("plan.tab.playbooks")}
        title={t("plan.pb.yours")}
        meta={<span>{t("plan.pb.rIs")}</span>}
        actions={newButton}
      />

      {notes.length > 0 && (
        <Card title={t("plan.pb.across")} sub={t("plan.tradesN", { n: notes.length })}>
          <div className="jr-two">
            <div>
              <span className="jr-label">{t("plan.pb.whereR")}</span>
              <ul className="jr-barlist">
                {[...stats.entries()].map(([id, s]) => (
                  <li key={id || "none"}>
                    <span>
                      {id
                        ? (ctx.playbooks.get(id)?.name ?? t("plan.pb.deleted"))
                        : t("plan.pb.noneLabel")}
                    </span>
                    <Bar value={s.group.totalR} max={maxR} />
                    <RText r={s.group.withR ? s.group.totalR : undefined} digits={1} />
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <span className="jr-label">{t("plan.pb.didMatter")}</span>
              <Compare
                items={[
                  {
                    label: t("plan.pb.followedN", { n: split.followed.trades }),
                    value: <RText r={avgR(split.followed)} />,
                    note: groupLine(split.followed),
                  },
                  {
                    label: t("plan.pb.skippedN", { n: split.skipped.trades }),
                    value: <RText r={avgR(split.skipped)} />,
                    note: groupLine(split.skipped),
                  },
                ]}
              />
              <p className="jr-hint">{t("plan.pb.patternNote")}</p>
            </div>
          </div>
        </Card>
      )}

      <div className="jr-master">
        <div className="jr-pblist" role="listbox" aria-label={t("plan.pb.yours")}>
          {ids.map((id) => {
            const p = ctx.playbooks.get(id) as Playbook;
            const s = stats.get(id);
            const g = s?.group ?? emptyGroup();
            const followed = g.trades ? (s?.followed ?? 0) / g.trades : undefined;
            const mine = notes.filter((n) => n.playbookId === id);
            return (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={id === current}
                className="jr-pbitem"
                style={hueOf(hues.get(id) ?? tagHue(id))}
                data-retired={p.status === "retired" || undefined}
                onClick={() => setPicked(id)}
              >
                <span className="jr-pbitem-head">
                  <strong>{p.name || t("plan.playbook.untitled")}</strong>
                  {inPlan.has(id) ? (
                    <Pill tone="strong">{t("plan.pb.inPlan")}</Pill>
                  ) : (
                    <StatusPill status={p.status} />
                  )}
                </span>
                <span className="jr-pbitem-sub">
                  {[
                    t(`plan.dir.${p.direction}` as const),
                    marketsLine(p.markets, ctx.markets, ctx.symbolFor, 3),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="jr-pbitem-tfs">
                  {timeframesOf(p.timeframe).map((tf) => (
                    <span key={tf} className="jr-tag" style={hueOf(timeframeHue(tf))}>
                      {tf}
                    </span>
                  ))}
                </span>
                <span className="jr-pbitem-figures">
                  <span>
                    <span className="jr-label">{t("plan.trades")}</span>
                    <span className="pd-num">{g.trades || "-"}</span>
                  </span>
                  <span>
                    <span className="jr-label">{t("plan.win")}</span>
                    <span className="pd-num">{g.trades ? pct(winRate(g)) : "-"}</span>
                  </span>
                  <span>
                    <span className="jr-label">{t("plan.avgR")}</span>
                    <RText r={avgR(g)} />
                  </span>
                  <span>
                    <span className="jr-label">{t("plan.checklist")}</span>
                    <span
                      className="pd-num"
                      data-tone={followed !== undefined && followed < 0.75 ? "warn" : undefined}
                    >
                      {followed === undefined ? "-" : pct(followed)}
                    </span>
                  </span>
                  <Sparkline points={cumulativeR(mine)} />
                </span>
              </button>
            );
          })}
          {none && (
            <p className="jr-hint">
              {t("plan.pb.noPlaybook", {
                n: none.group.trades,
                r: formatR(none.group.withR ? none.group.totalR : undefined),
              })}
            </p>
          )}
          <p className="jr-hint">{t("plan.pb.checklistFoot")}</p>
        </div>

        {selected && current && (
          <PlaybookCard
            ctx={ctx}
            id={current}
            hue={hues.get(current) ?? tagHue(current)}
            playbook={selected}
            notes={notes.filter((n) => n.playbookId === current)}
            onEdit={() => setEditing({ id: current, draft: selected })}
            onDuplicate={() =>
              setEditing({
                id: newId(),
                draft: {
                  ...selected,
                  name: t("plan.pb.copyOf", { name: selected.name }),
                  version: 1,
                  versions: [],
                  status: "draft",
                },
              })
            }
          />
        )}
      </div>
    </div>
  );
}

function PlaybookCard({
  ctx,
  id,
  hue,
  playbook: p,
  notes,
  onEdit,
  onDuplicate,
}: {
  ctx: PlanContext;
  id: string;
  /** The playbook's own hue, the one its list card has. */
  hue: number;
  playbook: Playbook;
  notes: TradeNote[];
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  const g = groupOf(notes);
  const curve = cumulativeR(notes);
  const followed = groupOf(notes.filter((n) => skippedItems(n) === 0));
  const skipped = groupOf(notes.filter((n) => skippedItems(n) > 0));
  const rs = curve.map((c, i) => c.r - (curve[i - 1]?.r ?? 0));
  const required = p.checklist.filter((c) => c.required).length;
  return (
    <section className="jr-card jr-pbdetail" style={hueOf(hue)}>
      <header className="jr-pbdetail-head">
        <div>
          <span className="jr-eyebrow">
            {ctx.plan?.playbookIds.includes(id)
              ? t("plan.pb.inPlan")
              : t(`plan.pb.status.${p.status}` as const)}{" "}
            · v{p.version}
          </span>
          <h3>{p.name || t("plan.playbook.untitled")}</h3>
        </div>
        <div className="jr-head-actions">
          <button type="button" className="jr-button jr-quiet" onClick={onDuplicate}>
            <LuCopyPlus size={13} aria-hidden /> {t("plan.duplicate")}
          </button>
          <button type="button" className="jr-button" onClick={onEdit}>
            <LuPencil size={13} aria-hidden /> {t("plan.edit")}
          </button>
        </div>
      </header>

      {p.thesis.trim() && (
        <SpreadText label={t("plan.pb.thesis")} hue={SECTION_HUES.basics} text={p.thesis} />
      )}

      <Kpis className="jr-kpis-inset">
        <Stat label={t("plan.trades")} value={g.trades} />
        <Stat label={t("plan.winRate")} value={g.trades ? pct(winRate(g)) : "-"} />
        <Stat label={t("plan.avgR")} value={<RText r={avgR(g)} />} />
        <Stat
          label={t("plan.total")}
          value={<RText r={g.withR ? g.totalR : undefined} digits={1} />}
        />
        <Stat
          label={t("plan.pb.bestWorst")}
          value={
            rs.length ? (
              <span className="jr-bestworst">
                <RText r={Math.max(...rs)} digits={1} />
                <RText r={Math.min(...rs)} digits={1} />
              </span>
            ) : (
              "-"
            )
          }
        />
      </Kpis>

      <div className="jr-pbdetail-body">
        <div className="jr-pbdetail-chart">
          <div className="jr-chart-head">
            <span className="jr-label">{t("plan.pb.cumulative", { n: notes.length })}</span>
            <CurveLegend />
          </div>
          <CumulativeChart points={curve} height={190} width={480} />
          <Compare
            items={[
              {
                label: t("plan.pb.followedN", { n: followed.trades }),
                value: <RText r={avgR(followed)} />,
                note: followed.trades ? t("plan.winPct", { v: pct(winRate(followed)) }) : undefined,
              },
              {
                label: t("plan.pb.skippedN", { n: skipped.trades }),
                value: <RText r={avgR(skipped)} />,
                note: skipped.trades ? t("plan.winPct", { v: pct(winRate(skipped)) }) : undefined,
              },
            ]}
          />
          {notes.length > 0 && notes.length < 30 && (
            <p className="jr-hint">{t("plan.pb.smallSample")}</p>
          )}
        </div>

        <dl className="jr-spec">
          <div>
            <dt style={hueOf(SECTION_HUES.context)}>{t("plan.pb.context")}</dt>
            <dd>
              {p.context.length ? (
                <ul className="jr-ticks">
                  {p.context.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : (
                "-"
              )}
            </dd>
          </div>
          <div>
            <dt style={hueOf(SECTION_HUES.trigger)}>{t("plan.pb.trigger")}</dt>
            <dd>{p.trigger || "-"}</dd>
          </div>
          <div>
            <dt style={hueOf(SECTION_HUES.invalidIf)}>{t("plan.pb.invalidIf")}</dt>
            <dd>{p.invalidIf || "-"}</dd>
          </div>
          <div>
            <dt style={hueOf(SECTION_HUES.risk)}>{t("plan.pb.risk")}</dt>
            <dd>
              {[
                p.stop && t("plan.pb.stopIs", { v: p.stop }),
                p.target && t("plan.pb.targetIs", { v: p.target }),
                `${p.riskPct}%`,
                p.minRR ? `≥ ${p.minRR} : 1` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
          <div>
            <dt style={hueOf(SECTION_HUES.checklist)}>
              {t("plan.checklist")}{" "}
              <span className="jr-muted">
                {t("plan.pb.items", { n: p.checklist.length, required })}
              </span>
            </dt>
            <dd>
              <ul className="jr-ticks">
                {p.checklist.map((c) => (
                  <li key={c.id} data-optional={!c.required || undefined}>
                    {c.text}
                    {!c.required && <span className="jr-muted"> · {t("plan.optional")}</span>}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
          {p.management.length > 0 && (
            <div>
              <dt style={hueOf(SECTION_HUES.management)}>{t("plan.pb.management")}</dt>
              <dd>
                <ul className="jr-ticks">
                  {p.management.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      </div>
    </section>
  );
}

function PlaybookEditor({
  ctx,
  id,
  draft,
  onDraft,
  onDone,
}: {
  ctx: PlanContext;
  id: string;
  draft: Playbook;
  onDraft: (p: Playbook) => void;
  onDone: (saved: boolean) => void;
}) {
  const stored = ctx.playbooks.get(id);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof Playbook>(key: K, value: Playbook[K]) =>
    onDraft({ ...draft, [key]: value });
  const changed = JSON.stringify(stored) !== JSON.stringify(draft);
  const used = ctx.trades.filter((x) => x.note.playbookId === id);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    const version = stored ? stored.version + 1 : 1;
    const next: Playbook = {
      ...draft,
      checklist: draft.checklist.filter((c) => c.text.trim()),
      version,
      versions: [
        ...draft.versions,
        {
          version,
          at: Date.now(),
          note: note.trim() || (stored ? t("plan.plan.edited") : t("plan.pb.firstVersion")),
        },
      ],
    };
    try {
      await ctx.journal.savePlaybook(id, next);
      onDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await ctx.journal.removePlaybook(id);
      onDone(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="jr-view jr-editor">
      <PageHead
        back={{ label: t("plan.tab.playbooks"), onClick: () => onDone(false) }}
        title={draft.name || t("plan.pb.new")}
        meta={
          <>
            <StatusPill status={draft.status} />
            <span>{t("plan.pb.editsApply")}</span>
          </>
        }
        actions={
          stored && (
            <ConfirmButton
              className="jr-button jr-danger"
              title={t("plan.confirm.playbookTitle", {
                name: draft.name || t("plan.playbook.untitled"),
              })}
              body={t("plan.confirm.playbookBody")}
              action={t("plan.delete")}
              danger
              onConfirm={() => void remove()}
            >
              <LuTrash2 size={13} aria-hidden /> {t("plan.delete")}
            </ConfirmButton>
          )
        }
      />
      {error && <p className="jr-error">{error}</p>}

      <div className="jr-split">
        <div className="jr-form">
          <FormSection hue={SECTION_HUES.basics} title={t("plan.plan.basics")}>
            <Field label={t("plan.name")}>
              <input
                className="pd-input"
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <Field label={t("plan.pb.thesis")}>
              <TextArea
                value={draft.thesis}
                rows={3}
                onChange={(v) => set("thesis", v)}
                placeholder={t("plan.pb.thesisPh")}
              />
            </Field>
            <div className="jr-fields-inline">
              <Field label={t("plan.pb.direction")}>
                <Segment
                  label={t("plan.pb.direction")}
                  value={draft.direction}
                  options={DIRECTIONS.map((d) => ({
                    value: d,
                    label: t(`plan.dir.${d}` as const),
                  }))}
                  onChange={(v) => set("direction", v)}
                />
              </Field>
              <Field label={t("col.status")}>
                <span className="jr-statusseg">
                  <Segment
                    label={t("col.status")}
                    value={draft.status}
                    options={(["draft", "active", "retired"] as const).map((s) => ({
                      value: s,
                      label: t(`plan.pb.status.${s}` as const),
                    }))}
                    onChange={(v) => set("status", v)}
                  />
                </span>
              </Field>
            </div>
            <Field label={t("plan.pb.timeframe")} hint={t("plan.pb.timeframesHint")}>
              <ChipGroup className="jr-chips" label={t("plan.pb.timeframe")}>
                {TIMEFRAMES.map((tf) => {
                  const on = timeframesOf(draft.timeframe).includes(tf);
                  return (
                    <button
                      key={tf}
                      type="button"
                      className="jr-chip jr-tfchip"
                      data-pick=""
                      style={hueOf(timeframeHue(tf))}
                      aria-pressed={on}
                      onClick={() => {
                        const now = timeframesOf(draft.timeframe);
                        const next = on ? now.filter((x) => x !== tf) : [...now, tf];
                        // At least one: the last one stays picked.
                        if (next.length) set("timeframe", timeframesOf(next.join(", ")).join(", "));
                      }}
                    >
                      {tf}
                    </button>
                  );
                })}
              </ChipGroup>
            </Field>
            <Field label={t("plan.plan.markets")}>
              <MarketPicker ctx={ctx} picked={draft.markets} onChange={(m) => set("markets", m)} />
            </Field>
          </FormSection>

          <FormSection
            hue={SECTION_HUES.context}
            title={t("plan.pb.setup")}
            hint={t("plan.pb.contextFoot")}
          >
            <Field hue={SECTION_HUES.context} label={t("plan.pb.context")}>
              <LinesEditor
                lines={draft.context}
                label={t("plan.pb.context")}
                placeholder={t("plan.pb.addCondition")}
                onChange={(v) => set("context", v)}
              />
            </Field>
            <Field hue={SECTION_HUES.trigger} label={t("plan.pb.trigger")}>
              <TextArea
                value={draft.trigger}
                onChange={(v) => set("trigger", v)}
                placeholder={t("plan.pb.triggerPh")}
                label={t("plan.pb.trigger")}
              />
            </Field>
            <Field hue={SECTION_HUES.invalidIf} label={t("plan.pb.invalidIf")}>
              <TextArea
                value={draft.invalidIf}
                onChange={(v) => set("invalidIf", v)}
                placeholder={t("plan.pb.invalidPh")}
                label={t("plan.pb.invalidIf")}
              />
            </Field>
            <Field label={t("plan.pb.cancelAfter")}>
              <NumberInput
                label={t("plan.pb.cancelAfter")}
                unit={t("plan.pb.candles")}
                min={0}
                max={1000}
                step={1}
                value={draft.cancelAfter}
                onChange={(v) => set("cancelAfter", v ?? 0)}
              />
            </Field>
          </FormSection>

          <FormSection hue={SECTION_HUES.checklist} title={t("plan.pb.checklistTitle")}>
            <div className="jr-lines">
              {draft.checklist.map((c, i) => (
                <div key={c.id} className="jr-check-row">
                  <LuGripVertical size={13} aria-hidden className="jr-muted" />
                  <input
                    className="pd-input"
                    value={c.text}
                    aria-label={t("plan.pb.itemN", { n: i + 1 })}
                    onChange={(e) =>
                      set(
                        "checklist",
                        draft.checklist.map((x) =>
                          x.id === c.id ? { ...x, text: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <span className="jr-check-req">
                    <Switch
                      checked={c.required}
                      label={t("plan.required")}
                      onChange={(required) =>
                        set(
                          "checklist",
                          draft.checklist.map((x) => (x.id === c.id ? { ...x, required } : x)),
                        )
                      }
                    />
                    <span className="jr-muted">
                      {c.required ? t("plan.required") : t("plan.optional")}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="jr-icon"
                    aria-label={t("plan.remove", { name: c.text || String(i + 1) })}
                    onClick={() =>
                      set(
                        "checklist",
                        draft.checklist.filter((x) => x.id !== c.id),
                      )
                    }
                  >
                    <LuX size={13} aria-hidden />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="jr-add"
                onClick={() =>
                  set("checklist", [
                    ...draft.checklist,
                    { id: newId().slice(0, 8), text: "", required: true },
                  ])
                }
              >
                <LuPlus size={12} aria-hidden /> {t("plan.pb.item")}
              </button>
            </div>
          </FormSection>

          <FormSection hue={SECTION_HUES.risk} title={t("plan.pb.riskTitle")}>
            <div className="jr-fields-2">
              <Field label={t("plan.pb.stop")}>
                <input
                  className="pd-input"
                  value={draft.stop}
                  placeholder={t("plan.pb.stopPh")}
                  onChange={(e) => set("stop", e.target.value)}
                />
              </Field>
              <Field label={t("plan.pb.target")}>
                <input
                  className="pd-input"
                  value={draft.target}
                  placeholder={t("plan.pb.targetPh")}
                  onChange={(e) => set("target", e.target.value)}
                />
              </Field>
              <Field
                label={t("plan.riskPerTrade")}
                hint={
                  ctx.plan && draft.riskPct > ctx.plan.riskPct ? (
                    <span className="jr-warn">
                      {t("plan.pb.planCaps", { v: ctx.plan.riskPct })}
                    </span>
                  ) : undefined
                }
              >
                <NumberInput
                  label={t("plan.riskPerTrade")}
                  unit="%"
                  min={0}
                  max={100}
                  value={draft.riskPct}
                  onChange={(v) => set("riskPct", v ?? 0)}
                />
              </Field>
              <Field label={t("plan.pb.minRR")}>
                <NumberInput
                  label={t("plan.pb.minRR")}
                  unit=": 1"
                  min={0}
                  max={100}
                  value={draft.minRR}
                  onChange={(v) => set("minRR", v ?? 0)}
                />
              </Field>
            </div>
            <Field label={t("plan.pb.management")}>
              <LinesEditor
                lines={draft.management}
                label={t("plan.pb.management")}
                placeholder={t("plan.pb.managementPh")}
                onChange={(v) => set("management", v)}
              />
            </Field>
          </FormSection>

          {stored && (
            <FormSection hue={SECTION_HUES.changes} title={t("plan.plan.whatChanged")}>
              <input
                className="pd-input"
                value={note}
                aria-label={t("plan.plan.whatChanged")}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("plan.plan.whatChangedPh")}
              />
            </FormSection>
          )}
        </div>

        <aside className="jr-rail jr-rail-sticky">
          <Card title={t("plan.pb.inTicket")} sub={t("plan.pb.preview")}>
            <div className="jr-ticket">
              <strong>{draft.name || t("plan.pb.new")}</strong>
              {draft.checklist.length === 0 ? (
                <p className="jr-muted">-</p>
              ) : (
                <ul className="jr-checks">
                  {draft.checklist.map((c) => (
                    <li key={c.id}>
                      <span className="jr-checkbox" aria-hidden />
                      <span>{c.text || <span className="jr-muted">…</span>}</span>
                      {!c.required && <span className="jr-muted">{t("plan.optional")}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
          <Card title={t("plan.pb.usedBy")}>
            {ctx.plan?.playbookIds.includes(id) ? (
              <p>
                {ctx.plan.name} ·{" "}
                <span className="jr-muted">{t("plan.pb.riskCap", { v: ctx.plan.riskPct })}</span>
              </p>
            ) : (
              <p className="jr-muted">{t("plan.pb.notInPlan")}</p>
            )}
            <p className="jr-muted">{t("plan.tradesN", { n: used.length })}</p>
          </Card>
          {stored && (
            <Card title={t("plan.pb.versions")}>
              <ol className="jr-timeline">
                <li data-current>
                  <span className="jr-timeline-head">
                    <strong>v{stored.version + 1}</strong>
                    <span className="jr-muted">{t("plan.pb.appliesNew")}</span>
                  </span>
                </li>
                {[...stored.versions].reverse().map((v) => (
                  <li key={v.version}>
                    <span className="jr-timeline-head">
                      <strong>v{v.version}</strong>
                      <span className="jr-muted">
                        {dateFormat(SHORT_DATE).format(v.at)} ·{" "}
                        {t("plan.tradesN", {
                          n: used.filter((x) => x.note.playbookVersion === v.version).length,
                        })}
                      </span>
                    </span>
                    {v.note && <p>{v.note}</p>}
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </aside>
      </div>

      <ActionBar note={changed ? t("plan.unsaved") : undefined}>
        <button type="button" className="jr-button" onClick={() => onDone(false)}>
          {t("plan.discard")}
        </button>
        <button
          type="button"
          className="jr-button jr-primary"
          disabled={busy || !draft.name.trim() || !changed}
          onClick={() => void save()}
        >
          {busy ? t("plan.saving") : t("plan.save")}
        </button>
      </ActionBar>
    </div>
  );
}
