import { venueLogos } from "@pewterdesk/assets";
import type { AccountSnapshot, VenueId } from "@pewterdesk/core";
import {
  accountTotals,
  EmptyState,
  formatNumber,
  formatPercent,
  formatSigned,
  Hint,
  type MessageKey,
  ratioLevel,
  Tooltip,
  t,
  trendClass,
} from "@pewterdesk/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LuArrowUpRight } from "react-icons/lu";
import { useAccount, useMarkets } from "../../hooks/useVenueFeeds";
import type { AccountsState, VenueAccount } from "../../lib/account";
import {
  accountKey,
  type BalanceKind,
  balanceAccounts,
  type Figures,
  figuresOf,
  kindOf,
  shareOf,
  totals,
} from "../../lib/balances";
import { VENUES } from "../../lib/venues";
import { accountId, accountName } from "../wallet/AccountList";

// Balances across venues, after Tealstreet's unified balances: every
// connected account on the venues turned on, as tiles, with the totals over
// them (real funds and Demo Trading's apart) and the picked account's
// summary beside them - the Account panel's figures, in this panel's own
// layout. Built to fit the panel: the tiles shrink, and lines go before
// anything scrolls. Reads each account's own feed (the one the account
// panels use); places nothing.

const usd = (n: number) => `${n < 0 ? "-" : ""}$${formatNumber(Math.abs(n), 2)}`;
const signedUsd = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "-" : ""}$${formatNumber(Math.abs(n), 2)}`;

type Feed = { snapshot?: AccountSnapshot; error?: string };

/**
 * How many colours accounts take, in turn, in the order the tiles show: each
 * one's tile outline, its share and its part of the allocation bar, so the
 * bar reads as a key to the tiles (`--bal-tone`, from the theme's tokens).
 */
const TONES = 7;

/** What each kind of account's tile says it is; live ones say nothing. */
const BADGE: Record<BalanceKind, MessageKey | undefined> = {
  live: undefined,
  demo: "balances.demo",
};

/** An account's tile: its own feed, handed up for the totals and the summary. */
function Tile({
  account,
  name,
  total,
  tone,
  selected,
  onSelect,
  onFeed,
}: {
  account: VenueAccount;
  name: string;
  /** Its total's equity (live or demo), for its share. */
  total: number;
  /** Its colour, of `TONES`. */
  tone: number;
  selected: boolean;
  onSelect: () => void;
  onFeed: (key: string, feed: Feed | undefined) => void;
}) {
  const kind = kindOf(account);
  const feed = useAccount(account.venue, account.id);
  const snapshot = feed.status === "live" || feed.status === "closed" ? feed.data : undefined;
  const error = feed.status === "error" ? feed.message : undefined;
  const key = accountKey(account);
  useEffect(() => onFeed(key, { snapshot, error }), [key, snapshot, error, onFeed]);
  useEffect(() => () => onFeed(key, undefined), [key, onFeed]);

  const figures = useMemo(() => (snapshot ? figuresOf(snapshot) : undefined), [snapshot]);
  const badge = BADGE[kind];
  const share = figures ? shareOf(figures.equity, total) : undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a tile picks the summary shown, like a radio
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      // One tab stop for the group: the arrow keys move between tiles.
      tabIndex={selected ? 0 : -1}
      className="bal-tile"
      data-kind={kind}
      data-bal-tone={tone}
      onClick={onSelect}
    >
      <span className="bal-tile-head">
        <img className="bal-logo" src={venueLogos[account.venue]} alt="" />
        <span className="bal-tile-name">{name}</span>
        {badge && <span className="bal-badge">{t(badge)}</span>}
      </span>
      <span className="bal-tile-sub">
        {VENUES[account.venue].label} · {accountId(account)}
      </span>
      {figures ? (
        <>
          <span className="bal-tile-equity pd-num">{usd(figures.equity)}</span>
          <span className="bal-tile-foot">
            <span className={`pd-num ${trendClass(figures.unrealized)}`}>
              {signedUsd(figures.unrealized)}
            </span>
            <span className="bal-tile-free">
              {t("balances.col.available")}{" "}
              <span className="bal-tile-free-value pd-num">{usd(figures.available)}</span>
            </span>
          </span>
        </>
      ) : (
        <span className="bal-tile-status" title={error}>
          {t(error ? "balances.unavailable" : "balances.loading")}
        </span>
      )}
      {share !== undefined && (
        <span className="bal-tile-share" aria-hidden>
          <span className="bal-tile-share-fill" style={{ width: `${share * 100}%` }} />
        </span>
      )}
    </button>
  );
}

/** One total: equity, its parts, and a bar split by account. */
function Total({
  label,
  figures,
  count,
  split,
}: {
  label: string;
  figures: Figures;
  count: number;
  /** Each account's colour and equity, in tile order, and whether it's the one picked. */
  split: { key: string; tone: number; equity: number; on: boolean }[];
}) {
  const sum = split.reduce((a, s) => a + Math.max(0, s.equity), 0);
  return (
    <div className="bal-total">
      <span className="bal-label" title={t("balances.note")}>
        {label} · {t("balances.accounts", { count })}
      </span>
      <span className="bal-total-line">
        <span className="bal-total-equity pd-num">{usd(figures.equity)}</span>
        <span className="bal-total-parts">
          <span>
            {t("balances.col.balance")} <b className="pd-num">{usd(figures.balance)}</b>
          </span>
          <span>
            {t("balances.col.upnl")}{" "}
            <b className={`pd-num ${trendClass(figures.unrealized)}`}>
              {signedUsd(figures.unrealized)}
            </b>
          </span>
          <span>
            {t("balances.col.available")} <b className="pd-num">{usd(figures.available)}</b>
          </span>
        </span>
      </span>
      {sum > 0 && (
        <span className="bal-split" data-picked={split.some((s) => s.on) || undefined} aria-hidden>
          {split.map((s) =>
            s.equity > 0 ? (
              <span
                key={s.key}
                className="bal-split-part"
                data-bal-tone={s.tone}
                data-on={s.on || undefined}
                style={{ flexGrow: s.equity / sum }}
              />
            ) : null,
          )}
        </span>
      )}
    </div>
  );
}

/** A figure's name, with what it means on hover where there's a hint. */
function Term({ label, hint }: { label: MessageKey; hint?: MessageKey }) {
  if (!hint) return <>{t(label)}</>;
  return (
    <Tooltip className="bal-term" content={<Hint title={t(label)}>{t(hint)}</Hint>}>
      {t(label)}
    </Tooltip>
  );
}

function Figure({
  label,
  hint,
  children,
}: {
  label: MessageKey;
  hint?: MessageKey;
  children: ReactNode;
}) {
  return (
    <div className="bal-figure">
      <dt>
        <Term label={label} hint={hint} />
      </dt>
      <dd className="pd-num">{children}</dd>
    </div>
  );
}

/**
 * The picked account's summary: the Account panel's figures (`accountTotals`,
 * with its venue's maximum leverage per market), laid out for this panel.
 */
function Summary({
  account,
  name,
  feed,
  onOpen,
}: {
  account: VenueAccount;
  name: string;
  feed: Feed | undefined;
  onOpen: (account: VenueAccount) => void;
}) {
  const markets = useMarkets(account.venue);
  const list = markets.status === "live" ? markets.data : undefined;
  const snapshot = feed?.snapshot;
  const sums = useMemo(
    () =>
      snapshot
        ? accountTotals(snapshot, (id) => list?.find((m) => m.id === id)?.maxLeverage)
        : undefined,
    [snapshot, list],
  );
  const ratio = sums?.maintenanceRatio ?? 0;
  return (
    <section className="bal-summary" aria-label={t("account.summary")}>
      <header className="bal-summary-head">
        <img className="bal-logo" src={venueLogos[account.venue]} alt="" />
        <span className="bal-summary-name">
          <span className="bal-summary-title">{name}</span>
          <span className="bal-tile-sub">{t("account.summary")}</span>
        </span>
        <button
          type="button"
          className="bal-open"
          title={t("balances.toTrade")}
          aria-label={t("balances.toTrade")}
          onClick={() => onOpen(account)}
        >
          <LuArrowUpRight size={15} aria-hidden />
        </button>
      </header>
      {sums ? (
        <>
          <div className="bal-ratio" data-level={ratioLevel(ratio)}>
            <span className="bal-ratio-head">
              <span className="bal-label">
                <Term label="account.marginRatio" hint="account.marginRatioHint" />
              </span>
              <span className="pd-num">{formatPercent(ratio)}</span>
            </span>
            <span className="bal-ratio-meter" aria-hidden>
              <span className="bal-ratio-fill" style={{ width: `${Math.min(1, ratio) * 100}%` }} />
            </span>
          </div>
          <dl className="bal-figures">
            <Figure label="account.portfolioValue">{usd(sums.equity)}</Figure>
            <Figure label="account.upnl">
              <span className={trendClass(sums.unrealizedPnl)}>
                {signedUsd(sums.unrealizedPnl)}
                {sums.pnlReturn !== undefined && (
                  <small className="bal-figure-note"> {formatSigned(sums.pnlReturn * 100)}%</small>
                )}
              </span>
            </Figure>
            <Figure label="account.initialMargin" hint="account.initialMarginHint">
              {usd(sums.marginUsed)}{" "}
              <small className="bal-figure-note">{formatPercent(sums.marginRatio)}</small>
            </Figure>
            <Figure label="account.maintenance" hint="account.maintenanceHint">
              {usd(sums.maintenanceMargin)}{" "}
              <small className="bal-figure-note">{formatPercent(ratio)}</small>
            </Figure>
            <Figure label="account.available" hint="account.availableHint">
              {usd(sums.available)}
            </Figure>
            <Figure label="account.leverage" hint="account.leverageHint">
              {formatNumber(sums.leverage, 2)}x
            </Figure>
          </dl>
        </>
      ) : (
        <span className="bal-tile-status" title={feed?.error}>
          {t(feed?.error ? "balances.unavailable" : "balances.loading")}
        </span>
      )}
    </section>
  );
}

export function BalancesPanel({
  accounts,
  venues,
  onOpen,
}: {
  accounts: AccountsState;
  /** The venues turned on, in the header's order. */
  venues: readonly VenueId[];
  /** Shows the account on the Trade page. */
  onOpen: (account: VenueAccount) => void;
}) {
  const venueList = venues.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `venueList` is `venues`, by value
  const listed = useMemo(() => balanceAccounts(accounts, venues), [accounts, venueList]);
  const [feeds, setFeeds] = useState<ReadonlyMap<string, Feed>>(new Map());
  const onFeed = useCallback((key: string, next: Feed | undefined) => {
    setFeeds((now) => {
      const was = now.get(key);
      if (was?.snapshot === next?.snapshot && was?.error === next?.error) return now;
      const map = new Map(now);
      if (next) map.set(key, next);
      else map.delete(key);
      return map;
    });
  }, []);
  const [picked, setPicked] = useState<string>();
  const count = listed.length;
  const tilesRef = useRef<HTMLDivElement>(null);
  // Whether there are tiles out of sight above or below, for the fades.
  const [more, setMore] = useState({ above: false, below: false });
  const measure = useCallback(() => {
    const el = tilesRef.current;
    if (!el) return;
    const next = {
      above: el.scrollTop > 2,
      below: el.scrollTop + el.clientHeight < el.scrollHeight - 2,
    };
    setMore((now) => (now.above === next.above && now.below === next.below ? now : next));
  }, []);
  // Measured again as tiles come and go (the list appears after the first render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `count` re-attaches to the new list
  useEffect(() => {
    const el = tilesRef.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, count]);

  const figures = useMemo(() => {
    const map = new Map<string, Figures>();
    for (const [key, feed] of feeds) if (feed.snapshot) map.set(key, figuresOf(feed.snapshot));
    return map;
  }, [feeds]);
  const sums = totals(listed, figures);
  const live = listed.filter((a) => kindOf(a) === "live");
  const demo = listed.filter((a) => kindOf(a) === "demo");
  const ordered = [...live, ...demo];
  const toneOf = (account: VenueAccount) =>
    ordered.findIndex((a) => accountKey(a) === accountKey(account)) % TONES;
  // The picked account, or the first while none is (or it's gone).
  const shown = listed.find((a) => accountKey(a) === picked) ?? listed[0];
  const shownKey = shown && accountKey(shown);

  if (!shown) {
    return (
      <div className="bal">
        <EmptyState>{t("balances.empty")}</EmptyState>
      </div>
    );
  }
  const nameOf = (account: VenueAccount) => accountName(accounts, account);
  /** The arrow keys pick the next or previous tile, and bring it into sight. */
  const onTilesKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const at = ordered.findIndex((a) => accountKey(a) === shownKey);
    if (step === undefined || at < 0) return;
    e.preventDefault();
    const next = ordered[(at + step + ordered.length) % ordered.length];
    if (!next) return;
    setPicked(accountKey(next));
    const tiles = tilesRef.current?.querySelectorAll<HTMLElement>(".bal-tile");
    const tile = tiles?.[ordered.indexOf(next)];
    tile?.focus();
    tile?.scrollIntoView({ block: "nearest" });
  };
  const split = (list: readonly VenueAccount[]) =>
    list.map((a) => ({
      key: accountKey(a),
      tone: toneOf(a),
      equity: figures.get(accountKey(a))?.equity ?? 0,
      on: accountKey(a) === shownKey,
    }));
  const tiles = (list: readonly VenueAccount[], total: number) =>
    list.map((account) => (
      <Tile
        key={accountKey(account)}
        account={account}
        name={nameOf(account)}
        total={total}
        tone={toneOf(account)}
        selected={accountKey(account) === shownKey}
        onSelect={() => setPicked(accountKey(account))}
        onFeed={onFeed}
      />
    ));
  return (
    <div className="bal">
      <div className="bal-totals">
        {live.length > 0 && (
          <Total
            label={t("balances.live")}
            figures={sums.live}
            count={live.length}
            split={split(live)}
          />
        )}
        {demo.length > 0 && (
          <Total
            label={t("balances.demoTotal")}
            figures={sums.demo}
            count={demo.length}
            split={split(demo)}
          />
        )}
      </div>
      <div className="bal-body">
        <div
          ref={tilesRef}
          className="bal-tiles"
          role="radiogroup"
          aria-label={t("panel.balances")}
          data-more-above={more.above || undefined}
          data-more-below={more.below || undefined}
          onScroll={measure}
          onKeyDown={onTilesKey}
        >
          {tiles(live, sums.live.equity)}
          {tiles(demo, sums.demo.equity)}
        </div>
        <Summary
          account={shown}
          name={nameOf(shown)}
          feed={feeds.get(accountKey(shown))}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}
