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
import {
  type BinanceKeyInfo,
  type BlofinKeyInfo,
  type BybitKeyInfo,
  binanceKeyClient,
  blofinKeyClient,
  bybitKeyClient,
} from "../../api/venueClient";
import {
  type AccountsState,
  accountsState,
  activeAccount,
  addAccount,
  isUidVenue,
  removeAccount,
  subscribeAccounts,
  type UidVenue,
  venueAccounts,
} from "../../lib/account";
import { refreshLiveTrading } from "../../lib/liveTrading";
import { VENUES } from "../../lib/venues";
import { AccountList } from "./AccountList";
import { LiveTradingSwitch } from "./LiveTradingSwitch";

const message = (err: unknown) => (err instanceof Error ? err.message : t("error.failed"));

/** A connected key, as each venue's Rust command describes it. */
type KeyInfo = BybitKeyInfo | BinanceKeyInfo | BlofinKeyInfo;

/**
 * What differs between the API-key venues: their commands (each checks the
 * key with its own venue before storing it), how the key should be made,
 * and what's worth showing about a connected one.
 */
interface KeyVenue {
  connect: (
    apiKey: string,
    apiSecret: string,
    demo: boolean,
    passphrase: string,
  ) => Promise<{ uid: string }>;
  status: (uid: string) => Promise<KeyInfo | null>;
  disconnect: (uid: string) => Promise<void>;
  /** How the key should be made, in order. */
  steps: readonly MessageKey[];
  /** The connected key's details, after its UID. */
  rows: (info: KeyInfo | null | undefined) => [MessageKey, string][];
  /** The key may come with a passphrase the user set when making it (optional). */
  passphrase?: boolean;
  /** Only Demo Trading keys are taken: the venue can't show a live one is trade-only. */
  demoOnly?: boolean;
}

const yesNo = (info: KeyInfo | null | undefined, v: boolean | undefined) =>
  info?.checked && v !== undefined ? t(v ? "apiKey.yes" : "venues.no") : "-";

const KEY_VENUES: Record<UidVenue, KeyVenue> = {
  bybit: {
    connect: bybitKeyClient.connect,
    status: bybitKeyClient.status,
    disconnect: bybitKeyClient.disconnect,
    steps: [
      "apiKey.step.subaccount",
      "apiKey.step.permissions",
      "apiKey.step.ip",
      "apiKey.step.demo",
    ],
    rows: (info) => {
      const key = info && "subAccount" in info ? info : undefined;
      return [
        ["apiKey.subAccount", yesNo(info, key?.subAccount)],
        ["apiKey.ipBound", yesNo(info, key?.ipRestricted)],
        [
          "apiKey.expires",
          key?.checked
            ? key.expiresAt
              ? dateFormat({ dateStyle: "medium" }).format(new Date(key.expiresAt))
              : t("apiKey.never")
            : "-",
        ],
        [
          "apiKey.permissions",
          key?.checked ? (key.readOnly ? t("apiKey.readOnly") : key.permissions.join(", ")) : "-",
        ],
      ];
    },
  },
  binance: {
    connect: binanceKeyClient.connect,
    status: binanceKeyClient.status,
    disconnect: binanceKeyClient.disconnect,
    steps: [
      "apiKey.step.hmac",
      "apiKey.step.subaccount",
      "apiKey.step.permissionsBinance",
      "apiKey.step.ip",
      "apiKey.step.demo",
    ],
    rows: (info) => [
      ["apiKey.ipBound", info?.demo ? "-" : yesNo(info, info?.ipRestricted)],
      [
        "apiKey.permissions",
        info?.checked && "permissions" in info && info.permissions.length > 0
          ? info.permissions.join(", ")
          : "-",
      ],
    ],
  },
  blofin: {
    connect: blofinKeyClient.connect,
    status: blofinKeyClient.status,
    disconnect: blofinKeyClient.disconnect,
    steps: ["apiKey.step.demoBlofin", "apiKey.step.permissionsBlofin", "apiKey.step.passphrase"],
    rows: (info) => [["apiKey.ipBound", yesNo(info, info?.ipRestricted)]],
    passphrase: true,
    demoOnly: true,
  },
};

/**
 * The key and secret (and, where the venue has one, the passphrase), handed
 * to Rust once on submit. Rust asks the venue what the key may do and
 * stores it only if it trades derivatives and nothing else. Every field is
 * cleared straight away, pass or fail.
 */
function KeyForm({ venue }: { venue: UidVenue }) {
  const keys = KEY_VENUES[venue];
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const label = VENUES[venue].label;
  // A key made in the venue's Demo Trading only works on its demo host.
  const [demo, setDemo] = useState(keys.demoOnly === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const [key, pasted, phrase] = [apiKey, secret, passphrase];
    setApiKey("");
    setSecret("");
    setPassphrase("");
    setBusy(true);
    setError(undefined);
    try {
      const info = await keys.connect(key, pasted, demo, phrase);
      addAccount(venue, info.uid);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="apikey-form" onSubmit={submit}>
      {keys.demoOnly ? (
        <p className="wallet-note">{t("apiKey.demoOnly", { venue: label })}</p>
      ) : (
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
              <span>{isDemo ? t("apiKey.demoHint") : t("apiKey.liveHint", { venue: label })}</span>
            </button>
          ))}
        </div>
      )}
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
        <small>{t("apiKey.secretHint", { venue: label })}</small>
      </label>
      {keys.passphrase && (
        <label className="wallet-field">
          <span>
            {t("apiKey.passphraseLabel")} ({t("apiKey.optional")})
          </span>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <small>{t("apiKey.passphraseHint", { venue: label })}</small>
        </label>
      )}
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="wallet-primary" disabled={busy}>
        {busy ? t("apiKey.checking", { venue: label }) : t("apiKey.submit")}
      </button>
    </form>
  );
}

/** The connected account: what the venue says the key may do, and disconnect. */
function Connected({ venue, uid }: { venue: UidVenue; uid: string }) {
  const keys = KEY_VENUES[venue];
  const label = VENUES[venue].label;
  const [info, setInfo] = useState<KeyInfo | null>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    keys.status(uid).then(
      (next) => live && setInfo(next),
      (err) => live && setError(message(err)),
    );
    return () => {
      live = false;
    };
  }, [keys, uid]);

  const disconnect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await keys.disconnect(uid);
      removeAccount(venue, uid);
      // Rust turned live trading off with the key; the page's copy follows.
      void refreshLiveTrading();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  const rows: [MessageKey, string][] = [
    ["apiKey.uid", uid.replace(/^demo:/, "")],
    ...keys.rows(info),
  ];
  const hedgeMode = info && "hedgeMode" in info && info.hedgeMode;

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
        <p className="wallet-note">{t("apiKey.unchecked", { venue: label })}</p>
      )}
      {hedgeMode && (
        <p className="wallet-error" role="alert">
          <LuTriangleAlert size={14} aria-hidden /> {t("apiKey.hedgeMode", { venue: label })}
        </p>
      )}
      {info?.checked && !info.demo && !info.ipRestricted && (
        <p className="wallet-note">{t("apiKey.ipAdvice", { venue: label })}</p>
      )}
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
      {!uid.startsWith("demo:") && <LiveTradingSwitch account={{ venue, id: uid }} />}
      <div className="wallet-actions">
        <button type="button" className="wallet-danger" disabled={busy} onClick={disconnect}>
          {t("wallet.disconnect")}
        </button>
      </div>
      <p className="wallet-note">{t("apiKey.disconnectHint", { venue: label })}</p>
    </section>
  );
}

/**
 * How the key should be made and the form for it, or the connected account:
 * the dialog's body, also onboarding's connect step for Bybit, Binance and
 * BloFin.
 * Nothing for a venue that connects with a wallet.
 */
export function ApiKeyBody({ venue }: { venue: VenueId }) {
  return isUidVenue(venue) ? <KeyVenueBody venue={venue} /> : null;
}

function KeyVenueBody({ venue }: { venue: UidVenue }) {
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
          <Connected key={uid} venue={venue} uid={uid} />
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
            {KEY_VENUES[venue].steps.map((key) => (
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
 * Connect an exchange account (Bybit, Binance, BloFin) with an API key rather than a
 * wallet: how the key should be made, then the key and secret, which Rust
 * checks with the venue before storing. Once connected, the account and what the key
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
