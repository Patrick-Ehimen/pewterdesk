//! Keeping `pdd` running in the background ("always on"). On macOS a
//! LaunchAgent: started at login, restarted by launchd whenever it exits
//! (a crash, `kill -9`), its output in the app's data folder. `install`
//! copies `pdd` into the app's data folder first: macOS keeps background
//! agents out of Documents and the like, and a fixed place keeps its
//! keychain "Always Allow". Elsewhere it's `pdd run` in a terminal, for now.

use std::path::{Path, PathBuf};

use pewterdesk_protocol::local::Paths;

/// The LaunchAgent's label, and its plist's name.
pub const LABEL: &str = "app.pewterdesk.pdd";

pub fn log_file(paths: &Paths) -> PathBuf {
    paths.data.join("pdd.log")
}

/// Where the installed `pdd` lives.
pub fn installed(paths: &Paths) -> PathBuf {
    paths.data.join("bin").join("pdd")
}

/// Text made safe inside a plist's `<string>`.
fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The LaunchAgent: run `pdd run` at login, and again whenever it exits.
pub fn plist(pdd: &Path, log: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>{}</string>
  <key>StandardErrorPath</key>
  <string>{}</string>
</dict>
</plist>
"#,
        xml(&pdd.to_string_lossy()),
        xml(&log.to_string_lossy()),
        xml(&log.to_string_lossy())
    )
}

/// Where the agent's plist goes.
pub fn agent_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{LABEL}.plist")),
    )
}

/// Where things stand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// No agent (or not on macOS).
    NotInstalled,
    /// Installed, not loaded.
    Stopped,
    /// Loaded: launchd keeps it running.
    Running,
}

#[cfg(target_os = "macos")]
fn domain() -> String {
    // SAFETY: getuid only reads this process's user id.
    format!("gui/{}", unsafe { libc::getuid() })
}

#[cfg(target_os = "macos")]
fn launchctl(args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("/bin/launchctl")
        .args(args)
        .output()
        .map_err(|e| format!("launchctl: {e}"))
}

#[cfg(target_os = "macos")]
pub fn state() -> State {
    let loaded =
        launchctl(&["print", &format!("{}/{LABEL}", domain())]).is_ok_and(|o| o.status.success());
    if loaded {
        State::Running
    } else if agent_path().is_some_and(|p| p.is_file()) {
        State::Stopped
    } else {
        State::NotInstalled
    }
}

#[cfg(not(target_os = "macos"))]
pub fn state() -> State {
    State::NotInstalled
}

#[cfg(target_os = "macos")]
pub fn start() -> Result<(), String> {
    match state() {
        State::Running => Ok(()),
        State::NotInstalled => Err("not installed".into()),
        State::Stopped => {
            let agent = agent_path().ok_or("no home folder")?;
            let out = launchctl(&["bootstrap", &domain(), &agent.to_string_lossy()])?;
            if out.status.success() {
                Ok(())
            } else {
                Err(format!(
                    "launchctl couldn't start it: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ))
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn stop() -> Result<(), String> {
    if state() != State::Running {
        return Ok(());
    }
    let out = launchctl(&["bootout", &format!("{}/{LABEL}", domain())])?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "launchctl couldn't stop it: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Copies `pdd` from `from` into the app's data folder, writes the agent
/// and starts it.
#[cfg(target_os = "macos")]
pub fn install(paths: &Paths, from: &Path) -> Result<PathBuf, String> {
    let to = installed(paths);
    std::fs::create_dir_all(to.parent().ok_or("no folder")?).map_err(|e| e.to_string())?;
    stop()?;
    std::fs::copy(from, &to).map_err(|e| format!("couldn't copy pdd: {e}"))?;
    let agent = agent_path().ok_or("no home folder")?;
    std::fs::create_dir_all(agent.parent().ok_or("no folder")?).map_err(|e| e.to_string())?;
    std::fs::write(&agent, plist(&to, &log_file(paths))).map_err(|e| e.to_string())?;
    start()?;
    Ok(to)
}

/// Stops the agent and removes it and the installed `pdd`.
#[cfg(target_os = "macos")]
pub fn uninstall(paths: &Paths) -> Result<(), String> {
    stop()?;
    if let Some(agent) = agent_path() {
        let _ = std::fs::remove_file(agent);
    }
    let _ = std::fs::remove_file(installed(paths));
    Ok(())
}

#[cfg(not(target_os = "macos"))]
const ELSEWHERE: &str =
    "running pdd in the background is macOS-only for now: run `pdd run` in a terminal";

#[cfg(not(target_os = "macos"))]
pub fn start() -> Result<(), String> {
    Err(ELSEWHERE.into())
}

#[cfg(not(target_os = "macos"))]
pub fn stop() -> Result<(), String> {
    Err(ELSEWHERE.into())
}

#[cfg(not(target_os = "macos"))]
pub fn install(_paths: &Paths, _from: &Path) -> Result<PathBuf, String> {
    Err(ELSEWHERE.into())
}

#[cfg(not(target_os = "macos"))]
pub fn uninstall(_paths: &Paths) -> Result<(), String> {
    Err(ELSEWHERE.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_runs_pdd_and_keeps_it_alive() {
        let text = plist(Path::new("/x/pdd & co/pdd"), Path::new("/x/pdd.log"));
        assert!(text.contains("<string>app.pewterdesk.pdd</string>"));
        assert!(text.contains("<string>/x/pdd &amp; co/pdd</string>"));
        assert!(text.contains("<string>run</string>"));
        assert!(text.contains("<key>KeepAlive</key>\n  <true/>"));
    }
}
