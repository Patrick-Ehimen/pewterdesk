import type { AlgoSpec } from "@pewterdesk/core";
import { formatNumber, t } from "@pewterdesk/ui";
import { formatDuration, runsOnVenue } from "./algos";
import type { Intent } from "./commands";

// An algo command in words, the same in the palette and the CLI panel.

type AlgoIntent = Extract<Intent, { kind: "chase" | "twap" }>;

/** "Chaser · Buy 1 BTC-USDT · give up at 0.5% · then at market". */
export function algoLine(intent: AlgoIntent): string {
  const side = t(intent.side === "buy" ? "side.buy" : "side.sell");
  const head = `${side} ${formatNumber(intent.size)} ${intent.market.symbol}`;
  if (intent.kind === "chase") {
    return [
      t("algo.kind.chaser"),
      head,
      intent.giveUpPct !== undefined && t("algo.giveUpAt", { pct: String(intent.giveUpPct) }),
      intent.finish && t("algo.thenMarket"),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    t("algo.kind.twap"),
    head,
    t("algo.over", { duration: formatDuration(intent.durationMs) }),
    intent.slices !== undefined && t("algo.inSlices", { count: intent.slices }),
    intent.chase && t("algo.style.chaser"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Where it would run, said plainly. */
export const algoWhere = (spec: AlgoSpec) =>
  t(runsOnVenue(spec) ? "algo.onVenueHint" : "algo.hereHint");
