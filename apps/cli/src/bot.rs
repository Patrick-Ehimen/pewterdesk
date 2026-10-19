//! `pd bot ...`: making bots, backtesting them, and moving them from
//! paper to live through the daemon. A bot paper trades first; `pd bot
//! live` takes it live only after its paper run, and asks first.

use pewterdesk_core::{CandleInterval, Market, PositionSide};
use pewterdesk_protocol::command::find_market;
use pewterdesk_protocol::rpc::{Call, Target};
use pewterdesk_strategy::bot::{BotLimits, BotSpec, BotView};
use pewterdesk_strategy::sim::RunResult;
use pewterdesk_strategy::{DcaParams, Direction, EmaParams, GridParams, StrategyConfig};

use crate::client::Client;
use crate::show;

const USAGE: &str = "pd bot new grid <coin> --from <price> --to <price> --lines <n> --size <base> [--stop-below <p>] [--stop-above <p>]
pd bot new dca <coin> --amount <quote> --every <candles> --tp <percent> [--max-buys <n>]
pd bot new ema <coin> [--fast 9] [--slow 26] [--risk 1] [--stop-atr 2] [--leverage 3] [--long-only]
  (each: [--interval 1h] [--capital 10000] [--daily-loss <quote>] [--max-position <quote>])
pd bot list | show <id> | backtest <id> [--since 90d]
pd bot paper <id> | live <id> | pause <id> | resume <id> | stop <id> [--flatten] | delete <id>";

/// The value after `--name`, if given.
fn flag<'a>(words: &'a [&'a str], name: &str) -> Option<&'a str> {
    words
        .iter()
        .position(|w| *w == name)
        .and_then(|i| words.get(i + 1).copied())
}

fn number(words: &[&str], name: &str) -> Result<Option<f64>, String> {
    flag(words, name)
        .map(|v| {
            v.trim_end_matches('%')
                .trim_start_matches('$')
                .replace(',', "")
                .parse::<f64>()
                .map_err(|_| format!("{name} needs a number, not {v:?}"))
        })
        .transpose()
}

fn needed(words: &[&str], name: &str) -> Result<f64, String> {
    number(words, name)?.ok_or_else(|| format!("{name} is needed"))
}

fn interval(words: &[&str]) -> Result<CandleInterval, String> {
    let text = flag(words, "--interval").unwrap_or("1h");
    serde_json::from_value(serde_json::Value::String(text.into()))
        .map_err(|_| format!("{text:?} isn't an interval (1m, 5m, 15m, 1h, 4h, 1d...)"))
}

/// "90d", "12h", "30" (days) as milliseconds.
fn span(text: &str) -> Result<u64, String> {
    let (n, unit) = match text.chars().last() {
        Some('d') => (&text[..text.len() - 1], 86_400_000u64),
        Some('h') => (&text[..text.len() - 1], 3_600_000),
        _ => (text, 86_400_000),
    };
    let n: u64 = n
        .parse()
        .map_err(|_| format!("{text:?} isn't a span (90d, 12h)"))?;
    Ok(n * unit)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A new bot's strategy from the line.
fn strategy(kind: &str, words: &[&str]) -> Result<StrategyConfig, String> {
    Ok(match kind {
        "grid" => {
            let lower = needed(words, "--from")?;
            let upper = needed(words, "--to")?;
            let (lower, upper) = (lower.min(upper), lower.max(upper));
            let gap = upper - lower;
            StrategyConfig::Grid(GridParams {
                lower,
                upper,
                levels: needed(words, "--lines")? as u32,
                size_per_level: needed(words, "--size")?,
                stop_below: number(words, "--stop-below")?.unwrap_or(lower - gap * 0.1),
                stop_above: number(words, "--stop-above")?.unwrap_or(upper + gap * 0.1),
            })
        }
        "dca" => StrategyConfig::Dca(DcaParams {
            every: needed(words, "--every")? as u32,
            amount: needed(words, "--amount")?,
            take_profit: needed(words, "--tp")? / 100.0,
            max_buys: number(words, "--max-buys")?.unwrap_or(10.0) as u32,
        }),
        "ema" => StrategyConfig::Ema(EmaParams {
            fast: number(words, "--fast")?.unwrap_or(9.0) as u32,
            slow: number(words, "--slow")?.unwrap_or(26.0) as u32,
            stop_atr: number(words, "--stop-atr")?.unwrap_or(2.0),
            risk: number(words, "--risk")?.unwrap_or(1.0) / 100.0,
            max_leverage: number(words, "--leverage")?.unwrap_or(3.0),
            direction: if words.contains(&"--long-only") {
                Direction::Long
            } else {
                Direction::Both
            },
        }),
        other => {
            return Err(format!(
                "{other:?} isn't a bot pd makes (grid, dca, ema)\n\n{USAGE}"
            ))
        }
    })
}

fn describe(v: &BotView) -> String {
    let kind = match &v.spec.strategy {
        StrategyConfig::Ema(_) => "ema",
        StrategyConfig::Grid(_) => "grid",
        StrategyConfig::Dca(_) => "dca",
        StrategyConfig::Custom(_) => "custom",
    };
    let side = if v.position > 0.0 {
        format!(" {} {}", show::side_word(PositionSide::Long), v.position)
    } else if v.position < 0.0 {
        format!(" {} {}", show::side_word(PositionSide::Short), -v.position)
    } else {
        String::new()
    };
    let reason = v
        .reason
        .as_deref()
        .map(|r| format!(" ({r})"))
        .unwrap_or_default();
    let ready = match (v.mode, v.paper_since) {
        (pewterdesk_strategy::bot::BotMode::Paper, Some(since)) => {
            let days = (now_ms().saturating_sub(since)) / 86_400_000;
            format!(
                "  paper day {}/{}",
                days.min(pewterdesk_strategy::bot::PAPER_DAYS),
                pewterdesk_strategy::bot::PAPER_DAYS
            )
        }
        _ => String::new(),
    };
    format!(
        "{}  {kind} {} on {}  {:?} {:?}{reason}  P&L today {:+.2}, total {:+.2}{side}  {} trades{ready}",
        v.id,
        v.spec.market,
        show::venue(v.spec.venue),
        v.mode,
        v.status,
        v.pnl_today,
        v.pnl_total,
        v.trades
    )
}

fn summary(run: &RunResult, capital: f64) -> String {
    let end = run.equity.last().copied().unwrap_or(capital);
    let mut peak = capital;
    let mut worst = 0.0f64;
    for e in &run.equity {
        peak = peak.max(*e);
        worst = worst.min((e - peak) / peak);
    }
    let wins = run.trades.iter().filter(|t| t.pnl > 0.0).count();
    format!(
        "{} candles, {} trades ({} won), net {:+.2} ({:+.2}%), max drawdown {:.2}%, fees {:.2}, funding {:+.2}",
        run.bars.len(),
        run.trades.len(),
        wins,
        end - capital,
        (end / capital - 1.0) * 100.0,
        worst * 100.0,
        -run.trades.iter().map(|t| t.fees).sum::<f64>(),
        run.trades.iter().map(|t| t.funding).sum::<f64>(),
    )
}

pub async fn run(
    client: &Client,
    words: &[&str],
    target: impl Fn() -> Result<Target, String>,
    json: bool,
    confirmed: impl Fn() -> bool,
) -> Result<(), String> {
    let call = |e: pewterdesk_protocol::RpcError| e.message;
    match words {
        [] | ["help"] => {
            println!("{USAGE}");
            Ok(())
        }
        ["list"] => {
            let bots: Vec<BotView> = client.call(Call::BotList).await.map_err(call)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&bots).unwrap_or_default()
                );
            } else if bots.is_empty() {
                println!("no bots: pd bot new grid|dca|ema ...");
            } else {
                bots.iter().for_each(|b| println!("{}", describe(b)));
            }
            Ok(())
        }
        ["show", id] => {
            let bot: BotView = client
                .call(Call::BotGet { id: (*id).into() })
                .await
                .map_err(call)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&bot).unwrap_or_default());
            } else {
                println!("{}", describe(&bot));
            }
            Ok(())
        }
        ["new", kind, coin, rest @ ..] => {
            let t = target()?;
            let markets: Vec<Market> = client
                .call(Call::Markets { venue: t.venue })
                .await
                .map_err(call)?;
            let market = find_market(coin, &markets, None).ok_or(format!("no {coin} market"))?;
            let limits = BotLimits {
                daily_loss: number(rest, "--daily-loss")?,
                max_position: number(rest, "--max-position")?,
                ..BotLimits::default()
            };
            let spec = BotSpec {
                name: flag(rest, "--name").map(str::to_owned),
                venue: t.venue,
                account: t.account,
                market: market.id.clone(),
                interval: interval(rest)?,
                strategy: strategy(kind, rest)?,
                limits,
                paper_capital: number(rest, "--capital")?.unwrap_or(10_000.0),
                max_slippage_bps: pewterdesk_protocol::action::default_slippage_bps(t.venue),
            };
            let bot: BotView = client
                .call(Call::BotCreate {
                    spec: Box::new(spec),
                })
                .await
                .map_err(call)?;
            println!(
                "made {}\nBacktest it: pd bot backtest {}   Paper trade it: pd bot paper {}",
                describe(&bot),
                bot.id,
                bot.id
            );
            Ok(())
        }
        ["backtest", id, rest @ ..] => {
            let bot: BotView = client
                .call(Call::BotGet { id: (*id).into() })
                .await
                .map_err(call)?;
            let since = now_ms().saturating_sub(span(flag(rest, "--since").unwrap_or("90d"))?);
            eprintln!("reading candles and running it...");
            let run: RunResult = client
                .call(Call::BotBacktest {
                    spec: Box::new(bot.spec.clone()),
                    since,
                    hold_out_days: 0.0,
                })
                .await
                .map_err(call)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&run).unwrap_or_default());
            } else {
                println!("{}", summary(&run, bot.spec.paper_capital));
            }
            Ok(())
        }
        ["paper" | "start", id] => {
            let bot: BotView = client
                .call(Call::BotStart { id: (*id).into() })
                .await
                .map_err(call)?;
            println!("{}", describe(&bot));
            Ok(())
        }
        ["live", id] => {
            let bot: BotView = client
                .call(Call::BotGet { id: (*id).into() })
                .await
                .map_err(call)?;
            eprintln!(
                "This takes {} live on {} {}: real orders, through the trading gate, within its limits.",
                bot.id,
                show::venue(bot.spec.venue),
                bot.spec.account
            );
            if !confirmed() {
                return Ok(());
            }
            let bot: BotView = client
                .call(Call::BotLive { id: (*id).into() })
                .await
                .map_err(call)?;
            println!("{}", describe(&bot));
            Ok(())
        }
        ["pause", id] => client
            .call::<()>(Call::BotPause { id: (*id).into() })
            .await
            .map_err(call),
        ["resume", id] => client
            .call::<()>(Call::BotResume { id: (*id).into() })
            .await
            .map_err(call),
        ["stop", id, rest @ ..] => client
            .call::<()>(Call::BotStop {
                id: (*id).into(),
                flatten: rest.contains(&"--flatten"),
            })
            .await
            .map_err(call),
        ["delete", id] => client
            .call::<()>(Call::BotDelete { id: (*id).into() })
            .await
            .map_err(call),
        _ => Err(USAGE.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_grid_and_spans() {
        let words = [
            "--from", "80,000", "--to", "90000", "--lines", "20", "--size", "0.01",
        ];
        let StrategyConfig::Grid(g) = strategy("grid", &words).unwrap() else {
            panic!()
        };
        assert_eq!((g.lower, g.upper, g.levels), (80_000.0, 90_000.0, 20));
        assert!(g.stop_below < 80_000.0 && g.stop_above > 90_000.0);
        assert!(strategy("grid", &["--from", "1"]).is_err());
        assert_eq!(span("90d").unwrap(), 90 * 86_400_000);
        assert_eq!(span("12h").unwrap(), 12 * 3_600_000);
        assert!(interval(&["--interval", "4h"]).is_ok());
        assert!(interval(&["--interval", "7h"]).is_err());
    }
}
