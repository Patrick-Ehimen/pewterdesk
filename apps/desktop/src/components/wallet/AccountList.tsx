import type { VenueId } from "@pewterdesk/core";
import { shortAddress, t } from "@pewterdesk/ui";
import { type FormEvent, useRef, useState, useSyncExternalStore } from "react";
import { LuCamera, LuCheck, LuPencil, LuPlus, LuX } from "react-icons/lu";
import {
  type AccountsState,
  accountLabel,
  accountsState,
  isDemoAccount,
  NAME_MAX,
  renameAccount,
  selectAccount,
  subscribeAccounts,
  type VenueAccount,
  venueAccounts,
} from "../../lib/account";
import { avatarFor, removeAvatar, setAvatar, subscribeAvatars } from "../../lib/avatars";
import { AccountAvatar, drawAvatar } from "./AccountAvatar";

/** An account's name as shown: the user's, or "Account 2" for an unnamed one. */
export function accountName(state: AccountsState, account: VenueAccount): string {
  const label = accountLabel(state, account);
  return "name" in label ? label.name : t("accounts.default", { n: label.index });
}

/** How an account's id reads: a short address, or the Bybit UID as is. */
export const accountId = (account: VenueAccount) =>
  account.venue === "bybit" ? `UID ${account.id.replace(/^demo:/, "")}` : shortAddress(account.id);

function Edit({
  account,
  current,
  onDone,
}: {
  account: VenueAccount;
  current: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(account.name);
  const [error, setError] = useState<string>();
  const file = useRef<HTMLInputElement>(null);
  const custom = useSyncExternalStore(subscribeAvatars, () => avatarFor(account.venue, account.id));

  const save = (e: FormEvent) => {
    e.preventDefault();
    renameAccount(account.venue, account.id, name);
    onDone();
  };
  // A picture applies as soon as it's picked; the name waits for save.
  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    setError(undefined);
    try {
      const url = await drawAvatar(picked);
      if (!setAvatar(account.venue, account.id, url)) setError(t("accounts.imageFailed"));
    } catch (err) {
      setError(
        t(
          err instanceof Error && err.message === "too big"
            ? "accounts.imageTooBig"
            : "accounts.imageFailed",
        ),
      );
    }
  };

  return (
    <form className="acct-edit" onSubmit={save}>
      <div className="acct-edit-row">
        <button
          type="button"
          className="acct-avatar-pick"
          aria-label={t("accounts.changeImage")}
          title={t("accounts.changeImage")}
          onClick={() => file.current?.click()}
        >
          <AccountAvatar account={account} size={40} />
          <span className="acct-avatar-overlay" aria-hidden>
            <LuCamera size={15} />
          </span>
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          className="acct-edit-name"
          // biome-ignore lint/a11y/noAutofocus: editing starts by typing the name
          autoFocus
          value={name}
          maxLength={NAME_MAX}
          placeholder={current}
          aria-label={t("accounts.nameLabel")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // Escape cancels the edit, not the whole dialog.
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onDone();
            }
          }}
        />
        <button type="submit" className="pd-icon-button" aria-label={t("accounts.save")}>
          <LuCheck size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("wallet.close")}
          onClick={onDone}
        >
          <LuX size={15} aria-hidden />
        </button>
      </div>
      <div className="acct-edit-foot">
        <button type="button" className="acct-link" onClick={() => file.current?.click()}>
          {t("accounts.changeImage")}
        </button>
        {custom && (
          <button
            type="button"
            className="acct-link"
            onClick={() => removeAvatar(account.venue, account.id)}
          >
            {t("accounts.removeImage")}
          </button>
        )}
        {error && (
          <span className="acct-edit-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * A venue's connected accounts, each with its picture: pick the active one,
 * edit any one's name and picture, or add another. The active account's details (and disconnect) sit below it.
 */
export function AccountList({ venue, onAdd }: { venue: VenueId; onAdd: () => void }) {
  const state = useSyncExternalStore(subscribeAccounts, accountsState);
  const [editing, setEditing] = useState<string>();
  const accounts = venueAccounts(state, venue);
  const active = state.active[venue];

  return (
    <section className="acct" aria-labelledby={`acct-title-${venue}`}>
      <header className="acct-head">
        <p id={`acct-title-${venue}`} className="apikey-label">
          {t("accounts.title")}
        </p>
        <button type="button" className="acct-add" onClick={onAdd}>
          <LuPlus size={14} aria-hidden />
          {t("accounts.add")}
        </button>
      </header>
      <ul className="acct-list">
        {accounts.map((a) => {
          const name = accountName(state, a);
          const isActive = a.id === active;
          return (
            <li key={a.id} className="acct-row" data-active={isActive || undefined}>
              {editing === a.id ? (
                <Edit account={a} current={name} onDone={() => setEditing(undefined)} />
              ) : (
                <>
                  <button
                    type="button"
                    className="acct-pick"
                    aria-pressed={isActive}
                    onClick={() => !isActive && selectAccount(venue, a.id)}
                  >
                    <AccountAvatar account={a} size={34} />
                    <span className="acct-text">
                      <strong>{name}</strong>
                      <span className="pd-num" title={a.id}>
                        {accountId(a)}
                      </span>
                    </span>
                    {isDemoAccount(a) && (
                      <span className="acct-badge acct-badge-demo">{t("accounts.demo")}</span>
                    )}
                    {isActive && <span className="acct-badge">{t("accounts.active")}</span>}
                  </button>
                  <button
                    type="button"
                    className="pd-icon-button"
                    aria-label={t("accounts.edit", { name })}
                    title={t("accounts.edit", { name })}
                    onClick={() => setEditing(a.id)}
                  >
                    <LuPencil size={14} aria-hidden />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
