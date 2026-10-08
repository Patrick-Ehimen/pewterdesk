//! Connecting a browser-extension wallet (MetaMask, Rabby, Coinbase...).
//! Extensions only reach pages open in the user's browser, so the app serves
//! one, briefly, on 127.0.0.1: the page asks the extension to sign the agent
//! approval that `wallet.rs` builds, and hands the signature back.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - Bound to 127.0.0.1 on a random port, for one connection attempt; it
//!   stops after a success, a cancel, or `SERVER_FOR`.
//! - Every path sits under a random one-time token, so nothing else on the
//!   machine can find the page or its endpoints by guessing.
//! - The Host header must be exactly 127.0.0.1:<port> (no DNS rebinding),
//!   and posts must come from the page's own origin as JSON.
//! - No key passes through the page: Rust generates the agent key and the
//!   approval (`wallet::begin`), and checks the signature recovers to the
//!   connected address before anything is sent or stored (`wallet::finish`).
//! - The page has a strict CSP: its own files, posts back to itself, and
//!   data: images (wallet icons) only.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pewterdesk_core::{VenueError, VenueId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::venues::Venues;
use crate::wallet::{self, Onboarding, WalletInfo};

/// How long the page stays up without a connection.
const SERVER_FOR: Duration = Duration::from_secs(10 * 60);
/// Requests bigger than this are refused; a signature is about 130 bytes.
const MAX_BODY: u64 = 16 * 1024;
/// The event the app listens for.
pub const EVENT: &str = "browser-connect";

const PAGE: &str = include_str!("../browser-connect/index.html");
const SCRIPT: &str = include_str!("../browser-connect/app.js");
const STYLE: &str = include_str!("../browser-connect/style.css");
const TOKENS: &str = include_str!("../../../../.claude/brand/pewterdesk-tokens.css");
const LOGO: &str = include_str!("../../../../assets/logo/pewterdesk-horizontal-dark-bg.svg");
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// What the app hears about the page.
#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum BrowserEvent {
    Connected { wallet: WalletInfo },
    Ended,
}

struct Running {
    stop: Arc<AtomicBool>,
    url: String,
}

/// Which chain the page asks the wallet to switch to before signing, for
/// `venue`: Arbitrum for Hyperliquid, as its own site does, and none for
/// Aster. Neither insists: both take a signature made on whichever chain
/// the wallet is on, so a wallet that can't switch still connects.
fn page_config(venue: VenueId) -> Result<serde_json::Value, VenueError> {
    match venue {
        VenueId::Hyperliquid => Ok(json!({ "chainId": 42161, "required": false })),
        VenueId::Aster => Ok(json!({ "chainId": 0, "required": false })),
        VenueId::Bybit => Err(VenueError::Unsupported(
            "connecting a wallet to Bybit (it connects with an API key)",
        )),
    }
}

/// The page that's up, if any.
#[derive(Default)]
pub struct BrowserConnect(Mutex<Option<Running>>);

fn random_token() -> Result<String, VenueError> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| VenueError::Network("no random source for the wallet page".into()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Starts the page for connecting to `venue` and opens it in the system
/// browser. `strings` is the page's text in the user's language.
#[tauri::command]
pub fn start_browser_connect(
    app: AppHandle,
    state: State<'_, BrowserConnect>,
    venue: VenueId,
    strings: HashMap<String, String>,
) -> Result<(), VenueError> {
    let config = page_config(venue)?.to_string();
    stop_running(&state);
    let token = random_token()?;
    let server = Server::http("127.0.0.1:0")
        .map_err(|_| VenueError::Network("couldn't start the wallet page".into()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| VenueError::Network("couldn't start the wallet page".into()))?;
    let url = format!("http://127.0.0.1:{port}/{token}/");
    let stop = Arc::new(AtomicBool::new(false));
    *state.0.lock().unwrap() = Some(Running {
        stop: Arc::clone(&stop),
        url: url.clone(),
    });
    let strings = serde_json::to_string(&strings).unwrap_or_else(|_| "{}".into());
    let page = Page {
        venue,
        strings,
        config,
    };
    std::thread::spawn(move || serve(app, server, Gate { token, port }, stop, page));
    crate::about::open_url(&url)
        .map_err(|_| VenueError::Network("couldn't open the browser".into()))
}

/// Opens the running page again (the user closed the tab).
#[tauri::command]
pub fn reopen_browser_connect(state: State<'_, BrowserConnect>) -> Result<(), VenueError> {
    let url = state.0.lock().unwrap().as_ref().map(|r| r.url.clone());
    match url {
        Some(url) => crate::about::open_url(&url)
            .map_err(|_| VenueError::Network("couldn't open the browser".into())),
        None => Err(VenueError::InvalidRequest(
            "the wallet page has closed; start again".into(),
        )),
    }
}

/// Stops the page and drops any approval it started.
#[tauri::command]
pub fn cancel_browser_connect(state: State<'_, BrowserConnect>, onboarding: State<'_, Onboarding>) {
    stop_running(&state);
    wallet::cancel(&onboarding);
}

fn stop_running(state: &BrowserConnect) {
    if let Some(running) = state.0.lock().unwrap().take() {
        running.stop.store(true, Ordering::Relaxed);
    }
}

/// What a request must match to be served.
struct Gate {
    token: String,
    port: u16,
}

#[derive(Debug, PartialEq, Eq)]
enum Route<'a> {
    Asset(&'a str),
    Post(&'a str),
}

impl Gate {
    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Where a request goes, or `None` to refuse it: wrong host, wrong
    /// token, a post from another origin or not JSON, or an unknown method.
    fn route<'a>(
        &self,
        method: &Method,
        url: &'a str,
        host: Option<&str>,
        origin: Option<&str>,
        content_type: Option<&str>,
    ) -> Option<Route<'a>> {
        if host != Some(self.host().as_str()) {
            return None;
        }
        let path = url.split('?').next()?;
        let rest = path.strip_prefix('/')?.strip_prefix(self.token.as_str())?;
        let name = rest.strip_prefix('/')?;
        match method {
            Method::Get => Some(Route::Asset(name)),
            Method::Post => {
                let json = content_type.is_some_and(|c| c.starts_with("application/json"));
                (origin == Some(self.origin().as_str()) && json).then_some(Route::Post(name))
            }
            _ => None,
        }
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn header_value<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

fn respond(request: Request, status: u16, content_type: &str, body: String) {
    let response = Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("Content-Security-Policy", CSP))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"));
    let _ = request.respond(response);
}

fn json_reply(request: Request, result: Result<serde_json::Value, VenueError>) {
    match result {
        Ok(body) => respond(request, 200, "application/json", body.to_string()),
        Err(e) => respond(
            request,
            400,
            "application/json",
            json!({ "error": e.to_string() }).to_string(),
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginBody {
    address: String,
    chain_id: u64,
}

#[derive(Deserialize)]
struct FinishBody {
    signature: String,
}

fn read_body<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T, VenueError> {
    let mut body = String::new();
    request
        .as_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .map_err(|_| VenueError::InvalidRequest("unreadable request".into()))?;
    serde_json::from_str(&body).map_err(|_| VenueError::InvalidRequest("malformed request".into()))
}

/// What one run of the page is for.
struct Page {
    venue: VenueId,
    /// The page's text, as JSON.
    strings: String,
    /// The chain to switch to first, as JSON (`page_config`).
    config: String,
}

/// Serves until connected, cancelled, or `SERVER_FOR` passes, then tells the app.
fn serve(app: AppHandle, server: Server, gate: Gate, stop: Arc<AtomicBool>, page: Page) {
    let deadline = Instant::now() + SERVER_FOR;
    while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
        let Ok(Some(mut request)) = server.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };
        let route = gate.route(
            request.method(),
            request.url(),
            header_value(&request, "Host"),
            header_value(&request, "Origin"),
            header_value(&request, "Content-Type"),
        );
        let route = match route {
            Some(Route::Asset(name)) => Route::Asset(match name {
                "" => "index",
                "app.js" => "script",
                "style.css" => "style",
                "strings.json" => "strings",
                "config.json" => "config",
                "logo.svg" => "logo",
                _ => "missing",
            }),
            Some(Route::Post(name)) => Route::Post(match name {
                "begin" => "begin",
                "finish" => "finish",
                "cancel" => "cancel",
                _ => "missing",
            }),
            None => {
                respond(request, 404, "text/plain", "not found".into());
                continue;
            }
        };
        let onboarding = app.state::<Onboarding>();
        let venues = app.state::<Venues>();
        match route {
            Route::Asset("index") => respond(request, 200, "text/html; charset=utf-8", PAGE.into()),
            Route::Asset("script") => respond(
                request,
                200,
                "text/javascript; charset=utf-8",
                SCRIPT.into(),
            ),
            Route::Asset("style") => respond(
                request,
                200,
                "text/css; charset=utf-8",
                format!("{TOKENS}\n{STYLE}"),
            ),
            Route::Asset("strings") => {
                respond(request, 200, "application/json", page.strings.clone())
            }
            Route::Asset("config") => {
                respond(request, 200, "application/json", page.config.clone())
            }
            Route::Asset("logo") => respond(request, 200, "image/svg+xml", LOGO.into()),
            Route::Post("begin") => {
                let result = read_body::<BeginBody>(&mut request).and_then(|body| {
                    tauri::async_runtime::block_on(wallet::begin(
                        &onboarding,
                        &venues,
                        page.venue,
                        &body.address,
                        body.chain_id,
                    ))
                });
                json_reply(request, result);
            }
            Route::Post("finish") => {
                let result = read_body::<FinishBody>(&mut request).and_then(|body| {
                    tauri::async_runtime::block_on(wallet::finish(
                        &onboarding,
                        &venues,
                        &body.signature,
                    ))
                });
                match result {
                    Ok(info) => {
                        json_reply(request, Ok(json!({ "ok": true })));
                        let _ = app.emit(EVENT, BrowserEvent::Connected { wallet: info });
                        break;
                    }
                    Err(e) => json_reply(request, Err(e)),
                }
            }
            Route::Post("cancel") => {
                wallet::cancel(&onboarding);
                json_reply(request, Ok(json!({ "ok": true })));
            }
            _ => respond(request, 404, "text/plain", "not found".into()),
        }
    }
    let _ = app.emit(EVENT, BrowserEvent::Ended);
    if let Some(state) = app.try_state::<BrowserConnect>() {
        let mut running = state.0.lock().unwrap();
        if running
            .as_ref()
            .is_some_and(|r| Arc::ptr_eq(&r.stop, &stop))
        {
            *running = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> Gate {
        Gate {
            token: "abc123".into(),
            port: 4567,
        }
    }

    const HOST: Option<&str> = Some("127.0.0.1:4567");
    const ORIGIN: Option<&str> = Some("http://127.0.0.1:4567");
    const JSON: Option<&str> = Some("application/json");

    #[test]
    fn serves_only_under_the_token() {
        let g = gate();
        assert_eq!(
            g.route(&Method::Get, "/abc123/", HOST, None, None),
            Some(Route::Asset(""))
        );
        assert_eq!(
            g.route(&Method::Get, "/abc123/app.js?v=1", HOST, None, None),
            Some(Route::Asset("app.js"))
        );
        assert_eq!(g.route(&Method::Get, "/", HOST, None, None), None);
        assert_eq!(g.route(&Method::Get, "/abc12/", HOST, None, None), None);
        assert_eq!(g.route(&Method::Get, "/abc1234/", HOST, None, None), None);
        assert_eq!(g.route(&Method::Get, "/abc123", HOST, None, None), None);
    }

    #[test]
    fn refuses_other_hosts() {
        // A rebound DNS name resolving to 127.0.0.1 still carries its own Host.
        let g = gate();
        for host in [
            Some("evil.example:4567"),
            Some("localhost:4567"),
            Some("127.0.0.1:1"),
            None,
        ] {
            assert_eq!(
                g.route(&Method::Get, "/abc123/", host, None, None),
                None,
                "{host:?}"
            );
        }
    }

    #[test]
    fn posts_need_the_pages_origin_and_json() {
        let g = gate();
        assert_eq!(
            g.route(&Method::Post, "/abc123/begin", HOST, ORIGIN, JSON),
            Some(Route::Post("begin"))
        );
        assert_eq!(
            g.route(
                &Method::Post,
                "/abc123/begin",
                HOST,
                Some("https://evil.example"),
                JSON
            ),
            None
        );
        assert_eq!(
            g.route(&Method::Post, "/abc123/begin", HOST, None, JSON),
            None
        );
        assert_eq!(
            g.route(
                &Method::Post,
                "/abc123/begin",
                HOST,
                ORIGIN,
                Some("text/plain")
            ),
            None
        );
        assert_eq!(
            g.route(&Method::Put, "/abc123/begin", HOST, ORIGIN, JSON),
            None
        );
    }

    #[test]
    fn tokens_are_random_and_long() {
        let a = random_token().unwrap();
        let b = random_token().unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
