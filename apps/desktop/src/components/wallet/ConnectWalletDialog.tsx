import { venueLogos, walletLogos } from "@pewterdesk/assets";
import type { VenueId } from "@pewterdesk/core";
import { dateFormat, type MessageKey, shortAddress, t } from "@pewterdesk/ui";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  LuChevronRight,
  LuCircleCheck,
  LuCircleX,
  LuKeyRound,
  LuLock,
  LuShieldCheck,
  LuX,
} from "react-icons/lu";
import { type WalletInfo, walletClient } from "../../api/venueClient";
import { connectedWallet, setConnectedWallet, subscribeWallet } from "../../lib/account";
import { BrowserWalletFlow } from "./BrowserWalletFlow";
import { WalletConnectFlow } from "./WalletConnectFlow";

type MethodId = "browser" | "walletConnect" | "api" | "ledger";

interface Method {
  id: MethodId;
  /** Wallet logos, overlapped, or an icon where there's no logo. */
  mark: string[] | ReactNode;
  title: MessageKey;
  detail: MessageKey;
  how: MessageKey;
  steps: MessageKey[];
  /** Not built yet: the pane explains it and says it's coming. */
  soon?: boolean;
}

// Each way to connect approves the same thing: a trade-only API wallet that
// can't withdraw (docs/adr/0001-venues-in-rust.md). Ledger only explains
// itself so far.
const METHODS: Method[] = [
  {
    id: "browser",
    mark: [walletLogos.metamask, walletLogos.rabby, walletLogos.coinbase],
    title: "wallet.browser",
    detail: "wallet.browserDetail",
    how: "wallet.browserHow",
    steps: ["wallet.browserStep1", "wallet.browserStep2", "wallet.stepKeySaved"],
  },
  {
    id: "walletConnect",
    mark: [walletLogos.walletConnect],
    title: "wallet.wc",
    detail: "wallet.wcDetail",
    how: "wallet.wcHow",
    steps: ["wallet.stepConnect", "wallet.stepApprove", "wallet.stepKeySaved"],
  },
  {
    id: "api",
    mark: <LuKeyRound size={18} aria-hidden />,
    title: "wallet.api",
    detail: "wallet.apiDetail",
    how: "wallet.apiHow",
    steps: ["wallet.hlStep1", "wallet.hlStep2", "wallet.hlStep3"],
  },
  {
    id: "ledger",
    mark: [walletLogos.ledger],
    title: "wallet.ledger",
    detail: "wallet.ledgerDetail",
    how: "wallet.ledgerHow",
    steps: ["wallet.stepConnect", "wallet.stepKeySaved", "wallet.stepApprove"],
    soon: true,
  },
];

/** A method's logos, overlapped like avatars, or its icon on a tile. */
function Mark({ mark, size = "md" }: { mark: Method["mark"]; size?: "md" | "lg" }) {
  if (!Array.isArray(mark)) {
    return (
      <span className="wallet-mark wallet-mark-icon" data-size={size}>
        {mark}
      </span>
    );
  }
  return (
    <span className="wallet-mark" data-size={size} data-count={mark.length}>
      {/* The first logo sits on top. */}
      {mark.map((src, i) => (
        <img key={src} src={src} alt="" style={{ zIndex: mark.length - i }} />
      ))}
    </span>
  );
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
    <form className="wallet-action" onSubmit={submit}>
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
      <button type="submit" className="wallet-primary" disabled={busy}>
        {t(busy ? "wallet.checking" : "wallet.submit")}
      </button>
    </form>
  );
}

/** The connected account: its addresses, the agent's approval, and disconnect. */
function ConnectedPane({ venue, address }: { venue: VenueId; address: string }) {
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
    <section className="wallet-detail wallet-connected" aria-labelledby="wallet-pane-title">
      <div className="wallet-hero">
        <span className="wallet-mark" data-size="lg" data-count={1}>
          <img src={venueLogos[venue]} alt="" />
        </span>
        <div>
          <h3 id="wallet-pane-title">
            <LuCircleCheck size={16} aria-hidden className="wallet-ok" />
            {t("wallet.connected")}
          </h3>
          <p>{t("wallet.viewOnly")}</p>
        </div>
      </div>
      <dl className="wallet-rows">
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
      <div className="wallet-actions">
        <button type="button" className="wallet-danger" disabled={busy} onClick={disconnect}>
          {t("wallet.disconnect")}
        </button>
      </div>
      <p className="wallet-note">{t("wallet.disconnectHint")}</p>
    </section>
  );
}

interface ConnectWalletDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Connect a wallet: pick a way on the left (browser extension, WalletConnect,
 * an API wallet key; Ledger to come), and the right shows how it works and
 * does it. Every way ends with a trade-only API wallet in the keychain. Once
 * connected, the dialog shows the account and can disconnect it.
 */
export function ConnectWalletDialog({ open, onClose }: ConnectWalletDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<MethodId>("browser");
  const method = METHODS.find((m) => m.id === selected) ?? (METHODS[0] as Method);
  const wallet = useSyncExternalStore(subscribeWallet, connectedWallet);

  // Drive the native dialog from `open`: showModal gives focus trapping,
  // Escape and the backdrop for free.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setSelected("browser");
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

      {/* Mounted only while open, so a half-typed key or a pending approval doesn't outlive the dialog. */}
      {open && (
        <div className="wallet-body" data-connected={wallet ? true : undefined}>
          {wallet ? (
            <ConnectedPane venue={wallet.venue} address={wallet.address} />
          ) : (
            <>
              <nav className="wallet-list" aria-label={t("wallet.tradingGroup")}>
                <p className="wallet-group">{t("wallet.tradingGroup")}</p>
                <div role="radiogroup" aria-label={t("wallet.tradingGroup")}>
                  {METHODS.map((m) => (
                    // biome-ignore lint/a11y/useSemanticElements: a card-style radio, like the app's other segmented choices
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={m.id === selected}
                      className="wallet-option"
                      data-soon={m.soon || undefined}
                      onClick={() => setSelected(m.id)}
                    >
                      <Mark mark={m.mark} />
                      <span className="wallet-option-text">
                        <strong>{t(m.title)}</strong>
                        <span>{t(m.detail)}</span>
                      </span>
                      {m.soon ? (
                        <span className="wallet-soon">{t("wallet.soon")}</span>
                      ) : (
                        <LuChevronRight className="wallet-chevron" size={16} aria-hidden />
                      )}
                    </button>
                  ))}
                </div>
              </nav>

              <section className="wallet-detail" aria-labelledby="wallet-pane-title">
                <div className="wallet-hero">
                  <Mark mark={method.mark} size="lg" />
                  <div>
                    <h3 id="wallet-pane-title">{t(method.title)}</h3>
                    <p>{t(method.how)}</p>
                  </div>
                </div>

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

                {method.id === "browser" && <BrowserWalletFlow />}
                {method.id === "walletConnect" && <WalletConnectFlow />}
                {method.id === "api" && <ApiWalletForm />}
                {method.soon && <p className="wallet-note">{t("wallet.coming")}</p>}

                <ul className="wallet-facts">
                  <li>
                    <LuCircleCheck size={14} aria-hidden className="wallet-ok" />
                    {t("wallet.factTrade")}
                  </li>
                  <li>
                    <LuCircleX size={14} aria-hidden />
                    {t("wallet.factWithdraw")}
                  </li>
                  <li>
                    <LuShieldCheck size={14} aria-hidden />
                    {t("wallet.factKeychain")}
                  </li>
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
