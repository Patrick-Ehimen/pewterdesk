import type { Market } from "@pewterdesk/core";
import { t } from "../../i18n";
import { Tooltip } from "../common/Tooltip";

/**
 * The exchange that listed a builder-deployed (HIP-3) market, e.g. "xyz";
 * nothing for the venue's own markets. `hint` adds a tooltip explaining it —
 * leave it off inside another button, since the tooltip's trigger is one.
 */
export function ListedBy({ market, hint = true }: { market?: Market; hint?: boolean }) {
  const dex = market?.listedBy;
  if (!dex) return null;
  const badge = <span className="pd-dex">{dex}</span>;
  if (!hint) return badge;
  return (
    <Tooltip content={t("market.listedBy", { dex })} className="pd-dex-tip">
      {badge}
    </Tooltip>
  );
}
