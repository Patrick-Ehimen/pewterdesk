import type { CandleInterval, Decimal, VenueId } from "@pewterdesk/core";
import {
  type ChartLevel,
  type ChartPin,
  decimalsOf,
  formatNumber,
  LevelsChart,
  t,
} from "@pewterdesk/ui";
import { LuMinus, LuTriangle } from "react-icons/lu";
import { useCandles } from "../../hooks/useVenueFeeds";
import { type Bias, type IdeaLevel, LEVEL_COLORS } from "../../lib/ideas";
import { LogoMark } from "../header/AppLogo";

/**
 * The tag palette's hues (BRAND.md: no green, red or warning orange, so a
 * level never reads as P&L or risk), each in two shades: sixteen colours,
 * one a level, identity only.
 */
const HUES = [205, 235, 265, 295, 325, 355, 95, 185] as const;
const hueOf = (color: number) => HUES[((color % LEVEL_COLORS) + LEVEL_COLORS) % HUES.length] ?? 205;
/** The second shade: lighter on a dark theme, darker on a light one. */
const shadeOf = (color: number, l: number) =>
  color % LEVEL_COLORS >= HUES.length ? (l > 0.65 ? -0.16 : 0.16) : 0;

/** OKLCH to `#rrggbb`, for the chart's canvas, which takes plain colours. */
export function oklchHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
  return `#${linear
    .map((x) => {
      const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/** The theme's tag lightness and chroma, as the page has them now. */
function tagTone(): { l: number; c: number } {
  const css = getComputedStyle(document.documentElement);
  const l = Number.parseFloat(css.getPropertyValue("--pd-tag-l"));
  const c = Number.parseFloat(css.getPropertyValue("--pd-tag-c"));
  return { l: Number.isFinite(l) ? l : 0.75, c: Number.isFinite(c) ? c : 0.11 };
}

/** A level's colour, the same on its swatch and its line on the chart. */
export function levelColor(color: number): string {
  const { l, c } = tagTone();
  return oklchHex(l + shadeOf(color, l), c, hueOf(color));
}

/** An idea's levels as the chart draws them: each in its own colour, with the trader's name for it. */
export const chartLevels = (levels: readonly IdeaLevel[]): ChartLevel[] =>
  levels.map((level) => ({
    id: level.id,
    price: level.price,
    color: levelColor(level.color),
    label: level.name,
  }));

/** A price as the market writes it: its tick's decimals, or a sensible guess. */
export function price(value: number, tick?: Decimal): string {
  if (tick) return formatNumber(value, decimalsOf(tick));
  const abs = Math.abs(value);
  return formatNumber(value, abs >= 1000 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 8);
}

/** A share as "+1.4%" / "−8.0%". */
export const signedPct = (share: number) =>
  `${share >= 0 ? "+" : "−"}${Math.abs(share * 100).toFixed(1)}%`;

/** The idea's direction: arrows in the market colours, a range in pewter. */
export function BiasPill({ bias }: { bias: Bias }) {
  return (
    <span className="ideas-bias" data-bias={bias}>
      {bias === "range" ? (
        <LuMinus size={11} aria-hidden />
      ) : (
        <LuTriangle size={9} aria-hidden className={bias === "bearish" ? "flip" : undefined} />
      )}
      {t(`ideas.bias.${bias}`)}
    </span>
  );
}

/** Conviction as five dots; clickable where it's being set. */
export function Conviction({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  const label = t("ideas.conviction.n", { n: value });
  if (!onChange) {
    return (
      <span className="ideas-conv" role="img" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <i key={n} data-on={n <= value || undefined} />
        ))}
      </span>
    );
  }
  return (
    <span className="ideas-conv" data-edit role="radiogroup" aria-label={t("ideas.conviction")}>
      {[1, 2, 3, 4, 5].map((n) => (
        // biome-ignore lint/a11y/useSemanticElements: five dots read as one scale
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={n === value}
          aria-label={t("ideas.conviction.n", { n })}
          data-on={n <= value || undefined}
          onClick={() => onChange(n)}
        />
      ))}
    </span>
  );
}

export const IDEA_INTERVALS: readonly CandleInterval[] = ["1h", "4h", "1d"];

/** A market's candles with the idea's levels on them (TradingView's Lightweight Charts). */
export function IdeaChart({
  venue,
  market,
  symbol,
  interval,
  levels,
  pins,
  onPick,
  className,
}: {
  venue: VenueId;
  market: string;
  /** Written faintly behind the candles. */
  symbol?: string;
  interval: CandleInterval;
  levels: readonly IdeaLevel[];
  pins?: readonly ChartPin[];
  onPick?: (price: number) => void;
  className?: string;
}) {
  const { feed } = useCandles(venue, market, interval);
  const candles = feed.status === "live" || feed.status === "closed" ? feed.data : [];
  return (
    <div className="ideas-chart">
      <LevelsChart
        candles={candles}
        levels={chartLevels(levels)}
        pins={pins}
        onPick={onPick}
        viewKey={`${venue}:${market}:${interval}`}
        watermark={symbol}
        className={className}
      />
      {candles.length === 0 &&
        (feed.status === "error" ? (
          <p className="ideas-chart-note">{t("ideas.chart.failed")}</p>
        ) : (
          // While the candles load: the logo, breathing.
          <div className="ideas-chart-note" role="status" aria-label={t("ideas.chart.loading")}>
            <svg className="ideas-chart-logo" viewBox="0 0 56 56" aria-hidden="true">
              <LogoMark x={0} y={0} size={56} />
            </svg>
          </div>
        ))}
    </div>
  );
}

/**
 * Reward to risk as a ratio and a bar: the reward's share against the
 * risk's, and each as a move from the entry. The info and warning colours,
 * never green, red or brass: it's a plan, not P&L.
 */
export function RiskBar({ rr }: { rr: { ratio: number; reward: number; risk: number } }) {
  return (
    <div className="ideas-rr">
      <div className="ideas-rr-head">
        <b className="pd-num">{rr.ratio.toFixed(1)} : 1</b>
        <span className="pd-num">
          {t("ideas.rr.reward", { pct: (rr.reward * 100).toFixed(1) })} ·{" "}
          {t("ideas.rr.risk", { pct: (rr.risk * 100).toFixed(1) })}
        </span>
      </div>
      <div className="ideas-rr-bar" role="img" aria-label={`${rr.ratio.toFixed(1)} : 1`}>
        <span className="ideas-rr-reward" style={{ flex: rr.reward }} />
        <span className="ideas-rr-risk" style={{ flex: rr.risk }} />
      </div>
    </div>
  );
}
