//! Read-only filesystem access for the Files tab + file viewer. Never writes.

use std::fs;
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// List a directory's entries (dirs first, then files; alphabetical). Hidden
/// dotfiles are included (like the screenshot) but `.git` is skipped as noise.
pub fn list_dir(dir: &str) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                continue;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push(DirEntry {
                name,
                path: e.path().to_string_lossy().into_owned(),
                is_dir,
            });
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

// ---- read contract --------------------------------------------------------

/// Fully editable up to 8 MB.
const EDIT_CAP: usize = 8 * 1024 * 1024;
/// Loaded (read-only) up to 24 MB; beyond this the first 24 MB is shown, truncated.
const HARD_CAP: usize = 24 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
    /// Buffer must never be written back (binary / oversized / truncated / non-UTF-8).
    pub read_only: bool,
    /// True on-disk size in bytes (metadata, not the possibly-truncated read length).
    pub size: u64,
    /// Modification time in fractional epoch-milliseconds (sub-ms nanos precision).
    pub mtime_ms: f64,
    /// Some(msg) on read failure — content stays empty so no message leaks into a buffer.
    pub error: Option<String>,
}

/// Modification time as fractional epoch-ms. Computed identically here, in `write_file`,
/// and (Phase 2) `stat_file`, so JS `{mtimeMs,size}` baselines compare equal.
fn mtime_ms_of(meta: &fs::Metadata) -> f64 {
    match meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    {
        Some(d) => d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1_000_000.0,
        None => 0.0,
    }
}

struct Classified {
    content: String,
    truncated: bool,
    binary: bool,
    read_only: bool,
}

/// Pure classification of already-read bytes into the editor text payload — split out so
/// tiering / UTF-8 / binary rules are unit-testable without the filesystem. `size` is the
/// TRUE on-disk length (drives the 8/24 MB tiers); `data` is what was read (capped at
/// HARD_CAP by the caller).
fn classify(data: &[u8], size: u64) -> Classified {
    // Crude binary sniff: a NUL byte in the first 8 KB.
    let sniff = &data[..data.len().min(8192)];
    if sniff.contains(&0) {
        return Classified {
            content: "(binary file — not shown)".into(),
            truncated: false,
            binary: true,
            read_only: true,
        };
    }
    // Oversized: keep the first 24 MB, read-only + truncated (lossy: a cut can split a codepoint).
    if size as usize > HARD_CAP {
        let slice = &data[..data.len().min(HARD_CAP)];
        return Classified {
            content: String::from_utf8_lossy(slice).into_owned(),
            truncated: true,
            binary: false,
            read_only: true,
        };
    }
    // Strict UTF-8: invalid bytes get a lossy PREVIEW and are never editable, so a
    // Latin-1/CP-1252 file can't be re-saved with U+FFFD substitutions destroying the original.
    match std::str::from_utf8(data) {
        Ok(s) => Classified {
            content: s.to_owned(),
            truncated: false,
            binary: false,
            read_only: size as usize > EDIT_CAP, // 8..=24 MB: loaded but read-only
        },
        Err(_) => Classified {
            content: String::from_utf8_lossy(data).into_owned(),
            truncated: false,
            binary: false,
            read_only: true,
        },
    }
}

/// Read a file for the editor. Infallible at the IPC layer: on failure `error` is set and
/// `content` stays empty.
pub fn read_file(path: &str) -> FileContent {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return err_content(format!("could not read file: {e}")),
    };
    let size = meta.len();
    let mtime_ms = mtime_ms_of(&meta);

    // Read at most HARD_CAP bytes so a giant file never exhausts memory.
    let mut data = Vec::new();
    match fs::File::open(path) {
        Ok(f) => {
            if let Err(e) = f.take(HARD_CAP as u64).read_to_end(&mut data) {
                return err_content(format!("could not read file: {e}"));
            }
        }
        Err(e) => return err_content(format!("could not read file: {e}")),
    }

    let c = classify(&data, size);
    FileContent {
        content: c.content,
        truncated: c.truncated,
        binary: c.binary,
        read_only: c.read_only,
        size,
        mtime_ms,
        error: None,
    }
}

fn err_content(msg: String) -> FileContent {
    FileContent {
        content: String::new(),
        truncated: false,
        binary: false,
        read_only: true,
        size: 0,
        mtime_ms: 0.0,
        error: Some(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh unique dir under the OS temp dir (no external crate).
    fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "conduit-fsops-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn classify_small_utf8_is_editable() {
        let c = classify(b"hello world\n", 12);
        assert_eq!(c.content, "hello world\n");
        assert!(!c.binary);
        assert!(!c.read_only);
        assert!(!c.truncated);
    }

    #[test]
    fn classify_nul_is_binary_readonly() {
        let c = classify(b"ab\0cd", 5);
        assert!(c.binary);
        assert!(c.read_only);
        assert!(!c.truncated);
    }

    #[test]
    fn classify_invalid_utf8_is_readonly_preview() {
        // 0xFF/0xFE are invalid UTF-8 with no NUL — the non-UTF-8 (read-only preview) path.
        let c = classify(&[0xff, 0xfe, b'A'], 3);
        assert!(!c.binary);
        assert!(c.read_only);
        assert!(c.content.contains('\u{FFFD}'));
    }

    #[test]
    fn classify_large_tier_is_readonly_not_truncated() {
        // 10 MB on-disk (8..=24 MB tier): loaded but read-only, not truncated.
        let c = classify(b"data", 10 * 1024 * 1024);
        assert!(!c.binary);
        assert!(c.read_only);
        assert!(!c.truncated);
        assert_eq!(c.content, "data");
    }

    #[test]
    fn classify_oversized_is_truncated_readonly() {
        let c = classify(b"data", 30 * 1024 * 1024);
        assert!(c.truncated);
        assert!(c.read_only);
        assert!(!c.binary);
    }

    #[test]
    fn read_file_small_utf8_editable() {
        let dir = unique_temp_dir("read-small");
        let p = dir.join("hello.txt");
        fs::write(&p, b"hi there\n").unwrap();
        let fc = read_file(p.to_str().unwrap());
        assert_eq!(fc.content, "hi there\n");
        assert!(!fc.read_only);
        assert!(!fc.binary);
        assert!(fc.error.is_none());
        assert_eq!(fc.size, 9);
        assert!(fc.mtime_ms > 0.0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_file_missing_sets_error_not_content() {
        let fc = read_file("/no/such/conduit/path/file-xyz.txt");
        assert!(fc.error.is_some());
        assert_eq!(fc.content, "");
    }
}
