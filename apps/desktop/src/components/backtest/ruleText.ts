import type { Cond, Rule, Source } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { isChange, isGroup, valueUnit } from "../../lib/rules";

/** A share as a percentage, without trailing zeros: 0.0003 → "0.03%". */
export const share = (v: number) => `${Number((v * 100).toFixed(4))}%`;

/** Hours as the builder says them: "12 days", "8 hours". */
export function hoursText(h: number) {
  if (h >= 24 && h % 24 === 0) return t("bt.unit.daysN", { n: h / 24 });
  return t("bt.unit.hoursN", { n: Number(h.toFixed(2)) });
}

/** What a source reads, in a word or two: "EMA 9", "Funding rate". */
export function sourceName(s: Source): string {
  switch (s.kind) {
    case "price":
      return t("bt.src.close");
    case "ema":
      return `EMA ${s.period}`;
    case "sma":
      return `SMA ${s.period}`;
    case "rsi":
      return `RSI ${s.period}`;
    case "value":
      return String(s.value);
    case "volume":
      return t("bt.src.volume");
    case "volumeAvg":
      return t("bt.src.volumeAvg");
    case "funding":
      return t("bt.src.funding");
    case "openInterest":
      return t("bt.src.openInterest");
    case "heldHours":
      return t("bt.src.heldHours");
  }
}

/** The small print after a source: "close", "on 1d", "20 candles". */
export function sourceNote(s: Source): string | undefined {
  if (s.kind === "ema" || s.kind === "sma" || s.kind === "rsi")
    return s.on ? t("bt.src.on", { frame: s.on }) : t("bt.src.ofClose");
  if (s.kind === "volumeAvg") return t("bt.src.candlesN", { n: s.period });
  return undefined;
}

/** The right-hand side of a rule, as typed: a number in its unit, or a source. */
export function rightText(r: Rule): string {
  if (r.right.kind !== "value") return sourceName(r.right);
  const v = r.right.value;
  if (isChange(r.op)) return t("bt.src.changeIn", { pct: share(v), hours: r.hours ?? 24 });
  switch (valueUnit(r)) {
    case "pct":
      return share(v);
    case "hours":
      return hoursText(v);
    default:
      return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }
}

export const opText = (r: Rule) => t(`bt.op.${r.op}`);

/** A rule in words: "EMA 9 crosses above EMA 21". */
export function ruleText(r: Rule): string {
  const left = sourceName(r.left);
  const note = r.left.kind !== "value" ? sourceNote(r.left) : undefined;
  const right = rightText(r);
  const rnote = r.right.kind !== "value" ? sourceNote(r.right) : undefined;
  return [
    left,
    note && note !== t("bt.src.ofClose") ? note : undefined,
    opText(r),
    right,
    rnote && rnote !== t("bt.src.ofClose") ? rnote : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

/** A condition in words; a group's joined by its "and" or "or". */
export function condText(c: Cond): string {
  if (!isGroup(c)) return ruleText(c);
  const join = c.match === "all" ? ` ${t("bt.say.and")} ` : ` ${t("bt.say.or")} `;
  return `(${c.conds.map(ruleText).join(join)})`;
}

/**
 * A condition in as few words as the builder's steps have room for:
 * "EMA 9 × 21", "RSI under 60", "volume", "OI drop", "12 days".
 */
export function condBrief(c: Cond): string {
  if (isGroup(c)) return c.conds.map(condBrief).join(" + ");
  const r = c;
  const l = r.left;
  const avg = (s: Source) => s.kind === "ema" || s.kind === "sma";
  if (avg(l) && avg(r.right) && "period" in l && "period" in r.right) {
    const crossing = r.op === "crossesAbove" || r.op === "crossesBelow";
    return crossing
      ? `${sourceName(l)} × ${r.right.period}`
      : `${sourceName(l)} ${t(`bt.brief.op.${r.op}`)} ${r.right.period}`;
  }
  switch (l.kind) {
    case "rsi":
      return r.right.kind === "value"
        ? `${sourceName(l)} ${t(`bt.brief.op.${r.op}`)} ${r.right.value}`
        : sourceName(l);
    case "volume":
    case "volumeAvg":
      return t("bt.brief.volume");
    case "funding":
      return t("bt.brief.funding");
    case "openInterest":
      return r.op === "fallsMoreThan" || r.op === "below" || r.op === "crossesBelow"
        ? t("bt.brief.oiDrop")
        : t("bt.brief.oiRise");
    case "heldHours":
      return r.right.kind === "value" ? hoursText(r.right.value) : sourceName(l);
    case "price":
      return `${t("bt.brief.price")} ${t(`bt.brief.op.${r.op}`)} ${rightText(r)}`;
    default:
      return ruleText(r);
  }
}
