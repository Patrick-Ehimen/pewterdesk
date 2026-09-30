//! Aster's combined-stream WebSocket. Each subscription gets its own
//! connection, named streams in its URL, which reconnects with backoff until
//! the receiver is dropped. Aster ends every connection after 24 hours; that
//! is just another reconnect.
//!
//! When a consumer's channel is full the update is dropped rather than
//! stalling the socket: every stream here is re-sent whole or is re-derived
//! into a snapshot, so a missed update loses nothing lasting.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use pewterdesk_core::VenueError;
use serde::Deserialize;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::time::{interval, sleep, timeout, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Aster pings every few minutes and the socket answers by itself; our own
/// pings get a pong back, which is how a dead connection shows itself.
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

/// One push on a combined stream.
#[derive(Deserialize)]
pub struct Push {
    pub stream: String,
    pub data: Value,
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

/// Connects before returning, so a venue that can't be reached is an error
/// here rather than a stream that never yields. `streams` are stream names
/// (`btcusdt@trade`), already encoded by `wire::stream_name`.
pub async fn subscribe<T, F>(
    base: &'static str,
    streams: Vec<String>,
    mut on_push: F,
) -> Result<mpsc::Receiver<T>, VenueError>
where
    T: Send + 'static,
    F: FnMut(Push) -> Handled<T> + Send + 'static,
{
    let url = format!("{base}?streams={}", streams.join("/"));
    let mut socket = connect(&url).await?;
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
                if let Ok(fresh) = connect(&url).await {
                    socket = fresh;
                    backoff = BACKOFF_MIN;
                    break;
                }
            }
        }
    });

    Ok(rx)
}

async fn connect(url: &str) -> Result<Socket, VenueError> {
    let (socket, _) = timeout(IO_TIMEOUT, connect_async(url))
        .await
        .map_err(|_| VenueError::Network("connection timed out".into()))?
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
                let ping = Message::Ping(Default::default());
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

    use futures_util::SinkExt;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use super::*;

    /// A server that sends one push on each connection, then goes silent: it
    /// never reads again, so it never answers a ping, like a connection whose
    /// network has gone. The client must notice and connect again.
    #[tokio::test]
    async fn reconnects_when_the_connection_goes_silent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url: &'static str =
            Box::leak(format!("ws://{}/stream", listener.local_addr().unwrap()).into_boxed_str());
        tokio::spawn(async move {
            let mut n = 0;
            let mut held = Vec::new();
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                n += 1;
                let mut ws = accept_async(tcp).await.unwrap();
                let push = format!(r#"{{"stream":"x","data":{n}}}"#);
                ws.send(Message::text(push)).await.unwrap();
                held.push(ws); // Kept open, never read.
            }
        });

        let mut rx = subscribe(url, vec![], |push| Handled::Emit(push.data))
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
        assert_eq!(first.unwrap(), Some(serde_json::json!(1)));
        // Silent past IDLE_TIMEOUT: a second connection, and its push.
        let second = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
        assert_eq!(second.unwrap(), Some(serde_json::json!(2)));
    }
}
