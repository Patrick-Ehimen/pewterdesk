import { dateFormat, t } from "../../i18n";
import { formatSigned } from "../../lib/format";
import { fundingApr } from "../../lib/screener";
import { FloatingTip, TipRows, useHoveredRow } from "../common/Tooltip";

export interface HeatmapRow {
  /** Label, e.g. "HYPE". */
  label: string;
  /** One rate per hour, oldest first; undefined where the venue had none. */
  rates: (number | undefined)[];
}

/** Where colour saturates: ±0.005% per hour. */
const SCALE = 0.00005;
const HOUR_MS = 3_600_000;
/** Placeholder label widths (px), one per row, while history loads. */
const SKELETON_ROWS = [34, 42, 28, 38, 46, 30, 40, 36, 32];
const SKELETON_HOURS = 12;

/** Fixes the label column's width; the hour cells share what's left. */
const Columns = ({ hours }: { hours: number }) => (
  <colgroup>
    <col className="pd-heatmap-label-col" />
    {Array.from({ length: hours }, (_, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: one fixed column per hour
      <col key={i} />
    ))}
  </colgroup>
);

interface FundingHeatmapProps {
  rows: HeatmapRow[];
  /** Start of the first (oldest) hour, epoch ms; each column is one hour after it. */
  start?: number;
  loading?: boolean;
}

function HeatTip({ label, rate, from }: { label: string; rate?: number; from?: number }) {
  const hours = dateFormat({ hour: "2-digit", minute: "2-digit" });
  const title =
    from === undefined ? label : `${label} · ${hours.format(from)}–${hours.format(from + HOUR_MS)}`;
  if (rate === undefined)
    return <TipRows title={title} rows={[[t("heatmap.paid"), t("heatmap.none")]]} />;
  return (
    <TipRows
      title={title}
      rows={[
        [t("heatmap.rate"), `${formatSigned(rate * 100, 4)}%`],
        [t("heatmap.annual"), `${formatSigned(fundingApr(rate, 3600) * 100, 1)}%`],
        [t("heatmap.paid"), t(rate >= 0 ? "heatmap.longsPaid" : "heatmap.shortsPaid")],
      ]}
    />
  );
}

/**
 * Hourly funding for a handful of markets: orange where longs paid, blue
 * where shorts paid, stronger the bigger the rate.
 */
export function FundingHeatmap({ rows, start, loading }: FundingHeatmapProps) {
  const hover = useHoveredRow<HTMLTableElement>();
  // Cell keys are "<row index>:<hour index>".
  const hovered = (() => {
    if (hover.key === undefined) return undefined;
    const [r, i] = hover.key.split(":").map(Number) as [number, number];
    const row = rows[r];
    return (
      row && {
        label: row.label,
        rate: row.rates[i],
        from: start === undefined ? undefined : start + i * HOUR_MS,
      }
    );
  })();
  return (
    <section className="pd-side-card" aria-label={t("heatmap.title")}>
      <header className="pd-side-head">
        <h3>{t("heatmap.title")}</h3>
        <span className="pd-muted">{t("heatmap.span")}</span>
      </header>
      {loading && rows.length === 0 ? (
        <table className="pd-heatmap" aria-busy aria-label={t("heatmap.loading")}>
          <Columns hours={SKELETON_HOURS} />
          <tbody aria-hidden>
            {SKELETON_ROWS.map((width, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
              <tr key={r} className="pd-skel-row">
                <th scope="row" className="pd-heatmap-label">
                  <span className="pd-skel" style={{ width }} />
                </th>
                {Array.from({ length: SKELETON_HOURS }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: one fixed cell per hour
                  <td key={i} className="pd-heat pd-heat-skel">
                    <span className="pd-skel" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="pd-heatmap" ref={hover.containerRef} {...hover.handlers}>
          <caption className="pd-visually-hidden">
            {t("heatmap.title")} · {t("heatmap.span")}
          </caption>
          <Columns hours={rows[0]?.rates.length ?? SKELETON_HOURS} />
          <tbody>
            {rows.map((row, r) => (
              <tr key={row.label}>
                <th scope="row" className="pd-heatmap-label">
                  {row.label}
                </th>
                {row.rates.map((rate, i) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: one fixed cell per hour
                    key={i}
                    className="pd-heat"
                    data-side={rate === undefined ? undefined : rate >= 0 ? "long" : "short"}
                    style={{
                      opacity:
                        rate === undefined ? 1 : 0.18 + 0.82 * Math.min(Math.abs(rate) / SCALE, 1),
                    }}
                    data-key={`${r}:${i}`}
                    data-active={hover.key === `${r}:${i}` || undefined}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hovered && (
        <FloatingTip getAnchor={hover.anchor} className="pd-tip-row">
          <HeatTip {...hovered} />
        </FloatingTip>
      )}
      <footer className="pd-heatmap-legend">
        <span className="pd-legend-item">
          <i className="pd-legend-swatch" data-side="short" aria-hidden /> {t("heatmap.shortsPay")}
        </span>
        <span className="pd-legend-item">
          <i className="pd-legend-swatch" data-side="long" aria-hidden /> {t("heatmap.longsPay")}
        </span>
        <span className="pd-legend-scale pd-muted">
          ±{formatSigned(SCALE * 100, 3).replace("+", "")}%
        </span>
      </footer>
    </section>
  );
}
