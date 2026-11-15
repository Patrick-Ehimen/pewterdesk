import type { Market } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { LuArrowUpRight, LuTicket } from "react-icons/lu";
import { useIdeaPrices } from "../../hooks/useIdeaPrices";
import { byCloseness, distance, type Idea, nearest, rewardRisk } from "../../lib/ideas";
import { VENUES } from "../../lib/venues";
import { ideaTitle } from "../ideas/IdeaChartChip";
import {
  BiasPill,
  Conviction,
  IdeaToken,
  levelColor,
  price as priceText,
  RiskBar,
  signedPct,
} from "../ideas/parts";

/**
 * The Ideas page beside the trade (after design/screens/100): the ideas on
 * the market on screen - what was written, the levels and how far each is,
 * reward to risk - with the ways to fill the ticket from one or open it;
 * and, when there are none here, the other ideas being watched, nearest a
 * level first. It reads only: the ticket still waits for the trader.
 */
export function IdeasPanel({
  ideas,
  market,
  current,
  price,
  canFill,
  onPick,
  onFill,
  onOpen,
  onShowMarket,
}: {
  /** Every idea, for those elsewhere. */
  ideas: readonly Idea[];
  market?: Market;
  /** The one drawn on the chart, if the market on screen has any. */
  current?: Idea;
  price?: number;
  canFill: boolean;
  onPick: (id: string) => void;
  onFill: () => void;
  onOpen: (idea: Idea) => void;
  onShowMarket: (idea: Idea) => void;
}) {
  const watching = ideas.filter((i) => i.status === "watching");
  const here = market
    ? watching.filter((i) => i.venue === market.venue && i.market === market.id)
    : [];
  const elsewhere = watching.filter((i) => !here.includes(i));
  const used = new Set(elsewhere.map((i) => i.venue));
  const priceOf = useIdeaPrices(used);
  const rr = current ? rewardRisk(current, price) : undefined;

  return (
    <section className="ideas-panel-kind">
      <header className="ideas-pk-head">
        <h3>{market ? t("ideas.panel.on", { symbol: market.symbol }) : t("nav.ideas")}</h3>
      </header>
      {current ? (
        <div className="ideas-pk-body">
          {here.length > 1 && (
            <div className="ideas-pk-picks">
              {here.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  aria-pressed={i.id === current.id}
                  onClick={() => onPick(i.id)}
                >
                  {ideaTitle(i)}
                </button>
              ))}
            </div>
          )}
          <div className="ideas-pk-title">
            <BiasPill bias={current.bias} />
            <span>{t(`ideas.tf.${current.timeframe}`)}</span>
            <Conviction value={current.conviction} />
          </div>
          {current.thesis && <p className="ideas-pk-thesis">{current.thesis}</p>}
          {current.levels.length > 0 && (
            <ul className="ideas-levels ideas-pk-levels">
              {[...current.levels]
                .sort((a, b) => b.price - a.price)
                .map((l) => (
                  <li key={l.id}>
                    <span className="ideas-swatch" style={{ background: levelColor(l.color) }} />
                    <b className={l.name ? undefined : "ideas-unnamed"}>
                      {l.name || t("ideas.unnamed")}
                    </b>
                    <span className="pd-num">{priceText(l.price, market?.tickSize)}</span>
                    <span className="pd-num ideas-dist">
                      {price ? signedPct(distance(price, l.price)) : "–"}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          {rr && (
            <div className="ideas-pk-rr">
              <span className="ideas-hint">{t("ideas.rr")}</span>
              <RiskBar rr={rr} />
            </div>
          )}
          <div className="ideas-pk-actions">
            <button
              type="button"
              className="rules-button"
              disabled={!canFill}
              title={canFill ? undefined : t("ideas.chip.fillNeedsRisk")}
              onClick={onFill}
            >
              <LuTicket size={13} aria-hidden />
              {t("ideas.chip.fill")}
            </button>
            <button type="button" className="rules-button" onClick={() => onOpen(current)}>
              <LuArrowUpRight size={13} aria-hidden />
              {t("ideas.chip.open")}
            </button>
          </div>
          <p className="ideas-hint ideas-pk-note">{t("ideas.panel.places")}</p>
        </div>
      ) : (
        <div className="ideas-pk-body">
          <p className="ideas-hint">
            {market ? t("ideas.panel.none", { symbol: market.symbol }) : t("ideas.panel.noMarket")}
          </p>
          {elsewhere.length > 0 && (
            <>
              <h4 className="ideas-record-sub">{t("ideas.panel.elsewhere")}</h4>
              <ul className="ideas-pk-list">
                {byCloseness(elsewhere, priceOf)
                  .slice(0, 8)
                  .map((idea) => {
                    const near = nearest(idea, priceOf(idea));
                    return (
                      <li key={idea.id}>
                        <button type="button" onClick={() => onShowMarket(idea)}>
                          <IdeaToken
                            venue={idea.venue}
                            market={idea.market}
                            symbol={idea.symbol}
                            size={18}
                          />
                          <span className="ideas-pk-name">
                            <b>{idea.symbol}</b>
                            <small>{VENUES[idea.venue].label}</small>
                          </span>
                          <BiasPill bias={idea.bias} />
                          <span className="pd-num ideas-dist">
                            {near ? signedPct(near.share) : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
