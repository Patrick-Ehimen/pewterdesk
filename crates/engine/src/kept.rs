//! A gate file (`live-trading.json`, `trading-rules.json`) as more than one
//! engine shares it: the app's and the daemon's. Each keeps a copy in
//! memory and reads the file again whenever it has changed on disk, so
//! turning live trading off in one reaches the other before its next
//! order. Files are written whole (to a temporary file, then renamed over),
//! so the other engine never reads half of one.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// What a file looked like when it was last read: enough to tell it's
/// changed since.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    modified: Option<SystemTime>,
    len: u64,
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = fs::metadata(path).ok()?;
    Some(Stamp {
        modified: meta.modified().ok(),
        len: meta.len(),
    })
}

/// What changed on disk since the last look.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Change {
    /// The same as when it was last read (or there's no file to keep).
    Same,
    /// It's been written: its bytes now.
    Written(Vec<u8>),
    /// It was there and now isn't.
    Gone,
}

/// One kept file.
pub(crate) struct Kept {
    path: Option<PathBuf>,
    /// `None` while there's no file.
    seen: Mutex<Option<Stamp>>,
}

impl Kept {
    /// `path`, as it is now (read once by the caller with `read`).
    pub(crate) fn new(path: Option<PathBuf>) -> Self {
        let seen = path.as_deref().and_then(stamp_of);
        Self {
            path,
            seen: Mutex::new(seen),
        }
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The file's bytes, if it can be read.
    pub(crate) fn read(&self) -> Option<Vec<u8>> {
        fs::read(self.path.as_ref()?).ok()
    }

    /// Whether the file has changed since it was last read or written here.
    /// A change is taken only once the caller has used it (`taken`): bytes
    /// it couldn't make sense of are read again next time.
    pub(crate) fn changed(&self) -> Change {
        let Some(path) = &self.path else {
            return Change::Same;
        };
        let now = stamp_of(path);
        let seen = *self.seen.lock().unwrap();
        if now == seen {
            return Change::Same;
        }
        match now {
            None => Change::Gone,
            Some(_) => match fs::read(path) {
                Ok(bytes) => Change::Written(bytes),
                // Unreadable for the moment: try again on the next look.
                Err(_) => Change::Same,
            },
        }
    }

    /// The file as it is now has been read in.
    pub(crate) fn taken(&self) {
        if let Some(path) = &self.path {
            *self.seen.lock().unwrap() = stamp_of(path);
        }
    }

    /// Writes `bytes` whole: to a temporary file beside it, then renamed
    /// over it, so a reader sees the old file or the new, never half.
    pub(crate) fn write(&self, bytes: &[u8]) -> bool {
        let Some(path) = &self.path else {
            return false;
        };
        let written = write_whole(path, bytes).is_ok();
        if written {
            self.taken();
        }
        written
    }
}

fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pd-kept-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join("file.json")
    }

    #[test]
    fn sees_another_writer() {
        let path = temp("other");
        let mine = Kept::new(Some(path.clone()));
        assert_eq!(mine.changed(), Change::Same);
        // Another engine writes it.
        let theirs = Kept::new(Some(path.clone()));
        assert!(theirs.write(b"[1]"));
        assert_eq!(mine.changed(), Change::Written(b"[1]".to_vec()));
        // Until it's taken, it's still a change.
        assert_eq!(mine.changed(), Change::Written(b"[1]".to_vec()));
        mine.taken();
        assert_eq!(mine.changed(), Change::Same);
        // Its own writes aren't news to it.
        assert!(mine.write(b"[1,2]"));
        assert_eq!(mine.changed(), Change::Same);
        fs::remove_file(&path).unwrap();
        assert_eq!(mine.changed(), Change::Gone);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn writes_whole_and_leaves_no_temporary_file() {
        let path = temp("whole");
        let kept = Kept::new(Some(path.clone()));
        assert!(kept.write(b"{\"a\":1}"));
        assert_eq!(fs::read(&path).unwrap(), b"{\"a\":1}");
        let files: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert_eq!(files.len(), 1, "only the file itself");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn nowhere_to_keep_is_never_a_change() {
        let kept = Kept::new(None);
        assert_eq!(kept.changed(), Change::Same);
        assert!(!kept.write(b"x"));
    }
}
