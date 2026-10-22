//! The note the page shows before this build first reads the keychain:
//! macOS asks for the login password when a build it hasn't seen reads a
//! keychain item (a first install, an update, and in development every
//! rebuild), and a password prompt out of nowhere looks like phishing.
//!
//! A build is named by its Mach-O UUID, which the linker derives from the
//! binary's contents: it changes with every build and update, and not
//! when the same build is signed again (`scripts/dev-run.sh` does that on
//! each run). The last build the note was shown for is kept in
//! `keychain-notice.json` in the config folder; nothing secret. Until the
//! note is dismissed, what reads the keychain at start (the algos'
//! reconciler, the daemon link, the menu-bar panel and the floating
//! window) waits for `cleared`, up to `MAX_WAIT`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::watch;

const FILE: &str = "keychain-notice.json";
/// Startup work waits this long at most: a page that never loads mustn't
/// keep the algos' reconciler from cancelling what they left behind.
const MAX_WAIT: Duration = Duration::from_secs(120);

#[derive(Serialize, Deserialize)]
struct Seen {
    build: String,
}

pub struct KeychainNotice {
    file: Option<PathBuf>,
    /// This build's name, on macOS only; elsewhere there's no such prompt.
    build: Option<String>,
    cleared: watch::Sender<bool>,
}

impl KeychainNotice {
    pub fn new(config: Option<PathBuf>) -> Self {
        let file = config.map(|dir| dir.join(FILE));
        let build = cfg!(target_os = "macos").then(build_id);
        let seen = file
            .as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|bytes| serde_json::from_slice::<Seen>(&bytes).ok());
        let pending = build
            .as_ref()
            .is_some_and(|b| seen.is_none_or(|s| &s.build != b));
        Self {
            file,
            build,
            cleared: watch::channel(!pending).0,
        }
    }

    /// Whether the page should show the note before anything reads the keychain.
    pub fn pending(&self) -> bool {
        !*self.cleared.borrow()
    }

    /// Returns once the note has been dismissed (or there's none), or after `MAX_WAIT`.
    pub async fn cleared(&self) {
        let mut rx = self.cleared.subscribe();
        let _ = tokio::time::timeout(MAX_WAIT, rx.wait_for(|c| *c)).await;
    }

    fn dismiss(&self) {
        if let (Some(file), Some(build)) = (&self.file, &self.build) {
            let seen = Seen {
                build: build.clone(),
            };
            // Unwritten, the note shows again next launch, which is harmless.
            if let Ok(json) = serde_json::to_vec(&seen) {
                if let Some(dir) = file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(file, json);
            }
        }
        self.cleared.send_replace(true);
    }
}

/// The version and, where it can be read, the binary's Mach-O UUID.
fn build_id() -> String {
    let version = env!("CARGO_PKG_VERSION");
    match exe_uuid() {
        Some(uuid) => {
            let hex: String = uuid.iter().map(|b| format!("{b:02x}")).collect();
            format!("{version}+{hex}")
        }
        None => version.to_owned(),
    }
}

const MH_MAGIC_64: u32 = 0xfeed_facf;
const FAT_MAGIC: u32 = 0xcafe_babe;
const LC_UUID: u32 = 0x1b;
const CPU_TYPE_ARM64: u32 = 0x0100_000c;
const CPU_TYPE_X86_64: u32 = 0x0100_0007;
/// The load commands sit at the start of the image; this covers them.
const HEAD: u64 = 64 * 1024;

fn exe_uuid() -> Option<[u8; 16]> {
    let mut file = File::open(std::env::current_exe().ok()?).ok()?;
    let mut read_at = |offset: u64| -> Option<Vec<u8>> {
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut buf = Vec::new();
        (&mut file).take(HEAD).read_to_end(&mut buf).ok()?;
        Some(buf)
    };
    let head = read_at(0)?;
    match fat_slice(&head, current_cpu()?) {
        Some(offset) => macho_uuid(&read_at(offset)?),
        None => macho_uuid(&head),
    }
}

fn current_cpu() -> Option<u32> {
    match std::env::consts::ARCH {
        "aarch64" => Some(CPU_TYPE_ARM64),
        "x86_64" => Some(CPU_TYPE_X86_64),
        _ => None,
    }
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// In a universal binary, where this machine's slice starts.
fn fat_slice(head: &[u8], cpu: u32) -> Option<u64> {
    if be32(head, 0)? != FAT_MAGIC {
        return None;
    }
    let count = be32(head, 4)? as usize;
    (0..count.min(16)).find_map(|i| {
        let entry = 8 + i * 20;
        (be32(head, entry)? == cpu).then(|| be32(head, entry + 8).map(u64::from))?
    })
}

/// The `LC_UUID` of a 64-bit little-endian Mach-O image starting at `image[0]`.
fn macho_uuid(image: &[u8]) -> Option<[u8; 16]> {
    if le32(image, 0)? != MH_MAGIC_64 {
        return None;
    }
    let count = le32(image, 16)?;
    let mut at = 32usize;
    for _ in 0..count {
        let cmd = le32(image, at)?;
        let size = le32(image, at + 4)? as usize;
        if cmd == LC_UUID {
            return image.get(at + 8..at + 24)?.try_into().ok();
        }
        if size < 8 {
            return None;
        }
        at = at.checked_add(size)?;
    }
    None
}

/// Whether to show the note now, before the page reads the keychain.
#[tauri::command]
pub fn keychain_notice(notice: State<'_, KeychainNotice>) -> bool {
    notice.pending()
}

/// The note was read: remember this build and let startup go on.
#[tauri::command]
pub fn dismiss_keychain_notice(notice: State<'_, KeychainNotice>) {
    notice.dismiss();
}

/// Answers once the note is out of the way, for the windows that load beside the main one.
#[tauri::command]
pub async fn keychain_notice_cleared(notice: State<'_, KeychainNotice>) -> Result<(), ()> {
    notice.cleared().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal Mach-O header: one unrelated command, then `LC_UUID`.
    fn image(uuid: [u8; 16]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(MH_MAGIC_64.to_le_bytes());
        out.extend(CPU_TYPE_ARM64.to_le_bytes());
        out.extend([0; 8]);
        out.extend(2u32.to_le_bytes()); // ncmds
        out.extend([0; 12]);
        out.extend(0x19u32.to_le_bytes()); // LC_SEGMENT_64
        out.extend(16u32.to_le_bytes());
        out.extend([0; 8]);
        out.extend(LC_UUID.to_le_bytes());
        out.extend(24u32.to_le_bytes());
        out.extend(uuid);
        out
    }

    #[test]
    fn reads_the_uuid_of_a_thin_image() {
        assert_eq!(macho_uuid(&image([7; 16])), Some([7; 16]));
    }

    #[test]
    fn finds_this_machines_slice_of_a_universal_binary() {
        let mut head = Vec::new();
        head.extend(FAT_MAGIC.to_be_bytes());
        head.extend(2u32.to_be_bytes());
        for (cpu, offset) in [(CPU_TYPE_X86_64, 0x4000u32), (CPU_TYPE_ARM64, 0x8000)] {
            head.extend(cpu.to_be_bytes());
            head.extend([0; 4]);
            head.extend(offset.to_be_bytes());
            head.extend([0; 8]);
        }
        assert_eq!(fat_slice(&head, CPU_TYPE_ARM64), Some(0x8000));
        assert_eq!(fat_slice(&head, CPU_TYPE_X86_64), Some(0x4000));
        assert_eq!(fat_slice(&image([1; 16]), CPU_TYPE_ARM64), None);
    }

    #[test]
    fn refuses_what_isnt_a_mach_o_image() {
        assert_eq!(macho_uuid(b"not an image"), None);
        let mut looping = image([1; 16]);
        looping[36..40].copy_from_slice(&0u32.to_le_bytes()); // a zero-sized command
        assert_eq!(macho_uuid(&looping), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn names_this_build_by_its_uuid() {
        assert!(exe_uuid().is_some());
        assert!(build_id().contains('+'));
    }
}
