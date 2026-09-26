// Shared React components: presentational only, fed through props. Import
// venue-agnostic types from @pewterdesk/core only — never from an exchange
// package, and never call Tauri from here; the app owns data fetching.
// Styles: import "@pewterdesk/ui/src/styles/styles.css" once at the app root.

export { type Column, ColumnHeader, Hint } from "./components/common/ColumnHeader";
export { IconButton } from "./components/common/IconButton";
export { type MenuOption, OptionsMenu } from "./components/common/OptionsMenu";
export { StarButton } from "./components/common/StarButton";
export { EmptyState } from "./components/common/Status";
export { Switch } from "./components/common/Switch";
export { type Tab, Tabs } from "./components/common/Tabs";
export { FloatingTip, Tooltip } from "./components/common/Tooltip";
export {
  AccountSummary,
  type AccountTotals,
  accountTotals,
} from "./components/trading/AccountSummary";
export { MarketList } from "./components/trading/MarketList";
export { MarketPicker } from "./components/trading/MarketPicker";
export { MarketStatsBar } from "./components/trading/MarketStatsBar";
export {
  type BookLadder,
  type BookRow,
  bookLadder,
  OrderBookView,
  type PriceTrend,
  ROW_HEIGHT,
  type RowMode,
  usePriceTrend,
} from "./components/trading/OrderBookView";
export {
  OpenOrdersTable,
  PositionsTable,
  type SymbolFor,
} from "./components/trading/PositionsTable";
export { OrderBookSkeleton, TradesSkeleton } from "./components/trading/Skeletons";
export { TradesView } from "./components/trading/TradesView";
export {
  currentLocale,
  dateFormat,
  isLocale,
  LOCALES,
  type Locale,
  languageName,
  loadLocale,
  type MessageKey,
  t,
} from "./i18n";
export {
  decimalsOf,
  formatNumber,
  formatPercent,
  formatSigned,
  shortAddress,
  trendClass,
} from "./lib/format";
