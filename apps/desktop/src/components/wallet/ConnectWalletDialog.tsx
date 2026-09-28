import { type MessageKey, t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { LuKeyRound, LuLock, LuQrCode, LuShieldCheck, LuUsb, LuX } from "react-icons/lu";

type MethodId = "walletConnect" | "ledger" | "api";

interface Method {
  id: MethodId;
  icon: ReactNode;
  title: MessageKey;
  detail: MessageKey;
  /** How it will work, then its steps, as the design's enable-trading flow. */
  how: MessageKey;
  steps: MessageKey[];
}

// None of these works yet: they need the KeySource and venue signers
// (docs/adr/0001-venues-in-rust.md). Each shows how it will work, so the
// dialog explains the model (a trade-only key that can't withdraw) today.
const METHODS: Method[] = [
  {
    id: "walletConnect",
    icon: <LuQrCode size={18} aria-hidden />,
    title: "wallet.wc",
    detail: "wallet.wcDetail",
    how: "wallet.wcHow",
    steps: ["wallet.stepConnect", "wallet.stepKeySaved", "wallet.stepApprove"],
  },
  {
    id: "ledger",
    icon: <LuUsb size={18} aria-hidden />,
    title: "wallet.ledger",
    detail: "wallet.ledgerDetail",
    how: "wallet.ledgerHow",
    steps: ["wallet.stepConnect", "wallet.stepKeySaved", "wallet.stepApprove"],
  },
  {
    id: "api",
    icon: <LuKeyRound size={18} aria-hidden />,
    title: "wallet.api",
    detail: "wallet.apiDetail",
    how: "wallet.apiHow",
    steps: ["wallet.stepCreateApi", "wallet.stepPasteKey", "wallet.stepKeychain"],
  },
];

const TRUST = ["wallet.trust1", "wallet.trust2", "wallet.trust3"] as const;

interface ConnectWalletDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Connect a wallet, after the design: pick a method on the left, see on the
 * right how it works: a trade-only key, approved once, that can't withdraw.
 * The methods arrive with order placement; until then this explains them.
 */
export function ConnectWalletDialog({ open, onClose }: ConnectWalletDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<MethodId>("walletConnect");
  const method = METHODS.find((m) => m.id === selected) ?? METHODS[0];

  // Drive the native dialog from `open`: showModal gives focus trapping,
  // Escape and the backdrop for free.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setSelected("walletConnect");
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
        <div className="wallet-methods" role="radiogroup" aria-label={t("wallet.connect")}>
          <p className="wallet-group">{t("wallet.tradingGroup")}</p>
          {METHODS.map((m) => (
            // biome-ignore lint/a11y/useSemanticElements: a card-style radio, like the app's other segmented choices
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={m.id === selected}
              className="wallet-method"
              onClick={() => setSelected(m.id)}
            >
              <span className="wallet-method-icon">{m.icon}</span>
              <span className="wallet-method-text">
                <strong>{t(m.title)}</strong>
                <span>{t(m.detail)}</span>
              </span>
            </button>
          ))}
        </div>

        {method && (
          <section className="wallet-pane" aria-labelledby="wallet-pane-title">
            <div className="wallet-pane-head">
              <h3 id="wallet-pane-title">{t(method.title)}</h3>
              <span className="wallet-coming">{t("wallet.coming")}</span>
            </div>
            <p className="wallet-lead">{t(method.how)}</p>

            <ol className="wallet-steps">
              {method.steps.map((step, i) => (
                <li key={step}>
                  <span className="wallet-step-num" aria-hidden>
                    {i + 1}
                  </span>
                  {t(step)}
                </li>
              ))}
            </ol>

            <dl className="wallet-scope">
              <div>
                <dt>{t("wallet.canTrade")}</dt>
                <dd className="pd-up">{t("wallet.canTradeValue")}</dd>
              </div>
              <div>
                <dt>{t("wallet.canWithdraw")}</dt>
                <dd>{t("wallet.no")}</dd>
              </div>
            </dl>

            <ul className="wallet-trust">
              {TRUST.map((k) => (
                <li key={k}>
                  <LuShieldCheck size={14} aria-hidden />
                  {t(k)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <footer className="wallet-dialog-foot">
        <LuLock size={14} aria-hidden />
        {t("wallet.footer")}
      </footer>
    </dialog>
  );
}
