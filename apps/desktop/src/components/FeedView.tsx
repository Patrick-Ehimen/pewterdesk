import { EmptyState, t } from "@pewterdesk/ui";
import type { ReactNode } from "react";
import type { Feed } from "../hooks/useVenueFeeds";

/** Renders `live` for live or closed feeds, and a placeholder otherwise. */
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
  switch (feed.status) {
    case "idle":
      return <EmptyState>{idle}</EmptyState>;
    case "loading":
      return loading ?? <EmptyState>{t("feed.loading")}</EmptyState>;
    case "error":
      return <EmptyState error>{feed.message}</EmptyState>;
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
