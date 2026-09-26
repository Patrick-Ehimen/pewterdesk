import { type MessageKey, shortAddress, t } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { LuLock, LuX } from "react-icons/lu";
import { isAddress } from "../../lib/watchAddress";

interface Method {
  badge: string;
  title: MessageKey;
  detail: MessageKey;
  /** Unset while the method isn't built; it's listed but can't be picked. */
  available: boolean;
}

// The signing methods need the KeySource and venue signers, which aren't
// built yet (see docs/adr/0001-venues-in-rust.md). They're shown so the
// roadmap is visible, but disabled.
const METHODS: Method[] = [
  { badge: "WC", title: "wallet.wc", detail: "wallet.wcDetail", available: false },
  { badge: "L", title: "wallet.ledger", detail: "wallet.ledgerDetail", available: false },
  { badge: "API", title: "wallet.api", detail: "wallet.apiDetail", available: false },
  { badge: "RO", title: "wallet.watch", detail: "wallet.watchDetail", available: true },
];

interface ConnectWalletDialogProps {
  open: boolean;
  onClose: () => void;
  /** The address being watched, if any. */
  address: string | undefined;
  onWatch: (address: string | undefined) => void;
}

export function ConnectWalletDialog({ open, onClose, address, onWatch }: ConnectWalletDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const invalid = trimmed !== "" && !isAddress(trimmed);

  // Drive the native dialog from `open`: showModal gives focus trapping,
  // Escape and the backdrop for free.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setDraft("");
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="wallet-dialog"
      aria-labelledby="wallet-dialog-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="wallet-dialog-head">
        <h2 id="wallet-dialog-title">{t("wallet.connect")}</h2>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("wallet.close")}
          onClick={onClose}
        >
          <LuX size={17} aria-hidden />
        </button>
      </header>

      <div className="wallet-dialog-body">
        <ul className="wallet-methods">
          {METHODS.map((m) => (
            <li key={m.badge}>
              <div
                className="wallet-method"
                aria-disabled={!m.available || undefined}
                aria-current={m.available || undefined}
              >
                <span className="wallet-badge">{m.badge}</span>
                <span className="wallet-method-text">
                  <strong>{t(m.title)}</strong>
                  <span>{t(m.detail)}</span>
                </span>
                {!m.available && <span className="wallet-soon">{t("wallet.soon")}</span>}
              </div>
            </li>
          ))}
          <li className="wallet-note">{t("wallet.note")}</li>
        </ul>

        <section className="wallet-pane" aria-labelledby="wallet-watch-title">
          <h3 id="wallet-watch-title">{t("wallet.watchTitle")}</h3>
          <p className="pd-muted">{t("wallet.watchHelp")}</p>
          {address ? (
            <div className="wallet-watching">
              <span className="pd-live-dot" data-live aria-hidden />
              <span>{t("wallet.watchingAddress", { address: shortAddress(address) })}</span>
              <button
                type="button"
                className="ws-button"
                onClick={() => {
                  onWatch(undefined);
                  onClose();
                }}
              >
                {t("wallet.stopWatching")}
              </button>
            </div>
          ) : null}
          <form
            className="wallet-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isAddress(trimmed)) return;
              onWatch(trimmed);
              onClose();
            }}
          >
            <label htmlFor="wallet-address">
              {t(address ? "wallet.watchAnother" : "wallet.address")}
            </label>
            <input
              id="wallet-address"
              className="pd-input pd-num"
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={invalid}
              aria-describedby={invalid ? "wallet-address-error" : undefined}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {invalid && (
              <span id="wallet-address-error" className="wallet-error">
                {t("wallet.invalid")}
              </span>
            )}
            <button
              type="submit"
              className="ws-button ws-button-primary"
              disabled={!isAddress(trimmed)}
            >
              {t("wallet.watch")}
            </button>
          </form>
        </section>
      </div>

      <footer className="wallet-dialog-foot">
        <LuLock size={14} aria-hidden />
        {t("wallet.footer")}
      </footer>
    </dialog>
  );
}
