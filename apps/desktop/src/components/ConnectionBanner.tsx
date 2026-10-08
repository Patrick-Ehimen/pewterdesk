import { type MessageKey, t } from "@pewterdesk/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { LuTriangleAlert, LuX } from "react-icons/lu";
import {
  bannerKind,
  type ErrorKind,
  faults,
  getFeedErrors,
  retryNow,
  subscribeFeedErrors,
} from "../lib/feedErrors";
import type { Connection } from "./StatusBar";

const COPY: Record<ErrorKind, { title: MessageKey; body: MessageKey }> = {
  offline: { title: "banner.offlineTitle", body: "banner.offlineBody" },
  unreachable: { title: "banner.unreachableTitle", body: "banner.unreachableBody" },
  timeout: { title: "banner.timeoutTitle", body: "banner.timeoutBody" },
  rateLimited: { title: "banner.rateLimitedTitle", body: "banner.rateLimitedBody" },
  venue: { title: "banner.venueTitle", body: "banner.venueBody" },
};

/** How long the retry button says it's retrying, so a press visibly does something. */
const RETRYING_MS = 1500;

/** The system's own view of the network (`navigator.onLine`), kept current. */
function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * The strip above the workspace when market data can't get through: what's
 * wrong in plain words, that it's retried by itself, and a button to retry
 * now. The panels underneath keep their placeholders instead of each
 * printing the error. Dismissing hides it until something different goes
 * wrong; it clears by itself once data flows again.
 */
export function ConnectionBanner({ venue, connection }: { venue: string; connection: Connection }) {
  const messages = faults(useSyncExternalStore(subscribeFeedErrors, getFeedErrors));
  const online = useOnline();
  const kind = bannerKind(messages, online, connection === "offline");
  const [dismissed, setDismissed] = useState<ErrorKind>();
  const [retrying, setRetrying] = useState(false);

  // Once it's all clear, the next problem shows again even if it's the same kind.
  useEffect(() => {
    if (kind === undefined) setDismissed(undefined);
  }, [kind]);
  useEffect(() => {
    if (!retrying) return;
    const id = setTimeout(() => setRetrying(false), RETRYING_MS);
    return () => clearTimeout(id);
  }, [retrying]);

  if (kind === undefined || kind === dismissed) return null;
  const copy = COPY[kind];
  return (
    <div className="app-banner" role="alert">
      <LuTriangleAlert className="app-banner-icon" size={15} aria-hidden />
      <p className="app-banner-text">
        <strong>{t(copy.title, { venue })}</strong>
        {/* A venue's refusal is said in its own words: "couldn't load" tells
            nobody what to do about it. The rest keep theirs on hover. */}
        <span title={messages[0]}>
          {kind === "venue" && messages[0] ? messages[0] : t(copy.body, { venue })}
        </span>
      </p>
      <button
        type="button"
        className="app-banner-retry"
        disabled={retrying}
        onClick={() => {
          setRetrying(true);
          retryNow();
        }}
      >
        {t(retrying ? "banner.retrying" : "banner.retry")}
      </button>
      <button
        type="button"
        className="app-banner-close"
        aria-label={t("banner.dismiss")}
        onClick={() => setDismissed(kind)}
      >
        <LuX size={14} aria-hidden />
      </button>
    </div>
  );
}
