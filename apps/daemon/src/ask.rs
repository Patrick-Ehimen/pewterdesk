//! Asking the person at this machine to approve a pairing: in the terminal
//! `pdd` runs in, or, when it runs in the background, a system dialog
//! (macOS). Elsewhere, with no terminal, nothing can be approved, and
//! `pdd` says to run it in one.

use std::sync::{Arc, Mutex};

use pewterdesk_protocol::rpc::ClientKind;

use crate::pairing::{Ask, PairPrompt};

/// One prompt at a time, in a terminal.
static TERMINAL: Mutex<()> = Mutex::new(());

fn kind_name(kind: ClientKind) -> &'static str {
    match kind {
        ClientKind::Pd => "the pd command line",
        ClientKind::App => "the pewterdesk app",
    }
}

fn message(prompt: &PairPrompt) -> String {
    format!(
        "{} ({}) wants to connect to the pewterdesk daemon.\n\nCode: {}\n\n\
         Allow it only if you started it just now and it shows the same code. \
         A paired client can place and cancel orders on your accounts that \
         have trading on.",
        prompt.name,
        kind_name(prompt.kind),
        prompt.code
    )
}

#[cfg(unix)]
fn on_a_terminal() -> bool {
    // SAFETY: isatty only reads the descriptors' state.
    unsafe { libc::isatty(0) == 1 && libc::isatty(2) == 1 }
}

#[cfg(not(unix))]
fn on_a_terminal() -> bool {
    false
}

fn ask_terminal(prompt: PairPrompt) -> bool {
    let _one = TERMINAL.lock().unwrap_or_else(|p| p.into_inner());
    eprintln!("\n{}\n", message(&prompt));
    eprint!("Allow? [y/N] ");
    let mut answer = String::new();
    if std::io::stdin().read_line(&mut answer).is_err() {
        return false;
    }
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

/// A system dialog, its text passed as an argument (never spliced into the
/// script), "Deny" the default; gone unanswered after almost three minutes.
#[cfg(target_os = "macos")]
async fn ask_dialog(prompt: PairPrompt) -> bool {
    let script = [
        "on run argv",
        "display dialog (item 1 of argv) with title \"pewterdesk\" buttons {\"Deny\", \"Allow\"} \
         default button \"Deny\" cancel button \"Deny\" with icon caution giving up after 170",
        "return button returned of result",
        "end run",
    ];
    let mut command = tokio::process::Command::new("/usr/bin/osascript");
    for line in script {
        command.arg("-e").arg(line);
    }
    command.arg("--").arg(message(&prompt));
    match command.output().await {
        Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "Allow",
        Err(_) => false,
    }
}

/// How this `pdd` asks.
pub fn asker() -> Ask {
    if on_a_terminal() {
        return Arc::new(|prompt| tokio::task::spawn_blocking(move || ask_terminal(prompt)));
    }
    #[cfg(target_os = "macos")]
    {
        Arc::new(|prompt| tokio::spawn(ask_dialog(prompt)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(|prompt| {
            eprintln!(
                "pdd: {} asked to pair, but there's no terminal to ask in: run `pdd run` in one to pair it",
                prompt.name
            );
            tokio::spawn(async { false })
        })
    }
}
