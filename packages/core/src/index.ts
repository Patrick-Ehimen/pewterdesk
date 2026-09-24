// ExchangeAdapter and the domain types (Order, Position, Market, OrderBook, ...)
// land here next. Every exchange package implements that interface.
export {
  isValidAccount,
  type SecretStore,
  SecretStoreError,
  type SecretStoreErrorKind,
  withSecret,
} from "./secrets";
