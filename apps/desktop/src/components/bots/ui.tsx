import { Hint, type MessageKey, Tooltip, t } from "@pewterdesk/ui";
import { Fragment, useState } from "react";
import { LuCheck, LuChevronRight, LuCircleHelp, LuX } from "react-icons/lu";
import type { Template } from "../../lib/backtest";
import { type Bot, PAPER_DAYS } from "../../lib/bots";

export interface Crumb {
  label: string;
  /** Goes there; the last crumb (where you are) has none. */
  onClick?: () => void;
}

/** Where you are on the page, each step back one click away: "Bots › Backtests › #15". */
export function Crumbs({ items }: { items: readonly Crumb[] }) {
  const last = items.length - 1;
  return (
    <nav className="bt-crumbs" aria-label={t("bots.crumbs")}>
      {items.map((item, i) => (
        <Fragment key={item.label}>
          {i > 0 && <LuChevronRight size={14} className="bt-crumb-sep" aria-hidden />}
          {i === last ? (
            <h1 aria-current="page">{item.label}</h1>
          ) : (
            <button type="button" className="bt-crumb" onClick={item.onClick}>
              {item.label}
            </button>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/** A "?" beside a figure that says, on hover or focus, what it means and what's good. */
export function HelpTip({ title, text }: { title: string; text: string }) {
  return (
    <Tooltip content={<Hint title={title}>{text}</Hint>} className="bt-help">
      <LuCircleHelp size={13} aria-label={title} />
    </Tooltip>
  );
}

type Step = "backtest" | "paper" | "live";
const STEPS: readonly Step[] = ["backtest", "paper", "live"];
const STEP_LABEL: Record<Step, MessageKey> = {
  backtest: "bots.stage.backtest",
  paper: "bots.stage.paper",
  live: "bots.stage.live",
};

/** A bot's way to live trading: backtest, a week of paper trading, then live; where it is now. */
export function Lifecycle({ bot }: { bot: Pick<Bot, "mode" | "paperDay"> }) {
  const at = STEPS.indexOf(bot.mode);
  return (
    <ol className="bt-lifecycle" aria-label={t("bots.stage.label")}>
      {STEPS.map((step, i) => (
        <li
          key={step}
          data-done={i < at || undefined}
          data-current={i === at || undefined}
          aria-current={i === at ? "step" : undefined}
        >
          <span className="bt-lifecycle-mark" aria-hidden>
            {i < at ? <LuCheck size={10} /> : i + 1}
          </span>
          {t(STEP_LABEL[step])}
          {step === "paper" && bot.mode === "paper" && (
            <em className="pd-num">{`${bot.paperDay ?? 1}/${PAPER_DAYS}`}</em>
          )}
        </li>
      ))}
    </ol>
  );
}

const GUIDE_KEY = "pd.bots.guideHidden";
const readHidden = () => {
  try {
    return localStorage.getItem(GUIDE_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * The three steps every bot takes, until it's put away; `fixed`, it's the
 * page's empty state and stays.
 */
export function Guide({ onStart, fixed = false }: { onStart: () => void; fixed?: boolean }) {
  const [hidden, setHidden] = useState(readHidden);
  if (hidden && !fixed) return null;
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(GUIDE_KEY, "1");
    } catch {
      // Storage unavailable: hidden for this visit.
    }
  };
  return (
    <section className="bt-guide" aria-label={t("bots.guide.title")}>
      <h2>{fixed ? t("bots.guide.emptyTitle") : t("bots.guide.title")}</h2>
      <ol>
        {(["backtest", "paper", "live"] as const).map((step, i) => (
          <li key={step}>
            <span className="bt-lifecycle-mark bt-guide-mark" aria-hidden>
              {i + 1}
            </span>
            <div>
              <strong className="bt-guide-step">{t(STEP_LABEL[step])}</strong>
              <p>{t(`bots.guide.${step}`, { days: PAPER_DAYS })}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="bt-guide-actions">
        <button type="button" className="bt-button" data-primary onClick={onStart}>
          {t("bots.guide.start")}
        </button>
        {!fixed && (
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("bots.guide.hide")}
            title={t("bots.guide.hide")}
            onClick={hide}
          >
            <LuX size={14} aria-hidden />
          </button>
        )}
      </div>
    </section>
  );
}

/** A section with nothing in it yet: what it's for, and the way to fill it. */
export function Empty({
  title,
  text,
  action,
  onAction,
}: {
  title: string;
  text: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="bt-empty">
      <strong className="bt-empty-title">{title}</strong>
      <p>{text}</p>
      <button type="button" className="bt-button" data-primary onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

/** A template's name: "Grid", "Trend" (the EMA cross) or "Custom". */
export const TEMPLATE_LABEL: Record<Template, MessageKey> = {
  grid: "bots.kind.grid",
  ema: "bots.kind.trend",
  custom: "bots.kind.custom",
};
