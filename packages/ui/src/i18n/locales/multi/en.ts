// The multi-venue ticket: one coin, an order on each venue ticked, each
// sized against that venue's own account. Kept apart from en.ts; spread into
// every locale's catalogue, so the other languages show it in English until
// it's translated.
export const multiEn = {
  "panel.multi": "Multi-venue ticket",

  "multi.coin": "Coin",
  "multi.coinHint":
    "The same coin on every venue ticked, whatever each calls it (kPEPE, 1000PEPE).",
  "multi.followScreen": "Use the market on screen",
  "multi.side": "Side",
  "multi.buy": "Buy / Long",
  "multi.sell": "Sell / Short",
  "multi.style": "Order",
  "multi.market": "Market",
  "multi.limit": "Limit",
  "multi.offset": "Inside the price",
  "multi.offsetHint":
    "Each venue's limit price, this far better than its own price: below it for a buy, above for a sell.",
  "multi.risk": "Risk per venue",
  "multi.riskHint":
    "What each venue's trade loses at its stop, as a share of that venue's own equity. 1% on a 2,000 account is 20; on a 5,000 one, 50. Sizes differ; the risk is even.",
  "multi.balance": "Size per venue",
  "multi.balanceHint":
    "With no stop, each order is this share of that venue's available margin, as position size.",
  "multi.stop": "Stop-loss",
  "multi.target": "Take-profit",
  "multi.exitHint":
    "A distance from each venue's own entry price, so every leg's stop and target sit the same % away. 0 for none.",
  "multi.noStopNote": "No stop: sized by the share of each available balance instead of by risk.",

  "multi.col.venue": "Venue",
  "multi.col.market": "Market",
  "multi.col.price": "Price",
  "multi.col.equity": "Equity",
  "multi.col.size": "Size",
  "multi.col.value": "Value",
  "multi.col.risk": "Risk",
  "multi.col.exits": "SL / TP",

  "multi.state.noAccount": "No account connected",
  "multi.state.paper": "Paper mode: left out",
  "multi.state.liveOff": "Live trading is off for this account",
  "multi.state.notListed": "{coin} isn't listed here",
  "multi.state.loading": "Loading…",
  "multi.problem.noPrice": "No price yet",
  "multi.problem.noFunds": "No equity on this account",
  "multi.problem.belowMin": "Under the market's smallest order",
  "multi.problem.overMargin": "More than the account can open",
  "multi.asterExits": "Aster takes the SL / TP on the position once the order fills.",
  "multi.asterLimitExits": "Aster can't take an SL / TP with a limit order: set it once it fills.",
  "multi.rules": "Your rules on this account: {message}",
  "multi.demo": "Demo",
  "multi.live": "Live",

  "multi.total": "{count} venues · {value} value · {risk} at risk",
  "multi.totalNoRisk": "{count} venues · {value} value",
  "multi.review": "Review {count} orders",
  "multi.reviewOne": "Review 1 order",
  "multi.nothing": "Tick a venue that can trade {coin}",
  "multi.confirmTitle": "Place these orders?",
  "multi.confirmBody":
    "One order on each venue, sent one after another. A venue that refuses doesn't stop the others; nothing is undone on the ones that went through.",
  "multi.confirmLine": "{side} {size} on {venue} ({value})",
  "multi.place": "Place {count} orders",
  "multi.back": "Back",
  "multi.placing": "Placing…",
  "multi.placed": "Placed",
  "multi.failed": "Refused: {reason}",
  "multi.protectFailed": "Placed, but the SL / TP wasn't set: {reason}",

  "multi.note.title": "Multi-venue order: {placed} of {count} placed",
  "multi.note.body": "{side} {coin} on {venues}",
};
