import type { VenueId } from "@pewterdesk/core";
import { formatNumber, t } from "@pewterdesk/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { venueClient } from "../api/venueClient";
import { notifyEvent } from "../lib/notifications";
import {
  amounts,
  type RulesAccount,
  type RulesStatus,
  type RulesView,
  sameAccount,
  type TradingRules,
} from "../lib/tradingRules";

/** How often an account is read against its rules. */
const STATUS_EVERY_MS = 15_000;
/** How often the rules themselves are re-read: a waiting change applies at midnight. */
const VIEW_EVERY_MS = 60_000;

/**
 * Where `account` stands against its rules, read on a timer while `on`
 * (its rules are in force) and whenever `tick` changes.
 */
export function useRulesStatus(account: RulesAccount | undefined, on: boolean, tick = 0) {
  const [status, setStatus] = useState<RulesStatus>();
  const [error, setError] = useState<string>();
  const venue = account?.venue;
  const id = account?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` asks for a fresh read
  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    if (!on || venue === undefined || id === undefined) return;
    let live = true;
    const read = () =>
      venueClient
        .tradingRulesStatus(venue, id)
        .then((next) => {
          if (!live) return;
          setStatus(next ?? undefined);
          setError(undefined);
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    void read();
    const timer = setInterval(read, STATUS_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [on, venue, id, tick]);
  return { status: on ? status : undefined, error };
}

/**
 * Every account's trading rules (Rust keeps them), and where the account on
 * screen stands against its own. Says so, once, when that account's limit
 * is close, its opening orders lock, a cool-off starts or a revenge trade
 * shows.
 */
export function useTradingRules(venue: VenueId, account: string | undefined) {
  const [views, setViews] = useState<readonly RulesView[]>([]);
  useEffect(() => {
    let live = true;
    const read = () =>
      venueClient
        .tradingRules()
        .then((next) => live && setViews(next))
        // Outside the desktop app there are none.
        .catch(() => {});
    void read();
    const id = setInterval(read, VIEW_EVERY_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const here: RulesAccount | undefined = account === undefined ? undefined : { venue, id: account };
  const view = views.find((v) => sameAccount(v.account, here));
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const { status, error } = useRulesStatus(here, view?.on === true, tick);

  // What was already said, so each thing is said once as it happens.
  const said = useRef<{ warned: boolean; lock?: string; coolOff?: number; revenges: number }>(
    undefined,
  );
  const rules = view?.rules;
  useEffect(() => {
    if (!status || !rules) {
      said.current = undefined;
      return;
    }
    const now = {
      warned: status.dailyWarned,
      lock: status.lock?.reason,
      coolOff: status.coolOffUntil ?? undefined,
      revenges: status.revenge?.count ?? 0,
    };
    const before = said.current;
    said.current = now;
    // The first reading is where things stand, not news.
    if (!before) return;
    if (now.lock && now.lock !== before.lock) {
      notifyEvent({
        type: "risk",
        title: t("rules.note.locked"),
        body: t(
          now.lock === "dailyLoss"
            ? "rules.banner.locked.dailyLoss"
            : "rules.banner.locked.maxDrawdown",
        ),
        tone: "warn",
        sound: "alert",
        venue,
      });
    } else if (now.warned && !before.warned) {
      notifyEvent({
        type: "risk",
        title: t("rules.note.warn", { pct: `${(status.dailyUsed * 100).toFixed(1)}%` }),
        body: t("rules.note.warnBody", {
          left: formatNumber(Math.max(amounts(rules).daily * (1 - status.dailyUsed), 0), 2),
        }),
        tone: "warn",
        sound: "alert",
        venue,
      });
    }
    if (now.coolOff !== undefined && now.coolOff !== before.coolOff) {
      notifyEvent({
        type: "risk",
        title: t("rules.note.coolOff", { minutes: rules.coolOff.minutes }),
        body: t("rules.block.coolOff"),
        tone: "warn",
        sound: "alert",
        venue,
      });
    }
    if (status.revenge && now.revenges > before.revenges) {
      notifyEvent({
        type: "risk",
        title: t("rules.note.revenge"),
        body: t("rules.revengeHit", {
          coin: status.revenge.market,
          minutes: status.revenge.minutes,
        }),
        tone: "warn",
        sound: "alert",
        venue,
        market: status.revenge.market,
      });
    }
  }, [status, rules, venue]);

  /** Saves an account's rules; resolves once Rust holds them. */
  const save = async (target: RulesAccount, name: string, on: boolean, next: TradingRules) => {
    setViews(await venueClient.setTradingRules(target.venue, target.id, name, on, next));
    refresh();
  };
  /** Forgets an account's rules (only ones that are off). */
  const remove = async (target: RulesAccount) => {
    setViews(await venueClient.deleteTradingRules(target.venue, target.id));
    refresh();
  };

  return { views, view, status, error, save, remove, refresh };
}
