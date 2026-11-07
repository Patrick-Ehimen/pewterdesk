import { formatCompact, formatPercent, t } from "@pewterdesk/ui";
import { useMemo } from "react";
import type { TraderRow, TraderSource, TraderSwept } from "../../api/venueClient";
import { sizeText, traderName, useTraderSnapshots } from "../../hooks/useTraderWatch";
import { shortShare, topInsights } from "../../lib/topInsights";
import { agreement, followedKeys, parseKey, useActivity, useTraders } from "../../lib/traders";
import { ago } from "./Following";
import { Bar } from "./Skeletons";
import { TraderAvatar } from "./TraderAvatar";
import { Side } from "./TraderView";

interface Props {
  source: TraderSource;
  rows: readonly TraderRow[] | undefined;
  swept: readonly TraderSwept[];
  /** How many of the top traders are being read. */
  total: number;
  loading: boolean;
  onSelect: (row: TraderRow) => void;
}

/** A long / short split by value, long on the left. */
function Split({ short }: { short: number }) {
  return (
    <span className="tr-ls tr-ins-split">
      <i data-side="long" style={{ width: `${(1 - short) * 100}%` }} />
      <i data-side="short" style={{ width: `${short * 100}%` }} />
    </span>
  );
}

function CardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <span className="tr-skel tr-ins-skel" aria-hidden>
      <Bar width={46} height={16} />
      <Bar width={100} height={6} />
      {lines > 1 && <Bar width={70} />}
    </span>
  );
}

export function Insights({ source, rows, swept, total, loading, onSelect }: Props) {
  const insights = useMemo(() => topInsights(swept), [swept]);
  const { btc, mostHeld, biggestNew } = insights;
  const reading = swept.length < total;
  const progress = reading ? t("traders.ins.reading", { read: swept.length, total }) : undefined;
  const newRow = biggestNew && rows?.find((r) => `${r.source}:${r.id}` === biggestNew.key);
  const now = Date.now();

  return (
    <div className="tr-insights">
      <section className="tr-panel tr-ins" aria-busy={loading || undefined}>
        <span className="tr-ins-label">
          {t("traders.ins.btc", { n: total || TOP_TEXT[source] })}
          <em>{t("traders.ins.byNotional")}</em>
        </span>
        {loading ? (
          <CardSkeleton />
        ) : btc ? (
          <>
            <b className={shortShare(btc) >= 0.5 ? "pd-down" : "pd-up"}>
              {shortShare(btc) >= 0.5
                ? t("traders.ins.short", { pct: formatPercent(shortShare(btc), 0) })
                : t("traders.ins.long", { pct: formatPercent(1 - shortShare(btc), 0) })}
            </b>
            <Split short={shortShare(btc)} />
            <small>
              {t("traders.ins.btcHold", { count: btc.long + btc.short })}
              {progress && ` · ${progress}`}
            </small>
          </>
        ) : (
          <>
            <b className="tr-muted">{t("traders.ins.noBtc")}</b>
            {progress && <small>{progress}</small>}
          </>
        )}
      </section>

      <section className="tr-panel tr-ins" aria-busy={loading || undefined}>
        <span className="tr-ins-label">
          {t("traders.ins.mostHeld", { n: total || TOP_TEXT[source] })}
        </span>
        {loading ? (
          <span className="tr-skel tr-ins-skel" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="tr-ins-held">
                <Bar width={30} px />
                <Bar width={100} height={6} />
                <Bar width={60} />
              </span>
            ))}
          </span>
        ) : mostHeld.length === 0 ? (
          <b className="tr-muted">{t("traders.ins.none")}</b>
        ) : (
          mostHeld.map((a) => (
            <span key={a.market} className="tr-ins-held">
              <b>{a.market}</b>
              <Split short={shortShare(a)} />
              <span className="tr-muted">
                {t("traders.ins.traders", { count: a.long + a.short })}
              </span>
            </span>
          ))
        )}
      </section>

      <section className="tr-panel tr-ins" aria-busy={loading || undefined}>
        <span className="tr-ins-label">{t("traders.ins.new")}</span>
        {loading ? (
          <span className="tr-skel tr-ins-skel" aria-hidden>
            <span className="tr-skel-who">
              <span className="pd-skel tr-skel-avatar" style={{ width: 24, height: 24 }} />
              <Bar width={110} px />
            </span>
            <Bar width={80} />
          </span>
        ) : biggestNew && newRow ? (
          <button type="button" className="tr-ins-new" onClick={() => onSelect(newRow)}>
            <span className="tr-who">
              <TraderAvatar id={biggestNew.key} size={24} />
              <span className="tr-who-name">
                <b>{traderName(newRow.source, newRow.id, newRow.name)}</b>
                <small>
                  <Side side={biggestNew.side} /> {sizeText(biggestNew.size)} {biggestNew.market} ·
                  ${formatCompact(biggestNew.value)}
                </small>
              </span>
            </span>
            <small className="tr-muted">
              {t("traders.ins.newRank", {
                rank: (rows?.indexOf(newRow) ?? 0) + 1,
                ago: ago(biggestNew.at, now),
              })}
            </small>
          </button>
        ) : (
          <>
            <b className="tr-muted">{t("traders.ins.noNew")}</b>
            <small>{t(source === "okx" ? "traders.ins.noNewOkx" : "traders.ins.noNewHl")}</small>
          </>
        )}
      </section>

      <Followed />
    </div>
  );
}

const TOP_TEXT: Record<TraderSource, number> = { hyperliquid: 100, okx: 50 };

/** The traders followed: how many are in a trade, where most of them agree, their last move. */
function Followed() {
  const { state } = useTraders();
  const snapshots = useTraderSnapshots();
  const moves = useActivity();
  const keys = followedKeys(state);
  const inTrade = snapshots.filter((s) => s.holdings.length > 0).length;
  const lead = agreement(snapshots, keys)[0];
  const last = moves[0];
  return (
    <section className="tr-panel tr-ins">
      <span className="tr-ins-label">
        {t("traders.ins.followed")}
        {keys.length > 0 && <em>{t("traders.ins.ofFollowed", { total: keys.length })}</em>}
      </span>
      {keys.length === 0 ? (
        <>
          <b className="tr-muted">{t("traders.ins.noFollowed")}</b>
          <small>{t("traders.ins.starHint")}</small>
        </>
      ) : (
        <>
          <b>{t("traders.ins.inTrade", { count: inTrade })}</b>
          <small>
            {lead &&
              t("traders.ins.lead", {
                count: Math.max(lead.long, lead.short),
                side: t(lead.short > lead.long ? "traders.short" : "traders.long"),
                market: lead.market,
              })}
            {lead && last && " · "}
            {last &&
              parseKey(`${last.source}:${last.id}`) &&
              t("traders.ins.last", { ago: ago(last.at, Date.now()) })}
          </small>
        </>
      )}
    </section>
  );
}
