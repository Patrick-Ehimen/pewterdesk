// Shared React components: presentational only, fed through props. Import
// venue-agnostic types from @pewterdesk/core only - never from an exchange
// package, and never call Tauri from here; the app owns data fetching.
// Styles: import "@pewterdesk/ui/src/styles/styles.css" once at the app root.

export {
  type Column,
  ColumnHeader,
  Hint,
} from "./components/common/ColumnHeader";
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
export { CandleChart } from "./components/trading/CandleChart";
export { BAND, DepthChart } from "./components/trading/DepthChart";
export { DepthView } from "./components/trading/DepthView";
export { FundingChart } from "./components/trading/FundingChart";
export {
  FundingHeatmap,
  type HeatmapRow,
} from "./components/trading/FundingHeatmap";
export { ListedBy } from "./components/trading/ListedBy";
export { MarketPicker } from "./components/trading/MarketPicker";
export { MarketStatsBar } from "./components/trading/MarketStatsBar";
export {
  type BookLadder,
  type BookRow,
  bookLadder,
  changedLevels,
  levelSizes,
  OrderBookView,
  type PriceTrend,
  ROW_HEIGHT,
  type RowMode,
  usePriceTrend,
} from "./components/trading/OrderBookView";
export { OrderTicket } from "./components/trading/OrderTicket";
export {
  FundingHistoryTable,
  OpenOrdersTable,
  PositionsTable,
  type SymbolFor,
  TradeHistoryTable,
} from "./components/trading/PositionsTable";
export {
  QuickTrade,
  type QuickTradePosition,
} from "./components/trading/QuickTrade";
export { Screener } from "./components/trading/Screener";
export { SignalsFeed } from "./components/trading/SignalsFeed";
export {
  ChartSkeleton,
  OrderBookSkeleton,
  TradesSkeleton,
} from "./components/trading/Skeletons";
export { Sparkline } from "./components/trading/Sparkline";

export {
  type IconLoader,
  TokenIcon,
  TokenIconProvider,
} from "./components/trading/TokenIcon";
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
  avgFillTo,
  type DepthLevel,
  depthLevels,
  depthWithin,
  type Imbalance,
  imbalance,
  largestWalls,
  WALL_FACTOR,
  type Wall,
} from "./lib/depth";

export {
  decimalsOf,
  formatCompact,
  formatNumber,
  formatPercent,
  formatSigned,
  shortAddress,
  trendClass,
} from "./lib/format";

export {
  FUNDING_RESOLUTIONS,
  type FundingPoint,
  type FundingResolution,
  fundingSeries,
} from "./lib/funding";

export {
  changeOver,
  FILTERS,
  fundingApr,
  HL_ECOSYSTEM,
  type MarketState,
  marketState,
  matchesFilter,
  matchesSearch,
  OI_WINDOW_MS,
  type OiSamples,
  rsi,
  type ScreenerFilter,
  type ScreenerRow,
  type ScreenerSort,
  SIGNAL_RULES,
  type Signal,
  type SignalEvent,
  type SignalEventKind,
  screenerRows,
  signalEvents,
  signalFor,
  sortRows,
  trackOpenInterest,
} from "./lib/screener";
