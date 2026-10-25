//! `pd`: the pewterdesk command line (`docs/bots/cli.md`). With the daemon
//! (`pdd`) running it sends everything over the protocol: trading lines in
//! the command palette's own language, algos, `halt`, `flatten`. Without
//! one it still reads markets and prices on its own, and refuses to trade.
//!
//! Every trading line shows what it would send and asks first; `--yes`
//! skips the question for scripts, `--dry-run` never sends. `pd` holds no
//! venue key: the daemon signs, with the trade-only keys the app stored,
//! through the same gate as the app.

mod client;
mod daemon;
mod show;

use std::io::{BufRead, IsTerminal, Write};
use std::time::Duration;

use pewterdesk_core::{AccountSnapshot, Market, Order, StopMode, VenueId};
use pewterdesk_exchange_aster::{constants::MAINNET as ASTER_MAINNET, AsterAdapter};
use pewterdesk_exchange_binance::{constants::MAINNET as BINANCE_MAINNET, BinanceAdapter};
use pewterdesk_exchange_bybit::{constants::MAINNET as BYBIT_MAINNET, BybitAdapter};
use pewterdesk_exchange_hyperliquid::{constants::MAINNET, HyperliquidAdapter};
use pewterdesk_protocol::action::{action_for, default_slippage_bps, Action, For};
use pewterdesk_protocol::command::{
    find_market, parse_command, CommandContext, OpenOrder, OpenPosition,
};
use pewterdesk_protocol::local::Paths;
use pewterdesk_protocol::rpc::{
    Call, Event, Halted, PairState, PairTicket, PairedClient, RpcError, Status, Target,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::{Client, Unreachable};

const USAGE: &str = "pd - the pewterdesk command line

Talks to the daemon (pdd). Trading lines are the command palette's own:
  pd buy 100 hype at 38.2          pd sell 50% hype          pd close eth
  pd buy 1 eth at 2400 to 2300 x5  pd tp hype 41             pd cancel all
  pd chase buy 1 btc to 0.5% then market
  pd twap sell 10 eth over 30m x6 chase
Each shows what it would send and asks first.

Account and daemon:
  pd status                  the daemon, its algos and the accounts it holds
  pd use <venue> <account>   the account pd trades (bybit demo:<uid>, hyperliquid 0x...)
  pd pair | unpair           pair this pd with the daemon (once), or forget its token
  pd clients [revoke <id>]   paired clients
  pd daemon install|uninstall|start|stop|status|logs

Reading:
  pd markets [venue]   pd price <coin>   pd book <coin>
  pd positions         pd orders         pd balance

Algos and safety:
  pd algo list|history|pause <id>|resume <id>|stop <id> [--market]
  pd tail                    algo updates as they happen
  pd halt                    stop every algo, and cancel what they placed
  pd flatten [market|all]    close positions at market, reduce-only

Options: --venue <v>  --account <a>  --json  --yes  --dry-run";

/// What `pd use` keeps: the account pd trades by default.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Defaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    venue: Option<VenueId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account: Option<String>,
}

fn defaults_path(paths: &Paths) -> std::path::PathBuf {
    paths.config.join("pd.json")
}

fn load_defaults(paths: &Paths) -> Defaults {
    std::fs::read(defaults_path(paths))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

struct Opts {
    json: bool,
    yes: bool,
    dry_run: bool,
    market_stop: bool,
    venue: Option<VenueId>,
    account: Option<String>,
    words: Vec<String>,
}

fn venue_named(word: &str) -> Option<VenueId> {
    match word.to_ascii_lowercase().as_str() {
        "bybit" => Some(VenueId::Bybit),
        "binance" => Some(VenueId::Binance),
        "hyperliquid" | "hl" => Some(VenueId::Hyperliquid),
        "aster" => Some(VenueId::Aster),
        _ => None,
    }
}

fn parse_opts(args: Vec<String>) -> Result<Opts, String> {
    let mut opts = Opts {
        json: false,
        yes: false,
        dry_run: false,
        market_stop: false,
        venue: None,
        account: None,
        words: Vec::new(),
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--json" => opts.json = true,
            "--yes" | "-y" => opts.yes = true,
            "--dry-run" => opts.dry_run = true,
            "--market" => opts.market_stop = true,
            "--venue" => {
                let v = args.next().ok_or("--venue needs a venue")?;
                opts.venue = Some(venue_named(&v).ok_or(format!("{v:?} isn't a venue"))?);
            }
            "--account" => opts.account = Some(args.next().ok_or("--account needs an account")?),
            _ => opts.words.push(arg),
        }
    }
    Ok(opts)
}

/// A failure, as `pd` reports it.
struct Fail(String);

impl From<String> for Fail {
    fn from(s: String) -> Self {
        Fail(s)
    }
}
impl From<&str> for Fail {
    fn from(s: &str) -> Self {
        Fail(s.into())
    }
}
impl From<RpcError> for Fail {
    fn from(e: RpcError) -> Self {
        Fail(e.message)
    }
}

type Out = Result<(), Fail>;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opts = match parse_opts(args) {
        Ok(opts) => opts,
        Err(e) => {
            eprintln!("pd: {e}");
            std::process::exit(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let code = match runtime.block_on(run(opts)) {
        Ok(()) => 0,
        Err(Fail(message)) => {
            eprintln!("pd: {message}");
            1
        }
    };
    std::process::exit(code);
}

fn print_json(value: &impl Serialize) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
}

async fn run(opts: Opts) -> Out {
    let paths = Paths::find().ok_or("no home folder")?;
    let words: Vec<&str> = opts.words.iter().map(String::as_str).collect();
    match words.as_slice() {
        [] | ["help" | "--help" | "-h"] => {
            println!("{USAGE}");
            Ok(())
        }
        ["--version" | "-V" | "version"] => {
            println!("pd {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        ["daemon", rest @ ..] => daemon::run(&paths, rest).await.map_err(Fail),
        ["use", rest @ ..] => use_account(&paths, rest),
        ["markets", rest @ ..] => markets(&paths, &opts, rest.first().copied()).await,
        ["price" | "book", coin] => price(&paths, &opts, coin, words[0] == "book").await,
        ["pair"] => pair(&paths).await,
        ["unpair"] => {
            client::forget_token().await;
            println!("this pd's token is forgotten; `pd clients revoke <id>` removes it from the daemon too");
            Ok(())
        }
        _ => with_daemon(&paths, &opts, &words).await,
    }
}

fn use_account(paths: &Paths, rest: &[&str]) -> Out {
    let [venue, account] = rest else {
        let d = load_defaults(paths);
        match (d.venue, d.account) {
            (Some(v), Some(a)) => println!("{} {a}", show::venue(v)),
            _ => println!("no account picked: pd use <venue> <account>"),
        }
        return Ok(());
    };
    let venue = venue_named(venue).ok_or(format!("{venue:?} isn't a venue"))?;
    let defaults = Defaults {
        venue: Some(venue),
        account: Some((*account).to_owned()),
    };
    let json = serde_json::to_vec_pretty(&defaults).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&paths.config).map_err(|e| e.to_string())?;
    std::fs::write(defaults_path(paths), json).map_err(|e| e.to_string())?;
    println!("pd trades {} {account}", show::venue(venue));
    Ok(())
}

/// A venue's adapter for reading public data in this process (no key).
async fn read_markets(venue: VenueId) -> Result<Vec<Market>, String> {
    use pewterdesk_core::ExchangeAdapter;
    let err = |e: pewterdesk_core::VenueError| e.to_string();
    match venue {
        VenueId::Hyperliquid => {
            HyperliquidAdapter::new(&MAINNET)
                .map_err(err)?
                .markets()
                .await
        }
        VenueId::Aster => {
            AsterAdapter::new(&ASTER_MAINNET)
                .map_err(err)?
                .markets()
                .await
        }
        VenueId::Bybit => {
            BybitAdapter::new(&BYBIT_MAINNET)
                .map_err(err)?
                .markets()
                .await
        }
        VenueId::Binance => {
            BinanceAdapter::new(&BINANCE_MAINNET)
                .map_err(err)?
                .markets()
                .await
        }
    }
    .map_err(err)
}

async fn read_book(venue: VenueId, market: &str) -> Result<pewterdesk_core::OrderBook, String> {
    use pewterdesk_core::ExchangeAdapter;
    let err = |e: pewterdesk_core::VenueError| e.to_string();
    match venue {
        VenueId::Hyperliquid => {
            HyperliquidAdapter::new(&MAINNET)
                .map_err(err)?
                .order_book(market)
                .await
        }
        VenueId::Aster => {
            AsterAdapter::new(&ASTER_MAINNET)
                .map_err(err)?
                .order_book(market)
                .await
        }
        VenueId::Bybit => {
            BybitAdapter::new(&BYBIT_MAINNET)
                .map_err(err)?
                .order_book(market)
                .await
        }
        VenueId::Binance => {
            BinanceAdapter::new(&BINANCE_MAINNET)
                .map_err(err)?
                .order_book(market)
                .await
        }
    }
    .map_err(err)
}

fn venue_of(paths: &Paths, opts: &Opts, word: Option<&str>) -> Result<VenueId, Fail> {
    if let Some(word) = word {
        return venue_named(word).ok_or_else(|| Fail(format!("{word:?} isn't a venue")));
    }
    Ok(opts
        .venue
        .or(load_defaults(paths).venue)
        .unwrap_or(VenueId::Hyperliquid))
}

async fn markets(paths: &Paths, opts: &Opts, venue: Option<&str>) -> Out {
    let venue = venue_of(paths, opts, venue)?;
    let markets = read_markets(venue).await?;
    if opts.json {
        print_json(&markets);
    } else {
        for m in &markets {
            println!("{:<16} {:<14} max {}x", m.id, m.symbol, m.max_leverage);
        }
        eprintln!("{} markets on {}", markets.len(), show::venue(venue));
    }
    Ok(())
}

async fn price(paths: &Paths, opts: &Opts, coin: &str, whole_book: bool) -> Out {
    let venue = venue_of(paths, opts, None)?;
    let markets = read_markets(venue).await?;
    let market = find_market(coin, &markets, None)
        .ok_or(format!("no {coin} market on {}", show::venue(venue)))?;
    let book = read_book(venue, &market.id).await?;
    if opts.json {
        print_json(&book);
        return Ok(());
    }
    let bid = book
        .bids
        .first()
        .map(|l| l.price.0.to_string())
        .unwrap_or("-".into());
    let ask = book
        .asks
        .first()
        .map(|l| l.price.0.to_string())
        .unwrap_or("-".into());
    println!(
        "{} on {}: bid {bid}  ask {ask}",
        market.symbol,
        show::venue(venue)
    );
    if whole_book {
        for (bid, ask) in book.bids.iter().zip(book.asks.iter()).take(10) {
            println!(
                "  {:>14} {:>12}   {:>14} {:>12}",
                bid.size.0, bid.price.0, ask.price.0, ask.size.0
            );
        }
    }
    Ok(())
}

async fn connect(paths: &Paths) -> Result<Client, Fail> {
    match Client::unix(paths, client::info(), client::token().await).await {
        Ok(client) => Ok(client),
        Err(Unreachable::NotRunning) => Err(Fail(
            "the daemon isn't running: start it with `pd daemon start` (or `pdd run` in a terminal)"
                .into(),
        )),
        Err(Unreachable::Refused(why)) => Err(Fail(why)),
    }
}

async fn pair(paths: &Paths) -> Out {
    let client = connect(paths).await?;
    if client.paired {
        println!("already paired");
        return Ok(());
    }
    let ticket: PairTicket = client
        .call(Call::PairRequest {
            client: client::info(),
        })
        .await?;
    println!(
        "Asking the daemon to pair. Approve it there; the code is {}",
        ticket.code
    );
    loop {
        let state: PairState = client
            .call(Call::PairStatus {
                request_id: ticket.request_id.clone(),
            })
            .await?;
        match state {
            PairState::Pending => tokio::time::sleep(Duration::from_millis(500)).await,
            PairState::Approved { token, .. } => {
                client::keep_token(token).await?;
                println!("paired");
                return Ok(());
            }
            PairState::Denied => return Err("pairing was denied".into()),
            PairState::Expired => return Err("pairing wasn't approved in time".into()),
        }
    }
}

/// The account the command acts on.
fn target(paths: &Paths, opts: &Opts) -> Result<Target, Fail> {
    let defaults = load_defaults(paths);
    let venue = opts.venue.or(defaults.venue);
    let account = opts.account.clone().or(defaults.account);
    match (venue, account) {
        (Some(venue), Some(account)) => Ok(Target {
            venue,
            account,
            origin: None,
        }),
        _ => Err(
            "pick the account to trade: pd use <venue> <account> (or --venue and --account)".into(),
        ),
    }
}

/// Whether to go ahead: `--yes`, or a "y" at the prompt. Without a terminal
/// to ask in, no.
fn confirmed(opts: &Opts) -> bool {
    if opts.yes {
        return true;
    }
    if !std::io::stdin().is_terminal() {
        eprintln!("pd: not sent - no terminal to ask in; add --yes to send without asking");
        return false;
    }
    eprint!("Send? [y/N] ");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer).is_ok()
        && matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

async fn with_daemon(paths: &Paths, opts: &Opts, words: &[&str]) -> Out {
    let client = connect(paths).await?;
    if !client.paired {
        return Err("this pd isn't paired with the daemon: run `pd pair` first".into());
    }
    match words {
        ["status"] => {
            let status: Status = client.call(Call::Status).await?;
            if opts.json {
                print_json(&status);
            } else {
                show::status(&status);
            }
            Ok(())
        }
        ["clients"] => {
            let clients: Vec<PairedClient> = client.call(Call::ClientsList).await?;
            if opts.json {
                print_json(&clients);
            } else {
                for c in &clients {
                    println!("{}  {}  paired {}", c.id, c.name, show::time(c.paired_at));
                }
            }
            Ok(())
        }
        ["clients", "revoke", id] => {
            let revoked: bool = client
                .call(Call::ClientsRevoke { id: (*id).into() })
                .await?;
            println!("{}", if revoked { "revoked" } else { "no such client" });
            Ok(())
        }
        ["positions" | "orders" | "balance"] => {
            let t = target(paths, opts)?;
            let snapshot: AccountSnapshot = client
                .call(Call::Account {
                    venue: t.venue,
                    account: t.account.clone(),
                })
                .await?;
            if opts.json {
                print_json(&snapshot);
            } else {
                show::account(words[0], &snapshot);
            }
            Ok(())
        }
        ["algo", "list" | "history"] => {
            let call = if words[1] == "list" {
                Call::AlgoList
            } else {
                Call::AlgoHistory { limit: 50 }
            };
            let algos: Vec<pewterdesk_core::AlgoView> = client.call(call).await?;
            if opts.json {
                print_json(&algos);
            } else {
                for a in &algos {
                    println!("{}", show::algo(a));
                }
                if algos.is_empty() {
                    println!("no algos");
                }
            }
            Ok(())
        }
        ["algo", "pause", id] => client
            .call::<()>(Call::AlgoPause { id: (*id).into() })
            .await
            .map_err(Into::into),
        ["algo", "resume", id] => client
            .call::<()>(Call::AlgoResume { id: (*id).into() })
            .await
            .map_err(Into::into),
        ["algo", "stop", id] => {
            let mode = if opts.market_stop {
                StopMode::FinishAtMarket
            } else {
                StopMode::Cancel
            };
            client
                .call::<()>(Call::AlgoStop {
                    id: (*id).into(),
                    mode,
                })
                .await
                .map_err(Into::into)
        }
        ["tail"] => {
            let mut events = client.events();
            client.call::<()>(Call::Subscribe).await?;
            eprintln!("following algo updates; Ctrl-C to stop");
            while let Ok(event) = events.recv().await {
                match event {
                    Event::Algo(view) => println!("{}", show::algo(&view)),
                    Event::Halted(Halted { stopped }) => {
                        println!("halted: {stopped} algo(s) stopped")
                    }
                }
            }
            Ok(())
        }
        ["halt"] => {
            eprintln!("This stops every algo the daemon runs and cancels the orders they placed.");
            if opts.dry_run || !confirmed(opts) {
                return Ok(());
            }
            let halted: Halted = client.call(Call::Halt).await?;
            println!("{} algo(s) stopped", halted.stopped);
            Ok(())
        }
        ["flatten", rest @ ..] => flatten(paths, opts, &client, rest.first().copied()).await,
        ["algo", line @ ..] => trade(paths, opts, &client, &line.join(" ")).await,
        _ => trade(paths, opts, &client, &words.join(" ")).await,
    }
}

async fn flatten(paths: &Paths, opts: &Opts, client: &Client, which: Option<&str>) -> Out {
    let target = target(paths, opts)?;
    let snapshot: AccountSnapshot = client
        .call(Call::Account {
            venue: target.venue,
            account: target.account.clone(),
        })
        .await?;
    let markets: Vec<Market> = client
        .call(Call::Markets {
            venue: target.venue,
        })
        .await?;
    let market = match which {
        None | Some("all") => None,
        Some(coin) => Some(
            find_market(coin, &markets, None)
                .ok_or(format!("no {coin} market"))?
                .id
                .clone(),
        ),
    };
    let closing: Vec<_> = snapshot
        .positions
        .iter()
        .filter(|p| market.as_ref().is_none_or(|m| &p.market == m))
        .collect();
    if closing.is_empty() {
        println!("no open positions to close");
        return Ok(());
    }
    let bps = default_slippage_bps(target.venue);
    for p in &closing {
        eprintln!(
            "close {} {} {} at market, within {}",
            show::side_word(p.side),
            p.size.0,
            p.market,
            show::bps(bps)
        );
    }
    if opts.dry_run || !confirmed(opts) {
        return Ok(());
    }
    let orders: Vec<Order> = client
        .call(Call::Flatten {
            target,
            market,
            max_slippage_bps: bps,
        })
        .await?;
    if opts.json {
        print_json(&orders);
    } else {
        for o in &orders {
            println!("sent {}", show::order(o));
        }
    }
    Ok(())
}

/// A trading line: read against the account, shown, confirmed, sent.
async fn trade(paths: &Paths, opts: &Opts, client: &Client, line: &str) -> Out {
    let target = target(paths, opts)?;
    let markets: Vec<Market> = client
        .call(Call::Markets {
            venue: target.venue,
        })
        .await?;
    let snapshot: AccountSnapshot = client
        .call(Call::Account {
            venue: target.venue,
            account: target.account.clone(),
        })
        .await?;
    let ctx = CommandContext {
        markets,
        current: None,
        positions: snapshot
            .positions
            .iter()
            .map(|p| OpenPosition {
                market: p.market.clone(),
                side: p.side,
                size: Some(p.size),
            })
            .collect(),
        orders: snapshot
            .open_orders
            .iter()
            .map(|o| OpenOrder {
                id: o.id.clone(),
                market: o.market.clone(),
            })
            .collect(),
    };
    let intent = parse_command(line, &ctx).ok_or_else(|| {
        Fail(format!(
            "not something pd can send: {line:?} (pd help lists what it reads)"
        ))
    })?;
    let who = For {
        venue: target.venue,
        account: target.account.clone(),
        max_slippage_bps: default_slippage_bps(target.venue),
    };
    let action = action_for(&intent, &ctx, &who)?;
    eprintln!(
        "Would send for {} on {}:",
        target.account,
        show::venue(target.venue)
    );
    for line in show::action(&action) {
        eprintln!("  {line}");
    }
    if opts.dry_run {
        return Ok(());
    }
    if !confirmed(opts) {
        return Ok(());
    }
    let mut results: Vec<Value> = Vec::new();
    match action {
        Action::Orders(orders) => {
            for request in orders {
                let placed: Order = client
                    .call(Call::PlaceOrder {
                        target: target.clone(),
                        request,
                    })
                    .await?;
                if !opts.json {
                    println!("sent {}", show::order(&placed));
                }
                results.push(serde_json::to_value(placed).unwrap_or_default());
            }
        }
        Action::Cancel(orders) => {
            for o in orders {
                client
                    .call::<()>(Call::CancelOrder {
                        target: target.clone(),
                        market: o.market.clone(),
                        order_id: o.id.clone(),
                    })
                    .await?;
                if !opts.json {
                    println!("cancelled {} on {}", o.id, o.market);
                }
                results.push(serde_json::json!({ "cancelled": o.id }));
            }
        }
        Action::Protect { market, protection } => {
            client
                .call::<()>(Call::Protect {
                    target: target.clone(),
                    market: market.clone(),
                    protection,
                })
                .await?;
            if !opts.json {
                println!("set on {market}");
            }
        }
        Action::Algo(spec) => {
            let view: pewterdesk_core::AlgoView =
                client.call(Call::AlgoStart { spec: *spec }).await?;
            if !opts.json {
                println!("started {}", show::algo(&view));
            }
            results.push(serde_json::to_value(view).unwrap_or_default());
        }
        Action::Halt => {
            let halted: Halted = client.call(Call::Halt).await?;
            if !opts.json {
                println!("{} algo(s) stopped", halted.stopped);
            }
        }
    }
    if opts.json {
        print_json(&results);
    }
    Ok(())
}
