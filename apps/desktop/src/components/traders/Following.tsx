import { EmptyState, formatCompact, MapSeg, t } from "@pewterdesk/ui";
import { type FormEvent, useMemo, useState } from "react";
import { LuCheck, LuCircle, LuPlus, LuSquare, LuStar, LuTrash2 } from "react-icons/lu";
import type {
  TraderHolding,
  TraderMove,
  TraderSnapshot,
  TraderSource,
} from "../../api/venueClient";
import { moveText, traderName, useTraderSnapshots } from "../../hooks/useTraderWatch";
import {
  agreement,
  clearActivity,
  FOLLOWING,
  LIST_NAME_MAX,
  listKeys,
  MAX_FOLLOWED,
  parseKey,
  SOURCE_LISTS,
  traderKey,
  useActivity,
  useTraders,
} from "../../lib/traders";
import { ListAlertsPanel, Timeline, WatchLegend } from "./FollowingParts";
import { AgreeSkeleton, ChipsSkeleton, SideSkeleton } from "./Skeletons";
import { TraderAvatar } from "./TraderAvatar";
import { Side } from "./TraderView";

type Open = (source: TraderSource, id: string) => void;

/** "3 min. ago", in the app's language. */
export const ago = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000);
  const format = new Intl.RelativeTimeFormat(undefined, { style: "short", numeric: "auto" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
};

/** What followed traders did, newest first. */
export function ActivityFeed({
  moves,
  onOpen,
  compact = false,
}: {
  moves: readonly TraderMove[];
  onOpen: Open;
  compact?: boolean;
}) {
  const [only, setOnly] = useState<"all" | "alerts">("all");
  const [confirming, setConfirming] = useState(false);
  const all = useActivity();
  const shown = only === "alerts" ? moves.filter((m) => m.alert) : moves;
  const now = Date.now();
  return (
    <section className="tr-panel tr-feed" data-compact={compact || undefined}>
      <header className="tr-panel-head">
        <h3>{t("traders.activity")}</h3>
        <span className="app-spacer" />
        {all.length > 0 && !confirming && (
          <button type="button" className="tr-mini" onClick={() => setConfirming(true)}>
            {t("traders.activity.clear")}
          </button>
        )}
        <MapSeg
          options={["all", "alerts"] as const}
          value={only}
          onChange={setOnly}
          label={t("traders.activity")}
          text={(o) => t(`traders.activity.${o}`)}
        />
      </header>
      {confirming && (
        <div className="tr-confirm" role="alertdialog" aria-label={t("traders.activity.clear")}>
          <span>{t("traders.activity.clearAsk", { count: all.length })}</span>
          <span className="tr-confirm-actions">
            <button type="button" className="tr-mini" onClick={() => setConfirming(false)}>
              {t("traders.activity.keepIt")}
            </button>
            <button
              type="button"
              className="tr-mini tr-mini-danger"
              onClick={() => {
                clearActivity();
                setConfirming(false);
              }}
            >
              {t("traders.activity.clearYes")}
            </button>
          </span>
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState>{t("traders.activity.none")}</EmptyState>
      ) : (
        <ol className="tr-moves">
          {shown.map((m) => {
            const key = traderKey(m.source, m.id);
            return (
              <li
                key={`${key}-${m.at}-${m.change.market}`}
                data-alert={m.alert || undefined}
                data-new={now - m.at < 60 * 60_000 || undefined}
              >
                <TraderAvatar id={key} size={26} />
                <div>
                  <div className="tr-move-top">
                    <button
                      type="button"
                      className="tr-link"
                      onClick={() => onOpen(m.source, m.id)}
                    >
                      {traderName(m.source, m.id)}
                    </button>
                    <span className="tr-src">{t(`traders.source.short.${m.source}`)}</span>
                    <time>{ago(m.at, now)}</time>
                  </div>
                  <p>
                    <Side side={m.change.side} /> {moveText(m)}
                  </p>
                  <small>
                    {m.alert && <LuCheck size={11} aria-hidden />}
                    {t(m.alert ? "traders.activity.sent" : "traders.activity.quiet")}
                  </small>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <footer className="tr-foot">{t("traders.activity.keep")}</footer>
    </section>
  );
}

export function Following({ onOpen, onBrowse }: { onOpen: Open; onBrowse: () => void }) {
  const { state, setActive, createList, removeList } = useTraders();
  const snapshots = useTraderSnapshots();
  const moves = useActivity();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  // The list on screen: one of the trader's own, or one made by source.
  const bySource = (SOURCE_LISTS as readonly string[]).includes(state.active);
  const own = state.lists.find((l) => l.id === state.active) ?? state.lists[0];
  const listId = bySource ? state.active : (own?.id ?? FOLLOWING);
  const keys = useMemo(() => listKeys(state, listId), [state, listId]);
  const listName = (id: string) =>
    id === FOLLOWING
      ? t("traders.list.following")
      : id === "source:hyperliquid"
        ? t("traders.source.hyperliquid")
        : id === "source:okx"
          ? t("traders.source.okx")
          : (state.lists.find((l) => l.id === id)?.name ?? "");
  const byKey = useMemo(
    () => new Map(snapshots.map((s) => [traderKey(s.source, s.id), s] as const)),
    [snapshots],
  );
  const agree = useMemo(() => agreement(snapshots, keys).slice(0, 8), [snapshots, keys]);
  /** No one in the list has been checked yet: their first look is still out. */
  const waiting = keys.length > 0 && !keys.some((k) => byKey.has(k));
  const listMoves = useMemo(() => {
    const wanted = new Set(keys);
    return moves.filter((m) => wanted.has(traderKey(m.source, m.id))).slice(0, 60);
  }, [moves, keys]);
  const anyone = state.lists.some((l) => l.keys.length > 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) createList(name);
    setName("");
    setNaming(false);
  };

  if (!anyone) {
    return (
      <section className="tr-panel tr-empty">
        <span className="tr-empty-glyph">
          <LuStar size={22} aria-hidden />
        </span>
        <h2>{t("traders.empty.title", { max: MAX_FOLLOWED })}</h2>
        <p>{t("traders.empty.body")}</p>
        <button type="button" className="tr-primary" onClick={onBrowse}>
          {t("traders.empty.browse")}
        </button>
      </section>
    );
  }

  return (
    <div className="tr-following-grid">
      <section className="tr-panel tr-lists">
        <header className="tr-panel-head">
          <h3>{t("traders.lists")}</h3>
          <span className="app-spacer" />
          <button
            type="button"
            className="tr-icon"
            onClick={() => setNaming(true)}
            aria-label={t("traders.list.new")}
          >
            <LuPlus size={14} aria-hidden />
          </button>
        </header>
        <ul className="tr-list-names">
          {[...state.lists.map((l) => l.id), ...SOURCE_LISTS].map((id) => {
            const count = listKeys(state, id).length;
            const auto = (SOURCE_LISTS as readonly string[]).includes(id);
            if (auto && count === 0) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-current={id === listId || undefined}
                  onClick={() => setActive(id)}
                >
                  {id === FOLLOWING ? (
                    <LuStar size={13} aria-hidden />
                  ) : auto ? (
                    <LuSquare size={12} aria-hidden />
                  ) : (
                    <LuCircle size={12} aria-hidden />
                  )}
                  <span>{listName(id)}</span>
                  <span className="tr-muted">{count}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {naming && (
          <form className="tr-new-list" onSubmit={submit}>
            <input
              // biome-ignore lint/a11y/noAutofocus: opened by the button just pressed
              autoFocus
              value={name}
              maxLength={LIST_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => !name.trim() && setNaming(false)}
              placeholder={t("traders.list.name")}
              aria-label={t("traders.list.name")}
            />
            <button type="submit">{t("traders.list.create")}</button>
          </form>
        )}
        <header className="tr-panel-head tr-sub">
          <h3>{listName(listId)}</h3>
          <span className="app-spacer" />
          <span className="tr-muted">{t("traders.inTrade")}</span>
          {listId !== FOLLOWING && !bySource && (
            <button
              type="button"
              className="tr-icon"
              onClick={() => removeList(listId)}
              aria-label={t("traders.list.delete")}
            >
              <LuTrash2 size={13} aria-hidden />
            </button>
          )}
        </header>
        {keys.length === 0 ? (
          <p className="tr-note tr-pad">{t("traders.list.empty")}</p>
        ) : (
          <ul className="tr-members">
            {keys.map((key) => {
              const parsed = parseKey(key);
              if (!parsed) return null;
              const snap = byKey.get(key);
              return (
                <li key={key}>
                  <button type="button" onClick={() => onOpen(parsed.source, parsed.id)}>
                    <Status snapshot={snap} />
                    <TraderAvatar id={key} size={20} />
                    <span className="tr-member-name">{traderName(parsed.source, parsed.id)}</span>
                    <span className="tr-src">{t(`traders.source.short.${parsed.source}`)}</span>
                    <Net snapshot={snap} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {bySource ? (
          <p className="tr-note tr-pad">{t("traders.listAlerts.bySource")}</p>
        ) : (
          <ListAlertsPanel listId={listId} size={keys.length} />
        )}
        <WatchLegend />
      </section>

      <div className="tr-following-main">
        <section className="tr-panel">
          <header className="tr-panel-head">
            <h3>{t("traders.agree")}</h3>
            <span className="tr-muted">{t("traders.agreeHint")}</span>
          </header>
          {waiting ? (
            <AgreeSkeleton cards={Math.min(4, keys.length)} />
          ) : agree.length === 0 ? (
            <EmptyState>{t("traders.agree.none")}</EmptyState>
          ) : (
            <div className="tr-agree">
              {agree.map((a) => {
                const held = a.long + a.short;
                const net = a.longValue - a.shortValue;
                return (
                  <div key={a.market} className="tr-agree-card">
                    <div className="tr-agree-top">
                      <b>{a.market}</b>
                      <span className="tr-muted">
                        {t("traders.agree.of", { count: held, total: keys.length })}
                      </span>
                    </div>
                    <div className="tr-dots">
                      {Array.from({ length: keys.length }, (_, i) => (
                        <i
                          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of squares
                          key={i}
                          data-side={i < a.long ? "long" : i < held ? "short" : undefined}
                        />
                      ))}
                    </div>
                    <div className="tr-ls">
                      <i data-side="long" style={{ width: `${(a.long / held) * 100}%` }} />
                      <i data-side="short" style={{ width: `${(a.short / held) * 100}%` }} />
                    </div>
                    <span>
                      {a.long > 0 && (
                        <span className="pd-up">{t("traders.agree.long", { count: a.long })}</span>
                      )}
                      {a.long > 0 && a.short > 0 && " · "}
                      {a.short > 0 && (
                        <span className="pd-down">
                          {t("traders.agree.short", { count: a.short })}
                        </span>
                      )}
                    </span>
                    <small className="tr-muted">
                      {t("traders.agree.net", {
                        value: `${net > 0 ? "+" : net < 0 ? "−" : ""}$${formatCompact(Math.abs(net))}`,
                      })}
                    </small>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <Timeline keys={keys} moves={moves} snapshots={snapshots} onOpen={onOpen} />

        <section className="tr-panel">
          <header className="tr-panel-head">
            <h3>{t("traders.positions")}</h3>
          </header>
          <ul className="tr-books">
            {keys.map((key, i) => {
              const parsed = parseKey(key);
              const snap = byKey.get(key);
              if (!parsed) return null;
              const held = merged(snap?.holdings ?? []);
              return (
                <li key={key}>
                  <button
                    type="button"
                    className="tr-who"
                    onClick={() => onOpen(parsed.source, parsed.id)}
                  >
                    <TraderAvatar id={key} size={22} />
                    <span className="tr-who-name">
                      <b>{traderName(parsed.source, parsed.id)}</b>
                    </span>
                  </button>
                  <div className="tr-book">
                    {!snap ? (
                      <ChipsSkeleton i={i} />
                    ) : snap.at === 0 ? (
                      <span className="tr-warn">
                        {t("traders.watch.failed", { error: snap.error ?? "" })}
                      </span>
                    ) : held.length === 0 ? (
                      <span className="tr-muted">{t("traders.flat")}</span>
                    ) : (
                      held.slice(0, 6).map((h) => (
                        <span key={`${h.market}-${h.side}-${h.entry}`} className="tr-pos">
                          <Side side={h.side} /> {h.market}{" "}
                          <span className="tr-muted">${formatCompact(h.value)}</span>
                        </span>
                      ))
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <ActivityFeed moves={listMoves} onOpen={onOpen} compact />
    </div>
  );
}

/** One chip per market and side: an OKX trader's sub-positions added up. */
function merged(holdings: readonly TraderHolding[]): TraderHolding[] {
  const by = new Map<string, TraderHolding>();
  for (const h of holdings) {
    const k = `${h.market}|${h.side}`;
    const had = by.get(k);
    by.set(k, had ? { ...had, size: had.size + h.size, value: had.value + h.value } : h);
  }
  return [...by.values()].sort((a, b) => b.value - a.value);
}

/** A dot: checked fine (filled), not checked yet (hollow), or failing (warning). */
function Status({ snapshot }: { snapshot?: TraderSnapshot }) {
  const title = !snapshot
    ? t("traders.watch.waiting")
    : snapshot.error
      ? t("traders.watch.failed", { error: snapshot.error })
      : t("traders.watch.every", { seconds: snapshot.every });
  const state = !snapshot ? "waiting" : snapshot.error ? "error" : "ok";
  return <span className="tr-status" data-state={state} title={title} />;
}

function Net({ snapshot }: { snapshot?: TraderSnapshot }) {
  if (!snapshot) return <SideSkeleton />;
  // The first look failed: nothing to say about their side yet.
  if (snapshot.at === 0) return null;
  if (snapshot.holdings.length === 0)
    return <span className="tr-muted tr-net">{t("traders.flat")}</span>;
  const long = snapshot.holdings.filter((h) => h.side === "long").reduce((s, h) => s + h.value, 0);
  const short = snapshot.holdings
    .filter((h) => h.side === "short")
    .reduce((s, h) => s + h.value, 0);
  return <Side side={long >= short ? "long" : "short"} />;
}
