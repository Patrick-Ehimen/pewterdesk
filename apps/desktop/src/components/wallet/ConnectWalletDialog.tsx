import { dateFormat, type MessageKey, shortAddress, t } from "@pewterdesk/ui";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { LuKeyRound, LuLock, LuQrCode, LuShieldCheck, LuUsb, LuX } from "react-icons/lu";
import { type WalletInfo, walletClient } from "../../api/venueClient";
import { connectedWallet, setConnectedWallet, subscribeWallet } from "../../lib/account";

type MethodId = "walletConnect" | "ledger" | "api";

interface Method {
  id: MethodId;
  icon: ReactNode;
  title: MessageKey;
  detail: MessageKey;
  /** How it works, then its steps, as the design's enable-trading flow. */
  how: MessageKey;
  steps: MessageKey[];
  /** Not built yet: the pane explains it and says it's coming. */
  soon?: boolean;
}

// Importing an API wallet works (Hyperliquid); WalletConnect and Ledger
// still only explain themselves. Each shows the model: a trade-only key that
// can't withdraw (docs/adr/0001-venues-in-rust.md).
const METHODS: Method[] = [
  {
    id: "api",
    icon: <LuKeyRound size={18} aria-hidden />,
    title: "wallet.api",
    detail: "wallet.apiDetail",
    how: "wallet.apiHow",
    steps: ["wallet.hlStep1", "wallet.hlStep2", "wallet.hlStep3"],
  },
  {
    id: "walletConnect",
    icon: <LuQrCode size={18} aria-hidden />,
    title: "wallet.wc",
    detail: "wallet.wcDetail",
    how: "wallet.wcHow",
    steps: ["wallet.stepConnect", "wallet.stepKeySaved", "wallet.stepApprove"],
    soon: true,
  },
  {
    id: "ledger",
    icon: <LuUsb size={18} aria-hidden />,
    title: "wallet.ledger",
    detail: "wallet.ledgerDetail",
    how: "wallet.ledgerHow",
    steps: ["wallet.stepConnect", "wallet.stepKeySaved", "wallet.stepApprove"],
    soon: true,
  },
];

const TRUST = ["wallet.trust1", "wallet.trust2", "wallet.trust3"] as const;

interface ConnectWalletDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Hyperliquid API wallet onboarding: the main address and the agent's
 * private key. The key is handed to Rust once on submit, which checks it's
 * an approved agent (not the main wallet's own key) before storing it in
 * the keychain, and the field is cleared straight away, pass or fail.
 */
function ApiWalletForm() {
  const [address, setAddress] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pasted = key;
    setKey("");
    setBusy(true);
    setError(undefined);
    try {
      const info = await walletClient.connect("hyperliquid", address, pasted);
      setConnectedWallet({ venue: info.venue, address: info.address });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="wallet-form" onSubmit={submit}>
      <label className="wallet-field">
        <span>{t("wallet.addressLabel")}</span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <small>{t("wallet.addressHint")}</small>
      </label>
      <label className="wallet-field">
        <span>{t("wallet.keyLabel")}</span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <small>{t("wallet.keyHint")}</small>
      </label>
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="wallet-submit" disabled={busy}>
        {t(busy ? "wallet.checking" : "wallet.submit")}
      </button>
    </form>
  );
}

/** The connected account: its addresses, the agent's approval, and disconnect. */
function ConnectedPane({ venue, address }: { venue: "hyperliquid" | "aster"; address: string }) {
  const [info, setInfo] = useState<WalletInfo | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    walletClient.status(venue, address).then(
      (next) => live && setInfo(next),
      (err) => live && setError(err instanceof Error ? err.message : t("error.failed")),
    );
    return () => {
      live = false;
    };
  }, [venue, address]);

  const disconnect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await walletClient.disconnect(venue, address);
      setConnectedWallet(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.failed"));
      setBusy(false);
    }
  };

  return (
    <section className="wallet-pane wallet-connected" aria-labelledby="wallet-pane-title">
      <div className="wallet-pane-head">
        <h3 id="wallet-pane-title">{t("wallet.connected")}</h3>
        <span className="wallet-venue">Hyperliquid</span>
      </div>
      <dl className="wallet-scope">
        <div>
          <dt>{t("wallet.mainAddress")}</dt>
          <dd className="pd-num" title={address}>
            {shortAddress(address)}
          </dd>
        </div>
        <div>
          <dt>{t("wallet.apiWallet")}</dt>
          <dd className="pd-num" title={info?.agent}>
            {info
              ? `${info.agentName ? `${info.agentName} · ` : ""}${shortAddress(info.agent)}`
              : "-"}
          </dd>
        </div>
        <div>
          <dt>{t("wallet.approvedUntil")}</dt>
          <dd>
            {info?.validUntil ? dateFormat({ dateStyle: "medium" }).format(info.validUntil) : "-"}
          </dd>
        </div>
      </dl>
      {info === null && <p className="wallet-error">{t("wallet.keyMissing")}</p>}
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
      <p className="wallet-lead">{t("wallet.viewOnly")}</p>
      <button type="button" className="wallet-disconnect" disabled={busy} onClick={disconnect}>
        {t("wallet.disconnect")}
      </button>
      <p className="wallet-note">{t("wallet.disconnectHint")}</p>
    </section>
  );
}

/**
 * Connect a wallet, after the design: pick a method on the left, see on the
 * right how it works: a trade-only key, approved once, that can't withdraw.
 * Importing a Hyperliquid API wallet works; once connected, the dialog shows
 * the account and can disconnect it.
 */
export function ConnectWalletDialog({ open, onClose }: ConnectWalletDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<MethodId>("api");
  const method = METHODS.find((m) => m.id === selected) ?? (METHODS[0] as Method);
  const wallet = useSyncExternalStore(subscribeWallet, connectedWallet);

  // Drive the native dialog from `open`: showModal gives focus trapping,
  // Escape and the backdrop for free.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setSelected("api");
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
        <h2 id="wallet-dialog-title">{t(wallet ? "wallet.account" : "wallet.connect")}</h2>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("wallet.close")}
          onClick={onClose}
        >
          <LuX size={17} aria-hidden />
        </button>
      </header>

      {/* Mounted only while open, so a half-typed key doesn't outlive the dialog. */}
      {open && (
        <div className="wallet-dialog-body">
          {wallet ? (
            <ConnectedPane venue={wallet.venue} address={wallet.address} />
          ) : (
            <>
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
                    data-soon={m.soon || undefined}
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

              <section className="wallet-pane" aria-labelledby="wallet-pane-title">
                <div className="wallet-pane-head">
                  <h3 id="wallet-pane-title">{t(method.title)}</h3>
                  {method.soon && <span className="wallet-coming">{t("wallet.coming")}</span>}
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

                {method.id === "api" && <ApiWalletForm />}

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
            </>
          )}
        </div>
      )}

      <footer className="wallet-dialog-foot">
        <LuLock size={14} aria-hidden />
        {t("wallet.footer")}
      </footer>
    </dialog>
  );
}
