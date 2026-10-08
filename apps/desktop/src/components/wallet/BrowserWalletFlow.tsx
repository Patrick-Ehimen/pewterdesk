import type { VenueId } from "@pewterdesk/core";
import { type MessageKey, t } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { walletClient } from "../../api/venueClient";
import { addAccount } from "../../lib/account";
import { VENUES } from "../../lib/venues";

/** The local page's text, keyed as `app.js` reads it. */
const PAGE_STRINGS: Record<string, MessageKey> = {
  pageTitle: "browser.pageTitle",
  title: "browser.title",
  lead: "browser.lead",
  note: "browser.note",
  connecting: "browser.connecting",
  noAccount: "browser.noAccount",
  sign: "browser.sign",
  sending: "browser.sending",
  done: "browser.done",
  failed: "error.failed",
  noWallet: "browser.noWallet",
  injected: "browser.injected",
  switchChain: "browser.switchChain",
};

type Step =
  | { kind: "idle"; notice?: string }
  | { kind: "waiting" }
  | { kind: "error"; message: string };

/**
 * Connecting a browser-extension wallet: pewterdesk opens a one-time page in
 * the system browser, where MetaMask, Rabby or any other extension signs the
 * approval. Rust builds and checks it; this shows the wait and hears the result.
 * Closing the dialog stops the page.
 */
export function BrowserWalletFlow({ venue }: { venue: VenueId }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });

  useEffect(() => {
    const stop = walletClient.onBrowser((event) => {
      if (event.status === "connected") {
        addAccount(event.wallet.venue, event.wallet.address);
      } else {
        setStep((s) => (s.kind === "waiting" ? { kind: "idle", notice: t("browser.closed") } : s));
      }
    });
    return () => {
      stop();
      void walletClient.cancelBrowser().catch(() => undefined);
    };
  }, []);

  const start = async () => {
    setStep({ kind: "waiting" });
    try {
      // The page fills `{chain}` in itself; the venue's name is known here.
      const label = VENUES[venue].label;
      const strings = Object.fromEntries(
        Object.entries(PAGE_STRINGS).map(([key, message]) => [
          key,
          t(message, { venue: label, chain: "{chain}" }),
        ]),
      );
      await walletClient.startBrowser(venue, strings);
    } catch (e) {
      setStep({ kind: "error", message: e instanceof Error ? e.message : t("error.failed") });
    }
  };

  const cancel = () => {
    void walletClient.cancelBrowser().catch(() => undefined);
    setStep({ kind: "idle" });
  };

  if (step.kind === "waiting") {
    return (
      <div className="wallet-action">
        <div className="wallet-waiting">
          <span className="wallet-spinner" aria-hidden />
          <div>
            <strong>{t("browser.waiting")}</strong>
            <p>{t("browser.waitingHint")}</p>
          </div>
        </div>
        <div className="wallet-actions">
          <button
            type="button"
            className="wallet-secondary"
            onClick={() => void walletClient.reopenBrowser().catch(() => undefined)}
          >
            {t("browser.reopen")}
          </button>
          <button type="button" className="wallet-text" onClick={cancel}>
            {t("wallet.wcCancel")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="wallet-action">
      {step.kind === "error" && (
        <p className="wallet-error" role="alert">
          {step.message}
        </p>
      )}
      {step.kind === "idle" && step.notice && <p className="wallet-note">{step.notice}</p>}
      <button type="button" className="wallet-primary" onClick={start}>
        {t("browser.open")}
      </button>
    </div>
  );
}
