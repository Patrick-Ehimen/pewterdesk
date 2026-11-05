import { t } from "@pewterdesk/ui";
import { useCallback, useMemo, useState } from "react";
import { LuCheck, LuPlus, LuSearch, LuX } from "react-icons/lu";
import { ALL_MARKETS, expandMarkets, isMarketRule, marketIn, ruleQuote } from "../../lib/journal";
import type { PlanContext } from "./PlanPage";
import { ChipGroup, groupByQuote, hueOf, marketHue, tagHue } from "./parts";

/**
 * The markets a plan trades: what's picked first, then the venue's busiest,
 * and a search over every market the venue lists to add any other.
 */
export function MarketPicker({
  ctx,
  picked,
  onChange,
}: {
  ctx: PlanContext;
  picked: readonly string[];
  onChange: (markets: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // What's picked: rules ("all USDT pairs", "all markets") and markets one by one.
  const rules = useMemo(() => picked.filter(isMarketRule), [picked]);
  const ones = useMemo(() => picked.filter((id) => !isMarketRule(id)), [picked]);
  const quoteOf = useMemo(() => new Map(ctx.markets.map((m) => [m.id, m.quote])), [ctx.markets]);
  const covered = useCallback(
    (id: string) =>
      rules.length > 0 &&
      marketIn(rules, { venue: ctx.venue, market: id }, quoteOf.get(id) ?? undefined),
    [rules, ctx.venue, quoteOf],
  );
  const pickedSet = useMemo(() => new Set(ones), [ones]);
  const total = useMemo(() => expandMarkets(picked, ctx.markets).length, [picked, ctx.markets]);
  const toggle = (id: string) =>
    onChange(pickedSet.has(id) ? picked.filter((m) => m !== id) : [...picked, id]);
  const allPicked = rules.includes(ALL_MARKETS);
  // A list picked one by one before rules (a whole quote's markets) still folds, for display.
  const grouped = useMemo(() => groupByQuote(ones, ctx.markets), [ones, ctx.markets]);
  const found = useMemo(
    () =>
      q
        ? ctx.markets
            .filter(
              (m) =>
                !pickedSet.has(m.id) &&
                !covered(m.id) &&
                (ctx.symbolFor(m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q)),
            )
            .slice(0, 40)
            .map((m) => m.id)
        : ctx.markets
            .slice(0, 60)
            .map((m) => m.id)
            .filter((id) => !pickedSet.has(id) && !covered(id)),
    [ctx, q, pickedSet, covered],
  );
  const chip = (id: string) => (
    <button
      key={id}
      type="button"
      className="jr-chip"
      data-pick=""
      style={hueOf(marketHue(id))}
      aria-pressed={pickedSet.has(id)}
      onClick={() => toggle(id)}
    >
      {!pickedSet.has(id) && <LuPlus size={11} aria-hidden />}
      {ctx.symbolFor(id)}
    </button>
  );
  return (
    <div className="jr-marketpick">
      <div className="jr-marketpick-bulk">
        {/* Every market the venue lists, as one rule: it holds on any venue (a
            playbook is the trader's, not one venue's), and takes in new listings. */}
        <button
          type="button"
          className="jr-button jr-quiet"
          aria-pressed={allPicked}
          disabled={allPicked}
          onClick={() => onChange([ALL_MARKETS])}
        >
          {allPicked ? <LuCheck size={12} aria-hidden /> : <LuPlus size={12} aria-hidden />}
          {t("plan.plan.allMarkets")}
          <span className="jr-muted pd-num">{ctx.markets.length}</span>
        </button>
        {picked.length > 0 && (
          <button
            type="button"
            className="jr-link jr-marketpick-clear"
            onClick={() => onChange([])}
          >
            {t("plan.plan.clearMarkets", { n: total })}
          </button>
        )}
      </div>
      {picked.length > 0 && (
        <ChipGroup className="jr-chips jr-chips-scroll" label={t("plan.plan.marketsPicked")}>
          {rules.map((r) => {
            const quote = ruleQuote(r);
            const name =
              quote === "*" ? t("plan.plan.allMarkets") : t("plan.plan.allPairs", { quote });
            const n = expandMarkets([r], ctx.markets).length;
            return (
              <span
                key={r}
                className="jr-chip"
                data-pick=""
                data-on=""
                style={hueOf(tagHue(quote))}
              >
                {name}
                <span className="pd-num">{n}</span>
                <button
                  type="button"
                  className="jr-chip-x"
                  aria-label={t("plan.remove", { name })}
                  onClick={() => onChange(picked.filter((x) => x !== r))}
                >
                  <LuX size={11} aria-hidden />
                </button>
              </span>
            );
          })}
          {grouped.whole.map((w) => (
            <span
              key={w.quote}
              className="jr-chip"
              data-pick=""
              data-on=""
              style={hueOf(tagHue(w.quote))}
            >
              {t("plan.plan.allPairs", { quote: w.quote })}
              <span className="pd-num">{w.ids.length}</span>
              <button
                type="button"
                className="jr-chip-x"
                aria-label={t("plan.remove", { name: t("plan.plan.allPairs", { quote: w.quote }) })}
                onClick={() => {
                  const drop = new Set(w.ids);
                  onChange(picked.filter((id) => !drop.has(id)));
                }}
              >
                <LuX size={11} aria-hidden />
              </button>
            </span>
          ))}
          {grouped.rest.map(chip)}
        </ChipGroup>
      )}
      <label className="jr-search jr-marketpick-search">
        <LuSearch size={13} aria-hidden />
        <input
          value={query}
          placeholder={t("plan.plan.marketSearch")}
          aria-label={t("plan.plan.marketSearch")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const first = found[0];
            if (e.key === "Enter" && first) {
              e.preventDefault();
              toggle(first);
              setQuery("");
            } else if (e.key === "Escape") setQuery("");
          }}
        />
      </label>
      {found.length > 0 ? (
        <ChipGroup className="jr-chips jr-chips-scroll" label={t("plan.plan.markets")}>
          {found.map(chip)}
        </ChipGroup>
      ) : (
        q && <p className="jr-hint">{t("plan.plan.noMarketMatch", { q: query.trim() })}</p>
      )}
    </div>
  );
}
