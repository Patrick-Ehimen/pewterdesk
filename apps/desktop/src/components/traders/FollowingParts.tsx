import { formatCompact, formatNumber, t } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import type { TraderMove, TraderSnapshot, TraderSource } from "../../api/venueClient";
import { traderName } from "../../hooks/useTraderWatch";
import { lanes, segments, WINDOW_MS } from "../../lib/timeline";
import {
  ALERT_CHANNELS,
  CHANGE_KINDS,
  type ListAlerts,
  listAlertsFor,
  MAX_FOLLOWED,
  parseKey,
  traderKey,
  useTraders,
} from "../../lib/traders";
import { TraderAvatar } from "./TraderAvatar";

// The Following page's parts after design/screens/95: a list's alerts, the
// legend for how often traders are checked, and the last 24 hours.

const AGREE_OPTIONS = [null, 2, 3, 4, 5, 6, 8, 10] as const;

/** A list's alerts: the default for its traders, and when enough of them agree. */
export function ListAlertsPanel({ listId, size }: { listId: string; size: number }) {
  const { state, setListAlerts } = useTraders();
  const [editing, setEditing] = useState(false);
  const a = listAlertsFor(state, listId);
  const set = (next: Partial<ListAlerts>) => setListAlerts(listId, { ...a, ...next });
  const toggle = <T extends string>(all: readonly T[], one: T) =>
    all.includes(one) ? all.filter((x) => x !== one) : [...all, one];
  const kinds = a.kinds.map((k) => t(`traders.kind.${k}`).toLowerCase()).join(", ");
  return (
    <>
      <header className="tr-panel-head tr-sub">
        <h3>{t("traders.listAlerts")}</h3>
        <span className="app-spacer" />
        <button type="button" className="tr-mini" onClick={() => setEditing((e) => !e)}>
          {t(editing ? "traders.listAlerts.done" : "traders.listAlerts.edit")}
        </button>
      </header>
      {editing ? (
        <div className="tr-list-alerts tr-list-alerts-edit">
          <div className="tr-chips tr-chips-left">
            {CHANGE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className="tr-chip"
                aria-pressed={a.kinds.includes(k)}
                onClick={() => set({ kinds: toggle(a.kinds, k) })}
              >
                {t(`traders.kind.${k}`)}
              </button>
            ))}
          </div>
          <label className="tr-input tr-input-wide">
            <span>{t("traders.listAlerts.above")}</span>
            <input
              inputMode="numeric"
              defaultValue={formatNumber(a.minValue, 0)}
              key={a.minValue}
              aria-label={t("traders.listAlerts.above")}
              onBlur={(e) => {
                const v = Number(e.target.value.replace(/[,\s$]/g, ""));
                if (Number.isFinite(v) && v >= 0) set({ minValue: v });
              }}
            />
            <span>USD</span>
          </label>
          <label className="tr-kv tr-agree-pick">
            <span>{t("traders.listAlerts.agree")}</span>
            <select
              value={a.agree ?? ""}
              onChange={(e) => set({ agree: e.target.value ? Number(e.target.value) : null })}
            >
              {AGREE_OPTIONS.filter(
                (n) => n === null || n <= Math.max(2, Math.min(size, MAX_FOLLOWED)),
              ).map((n) => (
                <option key={n ?? "off"} value={n ?? ""}>
                  {n === null
                    ? t("traders.listAlerts.agreeOff")
                    : t("traders.listAlerts.agreeN", { n })}
                </option>
              ))}
            </select>
          </label>
          <div className="tr-chips tr-chips-left">
            {ALERT_CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                className="tr-chip"
                aria-pressed={a.to.includes(c)}
                onClick={() => set({ to: toggle(a.to, c) })}
              >
                {t(`traders.alerts.to.${c}`)}
              </button>
            ))}
          </div>
          <p className="tr-note">{t("traders.listAlerts.hint")}</p>
        </div>
      ) : (
        <div className="tr-list-alerts">
          <div className="tr-kv">
            <span>{t("traders.listAlerts.when")}</span>
            <span>{kinds || t("traders.listAlerts.never")}</span>
          </div>
          <div className="tr-kv">
            <span>{t("traders.listAlerts.above")}</span>
            <span>${formatCompact(a.minValue)}</span>
          </div>
          <div className="tr-kv">
            <span>{t("traders.listAlerts.agree")}</span>
            <span>
              {a.agree
                ? t("traders.listAlerts.agreeN", { n: a.agree })
                : t("traders.listAlerts.agreeOff")}
            </span>
          </div>
          <div className="tr-kv">
            <span>{t("traders.listAlerts.to")}</span>
            <span>
              {a.to.map((c) => t(`traders.alerts.to.${c}`)).join(", ") ||
                t("traders.listAlerts.nowhere")}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

/** How often each source's traders are looked at. */
export function WatchLegend() {
  return (
    <footer className="tr-foot tr-legend">
      <span>
        <i className="tr-status" data-state="ok" />
        {t("traders.legend.hl")}
      </span>
      <span>
        <i className="tr-status" data-state="waiting" />
        {t("traders.legend.okx")}
      </span>
    </footer>
  );
}

const TICKS = 6;
/** Bars a trader's row stacks before counting the rest. */
const LANES = 3;

/** What each trader held over the last 24 hours, a bar a position. */
export function Timeline({
  keys,
  moves,
  snapshots,
  onOpen,
}: {
  keys: readonly string[];
  moves: readonly TraderMove[];
  snapshots: readonly TraderSnapshot[];
  onOpen: (source: TraderSource, id: string) => void;
}) {
  // Read once a render: the bars and the "now" line agree.
  const now = useMemo(() => Date.now(), []);
  const from = now - WINDOW_MS;
  const rows = useMemo(() => {
    const bySnap = new Map(snapshots.map((s) => [traderKey(s.source, s.id), s] as const));
    return keys.flatMap((key) => {
      const parsed = parseKey(key);
      if (!parsed) return [];
      const mine = moves.filter((m) => traderKey(m.source, m.id) === key);
      return [{ key, ...parsed, ...lanes(segments(mine, bySnap.get(key), now), LANES) }];
    });
  }, [keys, moves, snapshots, now]);
  const pct = (t0: number) => ((t0 - from) / WINDOW_MS) * 100;
  const hour = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <section className="tr-panel">
      <header className="tr-panel-head">
        <h3>{t("traders.timeline")}</h3>
        <span className="tr-muted">{t("traders.timelineHint")}</span>
        <span className="app-spacer" />
        <span className="tr-lg">
          <i data-side="long" />
          {t("traders.long")}
        </span>
        <span className="tr-lg">
          <i data-side="short" />
          {t("traders.short")}
        </span>
        <span className="tr-lg">
          <i data-now />
          {t("traders.timeline.now")}
        </span>
      </header>
      <div className="tr-tl">
        <div className="tr-tl-head">
          <span />
          <div className="tr-tl-ticks">
            {Array.from({ length: TICKS + 1 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of hour marks
              <span key={i}>{hour.format(from + (i * WINDOW_MS) / TICKS)}</span>
            ))}
          </div>
        </div>
        {rows.map((r) => (
          <div key={r.key} className="tr-tl-row">
            <button type="button" className="tr-who" onClick={() => onOpen(r.source, r.id)}>
              <TraderAvatar id={r.key} size={20} />
              <span className="tr-who-name">
                <b>{traderName(r.source, r.id)}</b>
              </span>
            </button>
            <div className="tr-tl-track" style={{ height: 14 + Math.max(1, r.rows.length) * 16 }}>
              {r.rows.length === 0 && (
                <span className="tr-tl-none">{t("traders.timeline.none")}</span>
              )}
              {r.rows.flatMap((lane, i) =>
                lane.map((b) => {
                  // A bar too short to see gets a little width, taken back from
                  // its left so it still ends where it ends (never past now).
                  const width = Math.max(0.6, pct(b.end) - pct(b.start));
                  const left = Math.max(0, Math.min(pct(b.start), pct(b.end) - width));
                  return (
                    <span
                      key={`${b.market}-${b.side}-${b.start}`}
                      className="tr-tl-bar"
                      data-side={b.side}
                      data-cut={!b.startKnown || undefined}
                      style={{ left: `${left}%`, width: `${width}%`, top: 7 + i * 16 }}
                      title={t(b.open ? "traders.timeline.barOpen" : "traders.timeline.barClosed", {
                        market: b.market,
                        side: t(b.side === "long" ? "traders.long" : "traders.short"),
                        from: b.startKnown ? hour.format(b.start) : t("traders.timeline.before"),
                        to: hour.format(b.end),
                      })}
                    >
                      {width > 6
                        ? `${b.market} ${t(b.side === "long" ? "traders.long" : "traders.short")}`
                        : ""}
                    </span>
                  );
                }),
              )}
              {r.hidden > 0 && (
                <span className="tr-tl-more">
                  {t("traders.timeline.more", { count: r.hidden })}
                </span>
              )}
              <span className="tr-tl-now" />
            </div>
          </div>
        ))}
      </div>
      <footer className="tr-foot">{t("traders.timeline.foot")}</footer>
    </section>
  );
}
