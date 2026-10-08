import { formatSigned, type MessageKey, t, trendClass } from "@pewterdesk/ui";
import { useEffect, useRef } from "react";
import { LuX } from "react-icons/lu";
import type { Group } from "../../lib/edge";

/** Each hold-time group's label; times read the same in every language. */
export const HOLD_LABEL: Record<string, MessageKey> = {
  under1m: "edge.hold.under1m",
  under10m: "edge.hold.under10m",
  under1h: "edge.hold.under1h",
  under1d: "edge.hold.under1d",
  under7d: "edge.hold.under7d",
  over7d: "edge.hold.over7d",
};
export const SIZE_LABEL: Record<string, MessageKey> = {
  under100: "edge.size.under100",
  under500: "edge.size.under500",
  under1k: "edge.size.under1k",
  under5k: "edge.size.under5k",
  under20k: "edge.size.under20k",
  over20k: "edge.size.over20k",
};

/**
 * One table of groups, each a bar from a shared middle line: left for a
 * typical loss, right for a gain. Its length is the group's median return,
 * its thickness the win rate, and how solid it is the number of trades.
 */
function Bars({
  title,
  head,
  groups,
  labels,
}: {
  title: string;
  head: string;
  groups: readonly Group[];
  labels: Record<string, MessageKey>;
}) {
  const traded = groups.filter((g) => g.trades > 0);
  const longest = Math.max(1, ...traded.map((g) => Math.abs(g.medianReturn)));
  const most = Math.max(1, ...traded.map((g) => g.trades));
  return (
    <section className="pf-break-col">
      <h3>{title}</h3>
      <div className="pf-break-head">
        <span>{head}</span>
        <span>{t("edge.pnl")}</span>
      </div>
      {groups.map((g) => {
        const down = g.medianReturn < 0;
        return (
          <div key={g.id} className="pf-break-row">
            <span className="pf-break-name">{t(labels[g.id] ?? "edge.hold.under1m")}</span>
            <span className="pf-break-track" aria-hidden>
              {g.trades > 0 && (
                <span
                  className="pf-break-bar"
                  data-side={down ? "down" : "up"}
                  style={{
                    // Half the track each way; a sliver even at zero, so it's seen.
                    width: `${Math.max(2, (Math.abs(g.medianReturn) / longest) * 50)}%`,
                    [down ? "right" : "left"]: "50%",
                    height: `${6 + g.winRate * 30}px`,
                    opacity: 0.35 + 0.65 * (g.trades / most),
                  }}
                />
              )}
            </span>
            <span
              className={`pd-num pf-break-value ${g.trades > 0 ? trendClass(g.medianReturn) : ""}`}
              title={
                g.trades > 0
                  ? `${t("tab.trades")}: ${g.trades} · ${t("portfolio.winRate")}: ${Math.round(g.winRate * 100)}%`
                  : undefined
              }
            >
              {g.trades > 0 ? `${formatSigned(g.medianReturn, 1)}%` : "-"}
            </span>
          </div>
        );
      })}
    </section>
  );
}

interface EdgeBreakdownProps {
  open: boolean;
  onClose: () => void;
  holds: readonly Group[];
  sizes: readonly Group[];
  /** The asset sizes are in, e.g. "USDT". */
  quote: string;
  /** Closes with no opening on record, left out of the hold times. */
  undated: number;
}

/** Every hold-time and entry-size group side by side: the cards' detail. */
export function EdgeBreakdown({ open, onClose, holds, sizes, quote, undated }: EdgeBreakdownProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="pf-cal pf-break"
      aria-labelledby="pf-break-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="pf-cal-head">
        <h2 id="pf-break-title">{t("edge.breakdown")}</h2>
        <button
          type="button"
          className="pd-icon-button pf-break-close"
          aria-label={t("wallet.close")}
          onClick={onClose}
        >
          <LuX size={17} aria-hidden />
        </button>
      </header>
      <div className="pf-break-cols">
        <Bars title={t("edge.hold")} head={t("edge.holdHead")} groups={holds} labels={HOLD_LABEL} />
        <Bars
          title={t("edge.entrySize")}
          head={t("edge.sizeHead", { quote })}
          groups={sizes}
          labels={SIZE_LABEL}
        />
      </div>
      <footer className="pf-break-foot">
        <span>{t("edge.legend.length")}</span>
        <span>{t("edge.legend.thickness")}</span>
        <span>{t("edge.legend.opacity")}</span>
        {undated > 0 && <span>{t("edge.undated", { count: undated })}</span>}
      </footer>
    </dialog>
  );
}
