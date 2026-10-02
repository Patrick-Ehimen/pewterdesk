import { venueLogos } from "@pewterdesk/assets";
import type { VenueId } from "@pewterdesk/core";
import { dateFormat, type MessageKey, t } from "@pewterdesk/ui";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  LuChevronLeft,
  LuCircleCheck,
  LuCircleX,
  LuLock,
  LuTriangleAlert,
  LuX,
} from "react-icons/lu";
import { type BybitKeyInfo, bybitKeyClient } from "../../api/venueClient";
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

/** How the key should be made, in order. */
const STEPS: readonly MessageKey[] = [
  "apiKey.step.subaccount",
  "apiKey.step.permissions",
  "apiKey.step.ip",
  "apiKey.step.demo",
];

const message = (err: unknown) => (err instanceof Error ? err.message : t("error.failed"));

/**
 * The key and secret, handed to Rust once on submit. Rust asks Bybit what
 * the key may do and stores it only if it trades contracts and nothing
 * else. Both fields are cleared straight away, pass or fail.
 */
function KeyForm({ venue }: { venue: VenueId }) {
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  // A key made in Bybit's Demo Trading only works on its demo host.
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const [key, pasted] = [apiKey, secret];
    setApiKey("");
    setSecret("");
    setBusy(true);
    setError(undefined);
    try {
      const info = await bybitKeyClient.connect(key, pasted, demo);
      addAccount("bybit", info.uid);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="apikey-form" onSubmit={submit}>
      <div className="apikey-env" role="radiogroup" aria-label={t("apiKey.envLabel")}>
        {([false, true] as const).map((isDemo) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
          <button
            key={String(isDemo)}
            type="button"
            role="radio"
            aria-checked={demo === isDemo}
            className="apikey-env-option"
            onClick={() => setDemo(isDemo)}
          >
            <strong>{t(isDemo ? "accounts.demo" : "apiKey.live")}</strong>
            <span>{t(isDemo ? "apiKey.demoHint" : "apiKey.liveHint")}</span>
          </button>
        ))}
      </div>
      <label className="wallet-field">
        <span>{t("apiKey.keyLabel")}</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <label className="wallet-field">
        <span>{t("apiKey.secretLabel")}</span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <small>{t("apiKey.secretHint")}</small>
      </label>
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="wallet-primary" disabled={busy}>
        {busy ? t("apiKey.checking", { venue: VENUES[venue].label }) : t("apiKey.submit")}
      </button>
    </form>
  );
}

/** The connected account: what Bybit says the key may do, and disconnect. */
function Connected({ uid }: { uid: string }) {
  const [info, setInfo] = useState<BybitKeyInfo | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    bybitKeyClient.status(uid).then(
      (next) => live && setInfo(next),
      (err) => live && setError(message(err)),
    );
    return () => {
      live = false;
    };
  }, [uid]);

  const disconnect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await bybitKeyClient.disconnect(uid);
      removeAccount("bybit", uid);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  const yesNo = (v: boolean | undefined) =>
    info?.checked && v !== undefined ? t(v ? "apiKey.yes" : "venues.no") : "-";
  const rows: [MessageKey, string][] = [
    ["apiKey.uid", uid.replace(/^demo:/, "")],
    ["apiKey.subAccount", yesNo(info?.subAccount)],
    ["apiKey.ipBound", yesNo(info?.ipRestricted)],
    [
      "apiKey.expires",
      info?.checked
        ? info.expiresAt
          ? dateFormat({ dateStyle: "medium" }).format(new Date(info.expiresAt))
          : t("apiKey.never")
        : "-",
    ],
    [
      "apiKey.permissions",
      info?.checked ? (info.readOnly ? t("apiKey.readOnly") : info.permissions.join(", ")) : "-",
    ],
  ];

  return (
    <section className="apikey-connected" aria-labelledby="apikey-pane-title">
      <h3 id="apikey-pane-title">
        <LuCircleCheck size={16} aria-hidden className="wallet-ok" />
        {t("wallet.connected")}
      </h3>
      <dl className="wallet-rows">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{t(label)}</dt>
            <dd className="pd-num">{value}</dd>
          </div>
        ))}
      </dl>
      {info === null && <p className="wallet-error">{t("wallet.keyMissing")}</p>}
      {info?.problem && (
        <p className="wallet-error" role="alert">
          <LuTriangleAlert size={14} aria-hidden /> {info.problem}
        </p>
      )}
      {info && !info.checked && !info.problem && (
        <p className="wallet-note">{t("apiKey.unchecked")}</p>
      )}
      {info?.checked && !info.ipRestricted && <p className="wallet-note">{t("apiKey.ipAdvice")}</p>}
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
      <p className="wallet-note">{t("apiKey.disconnectHint")}</p>
    </section>
  );
}

/**
 * How the key should be made and the form for it, or the connected account:
 * the dialog's body, also onboarding's connect step for Bybit.
 */
export function ApiKeyBody({ venue }: { venue: VenueId }) {
  const state = useSyncExternalStore(subscribeAccounts, accountsState);
  const uid = activeAccount(state, venue)?.id;
  // Adding another key shows the form until one connects: any change to
  // the accounts (the new one saved) ends it.
  const [addingFrom, setAddingFrom] = useState<AccountsState>();
  const adding = addingFrom === state;
  return (
    <div className="apikey-body">
      <div className="apikey-intro">
        <img className="apikey-logo" src={venueLogos[venue]} alt="" />
        <p>{t("apiKey.lead", { venue: VENUES[venue].label })}</p>
      </div>

      {uid && !adding ? (
        <>
          <AccountList venue={venue} onAdd={() => setAddingFrom(state)} />
          <Connected key={uid} uid={uid} />
        </>
      ) : (
        <>
          {adding && venueAccounts(state, venue).length > 0 && (
            <button type="button" className="acct-back" onClick={() => setAddingFrom(undefined)}>
              <LuChevronLeft size={15} aria-hidden />
              {t("accounts.back")}
            </button>
          )}
          <p className="apikey-label">{t("apiKey.howTo")}</p>
          <ol className="apikey-steps">
            {STEPS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>
          <ul className="wallet-facts">
            <li>
              <LuCircleCheck size={14} aria-hidden />
              {t("apiKey.can")}
            </li>
            <li>
              <LuCircleX size={14} aria-hidden />
              {t("apiKey.cannot")}
            </li>
          </ul>
          <KeyForm venue={venue} />
        </>
      )}
    </div>
  );
}

interface ApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  /** A venue that connects with an exchange API key (`auth: "apiKey"`). */
  venue: VenueId;
}

/**
 * Connect an exchange account (Bybit) with an API key rather than a wallet:
 * how the key should be made, then the key and secret, which Rust checks
 * with Bybit before storing. Once connected, the account and what the key
 * may do, and disconnect.
 */
export function ApiKeyDialog({ open, onClose, venue }: ApiKeyDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const label = VENUES[venue].label;
  const uid = activeAccount(useSyncExternalStore(subscribeAccounts, accountsState), venue)?.id;

  // Drive the native dialog from `open`: showModal gives focus trapping,
  // Escape and the backdrop for free.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="wallet-dialog apikey-dialog"
      aria-labelledby="apikey-dialog-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="wallet-dialog-head">
        <h2 id="apikey-dialog-title">
          {uid ? t("wallet.account") : t("apiKey.title", { venue: label })}
        </h2>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("wallet.close")}
          onClick={onClose}
        >
          <LuX size={17} aria-hidden />
        </button>
      </header>

      {/* Mounted only while open, so a half-typed secret doesn't outlive the dialog. */}
      {open && <ApiKeyBody venue={venue} />}

      <footer className="wallet-dialog-foot">
        <LuLock size={14} aria-hidden />
        {t("apiKey.footer")}
      </footer>
    </dialog>
  );
}
