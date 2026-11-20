import { venueLogos } from "@pewterdesk/assets";
import type { VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LuChevronRight, LuSettings2, LuShieldCheck, LuX } from "react-icons/lu";
import {
  accountsState,
  isDemoAccount,
  subscribeAccounts,
  type VenueAccount,
  venueAccounts,
} from "../../lib/account";
import { VENUES } from "../../lib/venues";
import { AccountAvatar } from "./AccountAvatar";
import { AccountList, accountName } from "./AccountList";

/**
 * The venue's accounts kept out of the page: a button showing the active one,
 * which slides the list in from the right edge - switch, rename, add, manage.
 */
export function AccountsButton({
  venue,
  onAdd,
  onManage,
}: {
  venue: VenueId;
  onAdd: () => void;
  onManage?: () => void;
}) {
  const state = useSyncExternalStore(subscribeAccounts, accountsState);
  const accounts = venueAccounts(state, venue);
  const active = accounts.find((a) => a.id === state.active[venue]) ?? accounts[0];
  const [open, setOpen] = useState(false);
  // The drawer steps aside for the dialog it opens.
  const then = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <>
      <button
        type="button"
        className="pf-accounts-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {active && <AccountAvatar account={active} size={22} />}
        <span className="pf-accounts-name">
          {active ? accountName(state, active) : t("accounts.title")}
        </span>
        {active && isDemoAccount(active) && (
          <span className="pf-accounts-demo">{t("accounts.demo")}</span>
        )}
        {accounts.length > 1 && <span className="pf-accounts-count pd-num">{accounts.length}</span>}
        <LuChevronRight size={14} aria-hidden />
      </button>
      {open && (
        <AccountsDrawer
          venue={venue}
          onAdd={then(onAdd)}
          onManage={onManage && then(onManage)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AccountsDrawer({
  venue,
  onAdd,
  onManage,
  onClose,
}: {
  venue: VenueId;
  onAdd: () => void;
  onManage?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const state = useSyncExternalStore(subscribeAccounts, accountsState);
  const accounts = venueAccounts(state, venue);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // showModal focuses the close button, ringed as if tabbed to: the
    // drawer takes focus instead, and Tab still walks its buttons.
    dialog.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      className="pd-drawer pf-accounts-drawer"
      aria-label={t("accounts.title")}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      tabIndex={-1}
    >
      <div className="pd-drawer-panel">
        <header className="pd-drawer-head">
          <h3>{t("accounts.title")}</h3>
          {/* Whose accounts these are: the venue on screen. */}
          <span className="pf-accounts-venue">
            <img src={venueLogos[venue]} alt="" />
            {VENUES[venue].label}
          </span>
          <button
            type="button"
            className="pd-icon-button pf-accounts-close"
            aria-label={t("wallet.close")}
            title={t("wallet.close")}
            onClick={onClose}
          >
            <LuX size={16} aria-hidden />
          </button>
        </header>
        <div className="pf-accounts-body">
          <AccountList venue={venue} onAdd={onAdd} />
          {onManage && (
            <button type="button" className="settings-button pf-accounts-manage" onClick={onManage}>
              <LuSettings2 size={14} aria-hidden />
              {t("portfolio.manageAccount")}
            </button>
          )}
        </div>
        <KeyVault venue={venue} accounts={accounts} />
      </div>
    </dialog>
  );
}

/** The rings the accounts orbit on: their radius, in px, and how long a turn takes. */
const ORBITS = [
  { r: 74, secs: 38 },
  { r: 112, secs: 56 },
] as const;

/**
 * The drawer's foot: the keychain as a vault - a shield in a slow brass glow,
 * dashed rings turning about it and the venue's accounts riding them, each
 * kept upright - over what it means: keys stay on this machine, and live
 * ones are trade-only. Still under "reduce motion".
 */
function KeyVault({ venue, accounts }: { venue: VenueId; accounts: readonly VenueAccount[] }) {
  return (
    <section className="pf-vault" aria-labelledby="pf-vault-title">
      <div className="pf-vault-art" aria-hidden>
        <span className="pf-vault-glow" />
        {ORBITS.map((orbit, ring) => {
          // Every other account to each ring, spread evenly round it.
          const riders = accounts.filter((_, i) => i % ORBITS.length === ring);
          return (
            <div
              key={orbit.r}
              className="pf-vault-ring"
              data-ring={ring}
              style={
                {
                  "--r": `${orbit.r}px`,
                  "--secs": `${orbit.secs}s`,
                } as CSSProperties
              }
            >
              {riders.map((a, i) => (
                <span
                  key={a.id}
                  className="pf-vault-rider"
                  style={
                    {
                      "--a": `${(360 / riders.length) * i + ring * 40}deg`,
                    } as CSSProperties
                  }
                >
                  <span className="pf-vault-upright">
                    {/* Turns back as the ring turns, so the picture stays level. */}
                    <span className="pf-vault-spin">
                      <AccountAvatar account={a} size={26} />
                    </span>
                  </span>
                </span>
              ))}
              {/* A spark on the ring, so an empty one still turns visibly. */}
              <span className="pf-vault-spark" />
            </div>
          );
        })}
        {/* The venue at the heart of it, the keychain's shield on its edge. */}
        <span className="pf-vault-core">
          <img className="pf-vault-venue" src={venueLogos[venue]} alt="" />
          <span className="pf-vault-badge">
            <LuShieldCheck size={13} strokeWidth={2} />
          </span>
        </span>
      </div>
      <span className="pf-vault-name">{VENUES[venue].label}</span>
      <h4 id="pf-vault-title">{t("accounts.vaultTitle")}</h4>
      <p>{t("accounts.vaultBody")}</p>
    </section>
  );
}
