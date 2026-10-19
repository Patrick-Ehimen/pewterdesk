//! `pdd`: the pewterdesk daemon. It runs the same trading engine as the
//! app - the router, the gate (live-trading switch and trading rules), the
//! event log, the algos - headless, so algos keep running with the app
//! closed, and serves it to `pd` and the app over the protocol
//! (`pewterdesk_protocol`). Started by the LaunchAgent the app or
//! `pd daemon install` sets up, or in a terminal with `pdd run`.
//!
//! Security-relevant (docs/bots/safety.md): listeners, pairing and token
//! checks live here. Keys stay in the keychain, read only by the venue
//! adapters through `KeychainKeySource` for a signing call; nothing here
//! logs, prints or sends one.

mod ask;
mod host;
mod pairing;
mod server;

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pewterdesk_engine::algo::Host;
use pewterdesk_protocol::local::Paths;
use tokio::sync::broadcast;

use crate::host::{Daemon, Venues};
use crate::pairing::{write_private, Clients, Pairing};

const USAGE: &str = "pdd - the pewterdesk daemon

Usage:
  pdd run        run in the foreground (pairing is approved in this terminal)
  pdd --version  print the version

Normally started by the LaunchAgent (`pd daemon install`). Talk to it with `pd`.";

/// How often the clock is compared with the monotonic one, to notice sleep.
const WAKE_CHECK: Duration = Duration::from_secs(5);
/// A gap this long between the clocks is the machine having slept.
const SLEPT: Duration = Duration::from_secs(30);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn main() {
    // A panic anywhere ends the process at once (`panic = "abort"` in
    // effect): launchd starts a fresh one, which reconciles before it
    // trades, rather than a half-alive daemon carrying on.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        std::process::abort();
    }));

    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("run") => {}
        Some("--version" | "-V" | "version") => {
            println!("pdd {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some("--help" | "-h" | "help") => {
            println!("{USAGE}");
            return;
        }
        Some(other) => {
            eprintln!("pdd: unknown command {other:?}\n\n{USAGE}");
            std::process::exit(2);
        }
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let code = runtime.block_on(run());
    std::process::exit(code);
}

/// Binds the Unix socket so only this user can use it: the umask is
/// narrowed around the bind, so there's no moment it's open wider.
#[cfg(unix)]
fn bind_socket(path: &std::path::Path) -> std::io::Result<tokio::net::UnixListener> {
    // SAFETY: umask only changes this process's file-creation mask; it's
    // put back straight after.
    let old = unsafe { libc::umask(0o177) };
    let bound = tokio::net::UnixListener::bind(path);
    unsafe { libc::umask(old) };
    let listener = bound?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

async fn run() -> i32 {
    let Some(paths) = Paths::find() else {
        eprintln!("pdd: no home folder to keep things in");
        return 1;
    };
    if let Err(e) = std::fs::create_dir_all(&paths.data) {
        eprintln!("pdd: can't use {}: {e}", paths.data.display());
        return 1;
    }

    // One daemon at a time: a socket someone answers on is a running one.
    #[cfg(unix)]
    {
        let socket = paths.socket();
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            eprintln!("pdd: already running ({})", socket.display());
            return 1;
        }
        let _ = std::fs::remove_file(&socket);
    }

    let venues = match Venues::new() {
        Ok(venues) => venues,
        Err(e) => {
            eprintln!("pdd: the venues couldn't be set up: {e}");
            return 1;
        }
    };
    let calendar = match Daemon::calendar() {
        Ok(calendar) => calendar,
        Err(e) => {
            eprintln!("pdd: the calendar couldn't be set up: {e}");
            return 1;
        }
    };
    let clients = Arc::new(Clients::load(paths.clients()));
    let (events, _) = broadcast::channel(256);
    let daemon = Arc::new(Daemon {
        engine: Daemon::engine_for(&paths),
        venues: Box::new(venues),
        calendar: Box::new(calendar),
        events,
        pairing: Pairing::new(Arc::clone(&clients), ask::asker()),
        clients,
        started_at: now_ms(),
    });
    // Algos run on this engine; any left over from an engine that's gone
    // (this daemon before a crash, or the app) are dealt with before
    // anything else trades. One another engine still runs is left to it.
    let host: Arc<dyn Host> = daemon.clone();
    daemon.engine.algos().attach(host);
    daemon.engine.algos().reconcile().await;

    #[cfg(unix)]
    let unix = match bind_socket(&paths.socket()) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("pdd: can't listen on {}: {e}", paths.socket().display());
            return 1;
        }
    };
    let tcp = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("pdd: can't listen on 127.0.0.1: {e}");
            return 1;
        }
    };
    let port = tcp.local_addr().map(|a| a.port()).unwrap_or(0);
    if let Err(e) = write_private(&paths.port_file(), port.to_string().as_bytes()) {
        eprintln!("pdd: can't write {}: {e}", paths.port_file().display());
        return 1;
    }

    #[cfg(unix)]
    tokio::spawn(server::serve_unix(Arc::clone(&daemon), unix));
    tokio::spawn(server::serve_ws(Arc::clone(&daemon), tcp, port));
    tokio::spawn(watch_for_wake(Arc::clone(&daemon)));
    eprintln!(
        "pdd {} listening on {} and 127.0.0.1:{port}",
        env!("CARGO_PKG_VERSION"),
        paths.socket().display()
    );

    shutdown().await;
    eprintln!("pdd: stopping");
    let _ = std::fs::remove_file(paths.socket());
    let _ = std::fs::remove_file(paths.port_file());
    0
}

/// Waits for Ctrl-C, or launchd's SIGTERM.
async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let Ok(mut term) = signal(SignalKind::terminate()) else {
            let _ = tokio::signal::ctrl_c().await;
            return;
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Notices the machine waking from sleep - the wall clock runs on while
/// asleep, the monotonic one doesn't - and has the engine reconcile before
/// it carries on. Running algos pause by themselves on stale data and read
/// their orders again before they resume; this catches what was left over.
async fn watch_for_wake(daemon: Arc<Daemon>) {
    let mut last_mono = Instant::now();
    let mut last_wall = SystemTime::now();
    loop {
        tokio::time::sleep(WAKE_CHECK).await;
        let mono = last_mono.elapsed();
        let wall = last_wall.elapsed().unwrap_or_default();
        last_mono = Instant::now();
        last_wall = SystemTime::now();
        if wall > mono + SLEPT {
            eprintln!(
                "pdd: woke after about {}s asleep; reconciling",
                (wall - mono).as_secs()
            );
            daemon.engine.algos().reconcile().await;
        }
    }
}
