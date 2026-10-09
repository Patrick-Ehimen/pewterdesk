import { venueLogos } from "@pewterdesk/assets";
import type { VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { LuPlus, LuShield } from "react-icons/lu";
import { useRulesStatus } from "../../hooks/useTradingRules";
import {
  newRules,
  type RulesAccount,
  type RulesStatus,
  type RulesView,
  sameAccount,
  type TradingRules,
} from "../../lib/tradingRules";
import { RulesDashboard } from "../rules/RulesDashboard";
import { RulesEditor } from "../rules/RulesEditor";

const keyOf = (account: RulesAccount) => `${account.venue}:${account.id}`;

interface TradingRulesPageProps {
  /** The venue on screen and the account connected on it, if one is. */
  venue: VenueId;
  account?: string;
  /** That account's equity, in USD. */
  equity?: number;
  /** Every account's rules, as Rust holds them. */
  views: readonly RulesView[];
  /** Where the account on screen stands against its own. */
  status?: RulesStatus;
  /** Why that account couldn't be read, when it couldn't. */
  error?: string;
  /** A venue's name. */
  venueLabel: (venue: VenueId) => string;
  /** A market's coin, for the lists. */
  coinOf: (market: string) => string;
  /** Saves an account's rules; rejects with why not. */
  onSave: (account: RulesAccount, name: string, on: boolean, rules: TradingRules) => Promise<void>;
  /** Forgets an account's rules; rejects with why not. */
  onRemove: (account: RulesAccount) => Promise<void>;
  /** Opens the dialog that connects an account on the venue on screen. */
  onConnect: () => void;
}

/**
 * Trading rules (after the Rules mockups in `design/`): each account has its
 * own - a prop firm's, a venue's. A row of accounts runs across the top, the
 * one on screen picked to begin with and again whenever the venue changes;
 * under it, that account's dashboard (its limits, a challenge, the tilt
 * signals) or its editor. Rust keeps the rules and checks each account's
 * orders against its own.
 */
export function TradingRulesPage({
  venue,
  account,
  equity,
  views,
  status,
  error,
  venueLabel,
  coinOf,
  onSave,
  onRemove,
  onConnect,
}: TradingRulesPageProps) {
  const here: RulesAccount | undefined = account === undefined ? undefined : { venue, id: account };
  const hereKey = here ? keyOf(here) : `${venue}:`;
  // The account on screen's rules to begin with, and again when the venue
  // or the account on screen changes. An account without rules shows none.
  const [picked, setPicked] = useState(hereKey);
  // Whose rules are being edited: a saved set's, or new ones for the account on screen.
  const [editing, setEditing] = useState<"saved" | "new">();
  useEffect(() => {
    setPicked(hereKey);
    setEditing(undefined);
  }, [hereKey]);

  const view = views.find((v) => keyOf(v.account) === picked);
  const onScreen = sameAccount(view?.account, here);
  const hereHasRules = views.some((v) => sameAccount(v.account, here));
  // Another account's standing is read here; the one on screen's is the app's.
  const other = useRulesStatus(onScreen ? undefined : view?.account, view?.on === true);
  const shown = onScreen ? { status, error } : other;

  // The trading hours count down by the minute.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // An account is named by its venue, with the venue's logo beside it.
  const accountName = (a: RulesAccount) => venueLabel(a.venue);
  const logo = (v: VenueId, size: number) => (
    <img className="rules-venue-logo" src={venueLogos[v]} alt="" width={size} height={size} />
  );
  const state = (v: RulesView) =>
    v.pending
      ? { tone: "waiting", text: t("rules.state.waiting") }
      : v.on
        ? { tone: "on", text: t("rules.state.on") }
        : { tone: "off", text: t("rules.off") };
  /** New rules for the account on screen, or the way to connect one. */
  const add = () => (here ? setEditing("new") : onConnect());

  if (editing === "new" && here) {
    // Named after the venue and sized to the account, to start with; the
    // rest is the trader's to fill in.
    const start = newRules(here);
    const blank: RulesView = {
      ...start,
      name: venueLabel(venue),
      rules:
        equity === undefined
          ? start.rules
          : { ...start.rules, challenge: { ...start.rules.challenge, size: Math.round(equity) } },
    };
    return (
      <RulesEditor
        key={`new:${hereKey}`}
        view={blank}
        saved={false}
        account={accountName(here)}
        logo={logo(here.venue, 18)}
        equity={equity}
        onCancel={() => setEditing(undefined)}
        onSave={async (name, on, rules) => {
          await onSave(here, name, on, rules);
          setEditing(undefined);
        }}
      />
    );
  }
  if (editing === "saved" && view) {
    return (
      <RulesEditor
        // A different account is a different form.
        key={keyOf(view.account)}
        view={view}
        saved
        account={accountName(view.account)}
        logo={logo(view.account.venue, 18)}
        equity={onScreen ? equity : shown.status?.equity}
        onCancel={() => setEditing(undefined)}
        onSave={async (name, on, rules) => {
          await onSave(view.account, name, on, rules);
          setEditing(undefined);
        }}
      />
    );
  }

  return (
    <div className="page rules-page">
      {/* The accounts with rules, and a way to add the one on screen's. */}
      <div className="rules-tabs" role="tablist" aria-label={t("rules.tabs")}>
        {views.map((v) => {
          const s = state(v);
          return (
            <button
              key={keyOf(v.account)}
              type="button"
              role="tab"
              aria-selected={keyOf(v.account) === picked}
              className="rules-tab"
              onClick={() => setPicked(keyOf(v.account))}
            >
              {logo(v.account.venue, 20)}
              <span className="rules-tab-text">
                <strong>{v.name || accountName(v.account)}</strong>
                {v.name && v.name !== accountName(v.account) && (
                  <small>{accountName(v.account)}</small>
                )}
              </span>
              <span className="rules-tab-state" data-tone={s.tone}>
                {s.text}
              </span>
            </button>
          );
        })}
        {!hereHasRules && (
          <button
            type="button"
            className="rules-tab rules-tab-add"
            aria-label={t("rules.add", { venue: venueLabel(venue) })}
            title={t("rules.add", { venue: venueLabel(venue) })}
            onClick={add}
          >
            <LuPlus size={18} aria-hidden />
          </button>
        )}
      </div>
      {view ? (
        <RulesDashboard
          view={view}
          venue={venueLabel(view.account.venue)}
          equity={onScreen ? equity : undefined}
          status={shown.status}
          error={shown.error}
          now={now}
          coinOf={coinOf}
          onEdit={() => setEditing("saved")}
          onDelete={async () => {
            await onRemove(view.account);
            // Gone: back to the account on screen.
            setPicked(hereKey);
          }}
        />
      ) : (
        // Nothing set for this venue: no rules are shown, only the way to add them.
        <div className="rules-panel rules-connect">
          {here ? logo(venue, 36) : <LuShield size={28} aria-hidden />}
          <h2>
            {here
              ? t("rules.emptyTitle", { venue: venueLabel(venue) })
              : t("rules.connectTitle", { venue: venueLabel(venue) })}
          </h2>
          <p>{t(here ? "rules.emptyBody" : "rules.connectBody")}</p>
          <button type="button" className="rules-button rules-primary rules-add" onClick={add}>
            {here ? (
              <>
                <LuPlus size={16} aria-hidden />
                {t("rules.add", { venue: venueLabel(venue) })}
              </>
            ) : (
              t("wallet.connect")
            )}
          </button>
        </div>
      )}
    </div>
  );
}
