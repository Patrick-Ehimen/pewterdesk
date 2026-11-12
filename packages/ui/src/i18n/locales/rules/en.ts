// The Trading rules page's explanations: the "?" tips, the sentences that
// spell out each setting, what saving a change does, and the order ticket's
// refusals with their figures. Kept apart from en.ts; spread into every
// locale's catalogue, so the other languages show them in English until
// they're translated.
export const rulesEn = {
  // The editor's sections
  "rules.group.account": "Account",
  "rules.group.accountDesc":
    "Which account these rules guard, and the size every percentage is taken from.",
  "rules.group.challenge": "Challenge",
  "rules.group.challengeDesc":
    "The profit to reach and the time to reach it in. Shown as progress: they never block an order.",
  "rules.group.losses": "Loss limits",
  "rules.group.lossesDesc": "How much the account may lose in a day and in total.",
  "rules.group.size": "Size and risk",
  "rules.group.sizeDesc":
    "Checked on every order that opens or adds to a position. Closing, reducing and cancelling are always allowed.",
  "rules.group.when": "When you trade",
  "rules.group.whenDesc": "When new positions are allowed.",
  "rules.group.tilt": "Tilt signals",
  "rules.group.tiltDesc": "Habits that often follow a loss.",

  // Labels the page didn't have
  "rules.label.position": "Max position size",
  "rules.label.positionSub": "per market",
  "rules.label.leverage": "Max leverage",
  "rules.label.leverageSub": "all positions together",
  "rules.label.breach": "When a loss limit is reached",
  "rules.label.start": "Preset or account size",
  "rules.label.on": "Rules on",
  "rules.help.open": "What is {label}?",

  // The "?" tips
  "rules.help.on":
    "Off, no order is checked. Turning rules off waits until 00:00 UTC, the same as loosening them.",
  "rules.help.account":
    "Rules belong to one account. Orders on your other accounts aren't checked against them.",
  "rules.help.name": "Only for you, to tell sets of rules apart.",
  "rules.help.accountSize":
    "Every percentage on this page is taken from this amount. Usually it's your balance when you start. Changing it starts the rules over.",
  "rules.help.breach":
    "What reaching the daily or overall loss limit does. Warn only: a notification, nothing is blocked. Warn at 80%: a warning first, then new positions are blocked. Lock: blocked at the limit, with no warning first.",
  "rules.help.target":
    "The profit the challenge asks for, as a share of the account size. Shown as progress; it never blocks an order.",
  "rules.help.days":
    "The fewest days you must trade, and the most the challenge allows. Shown as progress; they never block an order.",
  "rules.help.daily":
    "The most you may lose in one UTC day, open losses included. Day-start balance measures from the balance at 00:00 UTC; day-start equity from the balance plus open P&L then. It resets at 00:00 UTC.",
  "rules.help.max":
    "The most the account may fall in total. Static: the floor is fixed below the account size. Trailing intraday: the floor rises with the highest equity reached, until it reaches the account size. Trailing EOD: it rises with the highest end-of-day equity.",
  "rules.help.tradeLoss":
    "What one trade may lose if its stop-loss is hit: the distance from entry to stop, times the size. Require a stop refuses an order without a stop-loss; Warn only lets it through with a warning.",
  "rules.help.position":
    "The biggest one market's position may get, counted as its full size (quantity × price), not the margin, and including what you already hold there. 200 USD of position at 10× leverage uses 20 USD of margin, and counts as 200. Each market has its own room.",
  "rules.help.leverage":
    "All your open positions added together, divided by your equity. At 10× on 2,000 USD you may hold up to 20,000 USD across every market. This is a cap of yours, not the leverage set on the venue.",
  "rules.help.tradesPerDay":
    "How many trades you may make in one UTC day, counted from 00:00 UTC. Closing or reducing a position is never blocked.",
  "rules.help.hours":
    "New positions only inside this window, in UTC. Outside it you can still close, reduce and cancel.",
  "rules.help.news":
    "No new positions this many minutes before and after a high-impact USD release (CPI, FOMC, payrolls), from the economic calendar.",
  "rules.help.coolOff":
    "After this many losing trades in a row, new positions are blocked for this long.",
  "rules.help.revenge":
    "Re-entering a market soon after a loss on it. Warn only sends a notification; Require cool-off refuses the order until the time has passed.",
  "rules.help.sizeCreep":
    "A trade much bigger than your average, right after a loss. A warning only.",
  "rules.help.overtrading":
    "Trading faster than your own 30-day pace for this time of day. A warning only.",

  // Each setting in a sentence, with its own numbers
  "rules.says.accountSize": "1% of it is {amount} USD.",
  "rules.says.daily.warn":
    "Lose {amount} USD in a UTC day and you get a warning. Nothing is blocked.",
  "rules.says.daily.warnLock":
    "A warning at {warn} USD of loss in a UTC day. At {amount} USD, new positions stop until 00:00 UTC.",
  "rules.says.daily.lock":
    "At {amount} USD of loss in a UTC day, new positions stop until 00:00 UTC.",
  "rules.says.max.static": "The floor is {floor} USD: {amount} USD below the account size.",
  "rules.says.max.trailing":
    "The floor starts at {floor} USD and rises with your highest equity, staying {amount} USD below it.",
  "rules.says.target": "Reach {equity} USD of equity ({amount} USD of profit).",
  "rules.says.tradeLoss.stop":
    "Each trade may lose at most {amount} USD to its stop. Orders without a stop-loss are refused.",
  "rules.says.tradeLoss.warn":
    "Each trade may lose at most {amount} USD to its stop. Orders without a stop-loss get a warning.",
  "rules.says.position":
    "Any one market's position can be up to {amount} USD in size. At {leverage}× leverage that's {margin} USD of margin.",
  "rules.says.leverage":
    "All open positions together can be up to {amount} USD: {leverage}× the {size} USD account size.",
  "rules.says.tradesPerDay": "Up to {count} trades per UTC day.",
  "rules.says.hours.weekdays": "New positions Monday to Friday, {from}–{to} UTC.",
  "rules.says.hours.everyDay": "New positions every day, {from}–{to} UTC.",
  "rules.says.hours.local": "That's {from}–{to} your time.",
  "rules.says.news.on": "No new positions {minutes} min either side of a high-impact USD release.",
  "rules.says.news.off": "Off: news releases block nothing.",
  "rules.says.coolOff": "After {losses} losses in a row, no new positions for {time}.",

  // What saving does
  "rules.change.nowTitle": "Applies as soon as you save",
  "rules.change.nowBody": "These changes only make your rules stricter.",
  "rules.change.waitTitle": "Starts at 00:00 UTC, in {left}",
  "rules.change.waitBody":
    "Loosening a rule waits for the next UTC day, so a limit can't be lifted mid-session. {fields} loosen your rules, so everything you save starts {time}. Until then the rules in force still apply.",
  "rules.change.restart": "A new preset or account size also starts the rules' progress over.",
  "rules.change.off": "Turning the rules off",
  "rules.change.inForce": "in force: {value}",
  "rules.change.inForceTip":
    "This is what's checked until your change starts. Looser values wait for 00:00 UTC.",
  "rules.change.newRules": "New rules apply as soon as you save.",

  // The dashboard: a change waiting
  "rules.pending.title": "Changes waiting until {time}",
  "rules.pending.body":
    "Loosening waits for the next UTC day. Until then, the rules below still apply.",
  "rules.pending.offLine": "Rules turn off",
  "rules.pending.keep": "Keep current rules",
  "rules.pending.keepTip": "Cancel the waiting change and keep the rules in force.",

  // The dashboard's position and leverage, apart
  "rules.dash.position": "Largest position",
  "rules.dash.positionLimit": "{amount} USD per market",
  "rules.dash.leverage": "Leverage, all positions",
  "rules.dash.leverageValue": "{leverage}× · {exposure} USD",

  // The ticket: why, with the figures
  "rules.check.positionSize":
    "This would make the position {value} USD; your limit is {limit} USD per market.",
  "rules.check.leverage":
    "This would put {value}× your equity in open positions; your limit is {limit}×.",
  "rules.check.tradeRisk": "This risks {value} USD to its stop; a trade may risk {limit} USD.",
  "rules.check.dailyLeft":
    "This risks {value} USD to its stop; today has {limit} USD of loss left.",
  "rules.check.tradesPerDay": "You've made {value} of your {limit} trades today.",
  "rules.check.needsStop": "Add a stop-loss: your rules need one on every opening order.",
  "rules.check.pending": "Your new limit ({limit}) starts {time}.",
};
