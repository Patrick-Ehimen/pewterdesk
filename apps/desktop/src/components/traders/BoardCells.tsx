import { formatCompact, formatPercent, t } from "@pewterdesk/ui";
import type { TraderHolding, TraderSwept } from "../../api/venueClient";
import { PnlLine } from "./PnlLine";
import { Bar } from "./Skeletons";

// The leaderboard's cells that come from reading each top trader (their
// record and positions): green weeks, max drawdown, what they hold now and
// the month's line. While a trader's read is still out, a shimmer; past the
// traders that are read, a dash.

/** What a cell shows for a trader: their read, still coming, or never read. */
export type Read = TraderSwept | "pending" | undefined;

const Dash = () => <span className="tr-muted">–</span>;

/** Eight bars, a week each: up green, down red, height by size; empty before their history. */
export function GreenWeeks({ read }: { read: Read }) {
  if (read === "pending") return <Bar width={78} px height={16} />;
  const weeks = read?.stats?.weeks;
  if (!weeks) return <Dash />;
  const most = Math.max(...weeks.map((w) => Math.abs(w ?? 0)), 1);
  const green = weeks.filter((w) => (w ?? 0) > 0).length;
  return (
    <span
      className="tr-weeks-cell"
      title={t("traders.weeks.title", { green, total: weeks.filter((w) => w !== null).length })}
    >
      {weeks.map((w, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: a week's place
          key={i}
          data-side={w === null ? undefined : w > 0 ? "long" : w < 0 ? "short" : "flat"}
          style={{ height: w === null ? 3 : 4 + (Math.abs(w) / most) * 12 }}
        />
      ))}
    </span>
  );
}

export function Drawdown({ read }: { read: Read }) {
  if (read === "pending") return <Bar width={44} px />;
  const dd = read?.stats?.maxDrawdown;
  if (dd == null) return <Dash />;
  return (
    <span className={dd > 0 ? "pd-down" : undefined}>
      {dd > 0 ? `−${formatPercent(dd, 1)}` : "0%"}
    </span>
  );
}

/** Their open positions: the long / short split by value, and the biggest markets. */
export function Now({ read }: { read: Read }) {
  if (read === "pending") {
    return (
      <span className="tr-now">
        <Bar width={96} px height={5} />
        <Bar width={70} px height={7} />
      </span>
    );
  }
  if (!read) return <Dash />;
  const by = new Map<string, number>();
  let long = 0;
  let short = 0;
  for (const h of read.holdings as TraderHolding[]) {
    if (h.side === "long") long += h.value;
    else short += h.value;
    by.set(h.market, (by.get(h.market) ?? 0) + h.value);
  }
  const total = long + short;
  if (total <= 0) {
    return (
      <span className="tr-now">
        <span className="tr-ls" />
        <small>{t("traders.now.flat")}</small>
      </span>
    );
  }
  const top = [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([m]) => m);
  const shortShare = short / total;
  const label =
    Math.abs(long - short) / total < 0.1
      ? t("traders.now.hedged")
      : shortShare > 0.5
        ? t("traders.now.short", { pct: formatPercent(shortShare, 0) })
        : t("traders.now.long", { pct: formatPercent(1 - shortShare, 0) });
  return (
    <span className="tr-now" title={t("traders.now.title", { value: `$${formatCompact(total)}` })}>
      <span className="tr-ls">
        <i data-side="long" style={{ width: `${(1 - shortShare) * 100}%` }} />
        <i data-side="short" style={{ width: `${shortShare * 100}%` }} />
      </span>
      <small>
        {label} · {top.join(", ")}
      </small>
    </span>
  );
}

/** The month's PnL line: from their record, or OKX's ROI by day when it isn't read. */
export function Month({ read, fallback }: { read: Read; fallback: readonly number[] }) {
  if (read === "pending") return <Bar width={84} px height={18} />;
  const curve = read?.stats?.curve;
  const points =
    curve && curve.length > 1
      ? curve
      : fallback.length > 1
        ? fallback.map((v, i) => [i, v] as [number, number])
        : [];
  if (points.length < 2) return <Dash />;
  return <PnlLine points={points} height={22} label={t("traders.col.month")} />;
}
