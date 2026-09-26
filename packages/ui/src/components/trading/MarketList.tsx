import type { Market } from "@pewterdesk/core";
import { useId, useState } from "react";
import { t } from "../../i18n";
import { StarButton } from "../common/StarButton";
import { EmptyState } from "../common/Status";

interface MarketListProps {
  markets: Market[];
  /** `Market::id` of the selected market. */
  selected?: string;
  onSelect: (market: Market) => void;
  /** `Market::id`s on the watchlist. Omit both watchlist props to hide stars. */
  starred?: ReadonlySet<string>;
  onToggleStar?: (market: Market) => void;
}

type Filter = "all" | "watchlist";

export function MarketList({
  markets,
  selected,
  onSelect,
  starred,
  onToggleStar,
}: MarketListProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // One radio group per instance: the panel can appear more than once.
  const group = useId();
  const withStars = starred !== undefined && onToggleStar !== undefined;
  const needle = query.trim().toUpperCase();
  const shown = markets.filter(
    (m) =>
      (filter === "all" || starred?.has(m.id)) &&
      (!needle || m.symbol.toUpperCase().includes(needle)),
  );

  const empty =
    filter === "watchlist" && !needle
      ? t("markets.watchlistEmpty")
      : t("markets.noMatch", { query });

  return (
    <div className="pd-markets">
      <div className="pd-markets-bar">
        <input
          className="pd-input pd-markets-search"
          type="search"
          placeholder={t("markets.search")}
          aria-label={t("markets.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {withStars && (
          <fieldset className="pd-segmented">
            <legend className="pd-visually-hidden">{t("markets.show")}</legend>
            {(["all", "watchlist"] as const).map((f) => (
              <label key={f} data-checked={filter === f || undefined}>
                <input
                  type="radio"
                  name={group}
                  value={f}
                  checked={filter === f}
                  onChange={() => setFilter(f)}
                />
                {f === "all" ? t("markets.all") : t("markets.watchlist", { count: starred.size })}
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <table className="pd-table">
        <thead>
          <tr>
            {withStars && (
              <th className="pd-star-col">
                <span className="pd-visually-hidden">{t("markets.watchlistColumn")}</span>
              </th>
            )}
            <th>{t("col.market")}</th>
            <th className="pd-num">{t("col.maxLeverage")}</th>
            <th className="pd-num">{t("col.tickSize")}</th>
            <th className="pd-num">{t("col.sizeStep")}</th>
            <th className="pd-num">{t("col.minSize")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((market) => (
            <tr key={market.id} className="pd-row-select" aria-selected={market.id === selected}>
              {withStars && (
                <td className="pd-star-col">
                  <StarButton
                    starred={starred.has(market.id)}
                    name={market.symbol}
                    size={14}
                    className="pd-star-small"
                    onToggle={() => onToggleStar(market)}
                  />
                </td>
              )}
              <td>
                <button type="button" className="pd-row-button" onClick={() => onSelect(market)}>
                  {market.symbol}
                </button>
              </td>
              <td className="pd-num">{market.maxLeverage}x</td>
              <td className="pd-num">{market.tickSize}</td>
              <td className="pd-num">{market.sizeStep}</td>
              <td className="pd-num">{market.minSize}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <EmptyState>{empty}</EmptyState>}
    </div>
  );
}
