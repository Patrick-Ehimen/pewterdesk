import { dateFormat, t } from "@pewterdesk/ui";
import {
  type Finding,
  findings,
  moveOf,
  type Rate,
  RECORD_PERIODS,
  type RecordPeriod,
  share,
  trackRecord,
} from "../../lib/ideaStats";
import { BIASES, type Idea, TIMEFRAMES } from "../../lib/ideas";
import { VENUES } from "../../lib/venues";
import { Segmented } from "../rules/parts";
import { ideaTitle } from "./IdeaChartChip";
import { RecordEmpty } from "./IdeasEmpty";
import { BiasPill, Conviction, IdeaToken, signedPct } from "./parts";

const day = dateFormat({ month: "short", day: "numeric" });
const pct = (r: number | undefined) => (r === undefined ? "–" : `${Math.round(r * 100)}%`);

/** "4.6d", "9h": how long, roughly. */
function span(ms: number | undefined): string {
  if (ms === undefined) return "–";
  const hours = ms / 3_600_000;
  return hours < 48 ? `${Math.max(1, Math.round(hours))}h` : `${(hours / 24).toFixed(1)}d`;
}

/** A hit rate as a labelled bar. */
function RateBar({ label, rate }: { label: string; rate: Rate }) {
  const s = share(rate);
  return (
    <div className="ideas-rate">
      <span>{label}</span>
      <span className="ideas-rate-track">
        <i style={{ width: `${(s ?? 0) * 100}%` }} />
      </span>
      <b className="pd-num">{pct(s)}</b>
      <small className="pd-num">{rate.graded > 0 ? `${rate.playedOut}/${rate.graded}` : ""}</small>
    </div>
  );
}

function findingText(f: Finding): string {
  if (f.kind === "conviction") {
    return t(
      f.high >= f.low ? "ideas.record.find.convictionGood" : "ideas.record.find.convictionBad",
      {
        high: pct(f.high),
        low: pct(f.low),
      },
    );
  }
  return t(f.kind === "weakBias" ? "ideas.record.find.weak" : "ideas.record.find.strong", {
    bias: t(`ideas.bias.${f.bias}`),
    n: f.playedOut,
    of: f.graded,
  });
}

/**
 * How the trader's calls went (after design/screens/99): the ideas closed
 * in a period, played out against wrong, the move in each idea's own
 * direction, how long they took, and the hit rate by bias, timeframe and
 * conviction. Graded by the trader's own verdict on price, never by trades.
 */
export function TrackRecord({
  ideas,
  period,
  onPeriod,
  onOpen,
  onWatching,
}: {
  ideas: readonly Idea[];
  period: RecordPeriod;
  onPeriod: (period: RecordPeriod) => void;
  onOpen: (idea: Idea) => void;
  onWatching: () => void;
}) {
  const record = trackRecord(ideas, period);
  const graded = record.playedOut + record.wrong;
  const said = findings(record);

  return (
    <div className="ideas-record">
      <div className="ideas-record-main">
        <div className="ideas-record-bar">
          <h2>{t("ideas.record.title")}</h2>
          <span className="ideas-hint">{t("ideas.record.how")}</span>
          <div style={{ flex: 1 }} />
          <Segmented
            label={t("ideas.record.period")}
            value={period}
            options={RECORD_PERIODS.map((p) => ({
              value: p,
              label: t(`ideas.record.period.${p}`),
            }))}
            onChange={onPeriod}
          />
        </div>
        <div className="ideas-kpis">
          <div className="ideas-kpi">
            <span>{t("ideas.record.closed")}</span>
            <b className="pd-num">{record.closed.length}</b>
            <small>{t("ideas.record.stillWatching", { n: record.watching })}</small>
          </div>
          <div className="ideas-kpi">
            <span>{t("ideas.record.playedOut")}</span>
            <b className="pd-num ideas-kpi-accent">
              {pct(graded ? record.playedOut / graded : undefined)}
            </b>
            <small>{t("ideas.record.ofGraded", { n: record.playedOut, of: graded })}</small>
          </div>
          <div className="ideas-kpi">
            <span>{t("ideas.record.avgWin")}</span>
            <b className="pd-num">{record.avgWin === undefined ? "–" : signedPct(record.avgWin)}</b>
            <small>
              {t("ideas.record.avgLoss", {
                pct: record.avgLoss === undefined ? "–" : signedPct(record.avgLoss),
              })}
            </small>
          </div>
          <div className="ideas-kpi">
            <span>{t("ideas.record.letGo")}</span>
            <b className="pd-num">{record.letGo}</b>
            <small>{t("ideas.record.letGoHint")}</small>
          </div>
          <div className="ideas-kpi">
            <span>{t("ideas.record.held")}</span>
            <b className="pd-num">{span(record.medianHeld)}</b>
            <small>{t("ideas.record.heldHint")}</small>
          </div>
        </div>

        <section className="ideas-panel ideas-record-table">
          {record.closed.length === 0 ? (
            <RecordEmpty
              watching={record.watching}
              anyClosed={ideas.some((i) => i.status !== "watching")}
              onWatching={onWatching}
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("ideas.record.col.idea")}</th>
                  <th>{t("ideas.editor.bias")}</th>
                  <th>{t("ideas.thesis")}</th>
                  <th>{t("ideas.record.col.noted")}</th>
                  <th>{t("ideas.record.col.held")}</th>
                  <th>{t("ideas.record.col.outcome")}</th>
                  <th className="n">{t("ideas.record.col.move")}</th>
                  <th>{t("ideas.conviction")}</th>
                </tr>
              </thead>
              <tbody>
                {record.closed.map((idea) => {
                  const move = moveOf(idea);
                  return (
                    <tr
                      key={idea.id}
                      tabIndex={0}
                      onClick={() => onOpen(idea)}
                      onKeyDown={(e) => e.key === "Enter" && onOpen(idea)}
                    >
                      <td>
                        <span className="ideas-record-idea">
                          <IdeaToken
                            venue={idea.venue}
                            market={idea.market}
                            symbol={idea.symbol}
                            size={20}
                          />
                          <b>{idea.symbol}</b>
                          <small>{VENUES[idea.venue].label}</small>
                        </span>
                      </td>
                      <td>
                        <BiasPill bias={idea.bias} />
                      </td>
                      <td className="ideas-record-thesis">{ideaTitle(idea)}</td>
                      <td>{day.format(idea.notedAt)}</td>
                      <td className="pd-num">
                        {span(idea.resolvedAt ? idea.resolvedAt - idea.notedAt : undefined)}
                      </td>
                      <td>
                        <span className="ideas-outcome" data-status={idea.status}>
                          {t(`ideas.tab.${idea.status}`)}
                        </span>
                      </td>
                      <td
                        className={`n pd-num ${move === undefined ? "" : move >= 0 ? "pd-up" : "pd-down"}`}
                      >
                        {move === undefined ? "–" : signedPct(move)}
                      </td>
                      <td>
                        <Conviction value={idea.conviction} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <aside className="ideas-panel ideas-record-side">
        <div className="ideas-side-head">
          <h2>{t("ideas.record.calls")}</h2>
        </div>
        {graded === 0 && <p className="ideas-hint ideas-record-fills">{t("ideas.record.fills")}</p>}
        <h3 className="ideas-record-sub">{t("ideas.record.byBias")}</h3>
        {BIASES.map((b) => (
          <RateBar key={b} label={t(`ideas.bias.${b}`)} rate={record.byBias[b]} />
        ))}
        <h3 className="ideas-record-sub">{t("ideas.record.byTimeframe")}</h3>
        {TIMEFRAMES.map((tf) => (
          <RateBar key={tf} label={t(`ideas.tf.${tf}`)} rate={record.byTimeframe[tf]} />
        ))}
        <h3 className="ideas-record-sub">{t("ideas.record.byConviction")}</h3>
        <div className="ideas-cal">
          {record.byConviction.map((r, i) => {
            const s = share(r);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: one column per conviction, 1 to 5
              <div key={i}>
                <em className="pd-num">{pct(s)}</em>
                <i style={{ height: `${Math.max(3, (s ?? 0) * 100)}%` }} />
                <span>{i + 1}</span>
              </div>
            );
          })}
        </div>
        <p className="ideas-hint ideas-cal-hint">{t("ideas.record.byConvictionHint")}</p>
        {said.length > 0 && (
          <div className="ideas-findings">
            {said.map((f) => (
              <p key={`${f.kind}`} className="ideas-finding">
                {findingText(f)}
              </p>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
