// Shared React components: presentational only, fed through props. Import
// venue-agnostic types from @pewterdesk/core only - never from an exchange
// package, and never call Tauri from here; the app owns data fetching.
// Styles: import "@pewterdesk/ui/src/styles/styles.css" once at the app root.

export {
  type Column,
  ColumnHeader,
  Hint,
} from "./components/common/ColumnHeader";
export {
  CommandPalette,
  type PaletteItem,
  type PalettePreview,
  type PaletteSection,
} from "./components/common/CommandPalette";
export { IconButton } from "./components/common/IconButton";
export { MarketSearch } from "./components/common/MarketSearch";
export {
  type CentreNote,
  NotificationCentre,
} from "./components/common/NotificationCentre";
export { type MenuOption, OptionsMenu } from "./components/common/OptionsMenu";
export { Select, type SelectOption } from "./components/common/Select";
export { StarButton } from "./components/common/StarButton";
export { EmptyState } from "./components/common/Status";
export { Switch } from "./components/common/Switch";
export { type Tab, Tabs } from "./components/common/Tabs";
export { Toasts } from "./components/common/Toasts";
export { FloatingTip, Tooltip } from "./components/common/Tooltip";
export { LiqHeatmap } from "./components/maps/LiqHeatmap";
export { LIQ_WINDOWS, Liquidations, type LiqWindow } from "./components/maps/Liquidations";
export {
  HEAT_INDEXES,
  HEAT_PERIODS,
  HEAT_SECTORS,
  HEAT_TOPS,
  type HeatCoin,
  type HeatGroup,
  type HeatSector,
  MarketHeatmap,
} from "./components/maps/MarketHeatmap";
export {
  RSI_SCOPES,
  RsiHeatmap,
  type RsiQuote,
  type RsiScope,
} from "./components/maps/RsiHeatmap";
export {
  AccountSummary,
  type AccountTotals,
  accountTotals,
} from "./components/trading/AccountSummary";
export { type AlertDraft, AlertsPopover, firedAlertText } from "./components/trading/AlertsPopover";
export { CandleChart, type CandleChartHandle } from "./components/trading/CandleChart";
export { ChartToolbar } from "./components/trading/ChartToolbar";
export {
  BAND,
  DEFAULT_DEPTH_DISPLAY,
  DepthChart,
  type DepthDisplay,
} from "./components/trading/DepthChart";
export { DepthView } from "./components/trading/DepthView";
export { FundingChart } from "./components/trading/FundingChart";
export {
  FundingHeatmap,
  type HeatmapRow,
} from "./components/trading/FundingHeatmap";
export { ListedBy } from "./components/trading/ListedBy";
export { MarketMovement, type MovementVenue } from "./components/trading/MarketMovement";
export { MarketPicker } from "./components/trading/MarketPicker";
export { MarketStatsBar } from "./components/trading/MarketStatsBar";
export { MiniChart } from "./components/trading/MiniChart";
export { OpenOrdersPanel } from "./components/trading/OpenOrdersPanel";
export {
  BOOK_GROUPS,
  BOOK_SIDES,
  BOOK_UNITS,
  type BookGroup,
  type BookLadder,
  type BookRow,
  type BookSides,
  BookSidesPicker,
  type BookUnit,
  bookLadder,
  changedLevels,
  groupStep,
  levelSizes,
  OrderBookView,
  type PriceTrend,
  ROW_HEIGHT,
  type RowMode,
  usePriceTrend,
} from "./components/trading/OrderBookView";
export { OrderTicket } from "./components/trading/OrderTicket";
export { type CardPosition, PnlCard } from "./components/trading/PnlCard";
export {
  PnlShareDialog,
  SHARE_TARGETS,
  type ShareTarget,
} from "./components/trading/PnlShareDialog";
export { PositionDrawer } from "./components/trading/PositionDrawer";
export {
  ClosedTradesTable,
  closedRoi,
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
export {
  DEFAULT_SCREENER_DISPLAY,
  Screener,
  type ScreenerDisplay,
} from "./components/trading/Screener";
export { SignalsFeed } from "./components/trading/SignalsFeed";
export {
  ChartSkeleton,
  OrderBookSkeleton,
  SummarySkeleton,
  TableSkeleton,
  TradesSkeleton,
} from "./components/trading/Skeletons";
export { Sparkline } from "./components/trading/Sparkline";
export { TICKER_RANGES, TickerCard, type TickerRange } from "./components/trading/TickerCard";
export {
  type IconLoader,
  type IconPeek,
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
  ACCOUNT_KINDS,
  ALERT_COOLDOWN_MS,
  ALERT_KINDS,
  type AlertChannel,
  type AlertCondition,
  type AlertContext,
  type AlertKind,
  type AlertRepeat,
  canFire,
  crossed,
  type FiredAlert,
  isToday,
  type MarketAlert,
  watchedValue,
} from "./lib/alerts";
export { roundToStep } from "./lib/calculator";
export { formatCountdown, INTERVAL_MS } from "./lib/chart";
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
  onTick,
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
  ALL_INTERVALS,
  CHART_TYPES,
  type ChartType,
  INDICATORS,
  type IndicatorId,
} from "./lib/indicators";
export { type LiqMap, liquidationMap, openInterestFromVolume } from "./lib/liqModel";
export {
  LIQ_SOURCES,
  type LiqEvent,
  type LiqSource,
  mergeLiquidations,
} from "./lib/liquidations";
export { RSI_CANDLES, RSI_FRAMES, type RsiFrame, rsiNowAndBefore } from "./lib/marketMaps";
export {
  closeOrder,
  intervalFor,
  type PnlPoint,
  type PositionFills,
  pnlSeries,
  positionFills,
  positionFunding,
} from "./lib/positionDetail";
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
export type { ShareCard } from "./lib/shareCard";
export { sizeFromPercent, ticketOrder } from "./lib/ticket";
export {
  clearToasts,
  dismissToast,
  orderText,
  type Toast,
  type ToastTone,
  toast,
  toastError,
} from "./lib/toasts";
export { type ExitKind, exitMove } from "./lib/tradeMarks";
