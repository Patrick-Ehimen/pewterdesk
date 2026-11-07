import { formatCompact, formatNumber, formatPercent, t } from "@pewterdesk/ui";
import { LuSend } from "react-icons/lu";
import type { TraderSide as SideOf, TraderDetail } from "../../api/venueClient";
import { activeHours, HOLD_BUCKETS, holdTimes, longShort, usualHold } from "../../lib/traderHabits";
import {
  ALERT_CHANNELS,
  alertsFor,
  CHANGE_KINDS,
  FOLLOWING,
  isFollowed,
  ownAlerts,
  type TraderAlerts,
  useTraders,
} from "../../lib/traders";
import { ago } from "./Following";
import { Bar, BarsSkeleton } from "./Skeletons";
import { Side } from "./TraderView";

// The trader's page's right-hand column (after design/screens/94): their
// alerts, how they trade, and how they sit against your own account.

/** Your own positions on the venue on screen, for "Against your account". */
export interface MyBook {
  /** The account, as the header names it: "HL · main". */
  label: string;
  positions: { market: string; side: SideOf; size: number; entry: number }[];
}

const HOLD_LABELS = ["<1h", "4h", "12h", "1d", "3d", "1w", "1w+"];

/** "7 h", "3 d": how long a stretch of time is, roughly. */
function span(ms: number): string {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** Alerts for one trader: when, how big, which markets, where to. */
export function AlertsCard({ traderKey: key, markets }: { traderKey: string; markets: string[] }) {
  const { state, setAlerts, resetAlerts } = useTraders();
  const followed = isFollowed(state, key);
  const alerts = alertsFor(state, key);
  const own = ownAlerts(state, key);
  const list = state.lists.find((l) => l.keys.includes(key) && state.listAlerts[l.id]);
  const set = (next: Partial<TraderAlerts>) => setAlerts(key, { ...alerts, ...next });
  const off = !followed || !alerts.on;
  const toggle = <T extends string>(all: readonly T[], one: T) =>
    all.includes(one) ? all.filter((x) => x !== one) : [...all, one];

  return (
    <section className="tr-panel">
      <header className="tr-panel-head">
        <h3>{t("traders.alerts")}</h3>
        <span className="app-spacer" />
        <button
          type="button"
          role="switch"
          className="tr-switch"
          aria-checked={followed && alerts.on}
          aria-label={t("traders.alerts.on")}
          disabled={!followed}
          onClick={() => set({ on: !alerts.on })}
        >
          <i />
        </button>
      </header>
      <div className="tr-alerts" data-off={off || undefined}>
        <div className="tr-alert-row">
          <div>
            {t("traders.alerts.when")}
            <small>{t("traders.alerts.whenHint")}</small>
          </div>
          <div className="tr-chips">
            {CHANGE_KINDS.map((k) => (
              <button
                type="button"
                key={k}
                className="tr-chip"
                aria-pressed={alerts.kinds.includes(k)}
                disabled={off}
                onClick={() => set({ kinds: toggle(alerts.kinds, k) })}
              >
                {t(`traders.kind.${k}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="tr-alert-row">
          <div>
            {t("traders.alerts.min")}
            <small>{t("traders.alerts.minHint")}</small>
          </div>
          <label className="tr-input">
            <input
              inputMode="numeric"
              disabled={off}
              defaultValue={formatNumber(alerts.minValue, 0)}
              key={alerts.minValue}
              aria-label={t("traders.alerts.min")}
              onBlur={(e) => {
                const v = Number(e.target.value.replace(/[,\s$]/g, ""));
                if (Number.isFinite(v) && v >= 0) set({ minValue: v });
              }}
            />
            <span>USD</span>
          </label>
        </div>
        <div className="tr-alert-row">
          <div>
            {t("traders.alerts.markets")}
            <small>{t("traders.alerts.marketsHint")}</small>
          </div>
          <div className="tr-chips">
            <button
              type="button"
              className="tr-chip"
              aria-pressed={alerts.markets.length === 0}
              disabled={off}
              onClick={() => set({ markets: [] })}
            >
              {t("traders.alerts.allMarkets")}
            </button>
            {markets.slice(0, 6).map((m) => (
              <button
                type="button"
                key={m}
                className="tr-chip"
                aria-pressed={alerts.markets.includes(m)}
                disabled={off}
                onClick={() => set({ markets: toggle(alerts.markets, m) })}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="tr-alert-row">
          <div>{t("traders.alerts.sendTo")}</div>
          <div className="tr-chips">
            {ALERT_CHANNELS.map((c) => (
              <button
                type="button"
                key={c}
                className="tr-chip"
                aria-pressed={alerts.to.includes(c)}
                disabled={off}
                onClick={() => set({ to: toggle(alerts.to, c) })}
              >
                {t(`traders.alerts.to.${c}`)}
              </button>
            ))}
            <button type="button" className="tr-chip" disabled title={t("traders.telegram.soon")}>
              <LuSend size={11} aria-hidden />
              Telegram
            </button>
          </div>
        </div>
        <p className="tr-note">
          {!followed
            ? t("traders.alerts.followFirst")
            : !own && list
              ? t("traders.alerts.fromList", {
                  list: list.id === FOLLOWING ? t("traders.list.following") : list.name,
                })
              : t("traders.alerts.where")}
          {followed && own && (
            <>
              {" "}
              <button type="button" className="tr-link" onClick={() => resetAlerts(key)}>
                {t("traders.alerts.useList")}
              </button>
            </>
          )}
        </p>
      </div>
    </section>
  );
}

/** What they trade, which side, how long they hold, when they're active. */
export function HowTheyTrade({ detail }: { detail: TraderDetail | undefined }) {
  if (!detail) {
    return (
      <section className="tr-panel" aria-busy="true">
        <header className="tr-panel-head">
          <h3>{t("traders.how")}</h3>
        </header>
        <BarsSkeleton rows={4} />
        <div className="tr-skel tr-pad" aria-hidden>
          <Bar width={100} height={6} />
        </div>
      </section>
    );
  }
  const split = longShort(detail.closed);
  const hold = holdTimes(detail.closed);
  const most = Math.max(...hold.counts, 1);
  const usual = usualHold(hold.counts);
  const hours = activeHours(detail.closed);
  const pad = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return (
    <section className="tr-panel">
      <header className="tr-panel-head">
        <h3>{t("traders.how")}</h3>
        {detail.closed.length > 0 && (
          <span className="tr-muted">{t("traders.howHint", { count: detail.closed.length })}</span>
        )}
      </header>
      {detail.preferred.length > 0 && (
        <div className="tr-bars">
          {detail.preferred.slice(0, 4).map(([coin, share]) => (
            <div key={coin} className="tr-bar-row">
              <span>{coin}</span>
              <span className="tr-bar">
                <i style={{ width: `${Math.min(100, share * 100)}%` }} />
              </span>
              <span className="tr-muted">{formatPercent(share, 0)}</span>
            </div>
          ))}
        </div>
      )}
      {split && (
        <div className="tr-how-row">
          <div className="tr-kv">
            <span>{t("traders.how.longShort")}</span>
            <span>
              {t("traders.how.split", {
                long: formatPercent(split.long, 0),
                short: formatPercent(split.short, 0),
              })}
            </span>
          </div>
          <span className="tr-ls tr-how-split">
            <i data-side="long" style={{ width: `${split.long * 100}%` }} />
            <i data-side="short" style={{ width: `${split.short * 100}%` }} />
          </span>
        </div>
      )}
      <div className="tr-how-row">
        <div className="tr-kv">
          <span>{t("traders.how.hold")}</span>
          <span>
            {hold.known > 0
              ? t("traders.how.holdMost", { span: HOLD_LABELS[usual] ?? "" })
              : detail.fillsFrom
                ? t("traders.how.holdLonger", { span: span(Date.now() - detail.fillsFrom) })
                : t("traders.how.holdUnknown")}
          </span>
        </div>
        {hold.known > 0 && (
          <>
            <div className="tr-hold">
              {hold.counts.map((c, i) => (
                <i
                  key={HOLD_BUCKETS[i]}
                  data-top={(c > 0 && c >= most * 0.6) || undefined}
                  style={{ height: `${Math.max(6, (c / most) * 100)}%` }}
                  title={`${HOLD_LABELS[i]}: ${c}`}
                />
              ))}
            </div>
            <div className="tr-hold-axis">
              {HOLD_LABELS.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </div>
          </>
        )}
      </div>
      {hours && (
        <div className="tr-how-row">
          <div className="tr-kv">
            <span>{t("traders.how.hours")}</span>
            <span>
              {pad(hours.from)}–{pad(hours.to)} · {formatPercent(hours.share, 0)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

/** Where the trader and you hold the same markets: the same side, or opposite. */
export function AgainstYou({
  detail,
  mine,
}: {
  detail: TraderDetail | undefined;
  mine: MyBook | undefined;
}) {
  const now = Date.now();
  const theirs = new Map<string, { side: SideOf; value: number; openedAt: number | null }>();
  for (const h of detail?.holdings ?? []) {
    const had = theirs.get(h.market.toUpperCase());
    const signed =
      (h.side === "long" ? 1 : -1) * h.value +
      (had ? (had.side === "long" ? 1 : -1) * had.value : 0);
    theirs.set(h.market.toUpperCase(), {
      side: signed >= 0 ? "long" : "short",
      value: Math.abs(signed),
      openedAt: h.openedAt ?? had?.openedAt ?? null,
    });
  }
  const overlaps = (mine?.positions ?? []).flatMap((p) => {
    const them = theirs.get(p.market.toUpperCase());
    return them ? [{ mine: p, them }] : [];
  });
  return (
    <section className="tr-panel">
      <header className="tr-panel-head">
        <h3>{t("traders.against")}</h3>
        {mine && <span className="tr-muted">{mine.label}</span>}
      </header>
      {!detail ? (
        <div className="tr-skel tr-pad" aria-hidden>
          <Bar width={80} />
        </div>
      ) : !mine ? (
        <p className="tr-note tr-pad">{t("traders.against.connect")}</p>
      ) : overlaps.length === 0 ? (
        <p className="tr-note tr-pad">{t("traders.against.none")}</p>
      ) : (
        <ul className="tr-against">
          {overlaps.map(({ mine: p, them }) => {
            const same = p.side === them.side;
            return (
              <li key={`${p.market}-${p.side}`}>
                <div>
                  <b>
                    {p.market} ·{" "}
                    {same
                      ? t("traders.against.both", {
                          side: t(p.side === "long" ? "traders.long" : "traders.short"),
                        })
                      : t("traders.against.opposite")}
                  </b>
                  <small>
                    {t("traders.against.yours", {
                      size: formatNumber(p.size, p.size < 10 ? 4 : 2),
                      market: p.market,
                      price: formatNumber(p.entry, p.entry < 10 ? 4 : 2),
                    })}{" "}
                    · <Side side={them.side} /> ${formatCompact(them.value)}
                    {them.openedAt ? ` · ${ago(them.openedAt, now)}` : ""}
                  </small>
                </div>
                <span className="tr-against-tag" data-same={same || undefined}>
                  {t(same ? "traders.against.same" : "traders.against.opp")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <footer className="tr-foot">{t("traders.against.private")}</footer>
    </section>
  );
}
