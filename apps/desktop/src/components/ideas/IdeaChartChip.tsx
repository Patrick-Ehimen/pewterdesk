import { Select, t } from "@pewterdesk/ui";
import { LuArrowUpRight, LuEye, LuEyeOff, LuLightbulb, LuTicket } from "react-icons/lu";
import type { Idea } from "../../lib/ideas";
import { BiasPill } from "./parts";

/** An idea's name in a list: its thesis's first words, else its market. */
export const ideaTitle = (idea: Idea) => {
  const words = idea.thesis.trim().split(/\s+/).slice(0, 6).join(" ");
  return words ? (words.length < idea.thesis.trim().length ? `${words}…` : words) : idea.symbol;
};

/**
 * Over the Trade chart, when the market on screen has ideas being watched:
 * which one is drawn (a pick when there are several), its levels shown or
 * hidden, and the way to fill the ticket from it or open it. It places
 * nothing; the ticket still waits for the trader.
 */
export function IdeaChartChip({
  ideas,
  current,
  shown,
  canFill,
  onPick,
  onShown,
  onFill,
  onOpen,
}: {
  ideas: readonly Idea[];
  current: Idea;
  shown: boolean;
  /** Whether its reward-to-risk picks make a trade the ticket can take. */
  canFill: boolean;
  onPick: (id: string) => void;
  onShown: (shown: boolean) => void;
  onFill: () => void;
  onOpen: () => void;
}) {
  return (
    <section className="idea-chip" aria-label={t("ideas.chip.label")}>
      <LuLightbulb size={13} aria-hidden className="idea-chip-icon" />
      {ideas.length > 1 ? (
        <Select
          label={t("ideas.chip.pick")}
          value={current.id}
          options={ideas.map((i) => ({ value: i.id, label: ideaTitle(i) }))}
          onChange={onPick}
          // Near the foot of the chart: the list opens upward, over the candles.
          placement="above"
          className="idea-chip-select"
        />
      ) : (
        <span className="idea-chip-title">{ideaTitle(current)}</span>
      )}
      <BiasPill bias={current.bias} />
      <span className="idea-chip-count">
        {t("ideas.chip.levels", { n: current.levels.length })}
      </span>
      <button
        type="button"
        className="pd-icon-button"
        aria-pressed={shown}
        aria-label={t(shown ? "ideas.chip.hide" : "ideas.chip.show")}
        title={t(shown ? "ideas.chip.hide" : "ideas.chip.show")}
        onClick={() => onShown(!shown)}
      >
        {shown ? <LuEye size={14} aria-hidden /> : <LuEyeOff size={14} aria-hidden />}
      </button>
      <button
        type="button"
        className="pd-icon-button"
        disabled={!canFill}
        aria-label={t("ideas.chip.fill")}
        title={t(canFill ? "ideas.chip.fill" : "ideas.chip.fillNeedsRisk")}
        onClick={onFill}
      >
        <LuTicket size={14} aria-hidden />
      </button>
      <button
        type="button"
        className="pd-icon-button"
        aria-label={t("ideas.chip.open")}
        title={t("ideas.chip.open")}
        onClick={onOpen}
      >
        <LuArrowUpRight size={14} aria-hidden />
      </button>
    </section>
  );
}
