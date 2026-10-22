import { t } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { LoadingMark } from "./Splash";

/**
 * Before a new build first reads the keychain (a first install, an update,
 * a rebuild in development): macOS is about to ask for the login password,
 * so say so first. Shown over the splash, before the app mounts; Continue
 * is the only way on, since dismissing it is what lets the keychain be read.
 */
export function KeychainNotice({ onContinue }: { onContinue: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [going, setGoing] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="wallet-dialog keychain-notice"
      aria-labelledby="keychain-notice-title"
      // Escape would leave the app behind a closed dialog: Continue only.
      onCancel={(e) => e.preventDefault()}
    >
      <div className="keychain-notice-icon" aria-hidden>
        <LoadingMark size={44} />
      </div>
      <h2 id="keychain-notice-title">{t("keychainNotice.title")}</h2>
      <p>{t("keychainNotice.body")}</p>
      <p>{t("keychainNotice.item")}</p>
      <button
        type="button"
        className="wallet-primary keychain-notice-continue"
        disabled={going}
        // biome-ignore lint/a11y/noAutofocus: the dialog's one action
        autoFocus
        onClick={() => {
          setGoing(true);
          onContinue();
        }}
      >
        {t("keychainNotice.continue")}
      </button>
    </dialog>
  );
}
