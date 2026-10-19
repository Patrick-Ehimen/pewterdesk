//! "Always on": the app as a client of the daemon (`pdd`), so algos keep
//! running with the app quit. Turned on in Settings, it installs `pdd` as a
//! LaunchAgent, pairs the app with it once (the user approves in a dialog
//! `pdd` shows, the same code on both sides), and from then on the app's
//! trading and algo commands go to `pdd`'s engine instead of its own: the
//! same router, gate, log and client ids, in the other process. Its algo
//! updates come back as the same `algo` events.
//!
//! Security-relevant (docs/bots/safety.md): it decides where trading
//! commands go. While it's on and `pdd` can't be reached, opening orders and
//! new algos are refused rather than sent from the app's own engine (fail
//! closed); cancels always go through, here if not there. The pairing token
//! is kept in the keychain (`app:pdd-token`) and sent only to `pdd`, over
//! 127.0.0.1. No key reaches `pdd` from here: it reads the same keychain.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use pewterdesk_core::{KeySource, VenueError};
use pewterdesk_keychain::KeychainKeySource;
use pewterdesk_link::launchd::{self, State};
use pewterdesk_link::Link;
use pewterdesk_protocol::local::Paths;
use pewterdesk_protocol::rpc::{
    Call, ClientInfo, ClientKind, Event, PairState, PairTicket, RpcError,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::sync::RwLock;

/// Where the app's pairing token is kept in the keychain.
const TOKEN_ACCOUNT: &str = "app:pdd-token";
/// The setting, in the config folder.
const SETTING: &str = "always-on.json";
/// How often a lost connection is tried again.
const RETRY: Duration = Duration::from_secs(3);

#[derive(Default, Serialize, Deserialize)]
struct Setting {
    on: bool,
}

/// The app's link to `pdd`, when "always on" is.
pub struct DaemonLink {
    paths: Option<Paths>,
    on: AtomicBool,
    link: RwLock<Option<Arc<Link>>>,
}

/// Where things stand, for Settings.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonState {
    /// Whether this app can run `pdd` in the background here (macOS, with
    /// `pdd` beside it).
    pub available: bool,
    pub always_on: bool,
    /// "notInstalled", "stopped" or "running".
    pub agent: &'static str,
    pub connected: bool,
    pub paired: bool,
}

fn client() -> ClientInfo {
    ClientInfo {
        name: "the pewterdesk app".into(),
        kind: ClientKind::App,
    }
}

async fn token() -> Option<String> {
    KeychainKeySource
        .key(TOKEN_ACCOUNT)
        .await
        .ok()
        .map(|t| t.to_string())
}

/// The `pdd` that comes with this app: beside its own binary.
fn bundled_pdd() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let pdd = exe.with_file_name(if cfg!(windows) { "pdd.exe" } else { "pdd" });
    pdd.is_file().then_some(pdd)
}

fn not_reached() -> VenueError {
    VenueError::Network(
        "Always on is set, but the pewterdesk daemon can't be reached; nothing was sent".into(),
    )
}

impl DaemonLink {
    pub fn new() -> Self {
        let paths = Paths::find();
        let on = paths
            .as_ref()
            .and_then(|p| std::fs::read(p.config.join(SETTING)).ok())
            .and_then(|b| serde_json::from_slice::<Setting>(&b).ok())
            .is_some_and(|s| s.on);
        Self {
            paths,
            on: AtomicBool::new(on),
            link: RwLock::new(None),
        }
    }

    fn save(&self, on: bool) -> Result<(), String> {
        let paths = self
            .paths
            .as_ref()
            .ok_or("no folder to keep the setting in")?;
        std::fs::create_dir_all(&paths.config).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec(&Setting { on }).map_err(|e| e.to_string())?;
        std::fs::write(paths.config.join(SETTING), json).map_err(|e| e.to_string())
    }

    pub fn always_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    /// The link to send trading commands over: `Ok(None)` while always-on
    /// is off (the app's own engine trades), an error while it's on and
    /// `pdd` can't be reached.
    pub async fn route(&self) -> Result<Option<Arc<Link>>, VenueError> {
        if !self.always_on() {
            return Ok(None);
        }
        match &*self.link.read().await {
            Some(link) if link.alive() && link.paired => Ok(Some(Arc::clone(link))),
            _ => Err(not_reached()),
        }
    }

    /// For a cancel: `pdd` if it's there, else the app's own engine - an
    /// order is always allowed off.
    pub async fn route_cancel(&self) -> Option<Arc<Link>> {
        self.route().await.ok().flatten()
    }

    async fn connect(&self, app: &AppHandle) -> Option<Arc<Link>> {
        let paths = self.paths.as_ref()?;
        let link = Arc::new(Link::websocket(paths, client(), token().await).await.ok()?);
        if link.paired {
            // Algo updates from pdd's engine, as the app's own would come.
            let mut events = link.events();
            if link.call::<()>(Call::Subscribe).await.is_ok() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    while let Ok(event) = events.recv().await {
                        match event {
                            Event::Algo(view) => {
                                let _ = app.emit("algo", *view);
                            }
                            Event::Bot(view) => {
                                let _ = app.emit("bot", *view);
                            }
                            Event::Halted(_) => {}
                        }
                    }
                });
            }
        }
        *self.link.write().await = Some(Arc::clone(&link));
        Some(link)
    }

    async fn state(&self) -> DaemonState {
        let link = self.link.read().await;
        let connected = link.as_ref().is_some_and(|l| l.alive());
        DaemonState {
            available: cfg!(target_os = "macos") && bundled_pdd().is_some(),
            always_on: self.always_on(),
            agent: match launchd::state() {
                State::NotInstalled => "notInstalled",
                State::Stopped => "stopped",
                State::Running => "running",
            },
            connected,
            paired: connected && link.as_ref().is_some_and(|l| l.paired),
        }
    }
}

/// Keeps the link up while always-on is on: reconnects whenever it's lost
/// (pdd restarting, the machine waking).
pub fn install(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let daemon = app.state::<DaemonLink>();
            if daemon.always_on() {
                let up = daemon.link.read().await.as_ref().is_some_and(|l| l.alive());
                if !up {
                    daemon.connect(&app).await;
                }
            }
            tokio::time::sleep(RETRY).await;
        }
    });
}

fn venue_error(e: RpcError) -> VenueError {
    e.to_venue_error()
}

/// Sends `call` over `link`, as a trading command's answer.
pub async fn forward<T: serde::de::DeserializeOwned>(
    link: &Link,
    call: Call,
) -> Result<T, VenueError> {
    link.call(call).await.map_err(venue_error)
}

/// Where always-on stands.
#[tauri::command]
pub async fn daemon_state(daemon: TauriState<'_, DaemonLink>) -> Result<DaemonState, ()> {
    Ok(daemon.state().await)
}

/// Turns always-on on (installs and starts `pdd`, connects) or off (halts
/// `pdd`'s algos, stops and removes it; the app's own engine trades again).
#[tauri::command]
pub async fn set_always_on(
    app: AppHandle,
    daemon: TauriState<'_, DaemonLink>,
    on: bool,
) -> Result<DaemonState, String> {
    let paths = daemon
        .paths
        .clone()
        .ok_or("no folder to run the daemon from")?;
    if on {
        let pdd = bundled_pdd().ok_or("this build of the app doesn't include pdd")?;
        launchd::install(&paths, &pdd)?;
        daemon.save(true)?;
        daemon.on.store(true, Ordering::SeqCst);
        // pdd takes a moment to start listening.
        for _ in 0..20 {
            if daemon.connect(&app).await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    } else {
        if let Some(link) = daemon.link.write().await.take() {
            // Its algos stop with it: their orders are cancelled first.
            let _ = link.call::<serde_json::Value>(Call::Halt).await;
        }
        daemon.on.store(false, Ordering::SeqCst);
        daemon.save(false)?;
        launchd::uninstall(&paths)?;
    }
    Ok(daemon.state().await)
}

/// Asks `pdd` to pair this app; the code is shown here and in `pdd`'s dialog.
#[tauri::command]
pub async fn daemon_pair(daemon: TauriState<'_, DaemonLink>) -> Result<PairTicket, String> {
    let link = daemon
        .link
        .read()
        .await
        .clone()
        .ok_or("the daemon isn't connected")?;
    link.call(Call::PairRequest { client: client() })
        .await
        .map_err(|e| e.message)
}

/// Where a pairing stands; once approved, the token is kept and the link
/// made again with it.
#[tauri::command]
pub async fn daemon_pair_status(
    app: AppHandle,
    daemon: TauriState<'_, DaemonLink>,
    request_id: String,
) -> Result<&'static str, String> {
    let link = daemon
        .link
        .read()
        .await
        .clone()
        .ok_or("the daemon isn't connected")?;
    let state: PairState = link
        .call(Call::PairStatus { request_id })
        .await
        .map_err(|e| e.message)?;
    Ok(match state {
        PairState::Pending => "pending",
        PairState::Denied => "denied",
        PairState::Expired => "expired",
        PairState::Approved { token, .. } => {
            pewterdesk_keychain::store_secret(TOKEN_ACCOUNT.into(), token)
                .await
                .map_err(|_| "the pairing couldn't be kept in the keychain")?;
            daemon.connect(&app).await;
            "approved"
        }
    })
}
