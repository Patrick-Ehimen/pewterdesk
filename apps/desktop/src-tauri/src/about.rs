//! The About box: facts about this build, and its few fixed links.

use std::process::Command;

use serde::{Deserialize, Serialize};

const REPOSITORY: &str = "https://github.com/Patrick-Ehimen/pewterdesk";

/// What the page listens for to open its About dialog.
pub const OPEN_ABOUT_EVENT: &str = "open-about";
/// The menu item that sends it.
pub const ABOUT_MENU_ID: &str = "about";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    /// "macos", "windows", "linux", ...
    os: &'static str,
    /// "aarch64", "x86_64", ...
    arch: &'static str,
    /// A development build rather than a release.
    debug: bool,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        debug: cfg!(debug_assertions),
    }
}

/// The About box's links. The webview names one; the URL is fixed here, so
/// it can never get the system to open an address of its choosing.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AboutLink {
    Repository,
    Issues,
    License,
}

impl AboutLink {
    fn url(self) -> String {
        match self {
            Self::Repository => REPOSITORY.to_owned(),
            Self::Issues => format!("{REPOSITORY}/issues/new"),
            Self::License => format!("{REPOSITORY}/blob/main/LICENSE"),
        }
    }
}

/// Opens `link` in the system browser, for the About dialog.
#[tauri::command]
pub fn open_about_link(link: AboutLink) -> Result<(), String> {
    open(link)
}

/// Opens `link` in the system browser. The app doesn't wait for it.
pub fn open(link: AboutLink) -> Result<(), String> {
    open_url(&link.url())
}

/// Opens a URL that Rust built (never one from a command argument) in the
/// system browser: the About links, and the local wallet page.
pub(crate) fn open_url(url: &str) -> Result<(), String> {
    let spawned = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        // `start` takes a window title first; the URL has no shell metacharacters.
        Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    spawned
        .map(|_| ())
        .map_err(|_| "couldn't open the browser".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_the_repositorys_own() {
        for link in [AboutLink::Repository, AboutLink::Issues, AboutLink::License] {
            let url = link.url();
            assert!(url.starts_with(REPOSITORY), "{url}");
            // Nothing the Windows shell would read specially.
            assert!(!url.contains(['&', '|', '^', '<', '>', '"', ' ']), "{url}");
        }
    }

    #[test]
    fn only_named_links_are_accepted() {
        let parse = |s: &str| serde_json::from_str::<AboutLink>(s);
        assert_eq!(parse("\"issues\"").unwrap(), AboutLink::Issues);
        assert!(parse("\"https://example.com\"").is_err());
        assert!(parse("\"Issues\"").is_err());
    }

    #[test]
    fn reports_this_build() {
        let info = app_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(!info.os.is_empty() && !info.arch.is_empty());
    }
}
