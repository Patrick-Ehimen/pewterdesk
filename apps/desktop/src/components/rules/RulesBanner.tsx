import { formatNumber, t } from "@pewterdesk/ui";
import { LuLock, LuTriangleAlert } from "react-icons/lu";
import { amounts, type RulesStatus, type TradingRules } from "../../lib/tradingRules";

interface RulesBannerProps {
  /** The account on screen's rules, if it has any. */
  rules?: TradingRules;
  status?: RulesStatus;
  /** Opens the Trading rules page. */
  onOpen: () => void;
}

/**
 * The strip above the workspace when the trading rules have something to
 * say: most of the day's loss limit is used, or opening orders are locked.
 * Nothing otherwise.
 */
export function RulesBanner({ rules, status, onOpen }: RulesBannerProps) {
  if (!rules || !status || !(status.lock || status.dailyWarned)) return null;
  const locked = status.lock;
  const left = Math.max(amounts(rules).daily * (1 - status.dailyUsed), 0);
  return (
    <div className="app-banner rules-banner" data-locked={locked ? true : undefined} role="status">
      {locked ? (
        <LuLock className="app-banner-icon" size={16} aria-hidden />
      ) : (
        <LuTriangleAlert className="app-banner-icon" size={16} aria-hidden />
      )}
      <p className="app-banner-text">
        <strong>
          {locked
            ? t("rules.note.locked")
            : t("rules.note.warn", { pct: `${(status.dailyUsed * 100).toFixed(1)}%` })}
        </strong>
        <span>
          {locked
            ? t(
                locked.reason === "dailyLoss"
                  ? "rules.banner.locked.dailyLoss"
                  : "rules.banner.locked.maxDrawdown",
              )
            : t("rules.note.warnBody", { left: formatNumber(left, 2) })}
        </span>
      </p>
      <button type="button" className="rules-link rules-banner-link" onClick={onOpen}>
        {t("rules.banner.open")}
      </button>
    </div>
  );
}
