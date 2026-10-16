import { type ReactNode, useState } from "react";
import { t } from "../../i18n";
import { formatNumber } from "../../lib/format";
import {
  type HourCell,
  type HourProfile,
  inSession,
  SESSIONS,
  type SessionStats,
  sessionsAt,
} from "../../lib/mapStats";
import { heat, MapFrame, MapState, signedPct } from "./kit";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const hourText = (h: number) => `${String(h).padStart(2, "0")}`;

/** The scale's full colour: the bigger of the grid's typical moves. */
function scaleOf(values: number[]) {
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.9)] ?? 0;
}

/**
 * A market's average hourly return by weekday and UTC hour over the last
 * weeks, with the hour's average over every day beneath: when it has
 * tended to rise or fall. The current hour is outlined.
 */
export function SeasonalityMap({
  grid,
  profile,
  days,
  controls,
  loader,
  error,
  now,
}: {
  grid: readonly (readonly (HourCell | undefined)[])[];
  profile: readonly HourProfile[];
  /** Days of candles behind it. */
  days: number;
  controls?: ReactNode;
  loader?: ReactNode;
  error?: string;
  now: number;
}) {
  const [hover, setHover] = useState<{ day: number; hour: number }>();
  const cells = grid.flat().filter((c): c is HourCell => c !== undefined);
  const scale = scaleOf(cells.map((c) => c.avg));
  const date = new Date(now);
  const today = (date.getUTCDay() + 6) % 7;
  const thisHour = date.getUTCHours();
  const tip = hover && grid[hover.day]?.[hover.hour];
  const best = [...profile].sort((a, b) => b.avg - a.avg);

  return (
    <MapFrame
      title={t("mapx.season.title")}
      controls={controls}
      legend={
        tip && hover ? (
          <span className="pd-num">
            {t("mapx.season.cell", {
              day: t(`mapx.day.${DAYS[hover.day] ?? "mon"}`),
              hour: hourText(hover.hour),
              avg: signedPct(tip.avg, 3),
              up: formatNumber(tip.upShare * 100, 0),
              count: tip.count,
            })}
          </span>
        ) : (
          cells.length > 0 && (
            <span className="pd-num">
              {t("mapx.season.best", {
                best: `${hourText(best[0]?.hour ?? 0)}:00`,
                worst: `${hourText(best[best.length - 1]?.hour ?? 0)}:00`,
              })}
            </span>
          )
        )
      }
      note={t("mapx.season.note", { days })}
      state={
        error ? (
          <MapState error={error} />
        ) : cells.length === 0 ? (
          <MapState loader={loader} />
        ) : undefined
      }
    >
      <div className="pd-mx-scroll">
        <div className="pd-mx-season" onPointerLeave={() => setHover(undefined)}>
          <span />
          {HOURS.map((h) => (
            <span key={h} className="pd-mx-season-hour pd-num">
              {h % 3 === 0 ? hourText(h) : ""}
            </span>
          ))}
          {DAYS.map((d, day) => (
            <div key={d} className="pd-mx-season-row">
              <span className="pd-mx-season-day">{t(`mapx.day.${d}`)}</span>
              {HOURS.map((h) => {
                const c = grid[day]?.[h];
                const tone = heat(c?.avg, scale);
                return (
                  <span
                    key={h}
                    className="pd-mx-season-cell"
                    data-heat={tone["data-heat"]}
                    data-now={(day === today && h === thisHour) || undefined}
                    style={tone.style}
                    onPointerEnter={() => setHover({ day, hour: h })}
                  />
                );
              })}
            </div>
          ))}
          <div className="pd-mx-season-row" data-all>
            <span className="pd-mx-season-day">{t("mapx.season.all")}</span>
            {profile.map((p) => {
              const tone = heat(p.avg, scale);
              return (
                <span
                  key={p.hour}
                  className="pd-mx-season-cell"
                  data-heat={tone["data-heat"]}
                  style={tone.style}
                  title={`${hourText(p.hour)}:00 UTC ${signedPct(p.avg, 3)}`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </MapFrame>
  );
}

/**
 * When a market trades: each UTC hour's share of the day's volume (bars)
 * and its average range (the line of dots), under the Asia, Europe and US
 * sessions, with each session's figures and the hour now marked.
 */
export function SessionsMap({
  profile,
  stats,
  days,
  controls,
  loader,
  error,
  now,
}: {
  profile: readonly HourProfile[];
  stats: readonly SessionStats[];
  days: number;
  controls?: ReactNode;
  loader?: ReactNode;
  error?: string;
  now: number;
}) {
  const thisHour = new Date(now).getUTCHours();
  const open = sessionsAt(now);
  const maxVol = Math.max(...profile.map((p) => p.volumeShare), 0.0001);
  const maxRange = Math.max(...profile.map((p) => p.range), 0.0001);
  const hasData = profile.some((p) => p.volumeShare > 0);

  return (
    <MapFrame
      title={t("mapx.sessions.title")}
      controls={controls}
      legend={
        <span>
          {open.length === 0
            ? t("mapx.sessions.closed")
            : t("mapx.sessions.open", {
                names: open.map((s) => t(`mapx.sessions.${s}`)).join(" · "),
              })}
        </span>
      }
      note={t("mapx.sessions.note", { days })}
      state={
        error ? <MapState error={error} /> : !hasData ? <MapState loader={loader} /> : undefined
      }
      side={
        hasData && (
          <div className="pd-mx-session-cards">
            {stats.map((s) => (
              <div
                key={s.id}
                className="pd-mx-session-card"
                data-session={s.id}
                data-on={open.includes(s.id) || undefined}
              >
                <strong>{t(`mapx.sessions.${s.id}`)}</strong>
                <span className="pd-muted pd-num">
                  {(() => {
                    const def = SESSIONS.find((d) => d.id === s.id);
                    return def ? `${hourText(def.start)}:00–${hourText(def.end)}:00 UTC` : "";
                  })()}
                </span>
                <dl>
                  <dt>{t("mapx.sessions.volume")}</dt>
                  <dd className="pd-num">{`${formatNumber(s.volumeShare * 100, 0)}%`}</dd>
                  <dt>{t("mapx.sessions.range")}</dt>
                  <dd className="pd-num">{`${formatNumber(s.range * 100, 2)}%`}</dd>
                  <dt>{t("mapx.sessions.drift")}</dt>
                  <dd className={`pd-num ${s.drift > 0 ? "pd-up" : s.drift < 0 ? "pd-down" : ""}`}>
                    {signedPct(s.drift)}
                  </dd>
                </dl>
              </div>
            ))}
          </div>
        )
      }
    >
      <div className="pd-mx-sessions">
        <div className="pd-mx-bands" aria-hidden>
          {SESSIONS.map((s) => (
            <span
              key={s.id}
              className="pd-mx-band"
              data-session={s.id}
              style={{
                left: `${(s.start / 24) * 100}%`,
                width: `${((s.end - s.start) / 24) * 100}%`,
              }}
            >
              {t(`mapx.sessions.${s.id}`)}
            </span>
          ))}
        </div>
        <div className="pd-mx-hours">
          {profile.map((p) => (
            <div
              key={p.hour}
              className="pd-mx-hour"
              data-now={p.hour === thisHour || undefined}
              data-sessions={SESSIONS.filter((s) => inSession(p.hour, s)).length}
              title={t("mapx.sessions.hour", {
                hour: `${hourText(p.hour)}:00`,
                volume: formatNumber(p.volumeShare * 100, 1),
                range: formatNumber(p.range * 100, 2),
              })}
            >
              <span
                className="pd-mx-hour-dot"
                style={{ bottom: `${(p.range / maxRange) * 100}%` }}
              />
              <span
                className="pd-mx-hour-bar"
                style={{ height: `${(p.volumeShare / maxVol) * 100}%` }}
              />
            </div>
          ))}
        </div>
        <div className="pd-mx-hour-labels pd-num" aria-hidden>
          {HOURS.map((h) => (
            <span key={h}>{h % 3 === 0 ? hourText(h) : ""}</span>
          ))}
        </div>
        <div className="pd-mx-legend-row">
          <span className="pd-mx-legend-item">
            <i className="pd-mx-key-bar" aria-hidden /> {t("mapx.sessions.volumeKey")}
          </span>
          <span className="pd-mx-legend-item">
            <i className="pd-mx-key-dot" aria-hidden /> {t("mapx.sessions.rangeKey")}
          </span>
        </div>
      </div>
    </MapFrame>
  );
}
