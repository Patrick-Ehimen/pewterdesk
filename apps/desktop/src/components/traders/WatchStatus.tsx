import { t } from "@pewterdesk/ui";
import { useState } from "react";
import { LuSend } from "react-icons/lu";
import { useTraderSnapshots } from "../../hooks/useTraderWatch";
import { followedKeys, useTraders } from "../../lib/traders";

// The Following page's status (after design/screens/95): how many traders
// the app is watching and how, and Telegram, which needs the watch server
// (ADR 0005) that keeps alerts going with the app closed - not built yet,
// so the button says so rather than pretending to link.

export function WatchStatus() {
  const { state } = useTraders();
  const snapshots = useTraderSnapshots();
  const [open, setOpen] = useState(false);
  const count = followedKeys(state).length;
  const failing = snapshots.filter((s) => s.error).length;
  return (
    <span className="tr-status-bar">
      <span className="tr-status-chip" title={t("traders.status.hint")}>
        <i className="tr-live-dot" data-off={count === 0 || undefined} />
        {count === 0
          ? t("traders.status.none")
          : failing > 0
            ? t("traders.status.failing", { count, failing })
            : t("traders.status.watching", { count })}
      </span>
      <span className="tr-telegram">
        <button
          type="button"
          className="tr-status-chip"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <LuSend size={12} aria-hidden />
          {t("traders.telegram.button")}
        </button>
        {open && (
          <span className="tr-telegram-note" role="note">
            <b>{t("traders.telegram.title")}</b>
            <span>{t("traders.telegram.soon")}</span>
          </span>
        )}
      </span>
    </span>
  );
}
