import type { VenueId } from "@pewterdesk/core";
import { Switch, t } from "@pewterdesk/ui";
import { useState, useSyncExternalStore } from "react";
import { LuTriangleAlert } from "react-icons/lu";
import { isUidVenue } from "../../lib/account";
import {
  liveId,
  liveTradingUids,
  setLiveTrading,
  subscribeLiveTrading,
} from "../../lib/liveTrading";
import { VENUES } from "../../lib/venues";

const message = (err: unknown) => (err instanceof Error ? err.message : t("error.failed"));

/**
 * Live trading for a live account: off until it's turned on here, after a
 * warning that orders use real funds. Rust keeps the switch and checks the
 * key with the venue again before it turns on.
 */
export function LiveTradingSwitch({ account }: { account: { venue: VenueId; id: string } }) {
  const on = useSyncExternalStore(subscribeLiveTrading, liveTradingUids).includes(liveId(account));
  // An exchange account's API key, or a wallet's API wallet.
  const apiKey = isUidVenue(account.venue);
  const venue = VENUES[account.venue].label;
  // The warning shows before it's turned on; nothing changes until it's accepted.
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const change = async (next: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await setLiveTrading(account, next);
      setAsking(false);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="apikey-live" data-on={on || undefined}>
      <div className="apikey-live-head">
        <span>
          <strong>{t("live.title")}</strong>
          <small>{t(on ? "live.onHint" : "live.offHint")}</small>
        </span>
        <Switch
          checked={on}
          label={t("live.title")}
          // Turning it on asks first; turning it off just does.
          onChange={(next) => {
            if (busy) return;
            if (next) setAsking(true);
            else void change(false);
          }}
        />
      </div>
      {asking && !on && (
        <div className="apikey-live-ask" role="alert">
          <p>
            <LuTriangleAlert size={14} aria-hidden />{" "}
            {apiKey ? t("live.warning", { venue }) : t("live.warningWallet", { venue })}
          </p>
          <div className="wallet-actions">
            <button
              type="button"
              className="wallet-danger"
              disabled={busy}
              onClick={() => void change(true)}
            >
              {busy
                ? apiKey
                  ? t("live.checking", { venue })
                  : t("live.checkingWallet", { venue })
                : t("live.confirm")}
            </button>
            <button
              type="button"
              className="wallet-secondary"
              disabled={busy}
              onClick={() => setAsking(false)}
            >
              {t("live.cancel")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
