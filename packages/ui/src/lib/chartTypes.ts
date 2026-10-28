// The chart type menu's groups, after TradingView's: each is divided from
// the next by a line. Ids are the chart library's (and the app's own two
// profile types); any type the library lists that isn't here goes last.

export const CHART_TYPE_GROUPS: readonly (readonly string[])[] = [
  ["bar", "candlestick", "hollow-candle", "volume-candle"],
  ["line", "line-markers", "step"],
  ["area", "hlc-area", "baseline"],
  ["high-low"],
  ["session-volume-profile", "tpo"],
  ["heikin-ashi"],
  ["renko", "line-break", "kagi", "point-figure", "range-bars"],
];

/** `choices` (the types the chart offers) in their groups, in order; no empty group. */
export function groupedChartTypes(choices: readonly string[]): string[][] {
  const grouped = CHART_TYPE_GROUPS.map((g) => g.filter((id) => choices.includes(id)));
  const listed = new Set(CHART_TYPE_GROUPS.flat());
  grouped.push(choices.filter((id) => !listed.has(id)));
  return grouped.filter((g) => g.length > 0);
}

/** The starred types among `choices`, in the menu's order. */
export function favoriteChartTypes(
  choices: readonly string[],
  favorites: readonly string[],
): string[] {
  return groupedChartTypes(choices)
    .flat()
    .filter((id) => favorites.includes(id));
}
