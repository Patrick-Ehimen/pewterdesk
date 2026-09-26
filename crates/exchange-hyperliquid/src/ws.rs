//! Hyperliquid's WebSocket feed. Each subscription gets its own connection,
//! which reconnects with backoff until the receiver is dropped.
//!
//! Everything pushed here is a full snapshot (a whole book, a whole account),
//! so a slow consumer loses nothing by missing one: when its channel is full
//! the update is dropped rather than stalling the socket and its keepalive.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use pewterdesk_core::VenueError;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::time::{interval, sleep, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::wire::WsMessage;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The venue closes connections that are silent for 60s.
const PING_EVERY: Duration = Duration::from_secs(30);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const BUFFER: usize = 16;

/// What `on_message` tells the connection loop to do with a push.
pub enum Handled<T> {
    Emit(T),
    Ignore,
    /// The subscription can't continue (e.g. the venue rejected it); the
    /// receiver sees the stream end.
    Stop,
}

enum Ended {
    ReceiverDropped,
    Stopped,
    Disconnected,
}

/// Connects and subscribes before returning, so a venue that can't be reached
/// is an error here rather than a stream that never yields.
pub async fn subscribe<T, F>(
    url: &'static str,
    subscriptions: Vec<Value>,
    mut on_message: F,
) -> Result<mpsc::Receiver<T>, VenueError>
where
    T: Send + 'static,
    F: FnMut(WsMessage) -> Handled<T> + Send + 'static,
{
    let mut socket = connect(url, &subscriptions).await?;
    let (tx, rx) = mpsc::channel(BUFFER);

    tokio::spawn(async move {
        let mut backoff = BACKOFF_MIN;
        loop {
            match run(&mut socket, &tx, &mut on_message).await {
                Ended::ReceiverDropped | Ended::Stopped => {
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
                if let Ok(fresh) = connect(url, &subscriptions).await {
                    socket = fresh;
                    backoff = BACKOFF_MIN;
                    break;
                }
            }
        }
    });

    Ok(rx)
}

async fn connect(url: &str, subscriptions: &[Value]) -> Result<Socket, VenueError> {
    let (mut socket, _) = connect_async(url)
        .await
        .map_err(|e| VenueError::Network(e.to_string()))?;
    for subscription in subscriptions {
        let request = json!({ "method": "subscribe", "subscription": subscription });
        socket
            .send(Message::text(request.to_string()))
            .await
            .map_err(|e| VenueError::Network(e.to_string()))?;
    }
    Ok(socket)
}

async fn run<T, F>(socket: &mut Socket, tx: &mpsc::Sender<T>, on_message: &mut F) -> Ended
where
    F: FnMut(WsMessage) -> Handled<T>,
{
    let mut ping = interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ping.tick().await;

    loop {
        tokio::select! {
            _ = tx.closed() => return Ended::ReceiverDropped,
            _ = ping.tick() => {
                let ping = Message::text(json!({ "method": "ping" }).to_string());
                if socket.send(ping).await.is_err() {
                    return Ended::Disconnected;
                }
            }
            frame = socket.next() => {
                let text = match frame {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Ended::Disconnected,
                    Some(Ok(_)) => continue,
                };
                let Ok(message) = serde_json::from_str::<WsMessage>(&text) else {
                    continue;
                };
                match on_message(message) {
                    Handled::Emit(item) => match tx.try_send(item) {
                        Ok(()) | Err(TrySendError::Full(_)) => {}
                        Err(TrySendError::Closed(_)) => return Ended::ReceiverDropped,
                    },
                    Handled::Ignore => {}
                    Handled::Stop => return Ended::Stopped,
                }
            }
        }
    }
}
