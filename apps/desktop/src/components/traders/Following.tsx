import { EmptyState, formatCompact, MapSeg, t } from "@pewterdesk/ui";
import { type FormEvent, useMemo, useState } from "react";
import { LuPlus, LuStar, LuTrash2 } from "react-icons/lu";
import type {
  TraderHolding,
  TraderMove,
  TraderSnapshot,
  TraderSource,
} from "../../api/venueClient";
import { moveText, traderName, useTraderSnapshots } from "../../hooks/useTraderWatch";
import {
  agreement,
  FOLLOWING,
  LIST_NAME_MAX,
  MAX_FOLLOWED,
  parseKey,
  traderKey,
  useActivity,
  useTraders,
} from "../../lib/traders";
import { TraderAvatar } from "./TraderAvatar";
import { Side } from "./TraderView";

type Open = (source: TraderSource, id: string) => void;

const ago = (at: number, now: number) => {
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
  const shown = only === "alerts" ? moves.filter((m) => m.alert) : moves;
  const now = Date.now();
  return (
    <section className="tr-panel tr-feed" data-compact={compact || undefined}>
      <header className="tr-panel-head">
        <h3>{t("traders.activity")}</h3>
        <span className="app-spacer" />
        <MapSeg
          options={["all", "alerts"] as const}
          value={only}
          onChange={setOnly}
          label={t("traders.activity")}
          text={(o) => t(`traders.activity.${o}`)}
        />
      </header>
      {shown.length === 0 ? (
        <EmptyState>{t("traders.activity.none")}</EmptyState>
      ) : (
        <ol className="tr-moves">
          {shown.map((m) => {
            const key = traderKey(m.source, m.id);
            return (
              <li key={`${key}-${m.at}-${m.change.market}`} data-alert={m.alert || undefined}>
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
                  <p>{moveText(m)}</p>
                  <small>{t(m.alert ? "traders.activity.sent" : "traders.activity.quiet")}</small>
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
  const list = state.lists.find((l) => l.id === state.active) ??
    state.lists[0] ?? { id: FOLLOWING, name: "", keys: [] };
  const keys = list.keys;
  const byKey = useMemo(
    () => new Map(snapshots.map((s) => [traderKey(s.source, s.id), s] as const)),
    [snapshots],
  );
  const agree = useMemo(() => agreement(snapshots, keys).slice(0, 8), [snapshots, keys]);
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
          {state.lists.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                aria-current={l.id === list.id || undefined}
                onClick={() => setActive(l.id)}
              >
                <span>{l.id === FOLLOWING ? t("traders.list.following") : l.name}</span>
                <span className="tr-muted">{l.keys.length}</span>
              </button>
            </li>
          ))}
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
          <h3>{list.id === FOLLOWING ? t("traders.list.following") : list.name}</h3>
          <span className="app-spacer" />
          {list.id !== FOLLOWING && (
            <button
              type="button"
              className="tr-icon"
              onClick={() => removeList(list.id)}
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
      </section>

      <div className="tr-following-main">
        <section className="tr-panel">
          <header className="tr-panel-head">
            <h3>{t("traders.agree")}</h3>
            <span className="tr-muted">{t("traders.agreeHint")}</span>
          </header>
          {agree.length === 0 ? (
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

        <section className="tr-panel">
          <header className="tr-panel-head">
            <h3>{t("traders.positions")}</h3>
          </header>
          <ul className="tr-books">
            {keys.map((key) => {
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
                      <span className="tr-muted">{t("traders.watch.waiting")}</span>
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
  if (!snapshot) return null;
  if (snapshot.holdings.length === 0)
    return <span className="tr-muted tr-net">{t("traders.flat")}</span>;
  const long = snapshot.holdings.filter((h) => h.side === "long").reduce((s, h) => s + h.value, 0);
  const short = snapshot.holdings
    .filter((h) => h.side === "short")
    .reduce((s, h) => s + h.value, 0);
  return <Side side={long >= short ? "long" : "short"} />;
}
