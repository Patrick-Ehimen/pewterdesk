import { t } from "@pewterdesk/ui";

/**
 * Live or paper, for a venue that has paper trading: the header's switch.
 * Paper trades a simulated account on the venue's live prices; live trades
 * the connected account (once its own live-trading switch is on).
 */
export function PaperSwitch({
  on,
  venue,
  onChange,
}: {
  on: boolean;
  /** The venue's name, for the switch's label. */
  venue: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <div
      className="paper-switch"
      role="radiogroup"
      aria-label={t("paper.switchLabel", { venue })}
      data-paper={on || undefined}
    >
      {([false, true] as const).map((paper) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
        <button
          key={String(paper)}
          type="button"
          role="radio"
          aria-checked={on === paper}
          title={paper ? t("paper.paperHint") : t("paper.liveHint")}
          onClick={() => onChange(paper)}
        >
          {paper ? t("paper.paper") : t("paper.live")}
        </button>
      ))}
    </div>
  );
}
