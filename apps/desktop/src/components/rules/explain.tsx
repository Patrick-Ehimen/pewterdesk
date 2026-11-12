import { formatNumber, Hint, type MessageKey, Tooltip, t } from "@pewterdesk/ui";
import { LuArrowRight, LuCircleHelp } from "react-icons/lu";
import type { ChangeField, RuleChange, TradingRules } from "../../lib/tradingRules";
import { span } from "./parts";

/** A "?" beside a rule's name: what the rule means, on hover or keyboard focus. */
export function InfoTip({ label, help }: { label: string; help: MessageKey }) {
  return (
    <Tooltip className="rules-help" content={<Hint title={label}>{t(help)}</Hint>}>
      <LuCircleHelp size={14} aria-label={t("rules.help.open", { label })} />
    </Tooltip>
  );
}

/** What each change is about, by the rule's name. */
const FIELD_LABEL: Record<ChangeField, MessageKey> = {
  start: "rules.label.start",
  breach: "rules.label.breach",
  target: "rules.target",
  days: "rules.tradingDaysRange",
  daily: "rules.dailyDrawdown",
  max: "rules.maxDrawdown",
  tradeLoss: "rules.tradeLoss",
  position: "rules.label.position",
  leverage: "rules.label.leverage",
  tradesPerDay: "rules.tradesPerDay",
  hours: "rules.hours",
  news: "rules.news",
  coolOff: "rules.coolOffShort",
  revenge: "rules.revenge",
  sizeCreep: "rules.sizeCreepShort",
  overtrading: "rules.overtrading",
};
export const fieldLabel = (field: ChangeField) => t(FIELD_LABEL[field]);

const BREACH: Record<TradingRules["breach"], MessageKey> = {
  warn: "rules.breach.warn",
  warnLock: "rules.breach.warnLock",
  lock: "rules.breach.lock",
};
const PRESET: Record<TradingRules["preset"], MessageKey> = {
  classic: "rules.preset.classic",
  oneStep: "rules.preset.oneStep",
  instant: "rules.preset.instant",
  own: "rules.preset.own",
};

const usd = (v: number) => `${formatNumber(v, v % 1 === 0 ? 0 : 2)} USD`;
const off = () => t("rules.off");

/** One field's setting, short: "200 USD", "10×", "07:00–20:00 UTC". */
export function fieldValue(field: ChangeField, rules: TradingRules): string {
  const c = rules.challenge;
  switch (field) {
    case "start":
      return `${t(PRESET[rules.preset])} · ${usd(c.size)}`;
    case "breach":
      return t(BREACH[rules.breach]);
    case "target":
      return `${c.targetPct}%`;
    case "days":
      return `${c.minDays}–${c.maxDays}`;
    case "daily":
      return `${c.dailyPct}%`;
    case "max":
      return `${c.maxPct}%`;
    case "tradeLoss":
      return `${rules.tradeLoss.pct}%`;
    case "position":
      return usd(rules.position.usd);
    case "leverage":
      return `${rules.position.leverage}×`;
    case "tradesPerDay":
      return String(rules.tradesPerDay);
    case "hours":
      return `${rules.hours.from}–${rules.hours.to} UTC`;
    case "news":
      return rules.news.on ? t("rules.newsLimit", { minutes: rules.news.minutes }) : off();
    case "coolOff":
      return `${rules.coolOff.losses} → ${span(rules.coolOff.minutes)}`;
    case "revenge":
      return rules.tilt.revenge.on ? span(rules.tilt.revenge.minutes) : off();
    case "sizeCreep":
      return rules.tilt.sizeCreep.on ? `${rules.tilt.sizeCreep.factor}×` : off();
    case "overtrading":
      return rules.tilt.overtrading.on ? `${rules.tilt.overtrading.factor}×` : off();
  }
}

/** The changes as "Max position size  20 USD → 200 USD", one a line. */
export function ChangeList({
  changes,
  was,
  next,
  turnsOff,
}: {
  changes: readonly RuleChange[];
  was: TradingRules;
  next: TradingRules;
  /** The change turns the rules off. */
  turnsOff?: boolean;
}) {
  return (
    <ul className="rules-changes">
      {turnsOff && (
        <li data-looser>
          <span>{t("rules.pending.offLine")}</span>
        </li>
      )}
      {changes.map((c) => {
        const from = fieldValue(c.field, was);
        const to = fieldValue(c.field, next);
        return (
          <li key={c.field} data-looser={c.looser || undefined}>
            <span>{fieldLabel(c.field)}</span>
            {from !== to && (
              <span className="rules-change-values pd-num">
                <s>{from}</s>
                <LuArrowRight className="rules-change-arrow" size={12} aria-hidden />
                <b>{to}</b>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
