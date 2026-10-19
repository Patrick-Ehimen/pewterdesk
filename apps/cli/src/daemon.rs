//! `pd daemon ...`: keeping `pdd` running in the background ("always on"),
//! through `pewterdesk_link::launchd`.

use std::path::PathBuf;

use pewterdesk_link::launchd::{self, State};
use pewterdesk_protocol::local::Paths;

/// The `pdd` beside this `pd` (as `cargo build` and a release lay them out).
fn sibling() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pdd = exe.with_file_name(if cfg!(windows) { "pdd.exe" } else { "pdd" });
    if pdd.is_file() {
        Ok(pdd)
    } else {
        Err(format!(
            "no pdd beside pd ({}): build it with `make daemon`",
            pdd.display()
        ))
    }
}

async fn answering(paths: &Paths) -> bool {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(paths.socket())
            .await
            .is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = paths;
        false
    }
}

pub async fn run(paths: &Paths, args: &[&str]) -> Result<(), String> {
    match args {
        ["status"] | [] => {
            println!(
                "LaunchAgent: {}",
                match launchd::state() {
                    State::Running => "loaded",
                    State::Stopped => "installed, not running",
                    State::NotInstalled => "not installed",
                }
            );
            println!(
                "pdd: {}",
                if answering(paths).await {
                    "answering"
                } else {
                    "not answering"
                }
            );
            Ok(())
        }
        ["logs"] => {
            let log = launchd::log_file(paths);
            let text = std::fs::read_to_string(&log)
                .map_err(|_| format!("no log yet ({})", log.display()))?;
            let lines: Vec<&str> = text.lines().collect();
            for line in &lines[lines.len().saturating_sub(50)..] {
                println!("{line}");
            }
            Ok(())
        }
        ["install"] => {
            let to = launchd::install(paths, &sibling()?)?;
            println!(
                "installed and started: {} (log: {})",
                to.display(),
                launchd::log_file(paths).display()
            );
            println!("Pair this pd with it once: pd pair");
            Ok(())
        }
        ["uninstall"] => {
            launchd::uninstall(paths)?;
            println!(
                "stopped and removed; algos it ran are dealt with the next time an engine starts"
            );
            Ok(())
        }
        ["start"] => launchd::start().map(|()| println!("started")),
        ["stop"] => launchd::stop().map(|()| println!("stopped")),
        _ => Err("pd daemon install|uninstall|start|stop|status|logs".into()),
    }
}
