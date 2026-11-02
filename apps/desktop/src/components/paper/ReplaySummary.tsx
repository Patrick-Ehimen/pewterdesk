import { formatMoney, formatNumber, formatSignedMoney, t } from "@pewterdesk/ui";
import { useEffect, useRef } from "react";
import { LuX } from "react-icons/lu";
import type { ReplayResult } from "../../hooks/useReplayAccount";
import { edge } from "../../lib/edge";

/** What a finished replay session came to. */
export function ReplaySummary({
  result,
  quote,
  onClose,
}: {
  result?: ReplayResult;
  quote: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (result && !dialog.open) dialog.showModal();
    else if (!result && dialog.open) dialog.close();
  }, [result]);
  const stats = result && edge(result.trades, 0);
  const pnl = result ? result.after - result.before : 0;
  return (
    <dialog
      ref={ref}
      className="wallet-dialog paper-dialog"
      aria-labelledby="replay-summary-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="wallet-dialog-head">
        <h2 id="replay-summary-title">{t("replay.summary")}</h2>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("paper.cancel")}
          onClick={onClose}
        >
          <LuX size={17} aria-hidden />
        </button>
      </header>
      {result && stats && (
        <div className="paper-dialog-body">
          <dl className="replay-stats">
            <div>
              <dt>{t("replay.sessionPnl")}</dt>
              <dd className="pd-num" data-trend={pnl > 0 ? "up" : pnl < 0 ? "down" : undefined}>
                {formatSignedMoney(pnl, ` ${quote}`)}
              </dd>
            </div>
            <div>
              <dt>{t("replay.balance")}</dt>
              <dd className="pd-num">{formatMoney(result.after, ` ${quote}`)}</dd>
            </div>
            <div>
              <dt>{t("replay.trades")}</dt>
              <dd className="pd-num">{stats.trades}</dd>
            </div>
            <div>
              <dt>{t("portfolio.winRate")}</dt>
              <dd className="pd-num">{formatNumber(stats.winRate * 100, 0)}%</dd>
            </div>
            <div>
              <dt>{t("edge.profitFactor")}</dt>
              <dd className="pd-num">
                {stats.profitFactor === undefined ? "—" : formatNumber(stats.profitFactor, 2)}
              </dd>
            </div>
          </dl>
          <p className="replay-note">{t("replay.summaryNote")}</p>
        </div>
      )}
    </dialog>
  );
}
