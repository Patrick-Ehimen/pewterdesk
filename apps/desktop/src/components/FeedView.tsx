import { EmptyState, t } from "@pewterdesk/ui";
import { type ReactNode, useEffect } from "react";
import type { Feed } from "../hooks/useVenueFeeds";
import { reportFeedError } from "../lib/feedErrors";

/** Hands a failure to the connection banner for as long as it lasts. */
export function useReportError(message: string | undefined) {
  useEffect(() => (message === undefined ? undefined : reportFeedError(message)), [message]);
}

/**
 * Renders `live` for live or closed feeds, and a placeholder otherwise. A
 * failed feed keeps its placeholder (it's retried by itself) and tells the
 * connection banner, which explains it once for every panel.
 */
export function FeedView<T>({
  feed,
  idle,
  loading,
  live,
}: {
  feed: Feed<T>;
  idle?: ReactNode;
  /** Shown while loading, e.g. a skeleton; defaults to a plain message. */
  loading?: ReactNode;
  live: (data: T) => ReactNode;
}) {
  useReportError(feed.status === "error" ? feed.message : undefined);
  switch (feed.status) {
    case "idle":
      return <EmptyState>{idle}</EmptyState>;
    case "loading":
      return loading ?? <EmptyState>{t("feed.loading")}</EmptyState>;
    case "error":
      return loading ?? <EmptyState>{t("feed.reconnecting")}</EmptyState>;
    case "live":
    case "closed":
      return (
        <>
          {feed.status === "closed" && (
            <p className="pd-stale" role="status">
              {t("feed.closed")}
            </p>
          )}
          {live(feed.data)}
        </>
      );
  }
}
