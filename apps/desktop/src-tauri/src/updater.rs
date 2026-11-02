//! Updates: a newer release, found, downloaded and checked here, and
//! installed only when the trader asks (About › Restart to update).
//!
//! Security-relevant. What it reads is fixed: the latest release's
//! `latest.json` on this repository's GitHub releases (`tauri.conf.json`,
//! `plugins.updater.endpoints`), and the installer that names. The plugin
//! refuses an installer whose signature doesn't verify against the public
//! key in that same config, so only a build signed with the project's
//! private key (kept off this repo, in CI's secrets) can install. The page
//! gets no updater permission of its own: it can only ask Rust to check, or
//! to install what Rust already downloaded and verified. Nothing installs
//! without that ask.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// What the page listens for, with an `UpdateStatus`, whenever it changes.
pub const UPDATE_EVENT: &str = "update-status";

/// The first check, once the app has settled.
const FIRST_CHECK: Duration = Duration::from_secs(30);
/// Then, while the app runs.
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Release notes as the page shows them: plain text, bounded.
const NOTES_MAX: usize = 1_200;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum UpdateState {
    /// Not checked yet (or a development build, which never checks).
    #[default]
    Idle,
    Checking,
    UpToDate,
    /// Downloading `version`.
    Downloading {
        version: String,
        notes: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u64>,
        received: u64,
    },
    /// Downloaded and verified: one click from installing.
    Ready {
        version: String,
        notes: String,
        size: u64,
    },
    /// The check or the download failed; tried again at the next check.
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    #[serde(flatten)]
    state: UpdateState,
    /// The last finished check, in ms since the epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_checked: Option<u64>,
    /// Updates are only for release builds.
    enabled: bool,
}

#[derive(Default)]
pub struct Updates {
    status: Mutex<UpdateStatus>,
    /// The update and its verified bytes, once downloaded.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    /// A check or download under way.
    busy: Mutex<bool>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Release notes as text: no markup reaches the page, and only so much of it.
fn plain_notes(body: Option<&str>) -> String {
    let text: String = body
        .unwrap_or_default()
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    let text = text.trim();
    if text.chars().count() <= NOTES_MAX {
        return text.to_owned();
    }
    let cut: String = text.chars().take(NOTES_MAX).collect();
    format!("{}…", cut.trim_end())
}

fn set(app: &AppHandle, change: impl FnOnce(&mut UpdateStatus)) {
    let updates = app.state::<Updates>();
    let status = {
        let Ok(mut status) = updates.status.lock() else {
            return;
        };
        change(&mut status);
        status.clone()
    };
    let _ = app.emit(UPDATE_EVENT, status);
}

/// Checks for a newer release and, if there is one, downloads it.
async fn check(app: &AppHandle) {
    let updates = app.state::<Updates>();
    {
        let Ok(mut busy) = updates.busy.lock() else {
            return;
        };
        if *busy {
            return;
        }
        *busy = true;
    }
    run_check(app).await;
    if let Ok(mut busy) = app.state::<Updates>().busy.lock() {
        *busy = false;
    };
}

async fn run_check(app: &AppHandle) {
    // Already downloaded: nothing more to fetch until it's installed.
    let ready = app
        .state::<Updates>()
        .ready
        .lock()
        .ok()
        .is_some_and(|r| r.is_some());
    if ready {
        set(app, |s| s.last_checked = Some(now_ms()));
        return;
    }
    set(app, |s| s.state = UpdateState::Checking);
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => {
            set(app, |s| {
                s.state = UpdateState::UpToDate;
                s.last_checked = Some(now_ms());
            });
            return;
        }
        Err(e) => {
            set(app, |s| {
                s.state = UpdateState::Failed {
                    message: e.to_string(),
                };
                s.last_checked = Some(now_ms());
            });
            return;
        }
    };
    let version = update.version.clone();
    let notes = plain_notes(update.body.as_deref());
    set(app, |s| {
        s.last_checked = Some(now_ms());
        s.state = UpdateState::Downloading {
            version: version.clone(),
            notes: notes.clone(),
            total: None,
            received: 0,
        };
    });
    let mut received = 0u64;
    let mut last_told = 0u64;
    let progress_app = app.clone();
    let progress_version = version.clone();
    let progress_notes = notes.clone();
    // The plugin checks the signature as part of the download.
    let downloaded = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                // A word to the page every 256 KB, not every chunk.
                if received - last_told >= 256 * 1024 {
                    last_told = received;
                    set(&progress_app, |s| {
                        s.state = UpdateState::Downloading {
                            version: progress_version.clone(),
                            notes: progress_notes.clone(),
                            total,
                            received,
                        };
                    });
                }
            },
            || {},
        )
        .await;
    match downloaded {
        Ok(bytes) => {
            let size = bytes.len() as u64;
            if let Ok(mut ready) = app.state::<Updates>().ready.lock() {
                *ready = Some((update, bytes));
            }
            set(app, |s| {
                s.state = UpdateState::Ready {
                    version,
                    notes,
                    size,
                }
            });
        }
        Err(e) => set(app, |s| {
            s.state = UpdateState::Failed {
                message: e.to_string(),
            }
        }),
    }
}

/// Starts checking: soon after start, then every few hours. Release builds only.
pub fn install(app: &AppHandle) {
    let enabled = !cfg!(debug_assertions);
    app.manage(Updates::default());
    set(app, |s| s.enabled = enabled);
    if !enabled {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&app).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Where updates stand, for the About dialog.
#[tauri::command]
pub fn update_status(updates: tauri::State<'_, Updates>) -> UpdateStatus {
    updates.status.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Checks now, from the About dialog.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("updates are for release builds".into());
    }
    check(&app).await;
    Ok(())
}

/// Installs the downloaded update and restarts into it. The trader's click.
#[tauri::command]
pub fn install_update(app: AppHandle) -> Result<(), String> {
    let taken = app
        .state::<Updates>()
        .ready
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    let Some((update, bytes)) = taken else {
        return Err("no update is ready".into());
    };
    if let Err(e) = update.install(&bytes) {
        // Put it back, so another try needs no new download.
        if let Ok(mut ready) = app.state::<Updates>().ready.lock() {
            *ready = Some((update, bytes));
        }
        return Err(e.to_string());
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_are_plain_and_bounded() {
        assert_eq!(plain_notes(None), "");
        assert_eq!(plain_notes(Some("  New:\n- a\u{7}\n")), "New:\n- a");
        let long = "x".repeat(NOTES_MAX + 50);
        let cut = plain_notes(Some(&long));
        assert_eq!(cut.chars().count(), NOTES_MAX + 1);
        assert!(cut.ends_with('…'));
    }
}
