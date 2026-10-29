import type { VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import type { ReactNode } from "react";
import type { AccountsState, VenueAccount } from "../../lib/account";
import { type AccountView, useAccountView } from "../../lib/accountView";
import { BalancesPanel } from "./BalancesPanel";

// The Account panel's two views: the venue on screen's account, as it has
// always shown it, or every venue's balances. The switch sits in the
// panel's title; each panel keeps its own view (`lib/accountView`).

/** The switch in the Account panel's title: all venues, or the venue on screen. */
export function AccountViewSwitch({ id, venue }: { id: string; venue: string }) {
  const [view, setView] = useAccountView(id);
  const options: { value: AccountView; label: string }[] = [
    { value: "all", label: t("account.view.all") },
    { value: "venue", label: venue },
  ];
  return (
    <div className="pd-segmented account-view" role="radiogroup" aria-label={t("account.view")}>
      {options.map((o) => (
        <label key={o.value} data-checked={view === o.value || undefined}>
          <input
            type="radio"
            name={`account-view-${id}`}
            checked={view === o.value}
            onChange={() => setView(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/**
 * The panel: `venueView` (the venue's account summary) or the balances of
 * every venue turned on. Showing one account from there makes it the
 * active one, on its venue, and turns this panel to its view.
 */
export function AccountPanel({
  id,
  venueView,
  accounts,
  venues,
  onShowAccount,
}: {
  id: string;
  venueView: ReactNode;
  accounts: AccountsState;
  venues: readonly VenueId[];
  onShowAccount: (account: VenueAccount) => void;
}) {
  const [view, setView] = useAccountView(id);
  if (view === "venue") return <>{venueView}</>;
  return (
    <BalancesPanel
      accounts={accounts}
      venues={venues}
      onOpen={(account) => {
        onShowAccount(account);
        setView("venue");
      }}
    />
  );
}
