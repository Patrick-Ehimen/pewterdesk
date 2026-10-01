//! Bybit's public V5 WebSocket. Each subscription gets its own connection,
//! subscribes to its topics by message once connected (and again after every
//! reconnect), and reconnects with backoff until the receiver is dropped.
//!
//! Every topic here starts with a snapshot after subscribing, so a reconnect
//! resets the consumer's state by itself. When a consumer's channel is full
//! the update is dropped rather than stalling the socket: every stream is
//! re-sent whole or re-derived into a snapshot, so nothing lasting is lost.
//!
//! One unknown topic fails a whole subscribe request, so callers check their
//! markets over REST first.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use pewterdesk_core::VenueError;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::time::{interval, sleep, timeout, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Bybit drops a connection that sends nothing for a while; it asks for an
/// `{"op":"ping"}` every 20 seconds. The pong is also how a dead link shows.
const PING_EVERY: Duration = if cfg!(test) {
    Duration::from_millis(200)
} else {
    Duration::from_secs(15)
};
/// Silence this long (no message, not even a pong) means the connection is
/// dead: a dropped network doesn't close a socket, it just goes quiet.
const IDLE_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_millis(600)
} else {
    Duration::from_secs(40)
};
/// A connection attempt, or a send, that hasn't finished by now won't.
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
/// Kept short, so the feed is back within seconds of the network.
const BACKOFF_MAX: Duration = Duration::from_secs(10);
const BUFFER: usize = 16;

/// One message on a topic. Replies to our own ops (subscribe, ping) have no
/// topic, so requiring it is what skips them; each connection carries one
/// subscription's topics, so the handler doesn't need to read it.
#[derive(Deserialize)]
pub struct Push {
    #[serde(rename = "topic")]
    _topic: String,
    /// "snapshot" or "delta"; absent on topics that are always whole.
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    pub data: Value,
    #[serde(default)]
    pub ts: Option<u64>,
}

impl Push {
    pub fn is_snapshot(&self) -> bool {
        self.kind.as_deref() != Some("delta")
    }
}

/// What `on_push` tells the connection loop to do with a push.
pub enum Handled<T> {
    Emit(T),
    Ignore,
}

enum Ended {
    ReceiverDropped,
    Disconnected,
}

/// Connects and subscribes before returning, so a venue that can't be
/// reached is an error here rather than a stream that never yields.
pub async fn subscribe<T, F>(
    url: &'static str,
    topics: Vec<String>,
    mut on_push: F,
) -> Result<mpsc::Receiver<T>, VenueError>
where
    T: Send + 'static,
    F: FnMut(Push) -> Handled<T> + Send + 'static,
{
    let request = json!({ "op": "subscribe", "args": topics }).to_string();
    let mut socket = connect(url, &request).await?;
    let (tx, rx) = mpsc::channel(BUFFER);

    tokio::spawn(async move {
        let mut backoff = BACKOFF_MIN;
        loop {
            match run(&mut socket, &tx, &mut on_push).await {
                Ended::ReceiverDropped => {
                    let _ = socket.close(None).await;
                    return;
                }
                Ended::Disconnected => {}
            }
            // Reconnect until it works or nobody is listening any more.
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    _ = sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
                if let Ok(fresh) = connect(url, &request).await {
                    socket = fresh;
                    backoff = BACKOFF_MIN;
                    break;
                }
            }
        }
    });

    Ok(rx)
}

async fn connect(url: &str, request: &str) -> Result<Socket, VenueError> {
    let (mut socket, _) = timeout(IO_TIMEOUT, connect_async(url))
        .await
        .map_err(|_| VenueError::Network("connection timed out".into()))?
        .map_err(|e| VenueError::Network(e.to_string()))?;
    timeout(IO_TIMEOUT, socket.send(Message::text(request.to_owned())))
        .await
        .map_err(|_| VenueError::Network("subscribe timed out".into()))?
        .map_err(|e| VenueError::Network(e.to_string()))?;
    Ok(socket)
}

async fn run<T, F>(socket: &mut Socket, tx: &mpsc::Sender<T>, on_push: &mut F) -> Ended
where
    F: FnMut(Push) -> Handled<T>,
{
    let mut ping = interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ping.tick().await;
    let mut heard = Instant::now();
    let ping_op = json!({ "op": "ping" }).to_string();

    loop {
        tokio::select! {
            _ = tx.closed() => return Ended::ReceiverDropped,
            _ = ping.tick() => {
                if heard.elapsed() > IDLE_TIMEOUT {
                    return Ended::Disconnected;
                }
                let ping = Message::text(ping_op.clone());
                if !matches!(timeout(IO_TIMEOUT, socket.send(ping)).await, Ok(Ok(()))) {
                    return Ended::Disconnected;
                }
            }
            frame = socket.next() => {
                heard = Instant::now();
                let text = match frame {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Ended::Disconnected,
                    Some(Ok(_)) => continue,
                };
                let Ok(push) = serde_json::from_str::<Push>(&text) else {
                    continue;
                };
                match on_push(push) {
                    Handled::Emit(item) => match tx.try_send(item) {
                        Ok(()) | Err(TrySendError::Full(_)) => {}
                        Err(TrySendError::Closed(_)) => return Ended::ReceiverDropped,
                    },
                    Handled::Ignore => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use super::*;

    /// A server that reads the subscribe, sends one push on each connection,
    /// then goes silent (never answering a ping), like a connection whose
    /// network has gone. The client must notice, connect and subscribe again.
    #[tokio::test]
    async fn resubscribes_when_the_connection_goes_silent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url: &'static str =
            Box::leak(format!("ws://{}/v5", listener.local_addr().unwrap()).into_boxed_str());
        tokio::spawn(async move {
            let mut n = 0;
            let mut held = Vec::new();
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                n += 1;
                let mut ws = accept_async(tcp).await.unwrap();
                let first = ws.next().await.unwrap().unwrap();
                assert!(first.to_text().unwrap().contains(r#""op":"subscribe""#));
                let push = format!(r#"{{"topic":"t","type":"snapshot","data":{n}}}"#);
                ws.send(Message::text(push)).await.unwrap();
                held.push(ws); // Kept open, never read again.
            }
        });

        let mut rx = subscribe(url, vec!["t".into()], |push| Handled::Emit(push.data))
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
        assert_eq!(first.unwrap(), Some(serde_json::json!(1)));
        let second = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
        assert_eq!(second.unwrap(), Some(serde_json::json!(2)));
    }

    #[test]
    fn deltas_are_told_apart_from_snapshots() {
        let delta: Push =
            serde_json::from_str(r#"{"topic":"t","type":"delta","data":{}}"#).unwrap();
        let whole: Push = serde_json::from_str(r#"{"topic":"t","data":[]}"#).unwrap();
        assert!(!delta.is_snapshot());
        assert!(whole.is_snapshot());
    }
}
