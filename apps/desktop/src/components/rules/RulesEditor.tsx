import { type MessageKey, Select, Switch, t } from "@pewterdesk/ui";
import { type ReactNode, useState } from "react";
import { LuLock } from "react-icons/lu";
import {
  amounts,
  BREACH_ACTIONS,
  type BreachAction,
  DAILY_FROM,
  HOUR_DAYS,
  hasTarget,
  MAX_KINDS,
  type MaxKind,
  PRESET_TERMS,
  PRESETS,
  type Preset,
  type RulesView,
  type TradingRules,
  withPreset,
} from "../../lib/tradingRules";
import { clockTime, money, NumberField, Segmented } from "./parts";

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
const MAX_KIND_HINT: Record<MaxKind, MessageKey> = {
  static: "rules.maxHint.static",
  intraday: "rules.maxHint.intraday",
  eod: "rules.maxHint.eod",
};
/** The longest name a set of rules is kept under (Rust cuts it there too). */
const RULES_NAME_MAX = 40;

const BREACH_NAME: Record<BreachAction, MessageKey> = {
  warn: "rules.breach.warn",
  warnLock: "rules.breach.warnLock",
  lock: "rules.breach.lock",
};

/** One line of the editor: what it sets, then its controls and a note. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rules-edit-row">
      <span className="rules-edit-label">{label}</span>
      <div className="rules-edit-controls">{children}</div>
    </div>
  );
}

const Hint = ({ children }: { children: ReactNode }) => (
  <span className="rules-edit-hint">{children}</span>
);

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
 * Editing the rules: a preset to start from on the left, then the
 * challenge's terms, the trader's own limits and the tilt signals. Nothing
 * changes until it's saved; a change that's waiting for midnight is what's
 * edited, so it isn't lost.
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
  const own = draft.preset === "own";

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
            {t("rules.on")}
            <Switch label={t("rules.on")} checked={on} onChange={setOn} />
          </span>
          <label className="rules-breach-pick" htmlFor="rules-breach">
            {t("rules.breach")}
          </label>
          <Select
            id="rules-breach"
            value={draft.breach}
            options={BREACH_ACTIONS.map((b) => ({ value: b, label: t(BREACH_NAME[b]) }))}
            onChange={(breach) => set({ breach })}
          />
        </header>

        <div className="rules-form-body">
          <h3 className="rules-section">
            {t(own ? "rules.section.drawdown" : "rules.section.challenge")}
          </h3>
          <Row label={t("rules.account")}>
            <span className="rules-static">
              {logo}
              {account}
            </span>
            <Hint>{t("rules.accountOf")}</Hint>
          </Row>
          <Row label={t("rules.name")}>
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
            <Hint>{t("rules.nameHint")}</Hint>
          </Row>
          <Row label={t("rules.accountSize")}>
            <NumberField
              wide
              label={t("rules.accountSize")}
              value={challenge.size}
              unit="USD"
              onChange={(size) => setChallenge({ size })}
            />
            <Hint>{t("rules.accountSizeHint")}</Hint>
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
          {hasTarget(draft.preset) && (
            <Row label={t("rules.target")}>
              <NumberField
                label={t("rules.target")}
                value={challenge.targetPct}
                unit="%"
                onChange={(targetPct) => setChallenge({ targetPct })}
              />
              <Hint>= {money(usd.target)}</Hint>
            </Row>
          )}
          <Row label={t("rules.dailyDrawdown")}>
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
            <Hint>
              = {money(usd.daily)} · {t("rules.resets")}
            </Hint>
          </Row>
          <Row label={t("rules.maxDrawdown")}>
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
            <Hint>{t(MAX_KIND_HINT[challenge.maxKind])}</Hint>
          </Row>
          {hasTarget(draft.preset) && (
            <Row label={t("rules.tradingDaysRange")}>
              <NumberField
                whole
                label={t("rules.minDays")}
                value={challenge.minDays}
                unit={t("rules.days")}
                onChange={(minDays) => setChallenge({ minDays })}
              />
              <NumberField
                whole
                label={t("rules.maxDaysLabel")}
                value={challenge.maxDays}
                unit={t("rules.days")}
                onChange={(maxDays) => setChallenge({ maxDays })}
              />
            </Row>
          )}

          <h3 className="rules-section">{t("rules.section.limits")}</h3>
          <Row label={t("rules.tradeLoss")}>
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
            <Hint>{t("rules.riskToStop", { amount: money(usd.tradeLoss) })}</Hint>
          </Row>
          <Row label={t("rules.position")}>
            <NumberField
              wide
              label={t("rules.position")}
              value={draft.position.usd}
              unit="USD"
              onChange={(v) => set({ position: { ...draft.position, usd: v } })}
            />
            <NumberField
              label={t("rules.leverage")}
              value={draft.position.leverage}
              unit="×"
              onChange={(leverage) => set({ position: { ...draft.position, leverage } })}
            />
          </Row>
          <Row label={t("rules.tradesPerDay")}>
            <NumberField
              whole
              label={t("rules.tradesPerDay")}
              value={draft.tradesPerDay}
              onChange={(tradesPerDay) => set({ tradesPerDay })}
            />
          </Row>
          <Row label={t("rules.hours")}>
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
          <Row label={t("rules.news")}>
            <NumberField
              whole
              label={t("rules.news")}
              value={draft.news.minutes}
              unit={t("rules.min")}
              disabled
              onChange={(minutes) => set({ news: { ...draft.news, minutes } })}
            />
            <Hint>{t("rules.newsSoon")}</Hint>
          </Row>
          <Row label={t("rules.coolOffShort")}>
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

          <h3 className="rules-section">{t("rules.tilt")}</h3>
          <Row label={t("rules.revenge")}>
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
          <Row label={t("rules.sizeCreepShort")}>
            <Switch
              label={t("rules.sizeCreepShort")}
              checked={tilt.sizeCreep.on}
              onChange={(on) => set({ tilt: { ...tilt, sizeCreep: { ...tilt.sizeCreep, on } } })}
            />
            <Hint>{t("rules.sizeOver")}</Hint>
            <NumberField
              label={t("rules.sizeCreepShort")}
              value={tilt.sizeCreep.factor}
              unit="×"
              disabled={!tilt.sizeCreep.on}
              onChange={(factor) =>
                set({ tilt: { ...tilt, sizeCreep: { ...tilt.sizeCreep, factor } } })
              }
            />
            <Hint>{t("rules.sizeOverTail")}</Hint>
          </Row>
          <Row label={t("rules.overtrading")}>
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
            <Hint>{t("rules.paceTail")}</Hint>
          </Row>
        </div>

        <footer className="rules-form-foot">
          <LuLock size={15} aria-hidden />
          <span className="rules-foot-note" data-failed={failed ? true : undefined}>
            {failed ??
              (view.pending
                ? t("rules.pendingAt", { time: clockTime(view.pending.at) })
                : t("rules.footer"))}
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
