//! The link against a scripted daemon on a socket.
#![cfg(unix)]

use std::time::Duration;

use pewterdesk_link::Link;
use pewterdesk_protocol::local::Paths;
use pewterdesk_protocol::rpc::{Call, ClientInfo, ClientKind, Event, Halted};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn paths(name: &str) -> Paths {
    let dir = std::env::temp_dir().join(format!("pdl{}{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Paths {
        config: dir.clone(),
        data: dir,
    }
}

fn pd() -> ClientInfo {
    ClientInfo {
        name: "pd".into(),
        kind: ClientKind::Pd,
    }
}

/// A daemon that welcomes, then answers each call with its own id as the
/// result - the second before the first - and sends an event between.
async fn scripted(paths: &Paths) {
    let listener = tokio::net::UnixListener::bind(paths.socket()).unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let send = |v: Value| {
            let mut line = v.to_string();
            line.push('\n');
            line
        };
        // hello
        let hello: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let welcome = send(
            json!({"jsonrpc":"2.0","id":hello["id"],"result":{"version":1,"server":"t","paired":true}}),
        );
        write.write_all(welcome.as_bytes()).await.unwrap();
        // two calls, answered out of order, an event between
        let a: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let b: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        for line in [
            send(json!({"jsonrpc":"2.0","id":b["id"],"result":b["id"]})),
            send(
                json!({"jsonrpc":"2.0","method":"event","params":{"kind":"halted","data":{"stopped":2}}}),
            ),
            send(json!({"jsonrpc":"2.0","id":a["id"],"result":a["id"]})),
        ] {
            write.write_all(line.as_bytes()).await.unwrap();
        }
        // a third call that's never answered: the daemon goes away.
        let _ = lines.next_line().await;
    });
}

#[tokio::test]
async fn answers_find_their_calls_and_events_their_listeners() {
    let paths = paths("a");
    scripted(&paths).await;
    let link = Link::unix(&paths, pd(), None).await.unwrap();
    assert!(link.paired);
    let mut events = link.events();
    let (a, b) = tokio::join!(
        link.call::<u64>(Call::Status),
        link.call::<u64>(Call::AlgoList)
    );
    // Each got its own answer, though they came back the other way round.
    assert_ne!(a.unwrap(), b.unwrap());
    let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event, Event::Halted(Halted { stopped: 2 }));
    // The daemon goes: a call waiting on it is told, not left hanging.
    let gone = tokio::time::timeout(Duration::from_secs(5), link.call::<u64>(Call::Halt)).await;
    assert!(gone.unwrap().is_err());
    assert!(!link.alive());
    let _ = std::fs::remove_dir_all(&paths.data);
}

#[tokio::test]
async fn nothing_listening_is_not_running() {
    let paths = paths("b");
    assert!(matches!(
        Link::unix(&paths, pd(), None).await,
        Err(pewterdesk_link::Unreachable::NotRunning)
    ));
    let _ = std::fs::remove_dir_all(&paths.data);
}
