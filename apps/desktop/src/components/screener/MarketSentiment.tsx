import { t } from "@pewterdesk/ui";
import { useId } from "react";
import { useFearGreed } from "../../hooks/useVenueFeeds";
import { bandOf, comparisons, type FearGreedBand, gaugePoint, sideOf } from "../../lib/fearGreed";
import { LoadingMark } from "../Splash";

// The Screener's market sentiment card, after Bybit's Key Metrics: the crypto
// Fear & Greed Index on a half-circle gauge from fear to greed, with
// yesterday's, last week's and last month's readings beside it.

const CX = 60;
const CY = 58;
const R = 46;
/** Where the gauge's tick dots sit: clear of the band's name at the foot. */
const TICKS = [15, 32.5, 50, 67.5, 85];

const bandText = (band: FearGreedBand) => t(`screens.fg.${band}`);

export function Gauge({ value }: { value: number }) {
  const gradient = useId();
  const band = bandOf(value);
  const start = gaugePoint(0, CX, CY, R);
  const end = gaugePoint(100, CX, CY, R);
  const at = gaugePoint(value, CX, CY, R);
  return (
    <svg
      className="sentiment-gauge"
      viewBox="0 0 120 66"
      role="img"
      aria-label={t("screens.fg.label", { value, band: bandText(band) })}
      data-side={sideOf(band)}
    >
      <defs>
        <linearGradient id={gradient} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" className="sentiment-stop-fear" />
          <stop offset="0.5" className="sentiment-stop-neutral" />
          <stop offset="1" className="sentiment-stop-greed" />
        </linearGradient>
      </defs>
      <path
        className="sentiment-wedge"
        d={`M${CX} ${CY} L${start.x} ${start.y} A${R} ${R} 0 0 1 ${at.x} ${at.y} Z`}
      />
      <path
        className="sentiment-arc"
        d={`M${start.x} ${start.y} A${R} ${R} 0 0 1 ${end.x} ${end.y}`}
        stroke={`url(#${gradient})`}
      />
      {TICKS.map((tick) => {
        const dot = gaugePoint(tick, CX, CY, R - 11);
        return <circle key={tick} className="sentiment-tick" cx={dot.x} cy={dot.y} r={1} />;
      })}
      <circle className="sentiment-knob" cx={at.x} cy={at.y} r={4.5} />
      <circle className="sentiment-knob-dot" cx={at.x} cy={at.y} r={1.8} />
    </svg>
  );
}

export function MarketSentiment() {
  const feed = useFearGreed();
  const days = feed.status === "live" ? feed.data : undefined;
  const today = days?.[0];
  return (
    <section className="sentiment" aria-label={t("screens.sentiment")}>
      <header className="sentiment-head">
        <h2>{t("screens.sentiment")}</h2>
        <span className="sentiment-sub pd-muted">{t("screens.fearGreed")}</span>
      </header>
      {today ? (
        <div className="sentiment-body">
          <div className="sentiment-dial" data-side={sideOf(bandOf(today.value))}>
            <Gauge value={today.value} />
            <div className="sentiment-reading">
              <span className="sentiment-value pd-num">{today.value}</span>
              <span className="sentiment-band">{bandText(bandOf(today.value))}</span>
            </div>
          </div>
          <dl className="sentiment-past">
            {comparisons(days).map(({ when, value }) => (
              <div key={when} className="sentiment-row" data-side={sideOf(bandOf(value))}>
                <dt>{t(`screens.fg.${when}`)}</dt>
                <dd>
                  <span className="sentiment-past-band">{bandText(bandOf(value))}</span>
                  <span className="sentiment-past-value pd-num">{value}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : feed.status === "error" ? (
        <p className="sentiment-empty pd-muted">{t("screens.fg.unavailable")}</p>
      ) : (
        <div className="sentiment-empty">
          <LoadingMark size={28} />
        </div>
      )}
      <span className="sentiment-source pd-muted">{t("screens.fg.source")}</span>
    </section>
  );
}
