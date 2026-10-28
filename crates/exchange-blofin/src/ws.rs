//! BloFin's public WebSocket. Each subscription gets its own connection,
//! subscribes to its channels with a `subscribe` message, and reconnects
//! (subscribing again) with backoff until the receiver is dropped.
//!
//! BloFin closes a connection that hears nothing for 30 seconds, and keeps
//! one alive with the text `ping`, answered `pong`; this sends one every
//! `PING_EVERY`, and treats silence past `IDLE_TIMEOUT` as a dead connection.
//!
//! When a consumer's channel is full the update is dropped rather than
//! stalling the socket: every stream here is re-sent whole or re-derived
//! into a snapshot, so a missed update loses nothing lasting. A handler that
//! has lost its place (a book that missed an update) asks for `Resync`,
//! which reconnects: the fresh subscription starts with a full snapshot.

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

const PING_EVERY: Duration = if cfg!(test) {
    Duration::from_millis(200)
} else {
    Duration::from_secs(20)
};
const IDLE_TIMEOUT: Duration = if cfg!(test) {
    Duration::from_millis(600)
} else {
    Duration::from_secs(40)
};
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(10);
const BUFFER: usize = 16;

/// A channel to subscribe to: its name and the market.
#[derive(Clone, Debug)]
pub struct Channel {
    pub channel: String,
    pub inst_id: String,
}

impl Channel {
    pub fn new(channel: impl Into<String>, inst_id: &str) -> Self {
        Self {
            channel: channel.into(),
            inst_id: inst_id.to_owned(),
        }
    }
}

#[derive(Deserialize)]
pub struct Arg {
    pub channel: String,
}

/// One push on a channel.
#[derive(Deserialize)]
pub struct Push {
    pub arg: Arg,
    /// `snapshot` or `update`, on the book channel.
    #[serde(default)]
    pub action: Option<String>,
    pub data: Value,
}

/// What a handler tells the connection loop to do with a push.
pub enum Handled<T> {
    Emit(T),
    Ignore,
    /// Start over: reconnect and subscribe again.
    Resync,
}

enum Ended {
    ReceiverDropped,
    Disconnected,
}

/// Connects and subscribes before returning, so a venue that can't be
/// reached is an error here rather than a stream that never yields. The
/// market ids in `channels` are checked by the caller (`validate_market`).
pub async fn subscribe<T, F>(
    url: &'static str,
    channels: Vec<Channel>,
    mut on_push: F,
) -> Result<mpsc::Receiver<T>, VenueError>
where
    T: Send + 'static,
    F: FnMut(Push) -> Handled<T> + Send + 'static,
{
    let request = json!({
        "op": "subscribe",
        "args": channels
            .iter()
            .map(|c| json!({"channel": c.channel, "instId": c.inst_id}))
            .collect::<Vec<_>>(),
    })
    .to_string();
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
                Ended::Disconnected => {
                    let _ = socket.close(None).await;
                }
            }
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
    timeout(IO_TIMEOUT, socket.send(Message::text(request)))
        .await
        .map_err(|_| VenueError::Network("subscribing timed out".into()))?
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

    loop {
        tokio::select! {
            _ = tx.closed() => return Ended::ReceiverDropped,
            _ = ping.tick() => {
                if heard.elapsed() > IDLE_TIMEOUT {
                    return Ended::Disconnected;
                }
                if !matches!(timeout(IO_TIMEOUT, socket.send(Message::text("ping"))).await, Ok(Ok(()))) {
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
                // `pong`, and the `subscribe` / `error` events, aren't pushes.
                let Ok(push) = serde_json::from_str::<Push>(&text) else {
                    continue;
                };
                match on_push(push) {
                    Handled::Emit(item) => match tx.try_send(item) {
                        Ok(()) | Err(TrySendError::Full(_)) => {}
                        Err(TrySendError::Closed(_)) => return Ended::ReceiverDropped,
                    },
                    Handled::Ignore => {}
                    Handled::Resync => return Ended::Disconnected,
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

    fn push(n: u64) -> String {
        format!(r#"{{"arg":{{"channel":"trades","instId":"BTC-USDT"}},"data":{n}}}"#)
    }

    /// Each connection must subscribe first; the server then sends one push
    /// and goes silent, like a connection whose network has gone. The
    /// client must notice, connect again and subscribe again.
    #[tokio::test]
    async fn subscribes_and_reconnects_when_the_connection_goes_silent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url: &'static str = Box::leak(
            format!("ws://{}/ws/public", listener.local_addr().unwrap()).into_boxed_str(),
        );
        tokio::spawn(async move {
            let mut n = 0;
            let mut held = Vec::new();
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                n += 1;
                let mut ws = accept_async(tcp).await.unwrap();
                let Some(Ok(Message::Text(first))) = ws.next().await else {
                    panic!("no subscribe")
                };
                let first: serde_json::Value = serde_json::from_str(&first).unwrap();
                assert_eq!(first["op"], "subscribe");
                assert_eq!(first["args"][0]["instId"], "BTC-USDT");
                ws.send(Message::text(
                    r#"{"event":"subscribe","arg":{"channel":"trades","instId":"BTC-USDT"}}"#,
                ))
                .await
                .unwrap();
                ws.send(Message::text(push(n))).await.unwrap();
                held.push(ws);
            }
        });

        let mut rx = subscribe(url, vec![Channel::new("trades", "BTC-USDT")], |p| {
            Handled::Emit(p.data)
        })
        .await
        .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
        assert_eq!(first.unwrap(), Some(serde_json::json!(1)));
        let second = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
        assert_eq!(second.unwrap(), Some(serde_json::json!(2)));
    }

    /// A handler's `Resync` reconnects at once.
    #[tokio::test]
    async fn a_resync_reconnects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url: &'static str = Box::leak(
            format!("ws://{}/ws/public", listener.local_addr().unwrap()).into_boxed_str(),
        );
        tokio::spawn(async move {
            let mut n = 0;
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                n += 1;
                let mut ws = accept_async(tcp).await.unwrap();
                let _ = ws.next().await;
                ws.send(Message::text(push(n))).await.unwrap();
                tokio::spawn(async move { while ws.next().await.is_some() {} });
            }
        });
        let mut rx = subscribe(url, vec![Channel::new("books", "BTC-USDT")], |p| {
            if p.data == serde_json::json!(1) {
                Handled::Resync
            } else {
                Handled::Emit(p.data)
            }
        })
        .await
        .unwrap();
        let got = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await;
        assert_eq!(got.unwrap(), Some(serde_json::json!(2)));
    }
}
