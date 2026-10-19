//! `pewterdesk-link`: a program's connection to the daemon (`pdd`) - `pd`'s
//! over its Unix socket, the app's over its WebSocket on 127.0.0.1 - and
//! keeping `pdd` running in the background (`launchd`).
//!
//! A link carries many calls at once: each request goes out with an id, and
//! its answer is matched back to it; the daemon's events go to whoever
//! listens. It says `hello` first, with the client's pairing token: the
//! caller reads that from its keychain and hands it over; this crate never
//! keeps or prints it.

pub mod launchd;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use pewterdesk_protocol::local::Paths;
use pewterdesk_protocol::rpc::{
    code, Call, ClientInfo, Event, Hello, Id, Incoming, Request, Response, RpcError, Welcome,
    PROTOCOL_VERSION,
};
use serde::de::DeserializeOwned;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, oneshot};

/// How long a call waits for its answer. Generous: an order can wait on
/// the venue.
const ANSWER_WITHIN: Duration = Duration::from_secs(60);

type Waiting = Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>;

/// A connection to the daemon.
pub struct Link {
    out: mpsc::Sender<String>,
    waiting: Waiting,
    next: AtomicU64,
    events: broadcast::Sender<Event>,
    alive: Arc<AtomicBool>,
    /// Whether its `hello` carried a paired client's token.
    pub paired: bool,
}

/// Why there's no daemon to talk to.
#[derive(Debug)]
pub enum Unreachable {
    /// Nothing answers.
    NotRunning,
    /// It answered, but not as it should (another protocol version...).
    Refused(String),
}

impl std::fmt::Display for Unreachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unreachable::NotRunning => write!(f, "the daemon isn't running"),
            Unreachable::Refused(why) => write!(f, "{why}"),
        }
    }
}

fn lost() -> RpcError {
    RpcError::new(code::INTERNAL, "the daemon went away")
}

/// Takes each line (or frame) the daemon sends: an answer to the call
/// waiting on it, or an event for the listeners.
fn take(line: &str, waiting: &Waiting, events: &broadcast::Sender<Event>) {
    match serde_json::from_str::<Incoming>(line) {
        Ok(Incoming::Response(response)) => {
            let id = match &response.id {
                Some(Id::Num(n)) => *n,
                _ => return,
            };
            if let Some(tx) = waiting.lock().unwrap().remove(&id) {
                let _ = tx.send(*response);
            }
        }
        Ok(Incoming::Notification(n)) => {
            let _ = events.send(n.params);
        }
        Err(_) => {}
    }
}

/// When the connection ends, every call still waiting is told.
fn close(waiting: &Waiting, alive: &AtomicBool) {
    alive.store(false, Ordering::SeqCst);
    waiting.lock().unwrap().clear();
}

impl Link {
    fn new(
        out: mpsc::Sender<String>,
        waiting: Waiting,
        events: broadcast::Sender<Event>,
        alive: Arc<AtomicBool>,
    ) -> Self {
        Self {
            out,
            waiting,
            next: AtomicU64::new(1),
            events,
            alive,
            paired: false,
        }
    }

    /// Over the daemon's Unix socket (`pd`).
    #[cfg(unix)]
    pub async fn unix(
        paths: &Paths,
        client: ClientInfo,
        token: Option<String>,
    ) -> Result<Self, Unreachable> {
        let stream = tokio::net::UnixStream::connect(paths.socket())
            .await
            .map_err(|_| Unreachable::NotRunning)?;
        let (read, mut write) = stream.into_split();
        let (out, mut outgoing) = mpsc::channel::<String>(64);
        let waiting: Waiting = Arc::default();
        let (events, _) = broadcast::channel(256);
        let alive = Arc::new(AtomicBool::new(true));
        tokio::spawn(async move {
            while let Some(line) = outgoing.recv().await {
                if write.write_all(line.as_bytes()).await.is_err()
                    || write.write_all(b"\n").await.is_err()
                {
                    return;
                }
            }
        });
        let (w, e, a) = (Arc::clone(&waiting), events.clone(), Arc::clone(&alive));
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                take(&line, &w, &e);
            }
            close(&w, &a);
        });
        Self::new(out, waiting, events, alive)
            .hello(client, token)
            .await
    }

    /// Over the daemon's WebSocket on 127.0.0.1 (the app). Its port is in
    /// the data folder's `pdd.port`.
    pub async fn websocket(
        paths: &Paths,
        client: ClientInfo,
        token: Option<String>,
    ) -> Result<Self, Unreachable> {
        let port: u16 = std::fs::read_to_string(paths.port_file())
            .ok()
            .and_then(|p| p.trim().parse().ok())
            .ok_or(Unreachable::NotRunning)?;
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/"))
            .await
            .map_err(|_| Unreachable::NotRunning)?;
        let (mut sink, mut source) = ws.split();
        let (out, mut outgoing) = mpsc::channel::<String>(64);
        let waiting: Waiting = Arc::default();
        let (events, _) = broadcast::channel(256);
        let alive = Arc::new(AtomicBool::new(true));
        tokio::spawn(async move {
            use tokio_tungstenite::tungstenite::Message;
            while let Some(text) = outgoing.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    return;
                }
            }
            let _ = sink.close().await;
        });
        let (w, e, a) = (Arc::clone(&waiting), events.clone(), Arc::clone(&alive));
        tokio::spawn(async move {
            use tokio_tungstenite::tungstenite::Message;
            while let Some(Ok(message)) = source.next().await {
                match message {
                    Message::Text(text) => take(text.as_str(), &w, &e),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            close(&w, &a);
        });
        Self::new(out, waiting, events, alive)
            .hello(client, token)
            .await
    }

    async fn hello(
        mut self,
        client: ClientInfo,
        token: Option<String>,
    ) -> Result<Self, Unreachable> {
        let welcome: Welcome = self
            .call(Call::Hello(Hello {
                version: PROTOCOL_VERSION,
                client,
                token,
            }))
            .await
            .map_err(|e| Unreachable::Refused(e.message))?;
        self.paired = welcome.paired;
        Ok(self)
    }

    /// Whether the connection is still up.
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Sends one call and waits for its answer.
    pub async fn call<T: DeserializeOwned>(&self, call: Call) -> Result<T, RpcError> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        let line = serde_json::to_string(&Request::new(Id::Num(id), call))
            .map_err(|e| RpcError::new(code::INTERNAL, e.to_string()))?;
        if self.out.send(line).await.is_err() {
            self.waiting.lock().unwrap().remove(&id);
            return Err(lost());
        }
        match tokio::time::timeout(ANSWER_WITHIN, rx).await {
            Ok(Ok(response)) => response.into_result(),
            Ok(Err(_)) => Err(lost()),
            Err(_) => {
                self.waiting.lock().unwrap().remove(&id);
                Err(RpcError::new(
                    code::INTERNAL,
                    "the daemon didn't answer in time",
                ))
            }
        }
    }

    /// The daemon's events, from now on (after `Call::Subscribe`).
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }
}
