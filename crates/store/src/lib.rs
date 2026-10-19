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
//! - Append-only: nothing here updates or deletes an event. The tables
//!   that change are `algos` and `bots`, each one's current state (its
//!   spec, status and progress), so the engine can find the ones it closed
//!   on, and a bot's settings and paper record survive a restart.
//! - Candles a recorder keeps live in a file of their own (`Recorder`):
//!   market data, no account in them.
//! - The file lives in the app's own data folder, readable by the user only
//!   as much as that folder is.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

/// The schema this code writes, kept in SQLite's `user_version`.
const SCHEMA_VERSION: i64 = 3;

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
CREATE TABLE IF NOT EXISTS algos (
    id         TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    over       INTEGER NOT NULL,
    view       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS algos_over ON algos (over, created_at);
CREATE TABLE IF NOT EXISTS bots (
    id         TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    over       INTEGER NOT NULL,
    bot        TEXT NOT NULL
);
";

/// Version 2 adds which algo an event belongs to (`events.algo`) and the
/// `algos` table, which `SCHEMA` creates.
const TO_V2: &str = "
ALTER TABLE events ADD COLUMN algo TEXT;
CREATE INDEX IF NOT EXISTS events_algo ON events (algo);
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
    /// The algo that sent the command, if one did.
    pub algo: Option<&'a str>,
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
    pub algo: Option<String>,
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
        // A new log is version 0, so it takes version 2's column here too.
        if version < 2 {
            conn.execute_batch(TO_V2)?;
        }
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
                (at, command, kind, origin, venue, account, operation, client_id, algo, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                event.at as i64,
                event.command.map(|c| c as i64),
                event.kind,
                event.origin,
                event.venue,
                event.account,
                event.operation,
                event.client_id,
                event.algo,
                event.detail.to_string(),
            ],
        )?;
        Ok(conn.last_insert_rowid() as u64)
    }

    /// The latest `limit` events, newest first.
    pub fn recent(&self, limit: usize) -> Result<Vec<Event>, StoreError> {
        self.query(
            "SELECT seq, at, command, kind, origin, venue, account, operation, client_id, algo, detail
             FROM events ORDER BY seq DESC LIMIT ?1",
            params![limit as i64],
        )
    }

    /// A command and everything logged for it, in order.
    pub fn for_command(&self, seq: u64) -> Result<Vec<Event>, StoreError> {
        self.query(
            "SELECT seq, at, command, kind, origin, venue, account, operation, client_id, algo, detail
             FROM events WHERE seq = ?1 OR command = ?1 ORDER BY seq",
            params![seq as i64],
        )
    }

    /// Every event of `kind` an algo or bot (`bot:<id>`) logged, in order.
    pub fn for_algo(&self, algo: &str, kind: &str) -> Result<Vec<Event>, StoreError> {
        self.query(
            "SELECT seq, at, command, kind, origin, venue, account, operation, client_id, algo, detail
             FROM events WHERE algo = ?1 AND kind = ?2 ORDER BY seq",
            params![algo, kind],
        )
    }

    /// The client order ids an algo was given, oldest first: every order
    /// it sent, or tried to.
    pub fn algo_client_ids(&self, algo: &str) -> Result<Vec<String>, StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut statement = conn.prepare(
            "SELECT e.client_id FROM events e JOIN events c ON e.command = c.seq
             WHERE c.algo = ?1 AND e.kind = 'sent' AND e.client_id IS NOT NULL
             ORDER BY e.seq",
        )?;
        let ids = statement.query_map(params![algo], |row| row.get::<_, String>(0))?;
        Ok(ids.collect::<Result<_, _>>()?)
    }

    /// Keeps an algo's current state (`view`, its JSON), replacing the last.
    pub fn save_algo(
        &self,
        id: &str,
        created_at: u64,
        updated_at: u64,
        over: bool,
        view: &serde_json::Value,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO algos (id, created_at, updated_at, over, view)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (id) DO UPDATE SET
                updated_at = excluded.updated_at, over = excluded.over, view = excluded.view",
            params![
                id,
                created_at as i64,
                updated_at as i64,
                over,
                view.to_string()
            ],
        )?;
        Ok(())
    }

    /// Keeps a bot's current state (`bot`, its JSON), replacing the last.
    pub fn save_bot(
        &self,
        id: &str,
        created_at: u64,
        updated_at: u64,
        over: bool,
        bot: &serde_json::Value,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO bots (id, created_at, updated_at, over, bot)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (id) DO UPDATE SET
                updated_at = excluded.updated_at, over = excluded.over, bot = excluded.bot",
            params![
                id,
                created_at as i64,
                updated_at as i64,
                over,
                bot.to_string()
            ],
        )?;
        Ok(())
    }

    /// Every bot kept, oldest first; with `over`, the deleted ones too.
    pub fn bots(&self, over: bool) -> Result<Vec<serde_json::Value>, StoreError> {
        let sql = if over {
            "SELECT bot FROM bots ORDER BY created_at"
        } else {
            "SELECT bot FROM bots WHERE over = 0 ORDER BY created_at"
        };
        self.algo_views(sql, [])
    }

    /// The algos not over yet (running or paused when they were last kept),
    /// oldest first.
    pub fn open_algos(&self) -> Result<Vec<serde_json::Value>, StoreError> {
        self.algo_views(
            "SELECT view FROM algos WHERE over = 0 ORDER BY created_at",
            [],
        )
    }

    /// The latest `limit` algos that are over, newest first.
    pub fn past_algos(&self, limit: usize) -> Result<Vec<serde_json::Value>, StoreError> {
        self.algo_views(
            "SELECT view FROM algos WHERE over = 1 ORDER BY updated_at DESC LIMIT ?1",
            params![limit as i64],
        )
    }

    fn algo_views(
        &self,
        sql: &str,
        args: impl rusqlite::Params,
    ) -> Result<Vec<serde_json::Value>, StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut statement = conn.prepare(sql)?;
        let rows = statement.query_map(args, |row| row.get::<_, String>(0))?;
        Ok(rows
            .filter_map(Result::ok)
            .filter_map(|json| serde_json::from_str(&json).ok())
            .collect())
    }

    fn query(&self, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Event>, StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut statement = conn.prepare(sql)?;
        let rows = statement.query_map(args, |row| {
            let detail: String = row.get(10)?;
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
                algo: row.get(9)?,
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

    #[test]
    fn keeps_an_algos_state_and_its_client_ids() {
        let log = EventLog::open_in_memory().unwrap();
        let command = log
            .append(&NewEvent {
                at: 1,
                kind: "command",
                algo: Some("a1"),
                ..NewEvent::default()
            })
            .unwrap();
        log.append(&NewEvent {
            at: 2,
            command: Some(command),
            kind: "sent",
            client_id: Some("0x1"),
            ..NewEvent::default()
        })
        .unwrap();
        // Another algo's order isn't this one's.
        let other = log
            .append(&NewEvent {
                at: 3,
                kind: "command",
                algo: Some("a2"),
                ..NewEvent::default()
            })
            .unwrap();
        log.append(&NewEvent {
            at: 4,
            command: Some(other),
            kind: "sent",
            client_id: Some("0x2"),
            ..NewEvent::default()
        })
        .unwrap();
        assert_eq!(log.algo_client_ids("a1").unwrap(), ["0x1"]);

        log.save_algo("a1", 1, 1, false, &json!({ "status": "running" }))
            .unwrap();
        log.save_algo("a2", 2, 2, false, &json!({ "status": "running" }))
            .unwrap();
        log.save_algo("a1", 1, 5, true, &json!({ "status": "finished" }))
            .unwrap();
        assert_eq!(log.open_algos().unwrap(), [json!({ "status": "running" })]);
        assert_eq!(
            log.past_algos(10).unwrap(),
            [json!({ "status": "finished" })]
        );
    }

    #[test]
    fn upgrades_a_version_1_log() {
        let path = scratch("upgrade");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
                command INTEGER, kind TEXT NOT NULL, origin TEXT, venue TEXT, account TEXT,
                operation TEXT, client_id TEXT, detail TEXT NOT NULL);
             INSERT INTO events (at, kind, detail) VALUES (1, 'command', 'null');
             PRAGMA user_version = 1;",
        )
        .unwrap();
        drop(conn);
        let log = EventLog::open(&path).unwrap();
        let kept = log.recent(10).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].algo, None);
        log.append(&NewEvent {
            at: 2,
            kind: "command",
            algo: Some("a1"),
            ..NewEvent::default()
        })
        .unwrap();
        assert_eq!(log.recent(1).unwrap()[0].algo.as_deref(), Some("a1"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }
}

/// One candle as the recorder keeps it: its prices as the venue wrote them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCandle {
    /// When it opened, in milliseconds since the Unix epoch.
    pub open_time: u64,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub volume: String,
}

/// Candles kept for backtests and for picking up paper bots after a
/// restart, in a file of their own (`candles.sqlite3`): venues serve only
/// so much history (Hyperliquid about 5,000 candles), so what's been seen
/// is kept. Market data only: nothing about an account.
pub struct Recorder {
    conn: Mutex<Connection>,
}

const CANDLES: &str = "
CREATE TABLE IF NOT EXISTS candles (
    venue     TEXT NOT NULL,
    market    TEXT NOT NULL,
    interval  TEXT NOT NULL,
    open_time INTEGER NOT NULL,
    open      TEXT NOT NULL,
    high      TEXT NOT NULL,
    low       TEXT NOT NULL,
    close     TEXT NOT NULL,
    volume    TEXT NOT NULL,
    PRIMARY KEY (venue, market, interval, open_time)
) WITHOUT ROWID;
";

impl Recorder {
    /// The candles at `path`, created (with its folder) if it isn't there.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| StoreError(e.to_string()))?;
        }
        let conn = Connection::open(path)?;
        // Losing the last candles in a power cut costs nothing: they're read again.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(CANDLES)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(CANDLES)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Keeps `candles`, replacing any kept at the same open time (the
    /// forming candle, kept again once it closes).
    pub fn save(
        &self,
        venue: &str,
        market: &str,
        interval: &str,
        candles: &[StoredCandle],
    ) -> Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let tx = conn.transaction()?;
        {
            let mut insert = tx.prepare(
                "INSERT OR REPLACE INTO candles
                 (venue, market, interval, open_time, open, high, low, close, volume)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for c in candles {
                insert.execute(params![
                    venue,
                    market,
                    interval,
                    c.open_time as i64,
                    c.open,
                    c.high,
                    c.low,
                    c.close,
                    c.volume
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The candles kept that opened from `from` up to `to` (ms), oldest first.
    pub fn range(
        &self,
        venue: &str,
        market: &str,
        interval: &str,
        from: u64,
        to: u64,
    ) -> Result<Vec<StoredCandle>, StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut statement = conn.prepare(
            "SELECT open_time, open, high, low, close, volume FROM candles
             WHERE venue = ?1 AND market = ?2 AND interval = ?3
               AND open_time >= ?4 AND open_time <= ?5
             ORDER BY open_time",
        )?;
        let rows = statement.query_map(
            params![
                venue,
                market,
                interval,
                from as i64,
                to.min(i64::MAX as u64) as i64
            ],
            |row| {
                Ok(StoredCandle {
                    open_time: row.get::<_, i64>(0)? as u64,
                    open: row.get(1)?,
                    high: row.get(2)?,
                    low: row.get(3)?,
                    close: row.get(4)?,
                    volume: row.get(5)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The oldest candle kept, if any.
    pub fn oldest(
        &self,
        venue: &str,
        market: &str,
        interval: &str,
    ) -> Result<Option<u64>, StoreError> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let oldest: Option<i64> = conn.query_row(
            "SELECT MIN(open_time) FROM candles WHERE venue = ?1 AND market = ?2 AND interval = ?3",
            params![venue, market, interval],
            |row| row.get(0),
        )?;
        Ok(oldest.map(|t| t as u64))
    }
}

#[cfg(test)]
mod recorder_tests {
    use super::*;

    fn candle(t: u64, close: &str) -> StoredCandle {
        StoredCandle {
            open_time: t,
            open: "1".into(),
            high: "2".into(),
            low: "0.5".into(),
            close: close.into(),
            volume: "10".into(),
        }
    }

    #[test]
    fn keeps_candles_and_replaces_a_formed_one() {
        let r = Recorder::open_in_memory().unwrap();
        r.save(
            "bybit",
            "BTCUSDT",
            "1h",
            &[candle(1, "1.0"), candle(2, "1.1")],
        )
        .unwrap();
        // The second candle again, closed now.
        r.save(
            "bybit",
            "BTCUSDT",
            "1h",
            &[candle(2, "1.2"), candle(3, "1.3")],
        )
        .unwrap();
        let kept = r.range("bybit", "BTCUSDT", "1h", 0, u64::MAX).unwrap();
        let closes: Vec<&str> = kept.iter().map(|c| c.close.as_str()).collect();
        assert_eq!(closes, ["1.0", "1.2", "1.3"]);
        assert_eq!(r.range("bybit", "BTCUSDT", "1h", 2, 2).unwrap().len(), 1);
        assert!(r
            .range("bybit", "ETHUSDT", "1h", 0, u64::MAX)
            .unwrap()
            .is_empty());
        assert_eq!(r.oldest("bybit", "BTCUSDT", "1h").unwrap(), Some(1));
        assert_eq!(r.oldest("bybit", "BTCUSDT", "4h").unwrap(), None);
    }

    #[test]
    fn keeps_bots_and_leaves_deleted_ones_out() {
        let log = EventLog::open_in_memory().unwrap();
        log.save_bot("a", 1, 1, false, &serde_json::json!({"id": "a"}))
            .unwrap();
        log.save_bot("b", 2, 2, false, &serde_json::json!({"id": "b"}))
            .unwrap();
        log.save_bot(
            "a",
            1,
            3,
            true,
            &serde_json::json!({"id": "a", "gone": true}),
        )
        .unwrap();
        assert_eq!(log.bots(false).unwrap(), [serde_json::json!({"id": "b"})]);
        assert_eq!(log.bots(true).unwrap().len(), 2);
    }
}
