import { formatNumber, t } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { LuX } from "react-icons/lu";
import { PAPER_ADD_MAX, PAPER_MOVE_MIN, PAPER_START } from "../../lib/paper";

export type PaperDialogMode = "funds" | "reset";
type Direction = "add" | "reduce";

interface PaperFundsDialogProps {
  /** Which to show, or nothing. */
  mode?: PaperDialogMode;
  venue: string;
  /** The account's asset, e.g. "USDC". */
  quote: string;
  /** What could be taken out now. */
  withdrawable: number;
  /** Adds (positive) or takes out (negative); throws why it can't. */
  onAdjust: (amount: number) => void;
  onReset: () => void;
  onClose: () => void;
}

/**
 * The paper account's money: add funds or take some out (like a venue's demo
 * top-up), or start the whole account again from the default balance.
 */
export function PaperFundsDialog({
  mode,
  venue,
  quote,
  withdrawable,
  onAdjust,
  onReset,
  onClose,
}: PaperFundsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [direction, setDirection] = useState<Direction>("add");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();

  // Driven from `mode`: showModal gives focus trapping, Escape and the backdrop.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (mode && !dialog.open) {
      setDirection("add");
      setAmount("");
      setError(undefined);
      dialog.showModal();
    } else if (!mode && dialog.open) {
      dialog.close();
    }
  }, [mode]);

  const max = direction === "add" ? PAPER_ADD_MAX : Math.floor(withdrawable * 100) / 100;
  const value = Number(amount);
  const valid = amount.trim() !== "" && value >= PAPER_MOVE_MIN && value <= max;
  const submit = () => {
    if (!valid) return;
    try {
      onAdjust(direction === "add" ? value : -value);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("paper.error.amount"));
    }
  };

  return (
    <dialog
      ref={ref}
      className="wallet-dialog paper-dialog"
      aria-labelledby="paper-dialog-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="wallet-dialog-head">
        <h2 id="paper-dialog-title">
          {mode === "reset" ? t("paper.resetTitle") : t("paper.fundsTitle")}
        </h2>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("paper.cancel")}
          onClick={onClose}
        >
          <LuX size={17} aria-hidden />
        </button>
      </header>

      {mode === "reset" ? (
        <div className="paper-dialog-body">
          <p>
            {t("paper.resetText", {
              venue,
              amount: `${formatNumber(PAPER_START, 0)} ${quote}`,
            })}
          </p>
          <div className="paper-dialog-actions">
            <button type="button" className="paper-dialog-button" onClick={onClose}>
              {t("paper.cancel")}
            </button>
            <button
              type="button"
              className="paper-dialog-button"
              data-danger
              onClick={() => {
                onReset();
                onClose();
              }}
            >
              {t("paper.resetConfirm")}
            </button>
          </div>
        </div>
      ) : mode === "funds" ? (
        <form
          className="paper-dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="paper-tabs" role="radiogroup" aria-label={t("paper.fundsTitle")}>
            {(["add", "reduce"] as const).map((d) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
              <button
                key={d}
                type="button"
                className="paper-tab"
                role="radio"
                aria-checked={direction === d}
                onClick={() => {
                  setDirection(d);
                  setError(undefined);
                }}
              >
                {d === "add" ? t("paper.addFunds") : t("paper.reduceFunds")}
              </button>
            ))}
          </div>
          <p className="pd-muted">
            {direction === "add"
              ? t("paper.addHint", { quote })
              : t("paper.reduceHint", {
                  amount: `${formatNumber(withdrawable, 2)} ${quote}`,
                })}
          </p>
          <label className="paper-amount" data-error={error ? "" : undefined}>
            <input
              className="pd-num"
              inputMode="decimal"
              autoFocus
              aria-label={t("paper.amount")}
              placeholder={`${formatNumber(PAPER_MOVE_MIN, 0)} ~ ${formatNumber(max, max < 100 ? 2 : 0)}`}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(",", "."));
                setError(undefined);
              }}
            />
            {direction === "reduce" && max >= PAPER_MOVE_MIN && (
              <button type="button" className="paper-max" onClick={() => setAmount(String(max))}>
                {t("paper.max")}
              </button>
            )}
            <em>{quote}</em>
          </label>
          {error && <p className="paper-error">{error}</p>}
          <p className="pd-muted">{t("paper.fundsNote")}</p>
          <div className="paper-dialog-actions">
            <button type="button" className="paper-dialog-button" onClick={onClose}>
              {t("paper.cancel")}
            </button>
            <button type="submit" className="paper-dialog-button" data-primary disabled={!valid}>
              {direction === "add" ? t("paper.addFunds") : t("paper.reduceFunds")}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
