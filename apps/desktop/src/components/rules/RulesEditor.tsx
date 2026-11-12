import { dateFormat, type MessageKey, Select, Switch, t } from "@pewterdesk/ui";
import { type ReactNode, useMemo, useState } from "react";
import { LuClock, LuLock, LuShieldCheck } from "react-icons/lu";
import {
  amounts,
  BREACH_ACTIONS,
  type BreachAction,
  type ChangeField,
  DAILY_FROM,
  HOUR_DAYS,
  hasTarget,
  MAX_KINDS,
  type MaxKind,
  nextUtcMidnight,
  PRESET_TERMS,
  PRESETS,
  type Preset,
  type RulesView,
  ruleChanges,
  type TradingRules,
  WARN_AT,
  withPreset,
} from "../../lib/tradingRules";
import { ChangeList, fieldLabel, fieldValue, InfoTip } from "./explain";
import { clockTime, money, NumberField, Segmented, span } from "./parts";

export const PRESET_NAME: Record<Preset, MessageKey> = {
  classic: "rules.preset.classic",
  oneStep: "rules.preset.oneStep",
  instant: "rules.preset.instant",
  own: "rules.preset.own",
};
const PRESET_DESC: Record<Preset, MessageKey> = {
  classic: "rules.preset.classicDesc",
  oneStep: "rules.preset.oneStepDesc",
  instant: "rules.preset.instantDesc",
  own: "rules.preset.ownDesc",
};
export const MAX_KIND_NAME: Record<MaxKind, MessageKey> = {
  static: "rules.maxKind.static",
  intraday: "rules.maxKind.intraday",
  eod: "rules.maxKind.eod",
};
/** As a preset's card puts it: "10% trailing". */
const MAX_KIND_SHORT: Record<MaxKind, MessageKey> = {
  static: "rules.maxShort.static",
  intraday: "rules.maxShort.intraday",
  eod: "rules.maxShort.eod",
};
/** The longest name a set of rules is kept under (Rust cuts it there too). */
const RULES_NAME_MAX = 40;

const BREACH_NAME: Record<BreachAction, MessageKey> = {
  warn: "rules.breach.warn",
  warnLock: "rules.breach.warnLock",
  lock: "rules.breach.lock",
};

/** A group of rows under a heading that says what they're for. */
function Group({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className="rules-group">
      <header className="rules-group-head">
        <h3>{title}</h3>
        <p>{desc}</p>
      </header>
      {children}
    </section>
  );
}

interface RowProps {
  label: string;
  /** The "?" beside the name. */
  help: MessageKey;
  /** Under the name: "per market". */
  sub?: string;
  /** The setting in a sentence, with its numbers. */
  says?: ReactNode;
  /** What's checked until a change starts, where this row differs from it. */
  inForce?: string;
  children: ReactNode;
}

/** One rule: its name and "?", its controls, and what it comes to in words. */
function Row({ label, help, sub, says, inForce, children }: RowProps) {
  return (
    <div className="rules-edit-row" data-changed={inForce !== undefined || undefined}>
      <div className="rules-edit-label">
        <span className="rules-edit-name">
          {label}
          <InfoTip label={label} help={help} />
        </span>
        {sub && <span className="rules-edit-sub">{sub}</span>}
      </div>
      <div className="rules-edit-main">
        <div className="rules-edit-controls">
          {children}
          {inForce !== undefined && (
            <span className="rules-in-force" title={t("rules.change.inForceTip")}>
              {t("rules.change.inForce", { value: inForce })}
            </span>
          )}
        </div>
        {says && <p className="rules-edit-says">{says}</p>}
      </div>
    </div>
  );
}

const Hint = ({ children }: { children: ReactNode }) => (
  <span className="rules-edit-hint">{children}</span>
);

/** "07:00" UTC as this machine's clock shows it today. */
function localClock(utc: string): string {
  const now = new Date();
  const at = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    Number(utc.slice(0, 2)),
    Number(utc.slice(3)),
  );
  return dateFormat({ hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}

interface RulesEditorProps {
  /** The account's rules in force, and any change waiting to apply. */
  view: RulesView;
  /** Whether they've been saved before; new ones start switched on. */
  saved: boolean;
  /** The account they're checked against, by its venue, and the venue's logo. */
  account: string;
  logo?: ReactNode;
  /** That account's equity, to start the account size from. */
  equity?: number;
  /** Saves them under a name; rejects with why not. */
  onSave: (name: string, on: boolean, rules: TradingRules) => Promise<void>;
  onCancel: () => void;
}

/**
 * Editing the rules: a preset to start from on the left, then the rules in
 * groups, each with a "?" that explains it and a sentence that spells out
 * what it comes to. A row that differs from the rules in force says what's
 * in force, and the foot says whether saving applies now or at 00:00 UTC
 * (Rust's `looser_than` decides; `ruleChanges` mirrors it to explain). A
 * change that's waiting for midnight is what's edited, so it isn't lost.
 */
export function RulesEditor({
  view,
  saved,
  account,
  logo,
  equity,
  onSave,
  onCancel,
}: RulesEditorProps) {
  const [draft, setDraft] = useState(view.pending?.rules ?? view.rules);
  const [name, setName] = useState(view.name);
  // New rules start switched on; saved ones keep their switch.
  const [on, setOn] = useState(view.pending?.on ?? (view.on || !saved));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string>();
  const save = async () => {
    setSaving(true);
    setFailed(undefined);
    try {
      await onSave(name, on, draft);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };
  const set = (change: Partial<TradingRules>) => setDraft({ ...draft, ...change });
  const { challenge, tilt } = draft;
  const setChallenge = (change: Partial<TradingRules["challenge"]>) =>
    set({ challenge: { ...challenge, ...change } });
  const usd = amounts(draft);

  // What's checked now, where rules are on: a save is measured against it.
  const inForceRules = saved && view.on ? view.rules : undefined;
  const changes = useMemo(
    () => (inForceRules ? ruleChanges(inForceRules, draft) : []),
    [inForceRules, draft],
  );
  const turnsOff = inForceRules !== undefined && !on;
  const waits = turnsOff || changes.some((c) => c.looser);
  const changed = new Set(changes.map((c) => c.field));
  const inForce = (field: ChangeField) =>
    inForceRules && changed.has(field) ? fieldValue(field, inForceRules) : undefined;
  const now = Date.now();
  const startsAt = nextUtcMidnight(now);

  const amount = (v: number) => money(v);
  const hoursLocal = {
    from: localClock(draft.hours.from),
    to: localClock(draft.hours.to),
  };
  const sameClock = hoursLocal.from === draft.hours.from && hoursLocal.to === draft.hours.to;

  return (
    <div className="page rules rules-editor">
      <aside className="rules-panel rules-presets">
        <header className="rules-presets-head">
          <h2>{t("rules.startPreset")}</h2>
          <p>{t("rules.startPresetHint")}</p>
        </header>
        <div className="rules-preset-list" role="radiogroup" aria-label={t("rules.startPreset")}>
          {PRESETS.map((preset) => {
            const terms = PRESET_TERMS[preset];
            const mine = preset === "own";
            const pct = (v: number) => (v > 0 ? `${v}%` : "–");
            return (
              // biome-ignore lint/a11y/useSemanticElements: a card-style choice, like the app's others
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={draft.preset === preset}
                className="rules-preset"
                onClick={() => setDraft(withPreset(draft, preset))}
              >
                <span className="rules-preset-head">
                  <strong>{t(PRESET_NAME[preset])}</strong>
                  {draft.preset === preset && (
                    <span className="rules-badge" data-tone="brass">
                      {t("rules.selected")}
                    </span>
                  )}
                </span>
                <span className="rules-preset-desc">{t(PRESET_DESC[preset])}</span>
                <span className="rules-preset-terms">
                  <span>{t("rules.targetShort")}</span>
                  <b>{pct(terms.targetPct)}</b>
                  <span>{t("rules.daily")}</span>
                  <b>{mine ? t("rules.youSet") : pct(terms.dailyPct)}</b>
                  <span>{t("rules.maxDD")}</span>
                  <b>
                    {mine
                      ? t("rules.youSet")
                      : `${terms.maxPct}% ${t(MAX_KIND_SHORT[terms.maxKind])}`}
                  </b>
                  <span>{t("rules.minDays")}</span>
                  <b>{terms.minDays > 0 ? terms.minDays : "–"}</b>
                </span>
              </button>
            );
          })}
        </div>
        <p className="rules-disclaimer">
          <strong>{t("rules.disclaimerLead")}</strong> {t("rules.disclaimer")}
        </p>
      </aside>

      <section className="rules-panel rules-form">
        <header className="rules-form-head">
          <h1>{t("rules.title", { preset: t(PRESET_NAME[draft.preset]) })}</h1>
          <span className="rules-on">
            {t("rules.label.on")}
            <InfoTip label={t("rules.label.on")} help="rules.help.on" />
            <Switch label={t("rules.on")} checked={on} onChange={setOn} />
          </span>
        </header>

        <div className="rules-form-body">
          <Group title={t("rules.group.account")} desc={t("rules.group.accountDesc")}>
            <Row label={t("rules.account")} help="rules.help.account">
              <span className="rules-static">
                {logo}
                {account}
              </span>
            </Row>
            <Row label={t("rules.name")} help="rules.help.name">
              <span className="rules-field" data-wide="text">
                <input
                  type="text"
                  maxLength={RULES_NAME_MAX}
                  aria-label={t("rules.name")}
                  placeholder={t("rules.namePlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </span>
            </Row>
            <Row
              label={t("rules.accountSize")}
              help="rules.help.accountSize"
              inForce={inForce("start")}
              says={t("rules.says.accountSize", { amount: amount(challenge.size / 100) })}
            >
              <NumberField
                wide
                label={t("rules.accountSize")}
                value={challenge.size}
                unit="USD"
                onChange={(size) => setChallenge({ size })}
              />
              {equity !== undefined && Math.round(equity) !== challenge.size && (
                <button
                  type="button"
                  className="rules-link"
                  onClick={() => setChallenge({ size: Math.round(equity) })}
                >
                  {t("rules.useEquity", { equity: money(equity) })}
                </button>
              )}
            </Row>
          </Group>

          {hasTarget(draft.preset) && (
            <Group title={t("rules.group.challenge")} desc={t("rules.group.challengeDesc")}>
              <Row
                label={t("rules.target")}
                help="rules.help.target"
                inForce={inForce("target")}
                says={t("rules.says.target", {
                  amount: amount(usd.target),
                  equity: amount(challenge.size + usd.target),
                })}
              >
                <NumberField
                  label={t("rules.target")}
                  value={challenge.targetPct}
                  unit="%"
                  onChange={(targetPct) => setChallenge({ targetPct })}
                />
              </Row>
              <Row
                label={t("rules.tradingDaysRange")}
                help="rules.help.days"
                inForce={inForce("days")}
              >
                <NumberField
                  whole
                  label={t("rules.minDays")}
                  value={challenge.minDays}
                  unit={t("rules.days")}
                  onChange={(minDays) => setChallenge({ minDays })}
                />
                <Hint>{t("rules.to")}</Hint>
                <NumberField
                  whole
                  label={t("rules.maxDaysLabel")}
                  value={challenge.maxDays}
                  unit={t("rules.days")}
                  onChange={(maxDays) => setChallenge({ maxDays })}
                />
              </Row>
            </Group>
          )}

          <Group title={t("rules.group.losses")} desc={t("rules.group.lossesDesc")}>
            <Row
              label={t("rules.dailyDrawdown")}
              help="rules.help.daily"
              inForce={inForce("daily")}
              says={t(`rules.says.daily.${draft.breach}`, {
                amount: amount(usd.daily),
                warn: amount(usd.daily * WARN_AT),
              })}
            >
              <NumberField
                label={t("rules.dailyDrawdown")}
                value={challenge.dailyPct}
                unit="%"
                onChange={(dailyPct) => setChallenge({ dailyPct })}
              />
              <Segmented
                label={t("rules.dailyDrawdown")}
                value={challenge.dailyFrom}
                options={DAILY_FROM.map((d) => ({
                  value: d,
                  label: t(d === "balance" ? "rules.dailyFrom.balance" : "rules.dailyFrom.equity"),
                }))}
                onChange={(dailyFrom) => setChallenge({ dailyFrom })}
              />
            </Row>
            <Row
              label={t("rules.maxDrawdown")}
              help="rules.help.max"
              inForce={inForce("max")}
              says={t(
                challenge.maxKind === "static"
                  ? "rules.says.max.static"
                  : "rules.says.max.trailing",
                { amount: amount(usd.max), floor: amount(challenge.size - usd.max) },
              )}
            >
              <NumberField
                label={t("rules.maxDrawdown")}
                value={challenge.maxPct}
                unit="%"
                onChange={(maxPct) => setChallenge({ maxPct })}
              />
              <Segmented
                label={t("rules.maxDrawdown")}
                value={challenge.maxKind}
                options={MAX_KINDS.map((k) => ({ value: k, label: t(MAX_KIND_NAME[k]) }))}
                onChange={(maxKind) => setChallenge({ maxKind })}
              />
            </Row>
            <Row
              label={t("rules.label.breach")}
              help="rules.help.breach"
              inForce={inForce("breach")}
            >
              <Segmented
                label={t("rules.label.breach")}
                value={draft.breach}
                options={BREACH_ACTIONS.map((b) => ({ value: b, label: t(BREACH_NAME[b]) }))}
                onChange={(breach) => set({ breach })}
              />
            </Row>
          </Group>

          <Group title={t("rules.group.size")} desc={t("rules.group.sizeDesc")}>
            <Row
              label={t("rules.tradeLoss")}
              help="rules.help.tradeLoss"
              inForce={inForce("tradeLoss")}
              says={t(
                draft.tradeLoss.mode === "stop"
                  ? "rules.says.tradeLoss.stop"
                  : "rules.says.tradeLoss.warn",
                { amount: amount(usd.tradeLoss) },
              )}
            >
              <NumberField
                label={t("rules.tradeLoss")}
                value={draft.tradeLoss.pct}
                unit="%"
                onChange={(pct) => set({ tradeLoss: { ...draft.tradeLoss, pct } })}
              />
              <Segmented
                label={t("rules.tradeLoss")}
                value={draft.tradeLoss.mode}
                options={[
                  { value: "stop", label: t("rules.requireStop") },
                  { value: "warn", label: t("rules.warnOnly") },
                ]}
                onChange={(mode) => set({ tradeLoss: { ...draft.tradeLoss, mode } })}
              />
            </Row>
            <Row
              label={t("rules.label.position")}
              sub={t("rules.label.positionSub")}
              help="rules.help.position"
              inForce={inForce("position")}
              says={t("rules.says.position", {
                amount: amount(draft.position.usd),
                leverage: draft.position.leverage || 1,
                margin: amount(draft.position.usd / (draft.position.leverage || 1)),
              })}
            >
              <NumberField
                wide
                label={t("rules.label.position")}
                value={draft.position.usd}
                unit="USD"
                onChange={(v) => set({ position: { ...draft.position, usd: v } })}
              />
            </Row>
            <Row
              label={t("rules.label.leverage")}
              sub={t("rules.label.leverageSub")}
              help="rules.help.leverage"
              inForce={inForce("leverage")}
              says={t("rules.says.leverage", {
                amount: amount(challenge.size * draft.position.leverage),
                leverage: draft.position.leverage,
                size: amount(challenge.size),
              })}
            >
              <NumberField
                label={t("rules.label.leverage")}
                value={draft.position.leverage}
                unit="×"
                onChange={(leverage) => set({ position: { ...draft.position, leverage } })}
              />
            </Row>
            <Row
              label={t("rules.tradesPerDay")}
              help="rules.help.tradesPerDay"
              inForce={inForce("tradesPerDay")}
              says={t("rules.says.tradesPerDay", { count: draft.tradesPerDay })}
            >
              <NumberField
                whole
                label={t("rules.tradesPerDay")}
                value={draft.tradesPerDay}
                onChange={(tradesPerDay) => set({ tradesPerDay })}
              />
            </Row>
          </Group>

          <Group title={t("rules.group.when")} desc={t("rules.group.whenDesc")}>
            <Row
              label={t("rules.hours")}
              help="rules.help.hours"
              inForce={inForce("hours")}
              says={
                <>
                  {t(`rules.says.hours.${draft.hours.days}`, {
                    from: draft.hours.from,
                    to: draft.hours.to,
                  })}
                  {!sameClock && ` ${t("rules.says.hours.local", hoursLocal)}`}
                </>
              }
            >
              <Select
                label={t("rules.hours")}
                value={draft.hours.days}
                options={HOUR_DAYS.map((d) => ({
                  value: d,
                  label: t(d === "weekdays" ? "rules.weekdays" : "rules.everyDay"),
                }))}
                onChange={(days) => set({ hours: { ...draft.hours, days } })}
              />
              {(["from", "to"] as const).map((end) => (
                <span key={end} className="rules-time">
                  {end === "to" && <Hint>{t("rules.to")}</Hint>}
                  <span className="rules-field">
                    <input
                      type="time"
                      aria-label={t(end === "from" ? "rules.from" : "rules.until")}
                      value={draft.hours[end]}
                      onChange={(e) =>
                        e.target.value && set({ hours: { ...draft.hours, [end]: e.target.value } })
                      }
                    />
                    {end === "to" && <span className="rules-unit">UTC</span>}
                  </span>
                </span>
              ))}
            </Row>
            <Row
              label={t("rules.news")}
              help="rules.help.news"
              inForce={inForce("news")}
              says={
                draft.news.on
                  ? t("rules.says.news.on", { minutes: draft.news.minutes })
                  : t("rules.says.news.off")
              }
            >
              <Switch
                label={t("rules.news")}
                checked={draft.news.on}
                onChange={(on) => set({ news: { ...draft.news, on } })}
              />
              <NumberField
                whole
                label={t("rules.news")}
                value={draft.news.minutes}
                unit={t("rules.min")}
                disabled={!draft.news.on}
                onChange={(minutes) => set({ news: { ...draft.news, minutes } })}
              />
            </Row>
            <Row
              label={t("rules.coolOffShort")}
              help="rules.help.coolOff"
              inForce={inForce("coolOff")}
              says={t("rules.says.coolOff", {
                losses: draft.coolOff.losses,
                time: span(draft.coolOff.minutes),
              })}
            >
              <NumberField
                whole
                label={t("rules.coolOffLosses")}
                value={draft.coolOff.losses}
                unit={t("rules.losses")}
                onChange={(losses) => set({ coolOff: { ...draft.coolOff, losses } })}
              />
              <Hint>{t("rules.inARow")} →</Hint>
              <NumberField
                whole
                label={t("rules.coolOffMinutes")}
                value={draft.coolOff.minutes}
                unit={t("rules.min")}
                onChange={(minutes) => set({ coolOff: { ...draft.coolOff, minutes } })}
              />
            </Row>
          </Group>

          <Group title={t("rules.group.tilt")} desc={t("rules.group.tiltDesc")}>
            <Row
              label={t("rules.revenge")}
              help="rules.help.revenge"
              inForce={inForce("revenge")}
              says={t("rules.revengeRule", { minutes: tilt.revenge.minutes })}
            >
              <Switch
                label={t("rules.revenge")}
                checked={tilt.revenge.on}
                onChange={(on) => set({ tilt: { ...tilt, revenge: { ...tilt.revenge, on } } })}
              />
              <Hint>{t("rules.reentryWithin")}</Hint>
              <NumberField
                whole
                label={t("rules.reentryWithin")}
                value={tilt.revenge.minutes}
                unit={t("rules.min")}
                disabled={!tilt.revenge.on}
                onChange={(minutes) =>
                  set({ tilt: { ...tilt, revenge: { ...tilt.revenge, minutes } } })
                }
              />
              <Segmented
                label={t("rules.revenge")}
                value={tilt.revenge.mode}
                disabled={!tilt.revenge.on}
                options={[
                  { value: "warn", label: t("rules.warn") },
                  { value: "coolOff", label: t("rules.requireCoolOff") },
                ]}
                onChange={(mode) => set({ tilt: { ...tilt, revenge: { ...tilt.revenge, mode } } })}
              />
            </Row>
            <Row
              label={t("rules.sizeCreepShort")}
              help="rules.help.sizeCreep"
              inForce={inForce("sizeCreep")}
              says={t("rules.sizeCreepRule", { factor: tilt.sizeCreep.factor })}
            >
              <Switch
                label={t("rules.sizeCreepShort")}
                checked={tilt.sizeCreep.on}
                onChange={(on) => set({ tilt: { ...tilt, sizeCreep: { ...tilt.sizeCreep, on } } })}
              />
              <NumberField
                label={t("rules.sizeCreepShort")}
                value={tilt.sizeCreep.factor}
                unit="×"
                disabled={!tilt.sizeCreep.on}
                onChange={(factor) =>
                  set({ tilt: { ...tilt, sizeCreep: { ...tilt.sizeCreep, factor } } })
                }
              />
            </Row>
            <Row
              label={t("rules.overtrading")}
              help="rules.help.overtrading"
              inForce={inForce("overtrading")}
              says={t("rules.overtradingRule", { factor: tilt.overtrading.factor })}
            >
              <Switch
                label={t("rules.overtrading")}
                checked={tilt.overtrading.on}
                onChange={(on) =>
                  set({ tilt: { ...tilt, overtrading: { ...tilt.overtrading, on } } })
                }
              />
              <NumberField
                label={t("rules.overtrading")}
                value={tilt.overtrading.factor}
                unit="×"
                disabled={!tilt.overtrading.on}
                onChange={(factor) =>
                  set({ tilt: { ...tilt, overtrading: { ...tilt.overtrading, factor } } })
                }
              />
            </Row>
          </Group>
        </div>

        {/* What saving does: at once, or at 00:00 UTC, and what changes. */}
        {inForceRules && (changes.length > 0 || turnsOff) && (
          <div className="rules-save-notice" data-waits={waits || undefined} aria-live="polite">
            <div className="rules-save-notice-head">
              {waits ? <LuClock size={16} aria-hidden /> : <LuShieldCheck size={16} aria-hidden />}
              <strong>
                {waits
                  ? t("rules.change.waitTitle", {
                      left: span(Math.max(1, Math.round((startsAt - now) / 60_000))),
                    })
                  : t("rules.change.nowTitle")}
              </strong>
            </div>
            <p>
              {waits
                ? t("rules.change.waitBody", {
                    fields: [
                      ...(turnsOff ? [t("rules.change.off")] : []),
                      ...changes.filter((c) => c.looser).map((c) => fieldLabel(c.field)),
                    ].join(", "),
                    time: clockTime(startsAt),
                  })
                : t("rules.change.nowBody")}
              {changed.has("start") && ` ${t("rules.change.restart")}`}
            </p>
            <ChangeList changes={changes} was={inForceRules} next={draft} turnsOff={turnsOff} />
          </div>
        )}

        <footer className="rules-form-foot">
          <LuLock size={15} aria-hidden />
          <span className="rules-foot-note" data-failed={failed ? true : undefined}>
            {failed ?? (inForceRules ? t("rules.footer") : t("rules.change.newRules"))}
          </span>
          <button type="button" className="rules-button" onClick={onCancel}>
            {t("protect.cancel")}
          </button>
          <button
            type="button"
            className="rules-button rules-primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {t("rules.save")}
          </button>
        </footer>
      </section>
    </div>
  );
}
