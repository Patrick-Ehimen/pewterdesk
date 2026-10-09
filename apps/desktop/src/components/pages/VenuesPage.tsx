import { upcomingVenueLogos, venueLogos } from "@pewterdesk/assets";
import type { VenueId } from "@pewterdesk/core";
import { type MessageKey, t } from "@pewterdesk/ui";
import { useState, useSyncExternalStore } from "react";
import { appClient } from "../../api/appClient";
import { useVenueProbe, type VenueProbe } from "../../hooks/useVenueProbe";
import { accountsState, activeAccount, subscribeAccounts, venueAccounts } from "../../lib/account";
import { VENUE_IDS, VENUES } from "../../lib/venues";
import { accountName } from "../wallet/AccountList";

/** What each venue runs on. */
const CHAIN: Record<VenueId, MessageKey> = {
  bybit: "onb.chain.bybit",
  hyperliquid: "onb.chain.hyperliquid",
  aster: "onb.chain.aster",
};

/** The kind of trade-only key each venue uses. */
const KEY_KIND: Record<VenueId, MessageKey> = {
  bybit: "venues.key.apiKey",
  hyperliquid: "venues.key.apiWallet",
  aster: "venues.key.apiWallet",
};

const UPCOMING = [
  { id: "binance", name: "Binance", chain: "onb.chain.bybit" },
  { id: "okx", name: "OKX", chain: "onb.chain.bybit" },
  { id: "coinbase", name: "Coinbase", chain: "onb.chain.bybit" },
  { id: "kraken", name: "Kraken", chain: "onb.chain.bybit" },
  { id: "kucoin", name: "KuCoin", chain: "onb.chain.bybit" },
  { id: "bitget", name: "Bitget", chain: "onb.chain.bybit" },
  { id: "backpack", name: "Backpack", chain: "onb.chain.bybit" },
  { id: "gmx", name: "GMX", chain: "onb.chain.gmx" },
  { id: "dydx", name: "dYdX", chain: "onb.chain.dydx" },
] as const;

function Status({ probe }: { probe: VenueProbe }) {
  if (probe.status === "up") {
    return (
      <span className="venues-status" data-up>
        <span className="venues-dot" aria-hidden />
        <span className="pd-num">{probe.ms} ms</span>
      </span>
    );
  }
  return (
    <span
      className="venues-status"
      data-down={probe.status === "down" || undefined}
      title={probe.status === "down" ? probe.message : undefined}
    >
      <span className="venues-dot" aria-hidden />
      {t(probe.status === "down" ? "venues.unreachable" : "venues.checking")}
    </span>
  );
}

/**
 * The venues, after the design's venue hub (design/screens/34-VenueHub): each
 * one's status, trading key and markets, added to or removed from the
 * terminal here rather than by running setup again. GMX and dYdX are shown
 * as coming soon, and a missing venue can be requested.
 */
export function VenuesPage({
  chosen,
  onToggle,
  onManage,
}: {
  /** The venues in the terminal (setup's choice). */
  chosen: readonly VenueId[];
  /** Adds or removes a venue; the last one can't be removed. */
  onToggle: (venue: VenueId) => void;
  /** Opens the venue's connect flow. */
  onManage: (venue: VenueId) => void;
}) {
  const probes = useVenueProbe();
  const accounts = useSyncExternalStore(subscribeAccounts, accountsState);
  const [linkFailed, setLinkFailed] = useState(false);

  return (
    <div className="page venues">
      <header className="page-head venues-head">
        <div>
          <h1>{t("nav.venues")}</h1>
          <span>{t("venues.subtitle", { count: chosen.length, total: VENUE_IDS.length })}</span>
        </div>
      </header>

      <div className="venues-grid">
        {VENUE_IDS.map((id) => {
          const added = chosen.includes(id);
          const probe = probes[id];
          const active = activeAccount(accounts, id);
          const account = active?.id;
          const count = venueAccounts(accounts, id).length;
          const rows: [MessageKey, string][] = [
            ["venues.tradingKey", t(KEY_KIND[id])],
            [
              "venues.account",
              active
                ? `${accountName(accounts, active)}${count > 1 ? ` · ${t("accounts.count", { count })}` : ""}`
                : t("venues.notConnected"),
            ],
            ["venues.stored", account ? t("venues.keychain") : "-"],
            ["venues.canWithdraw", t("venues.no")],
            ["venues.markets", probe.status === "up" ? String(probe.markets) : "-"],
          ];
          return (
            <section key={id} className="venues-card" data-added={added || undefined}>
              <header>
                <img src={venueLogos[id]} alt="" />
                <div>
                  <h2>{VENUES[id].label}</h2>
                  <span>{t(CHAIN[id])}</span>
                </div>
                <Status probe={probe} />
              </header>
              <dl>
                {rows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{t(label)}</dt>
                    <dd className="pd-num">{value}</dd>
                  </div>
                ))}
              </dl>
              <footer>
                {added ? (
                  <>
                    <button
                      type="button"
                      className="venues-button"
                      disabled={!VENUES[id].connectable}
                      title={VENUES[id].connectable ? undefined : t("venues.connectSoon")}
                      onClick={() => onManage(id)}
                    >
                      {t(
                        account
                          ? "venues.manage"
                          : VENUES[id].auth === "apiKey"
                            ? "apiKey.connect"
                            : "venues.connect",
                      )}
                    </button>
                    <button
                      type="button"
                      className="venues-button"
                      disabled={chosen.length === 1}
                      title={chosen.length === 1 ? t("venues.lastOne") : undefined}
                      onClick={() => onToggle(id)}
                    >
                      {t("venues.remove")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="venues-button"
                    data-primary
                    onClick={() => onToggle(id)}
                  >
                    {t("venues.add")}
                  </button>
                )}
              </footer>
            </section>
          );
        })}

        {UPCOMING.map((v) => (
          <section key={v.id} className="venues-card" data-soon>
            <header>
              <img src={upcomingVenueLogos[v.id]} alt="" />
              <div>
                <h2>{v.name}</h2>
                <span>{t(v.chain)}</span>
              </div>
              <span className="onb-soon">{t("wallet.soon")}</span>
            </header>
            <p className="venues-soon-text">{t(`venues.soon.${v.id}`)}</p>
          </section>
        ))}

        <section className="venues-card venues-missing">
          <h2>{t("venues.missing")}</h2>
          <p>{t("venues.missingBody")}</p>
          <button
            type="button"
            className="venues-button"
            onClick={() => {
              setLinkFailed(false);
              appClient.openLink("issues").catch(() => setLinkFailed(true));
            }}
          >
            {t("venues.request")}
          </button>
          {linkFailed && <p className="venues-error">{t("about.linkFailed")}</p>}
        </section>
      </div>
    </div>
  );
}
