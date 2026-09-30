import type { VenueId } from "@pewterdesk/core";
import { type MessageKey, t } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { venueClient } from "../api/venueClient";
import {
  FEED_TIMEOUT_MS,
  type FeedHealth,
  type FeedKind,
  feedHealth,
  feedSnapshot,
} from "../lib/feedActivity";

/** How often the panel times a REST round trip while it's open. */
const PING_EVERY_MS = 5000;

const FEED_LABEL: Record<FeedKind, MessageKey> = {
  book: "conn.feed.book",
  trades: "conn.feed.trades",
  stats: "conn.feed.stats",
  candles: "conn.feed.candles",
  summaries: "conn.feed.summaries",
  history: "conn.feed.history",
  account: "conn.feed.account",
};

/** "180ms", "14s", "3m": how long ago, at a glance. */
export function ago(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

function Row({ health, label, value }: { health: FeedHealth; label: string; value: string }) {
  return (
    <li className="conn-row" data-health={health}>
      <span className="conn-dot" aria-hidden />
      <span className="conn-label">{label}</span>
      <span className="conn-leader" aria-hidden />
      <span className="conn-value">{value}</span>
    </li>
  );
}

/**
 * What the status badge stands for, in detail, after the design's
 * connection screen: the system network, a REST round trip to the venue
 * (timed while the panel is open), how far behind the order book arrives,
 * and every open feed with its last update against its timeout.
 */
export function ConnectionPanel({
  venue,
  venueId,
  market,
}: {
  venue: string;
  venueId: VenueId;
  /** Timed with a book request: a real round trip through the Rust shell to the venue. */
  market?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [rest, setRest] = useState<number | "error">();
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!market) return;
    let live = true;
    const ping = async () => {
      const start = performance.now();
      try {
        await venueClient.orderBook(venueId, market);
        if (live) setRest(Math.round(performance.now() - start));
      } catch {
        if (live) setRest("error");
      }
    };
    void ping();
    const id = setInterval(() => void ping(), PING_EVERY_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [venueId, market]);

  const network = navigator.onLine;
  const feeds = feedSnapshot(venueId);
  const book = feeds.find((f) => f.kind === "book");
  const account = feeds.find((f) => f.kind === "account");

  return (
    <div className="conn-panel" role="dialog" aria-label={t("conn.title", { venue })}>
      <p className="conn-title">{t("conn.title", { venue })}</p>
      <ul className="conn-rows">
        <Row
          health={network ? "live" : "down"}
          label={t("conn.network")}
          value={t(network ? "conn.ok" : "conn.offline")}
        />
        <Row
          health={
            rest === undefined
              ? "waiting"
              : rest === "error"
                ? "down"
                : rest > 1500
                  ? "late"
                  : "live"
          }
          label={t("conn.rest", { venue })}
          value={
            rest === undefined
              ? t("conn.measuring")
              : rest === "error"
                ? t("conn.unreachable")
                : `${rest}ms`
          }
        />
        <Row
          health={book ? feedHealth(book, now) : "waiting"}
          label={t("conn.bookDelay")}
          value={book?.lagMs === undefined ? t("conn.waiting") : ago(book.lagMs)}
        />
        <Row
          health={account ? feedHealth(account, now) : "waiting"}
          label={t("conn.account")}
          value={account ? t("conn.ok") : t("conn.notConnected")}
        />
      </ul>

      <div className="conn-head">
        <span>{t("conn.datafeed")}</span>
        <span>{t("conn.lastTimeout")}</span>
      </div>
      <ul className="conn-rows">
        {feeds.map((f) => {
          const health = feedHealth(f, now);
          const timeout = ago(FEED_TIMEOUT_MS[f.kind]);
          const last =
            health === "down"
              ? t("conn.closed")
              : f.last === undefined
                ? t("conn.waiting")
                : ago(now - f.last);
          return (
            <Row
              key={f.kind}
              health={health}
              label={t(FEED_LABEL[f.kind])}
              value={`${last} / ${timeout}`}
            />
          );
        })}
      </ul>
      <p className="conn-note">{t("conn.note")}</p>
    </div>
  );
}
