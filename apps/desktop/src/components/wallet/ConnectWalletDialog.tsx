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
  LuChevronLeft,
  LuChevronRight,
  LuCircleCheck,
  LuCircleX,
  LuKeyRound,
  LuLock,
  LuShieldCheck,
  LuX,
} from "react-icons/lu";
import { type WalletInfo, walletClient } from "../../api/venueClient";
import {
  type AccountsState,
  accountsState,
  activeAccount,
  addAccount,
  removeAccount,
  subscribeAccounts,
  venueAccounts,
} from "../../lib/account";
import { VENUES } from "../../lib/venues";
import { AccountList } from "./AccountList";
import { BrowserWalletFlow } from "./BrowserWalletFlow";
import { WalletConnectFlow } from "./WalletConnectFlow";

export type MethodId = "browser" | "walletConnect" | "api" | "ledger";

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
  /** The only venue it works on; unset, every wallet venue. */
  only?: VenueId;
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
    // Aster's API wallets have permissions a pasted key can't prove; there
    // pewterdesk makes the key itself, without withdrawals.
    only: "hyperliquid",
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
      addAccount(info.venue, info.address);
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
  const venueLabel = VENUES[venue].label;
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
      removeAccount(venue, address);
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
      <p className="wallet-note">{t("wallet.disconnectHint", { venue: venueLabel })}</p>
    </section>
  );
}

/**
 * The ways to connect and the chosen one's flow, or the connected account:
 * the dialog's body, also the onboarding's connect step. Each flow abandons
 * a half-done connection when it unmounts.
 */
export function ConnectWalletBody({
  venue = "hyperliquid",
  selected,
  onSelect,
}: {
  /** The venue being connected to. */
  venue?: VenueId;
  selected: MethodId;
  onSelect: (id: MethodId) => void;
}) {
  const methods = METHODS.filter((m) => !m.only || m.only === venue);
  const method = methods.find((m) => m.id === selected) ?? (methods[0] as Method);
  const venueLabel = VENUES[venue].label;
  const state = useSyncExternalStore(subscribeAccounts, accountsState);
  const wallet = activeAccount(state, venue);
  // Adding another account shows the ways to connect until one connects:
  // any change to the accounts (the new one saved) ends it.
  const [addingFrom, setAddingFrom] = useState<AccountsState>();
  const adding = addingFrom === state;
  return (
    <div className="wallet-body" data-connected={wallet && !adding ? true : undefined}>
      {wallet && !adding ? (
        <div className="wallet-accounts">
          <div className="wallet-accounts-list">
            <AccountList venue={venue} onAdd={() => setAddingFrom(state)} />
          </div>
          <ConnectedPane key={wallet.id} venue={wallet.venue} address={wallet.id} />
        </div>
      ) : (
        <>
          <nav className="wallet-list" aria-label={t("wallet.tradingGroup")}>
            {adding && venueAccounts(state, venue).length > 0 && (
              <button type="button" className="acct-back" onClick={() => setAddingFrom(undefined)}>
                <LuChevronLeft size={15} aria-hidden />
                {t("accounts.back")}
              </button>
            )}
            <p className="wallet-group">{t("wallet.tradingGroup")}</p>
            <div role="radiogroup" aria-label={t("wallet.tradingGroup")}>
              {methods.map((m) => (
                // biome-ignore lint/a11y/useSemanticElements: a card-style radio, like the app's other segmented choices
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={m.id === method.id}
                  className="wallet-option"
                  data-soon={m.soon || undefined}
                  onClick={() => onSelect(m.id)}
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
                <p>{t(method.how, { venue: venueLabel })}</p>
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

            {method.id === "browser" && <BrowserWalletFlow key={venue} venue={venue} />}
            {method.id === "walletConnect" && <WalletConnectFlow key={venue} venue={venue} />}
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
  );
}

interface ConnectWalletDialogProps {
  open: boolean;
  onClose: () => void;
  /** The venue being connected to: Hyperliquid or Aster. */
  venue: VenueId;
}

/**
 * Connect a wallet: pick a way on the left (browser extension, WalletConnect,
 * an API wallet key; Ledger to come), and the right shows how it works and
 * does it. Every way ends with a trade-only API wallet in the keychain. Once
 * connected, the dialog shows the account and can disconnect it.
 */
export function ConnectWalletDialog({ open, onClose, venue }: ConnectWalletDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<MethodId>("browser");
  const wallet = activeAccount(useSyncExternalStore(subscribeAccounts, accountsState), venue);

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
      {open && <ConnectWalletBody venue={venue} selected={selected} onSelect={setSelected} />}

      <footer className="wallet-dialog-foot">
        <LuLock size={14} aria-hidden />
        {t("wallet.footer")}
      </footer>
    </dialog>
  );
}
