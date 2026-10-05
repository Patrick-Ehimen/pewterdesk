import { type FormEvent, useEffect, useRef, useState } from "react";
import { t } from "../../i18n";

export interface ConfirmRow {
  label: string;
  value: string;
}

/** A before-and-after line: "250.00 → 500.00 long". */
export interface ConfirmChange {
  label: string;
  from: string;
  to: string;
  /** Colours `to`: as a side, or as a caution (a liquidation price). */
  tone?: "buy" | "sell" | "warn";
}

/**
 * The last look before an order goes: what it is, what it costs, and the
 * position it leaves. Enter confirms, Esc cancels. Its checkbox turns the
 * dialog off for smaller orders (back on in Settings).
 */
export function OrderConfirmDialog({
  side,
  symbol,
  rows,
  after,
  skipLabel,
  onConfirm,
  onCancel,
}: {
  side: "buy" | "sell";
  symbol: string;
  rows: ConfirmRow[];
  /** The position after the fill; unset where it can't be worked out. */
  after?: ConfirmChange[];
  /** "Don't confirm orders under …"; unset hides the checkbox. */
  skipLabel?: string;
  onConfirm: (skipSmaller: boolean) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [skip, setSkip] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="pd-confirm"
      aria-labelledby="pd-confirm-title"
      onClose={onCancel}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onConfirm(skip);
        }}
      >
        <header className="pd-confirm-head">
          <span className="pd-confirm-side" data-side={side}>
            {t(side === "buy" ? "ticket.buy" : "ticket.sell")}
          </span>
          <h3 id="pd-confirm-title">{t("confirm.title")}</h3>
          <span className="pd-confirm-symbol">{symbol}</span>
        </header>
        <div className="pd-confirm-body">
          <dl className="pd-confirm-rows">
            {rows.map((r) => (
              <div key={r.label} className="pd-confirm-row">
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          {after && after.length > 0 && (
            <section className="pd-confirm-after">
              <h4>{t("confirm.after")}</h4>
              <dl className="pd-confirm-rows">
                {after.map((c) => (
                  <div key={c.label} className="pd-confirm-row">
                    <dt>{c.label}</dt>
                    <dd>
                      {c.from} → <span data-tone={c.tone}>{c.to}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          {skipLabel && (
            <label className="pd-confirm-skip">
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
              {skipLabel}
            </label>
          )}
          <div className="pd-confirm-actions">
            <button type="button" className="pd-confirm-cancel" onClick={onCancel}>
              {t("protect.cancel")}
            </button>
            {/* biome-ignore lint/a11y/noAutofocus: Enter confirms, as the footer says */}
            <button type="submit" className="pd-confirm-go" data-side={side} autoFocus>
              {t(side === "buy" ? "confirm.buy" : "confirm.sell")}
            </button>
          </div>
        </div>
        <footer className="pd-confirm-foot">{t("confirm.keys")}</footer>
      </form>
    </dialog>
  );
}
