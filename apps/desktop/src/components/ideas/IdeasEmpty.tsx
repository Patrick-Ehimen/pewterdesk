import { t } from "@pewterdesk/ui";
import type { ReactNode } from "react";
import {
  LuArchive,
  LuBellRing,
  LuCircleCheck,
  LuCircleX,
  LuEye,
  LuLightbulb,
  LuPencilLine,
  LuPlus,
  LuTrophy,
} from "react-icons/lu";
import type { IdeaStatus } from "../../lib/ideas";
import { LogoMark } from "../header/AppLogo";

/** The logo, breathing, while the ideas (or anything of theirs) load. */
export function IdeasLoading({ label }: { label: string }) {
  return (
    <div className="ideas-loading" role="status" aria-label={label}>
      <svg className="ideas-chart-logo" viewBox="0 0 56 56" aria-hidden="true">
        <LogoMark x={0} y={0} size={56} />
      </svg>
      <span>{label}</span>
    </div>
  );
}

const ICON: Record<IdeaStatus, ReactNode> = {
  watching: <LuEye size={22} aria-hidden />,
  playedOut: <LuCircleCheck size={22} aria-hidden />,
  wrong: <LuCircleX size={22} aria-hidden />,
  archived: <LuArchive size={22} aria-hidden />,
};

/** A list with nothing in it: what goes there, how an idea gets there, and where to go. */
export function IdeasEmptyList({
  status,
  watching,
  onWatching,
  onNew,
}: {
  status: IdeaStatus;
  /** How many are being watched, to point at them from a closed list. */
  watching: number;
  onWatching: () => void;
  onNew: () => void;
}) {
  return (
    <div className="ideas-empty-card" data-status={status}>
      <span className="ideas-empty-icon">{ICON[status]}</span>
      <h3>{t(`ideas.empty.${status}.title`)}</h3>
      <p>{t(`ideas.empty.${status}.body`)}</p>
      <div className="ideas-empty-actions">
        {status !== "watching" && watching > 0 && (
          <button type="button" className="rules-button" onClick={onWatching}>
            <LuEye size={13} aria-hidden />
            {t("ideas.empty.toWatching", { n: watching })}
          </button>
        )}
        <button type="button" className="rules-button rules-primary" onClick={onNew}>
          <LuPlus size={13} aria-hidden />
          {t("ideas.new")}
        </button>
      </div>
    </div>
  );
}

/** Where an idea would be, with none to show: how ideas work, in three steps. */
export function IdeasGuide() {
  const steps = [
    { icon: <LuPencilLine size={18} aria-hidden />, key: "write" },
    { icon: <LuBellRing size={18} aria-hidden />, key: "watch" },
    { icon: <LuTrophy size={18} aria-hidden />, key: "grade" },
  ] as const;
  return (
    <div className="ideas-guide">
      <span className="ideas-empty-icon ideas-guide-mark">
        <LuLightbulb size={24} aria-hidden />
      </span>
      <h3>{t("ideas.guide.title")}</h3>
      <p className="ideas-guide-lead">{t("ideas.guide.lead")}</p>
      <ol>
        {steps.map((s, i) => (
          <li key={s.key}>
            <span className="ideas-guide-step">{s.icon}</span>
            <div>
              <b>
                {i + 1}. {t(`ideas.guide.${s.key}.title`)}
              </b>
              <p>{t(`ideas.guide.${s.key}.body`)}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The track record with nothing graded in the period: faint rows of what it
 * will hold, and what starts it - the ideas being watched, a way to them.
 */
export function RecordEmpty({
  watching,
  anyClosed,
  onWatching,
}: {
  watching: number;
  /** Closed ideas exist, just not in this period. */
  anyClosed: boolean;
  onWatching: () => void;
}) {
  return (
    <div className="ideas-record-empty">
      <div className="ideas-ghost-rows" aria-hidden>
        {[0.9, 0.7, 0.5, 0.3].map((o) => (
          <div key={o} className="ideas-ghost-row" style={{ opacity: o }}>
            <i className="ideas-ghost-dot" />
            <i style={{ width: "14%" }} />
            <i style={{ width: "9%" }} />
            <i style={{ width: "26%" }} />
            <i style={{ width: "8%" }} />
            <i style={{ width: "11%" }} />
            <i style={{ width: "7%" }} />
          </div>
        ))}
      </div>
      <div className="ideas-record-empty-text">
        <span className="ideas-empty-icon">
          <LuTrophy size={22} aria-hidden />
        </span>
        <h3>{t(anyClosed ? "ideas.record.emptyPeriod" : "ideas.record.emptyTitle")}</h3>
        <p>{t(anyClosed ? "ideas.record.emptyPeriodBody" : "ideas.record.emptyBody")}</p>
        {watching > 0 && (
          <button type="button" className="rules-button" onClick={onWatching}>
            <LuEye size={13} aria-hidden />
            {t("ideas.empty.toWatching", { n: watching })}
          </button>
        )}
      </div>
    </div>
  );
}
