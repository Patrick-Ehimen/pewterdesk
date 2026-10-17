//! The engine's event log: an append-only record, in SQLite (WAL), of every
//! routed command, every gate decision, every order sent and every venue
//! result, each with where it came from. It is the audit trail, and the
//! record a client order id is written to before its order is sent.
//!
//! Security-relevant - review any change against
//! `.claude/commands/security-review.md` and `docs/bots/safety.md`:
//! - No key material, ever. Callers log what was asked and what came back
//!   (orders, account ids, keychain entry *names* at most), never a key, a
//!   signature or a signed payload.
//! - Append-only: nothing here updates or deletes an event.
//! - The file lives in the app's own data folder, readable by the user only
//!   as much as that folder is.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

/// The schema this code writes, kept in SQLite's `user_version`.
const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    command   INTEGER,
    kind      TEXT NOT NULL,
    origin    TEXT,
    venue     TEXT,
    account   TEXT,
    operation TEXT,
    client_id TEXT,
    detail    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_command ON events (command);
CREATE INDEX IF NOT EXISTS events_client_id ON events (client_id);
";

/// Why the log couldn't be opened, read or written. Messages are SQLite's
/// own (about the file or the statement), never an event's contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "event log: {}", self.0)
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(err: rusqlite::Error) -> Self {
        Self(err.to_string())
    }
}

/// One event to append.
#[derive(Clone, Debug, Default)]
pub struct NewEvent<'a> {
    /// When, in milliseconds since the Unix epoch.
    pub at: u64,
    /// The command event this one belongs to (its `seq`); none for a command.
    pub command: Option<u64>,
    /// What happened: the engine's own vocabulary (`command`, `gate`, `sent`,
    /// `result`).
    pub kind: &'a str,
    /// Where the command came from (`ticket`, `palette`, ...).
    pub origin: Option<&'a str>,
    pub venue: Option<&'a str>,
    pub account: Option<&'a str>,
    /// The trading operation (`placeOrder`, `cancelOrder`, ...).
    pub operation: Option<&'a str>,
    /// The client order id, on the event that records it.
    pub client_id: Option<&'a str>,
    /// Everything else about it, as JSON.
    pub detail: serde_json::Value,
}

/// One event as kept.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub seq: u64,
    pub at: u64,
    pub command: Option<u64>,
    pub kind: String,
    pub origin: Option<String>,
    pub venue: Option<String>,
    pub account: Option<String>,
    pub operation: Option<String>,
    pub client_id: Option<String>,
    pub detail: serde_json::Value,
}

/// The event log, open.
pub struct EventLog {
    conn: Mutex<Connection>,
    engine_id: u64,
}

impl EventLog {
    /// The log at `path`, created (with its folder) if it isn't there yet.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| StoreError(e.to_string()))?;
        }
        let conn = Connection::open(path)?;
        // WAL: appends don't block readers. FULL: an order's record is on
        // disk before the order is sent, even across a power cut.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        Self::with(conn)
    }

    /// A log that lives in memory only, for tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::with(Connection::open_in_memory()?)
    }

    fn with(conn: Connection) -> Result<Self, StoreError> {
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StoreError(format!(
                "written by a newer version of the app (schema {version})"
            )));
        }
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        let engine_id = Self::engine_id_of(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            engine_id,
        })
    }

    /// This log's engine id: random, made once, never zero. Client order
    /// ids start with it, so two installs never make the same one.
    fn engine_id_of(conn: &Connection) -> Result<u64, StoreError> {
        let kept: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'engine_id'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = kept.and_then(|v| u64::from_str_radix(&v, 16).ok()) {
            if id != 0 {
                return Ok(id);
            }
        }
        let id = loop {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes).map_err(|e| StoreError(e.to_string()))?;
            let id = u64::from_be_bytes(bytes);
            if id != 0 {
                break id;
            }
        };
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('engine_id', ?1)",
            params![format!("{id:016x}")],
        )?;
        Ok(id)
    }

    pub fn engine_id(&self) -> u64 {
        self.engine_id
    }

    /// Appends `event` and returns its `seq`, once it's written.
    pub fn append(&self, event: &NewEvent<'_>) -> Result<u64, StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO events
                (at, command, kind, origin, venue, account, operation, client_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                event.at as i64,
                event.command.map(|c| c as i64),
                event.kind,
                event.origin,
                event.venue,
                event.account,
                event.operation,
                event.client_id,
                event.detail.to_string(),
            ],
        )?;
        Ok(conn.last_insert_rowid() as u64)
    }

    /// The latest `limit` events, newest first.
    pub fn recent(&self, limit: usize) -> Result<Vec<Event>, StoreError> {
        self.query(
            "SELECT seq, at, command, kind, origin, venue, account, operation, client_id, detail
             FROM events ORDER BY seq DESC LIMIT ?1",
            params![limit as i64],
        )
    }

    /// A command and everything logged for it, in order.
    pub fn for_command(&self, seq: u64) -> Result<Vec<Event>, StoreError> {
        self.query(
            "SELECT seq, at, command, kind, origin, venue, account, operation, client_id, detail
             FROM events WHERE seq = ?1 OR command = ?1 ORDER BY seq",
            params![seq as i64],
        )
    }

    fn query(&self, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Event>, StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut statement = conn.prepare(sql)?;
        let rows = statement.query_map(args, |row| {
            let detail: String = row.get(9)?;
            Ok(Event {
                seq: row.get::<_, i64>(0)? as u64,
                at: row.get::<_, i64>(1)? as u64,
                command: row.get::<_, Option<i64>>(2)?.map(|c| c as u64),
                kind: row.get(3)?,
                origin: row.get(4)?,
                venue: row.get(5)?,
                account: row.get(6)?,
                operation: row.get(7)?,
                client_id: row.get(8)?,
                detail: serde_json::from_str(&detail).unwrap_or(serde_json::Value::Null),
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pewterdesk-store-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("nested").join("events.sqlite3")
    }

    #[test]
    fn appends_in_order_and_reads_a_command_back() {
        let log = EventLog::open_in_memory().unwrap();
        let command = log
            .append(&NewEvent {
                at: 1,
                kind: "command",
                origin: Some("ticket"),
                venue: Some("bybit"),
                account: Some("demo:1"),
                operation: Some("placeOrder"),
                detail: json!({ "market": "BTCUSDT" }),
                ..NewEvent::default()
            })
            .unwrap();
        let sent = log
            .append(&NewEvent {
                at: 2,
                command: Some(command),
                kind: "sent",
                client_id: Some("0xabc"),
                detail: json!(null),
                ..NewEvent::default()
            })
            .unwrap();
        assert!(sent > command);
        let events = log.for_command(command).unwrap();
        assert_eq!(
            events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            ["command", "sent"]
        );
        assert_eq!(events[0].origin.as_deref(), Some("ticket"));
        assert_eq!(events[0].detail, json!({ "market": "BTCUSDT" }));
        assert_eq!(events[1].client_id.as_deref(), Some("0xabc"));
        assert_eq!(log.recent(1).unwrap()[0].seq, sent);
    }

    #[test]
    fn keeps_its_engine_id_and_events_across_opens() {
        let path = scratch("reopen");
        let log = EventLog::open(&path).unwrap();
        let id = log.engine_id();
        assert_ne!(id, 0);
        let first = log
            .append(&NewEvent {
                at: 1,
                kind: "command",
                ..NewEvent::default()
            })
            .unwrap();
        drop(log);
        let again = EventLog::open(&path).unwrap();
        assert_eq!(again.engine_id(), id);
        let next = again
            .append(&NewEvent {
                at: 2,
                kind: "command",
                ..NewEvent::default()
            })
            .unwrap();
        // Sequence numbers carry on: a client id made from one is never reused.
        assert!(next > first);
        assert_eq!(again.recent(10).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn two_logs_have_different_engine_ids() {
        let a = EventLog::open_in_memory().unwrap();
        let b = EventLog::open_in_memory().unwrap();
        assert_ne!(a.engine_id(), b.engine_id());
    }

    #[test]
    fn refuses_a_log_from_a_newer_app() {
        let path = scratch("newer");
        drop(EventLog::open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);
        assert!(EventLog::open(&path).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }
}
