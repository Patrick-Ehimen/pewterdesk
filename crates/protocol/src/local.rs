//! Where the daemon and the app keep things on this machine: the same
//! config and data folders as the desktop app (its Tauri identifier), so
//! the daemon reads the same gate files and writes the same event log, and
//! `pd` finds the daemon's socket. Computed from the environment only.

use std::path::PathBuf;

/// The desktop app's identifier (`tauri.conf.json`), which names its folders.
pub const IDENTIFIER: &str = "app.pewterdesk.desktop";

/// The longest socket path every platform takes, with room to spare.
const MAX_SOCKET_PATH: usize = 100;

/// Overrides both folders, for development and tests: the daemon and `pd`
/// then keep everything in this one folder.
pub const HOME_ENV: &str = "PEWTERDESK_HOME";

/// The app's folders, as the daemon and `pd` use them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    /// The gate's files (`live-trading.json`, `trading-rules.json`) and the
    /// daemon's paired clients.
    pub config: PathBuf,
    /// The event log, the accounts' locks, the daemon's socket and port.
    pub data: PathBuf,
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

impl Paths {
    /// This machine's folders, as Tauri names them on each platform; `None`
    /// when there's no home folder to put them in.
    pub fn find() -> Option<Self> {
        if let Some(home) = env_dir(HOME_ENV) {
            return Some(Self {
                config: home.clone(),
                data: home,
            });
        }
        Self::platform()
    }

    #[cfg(target_os = "macos")]
    fn platform() -> Option<Self> {
        let dir = env_dir("HOME")?
            .join("Library")
            .join("Application Support")
            .join(IDENTIFIER);
        Some(Self {
            config: dir.clone(),
            data: dir,
        })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn platform() -> Option<Self> {
        let home = env_dir("HOME");
        let config = env_dir("XDG_CONFIG_HOME").or_else(|| Some(home.clone()?.join(".config")))?;
        let data = env_dir("XDG_DATA_HOME").or_else(|| Some(home?.join(".local").join("share")))?;
        Some(Self {
            config: config.join(IDENTIFIER),
            data: data.join(IDENTIFIER),
        })
    }

    #[cfg(windows)]
    fn platform() -> Option<Self> {
        let dir = env_dir("APPDATA")?.join(IDENTIFIER);
        Some(Self {
            config: dir.clone(),
            data: dir,
        })
    }

    /// The daemon's Unix socket, for `pd` (mode 0600): in the data folder,
    /// or - where that path is too long for a socket (about 104 bytes) -
    /// in this user's own runtime or temporary folder.
    pub fn socket(&self) -> PathBuf {
        let usual = self.data.join("pdd.sock");
        if usual.as_os_str().len() < MAX_SOCKET_PATH {
            return usual;
        }
        // Per-user and private: Linux's runtime folder, macOS's $TMPDIR.
        env_dir("XDG_RUNTIME_DIR")
            .unwrap_or_else(std::env::temp_dir)
            .join("pewterdesk-pdd.sock")
    }

    /// The port of the daemon's WebSocket on 127.0.0.1, for the app.
    pub fn port_file(&self) -> PathBuf {
        self.data.join("pdd.port")
    }

    /// The daemon's paired clients: names and token hashes, never a token.
    pub fn clients(&self) -> PathBuf {
        self.config.join("pdd-clients.json")
    }

    /// The engine's event log, shared with the app.
    pub fn event_log(&self) -> PathBuf {
        self.data.join("events.sqlite3")
    }

    /// The accounts' locks: one engine per account.
    pub fn locks(&self) -> PathBuf {
        self.data.join("locks")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_socket_path_too_long_moves_somewhere_shorter() {
        let short = Paths {
            config: "/u/c".into(),
            data: "/u/d".into(),
        };
        assert_eq!(short.socket(), PathBuf::from("/u/d/pdd.sock"));
        let deep = PathBuf::from(format!("/{}", "x".repeat(120)));
        let long = Paths {
            config: deep.clone(),
            data: deep,
        };
        assert!(long.socket().as_os_str().len() < 110, "{:?}", long.socket());
        assert!(long.socket().ends_with("pewterdesk-pdd.sock"));
    }
}
