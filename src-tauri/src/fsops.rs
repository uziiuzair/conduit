//! Read-only filesystem access for the Files tab + file viewer. Never writes.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
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

/// Quick Open's fallback when the project isn't a git repo: a bounded recursive
/// walk. Depth/entry caps keep a mistakenly-opened $HOME from hanging the palette;
/// the heavy well-known noise dirs are skipped outright.
const WALK_DEPTH: usize = 6;
const WALK_SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".venv",
    "__pycache__",
];

pub fn walk_files(dir: &str, cap: usize) -> Vec<String> {
    fn rec(base: &Path, dir: &Path, depth: usize, cap: usize, out: &mut Vec<String>) {
        if depth > WALK_DEPTH || out.len() >= cap {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            if out.len() >= cap {
                return;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if !WALK_SKIP.contains(&name.as_str()) && !name.starts_with('.') {
                    rec(base, &e.path(), depth + 1, cap, out);
                }
            } else if let Ok(rel) = e.path().strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    rec(Path::new(dir), Path::new(dir), 0, cap, &mut out);
    out
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

// ---- raw-bytes read (image preview) ----------------------------------------

/// Cap for `read_file_base64`, well under the text HARD_CAP — a 16 MB file already
/// becomes a ~21 MB base64 string over IPC.
const IMAGE_CAP: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileBase64 {
    pub base64: String,
    pub size: u64,
}

/// Read a file's raw bytes base64-encoded (STANDARD engine, same as pty.rs frames).
/// Fallible at the IPC layer: the caller shows the error string in the preview pane.
/// The cap is enforced on the BYTES ACTUALLY READ (`take`, like `read_file`'s
/// HARD_CAP) — a pre-read metadata check alone is a TOCTOU hole: a file that grows
/// (or a symlink to an unbounded stream) between stat and read would otherwise be
/// read to EOF without limit.
pub fn read_file_base64(path: &str) -> Result<FileBase64, String> {
    use base64::Engine;
    let f = fs::File::open(path).map_err(|e| format!("could not read file: {e}"))?;
    let mut data = Vec::new();
    f.take(IMAGE_CAP + 1)
        .read_to_end(&mut data)
        .map_err(|e| format!("could not read file: {e}"))?;
    if data.len() as u64 > IMAGE_CAP {
        return Err(format!(
            "file is too large to preview (limit {} MB)",
            IMAGE_CAP / (1024 * 1024)
        ));
    }
    let size = data.len() as u64;
    Ok(FileBase64 {
        base64: base64::engine::general_purpose::STANDARD.encode(&data),
        size,
    })
}

// ---- write contract (atomic, std-only) ------------------------------------

/// Size + mtime of a path. Shared by `write_file` (returns it, `exists:true`) and the
/// Phase 2 `stat_file`. `mtime_ms`/`size` are 0 and `exists:false` when the path is gone.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime_ms: f64,
    pub size: u64,
    pub exists: bool,
}

/// Atomically overwrite `path` with `content`. std::fs only. Rejects a missing parent dir
/// (a save must never conjure directories). Writes a sibling temp, fsyncs it, reapplies the
/// target's Unix mode, then `fs::rename`s it into place (atomic same-fs replace). Returns
/// the post-rename stat.
pub fn write_file(path: &str, content: &str) -> Result<FileStat, String> {
    let target = std::path::Path::new(path);
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err(format!(
            "parent directory does not exist: {}",
            parent.display()
        ));
    }
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(
        ".{name}.conduit-tmp-{}-{nanos}",
        std::process::id()
    ));

    // Write + flush + fsync the temp so a crash can't leave a half-written target.
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create temp failed: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("write temp failed: {e}"))?;
        f.sync_all()
            .map_err(|e| format!("fsync temp failed: {e}"))?;
    }

    // Reapply the existing file's mode (a fresh temp is 0600 and would strip +x off scripts).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(target) {
            let _ =
                fs::set_permissions(&tmp, fs::Permissions::from_mode(meta.permissions().mode()));
        }
    }

    // Atomic replace. Clean up the temp on failure so we don't litter.
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("atomic rename failed: {e}"));
    }

    let meta = fs::metadata(target).map_err(|e| format!("post-write stat failed: {e}"))?;
    Ok(FileStat {
        mtime_ms: mtime_ms_of(&meta),
        size: meta.len(),
        exists: true,
    })
}

/// Stat a path for the file watcher. Infallible: any error (missing file,
/// permission denied, broken symlink) reports exists=false with zeroed fields.
/// std::fs only — polled ~1500ms (visibility-gated) by useFileWatch.
pub fn stat_file(path: &str) -> FileStat {
    match fs::metadata(path) {
        Ok(meta) => FileStat {
            mtime_ms: mtime_ms_of(&meta),
            size: meta.len(),
            exists: true,
        },
        Err(_) => FileStat {
            mtime_ms: 0.0,
            size: 0,
            exists: false,
        },
    }
}

// ---- Mutating ops (std::fs only; guarded, no clobber) -----------------------

/// Create an empty file. Errors if the target already exists (no clobber).
pub fn create_file(path: &str) -> Result<(), String> {
    if Path::new(path).exists() {
        return Err(format!("already exists: {path}"));
    }
    // create_new also closes the check-then-create race window.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| format!("could not create file: {e}"))
}

/// Create a single directory level (parent must already exist). Errors if it exists.
pub fn create_dir(path: &str) -> Result<(), String> {
    if Path::new(path).exists() {
        return Err(format!("already exists: {path}"));
    }
    fs::create_dir(path).map_err(|e| format!("could not create folder: {e}"))
}

/// Rename/move a file or directory. Errors if the destination already exists.
pub fn rename_path(from: &str, to: &str) -> Result<(), String> {
    if Path::new(to).exists() {
        return Err(format!("destination already exists: {to}"));
    }
    fs::rename(from, to).map_err(|e| format!("could not rename: {e}"))
}

/// Permanently delete a file (or a directory and its contents). No trash.
/// Uses symlink_metadata so a symlink is unlinked, never followed/recursed.
pub fn delete_path(path: &str) -> Result<(), String> {
    let md = fs::symlink_metadata(path).map_err(|e| format!("could not stat: {e}"))?;
    if md.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("could not delete folder: {e}"))
    } else {
        fs::remove_file(path).map_err(|e| format!("could not delete: {e}"))
    }
}

// ---- terminal path resolution (clickable paths) ---------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPath {
    pub abs_path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
}

/// Split a terminal token into its path part and optional 1-based line/col. A trailing
/// `:<line>` or `:<line>:<col>` (all-ASCII-digit groups) is stripped; a non-numeric colon
/// suffix (e.g. `foo:bar`) is left as part of the path. Pure — unit-tested without the fs.
fn parse_path_token(token: &str) -> (&str, Option<u32>, Option<u32>) {
    // Peel a single trailing `:<digits>` group off `s`, if present.
    fn peel(s: &str) -> Option<(&str, u32)> {
        let idx = s.rfind(':')?;
        let (head, tail) = s.split_at(idx);
        let num = &tail[1..]; // drop the ':'
        if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        num.parse::<u32>().ok().map(|n| (head, n))
    }
    if let Some((head1, n1)) = peel(token) {
        if let Some((head2, n2)) = peel(head1) {
            return (head2, Some(n2), Some(n1)); // head2:line:col
        }
        return (head1, Some(n1), None); // head1:line
    }
    (token, None, None)
}

/// Expand a leading `~` or `~/` to the user's home dir (not `~user`); otherwise unchanged.
fn expand_home(path: &str) -> String {
    if path == "~" {
        if let Some(h) = dirs::home_dir() {
            return h.to_string_lossy().into_owned();
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = dirs::home_dir() {
            return h.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Resolve a path token printed in a terminal into an existing regular file. `base` is the
/// session's working directory (used for relative tokens). Returns None when the token does
/// not resolve to an existing file (canonicalize confirms existence + resolves `..`/symlinks;
/// directories are rejected). Never opens or reads the file.
pub fn resolve_terminal_path(base: &str, token: &str) -> Option<ResolvedPath> {
    let (path_part, line, col) = parse_path_token(token.trim());
    if path_part.is_empty() {
        return None;
    }
    let expanded = expand_home(path_part);
    let joined = if Path::new(&expanded).is_absolute() {
        std::path::PathBuf::from(&expanded)
    } else {
        Path::new(base).join(&expanded)
    };
    // Verify it's an existing regular file. `metadata` follows symlinks for the check, but we
    // deliberately do NOT `canonicalize` the returned path: the rest of the app (FileTree,
    // add_project) keys tabs/models by the raw, non-symlink-resolved path, so canonicalizing
    // here would open a duplicate tab/model for a file under a symlinked ancestor (e.g. macOS
    // /tmp -> /private/tmp). Return the lexically-normalized join (drops `.`, keeps `..` and
    // symlinks) so the path stays in the same namespace the tree uses.
    if !fs::metadata(&joined).ok()?.is_file() {
        return None;
    }
    let normalized: std::path::PathBuf = joined.components().collect();
    Some(ResolvedPath {
        abs_path: normalized.to_string_lossy().into_owned(),
        line,
        col,
    })
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

    #[test]
    fn write_file_atomic_replace() {
        let dir = unique_temp_dir("write-replace");
        let p = dir.join("note.txt");
        fs::write(&p, b"old contents").unwrap();
        let stat = write_file(p.to_str().unwrap(), "new contents").expect("write ok");
        assert!(stat.exists);
        assert_eq!(stat.size, "new contents".len() as u64);
        assert_eq!(fs::read_to_string(&p).unwrap(), "new contents");
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn write_file_preserves_unix_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_temp_dir("write-mode");
        let p = dir.join("script.sh");
        fs::write(&p, b"#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        write_file(p.to_str().unwrap(), "#!/bin/sh\necho bye\n").expect("write ok");
        let mode = fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_file_rejects_missing_parent() {
        let dir = unique_temp_dir("write-missing");
        let p = dir.join("ghost-dir").join("file.txt");
        let res = write_file(p.to_str().unwrap(), "data");
        assert!(res.is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stat_file_reports_existing_and_missing() {
        // Real file: exists=true, size == bytes written, mtime_ms populated.
        let p = std::env::temp_dir().join(format!("conduit-stat-{}.txt", std::process::id()));
        std::fs::write(&p, b"hello").unwrap();
        let s = stat_file(p.to_str().unwrap());
        assert!(s.exists);
        assert_eq!(s.size, 5);
        assert!(s.mtime_ms > 0.0);

        // Missing path: exists=false with zeroed fields.
        std::fs::remove_file(&p).unwrap();
        let gone = stat_file(p.to_str().unwrap());
        assert!(!gone.exists);
        assert_eq!(gone.size, 0);
        assert_eq!(gone.mtime_ms, 0.0);
    }
}

#[cfg(test)]
mod crud_tests {
    use super::*;
    use std::path::PathBuf;

    /// Fresh unique scratch dir under the OS temp dir (mirrors `tests::unique_temp_dir`;
    /// no external crate needed).
    fn tmpdir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("conduit-fsops-crud-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn create_file_makes_file_and_rejects_existing() {
        let d = tmpdir();
        let p = d.join("a.txt");
        assert!(create_file(&s(&p)).is_ok());
        assert!(p.is_file());
        // no clobber: a second create must fail and must not touch existing bytes
        fs::write(&p, b"keep").unwrap();
        assert!(create_file(&s(&p)).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"keep");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn create_dir_single_level_and_rejects_existing() {
        let d = tmpdir();
        let sub = d.join("nested");
        assert!(create_dir(&s(&sub)).is_ok());
        assert!(sub.is_dir());
        assert!(create_dir(&s(&sub)).is_err()); // already exists
                                                // single level only — a missing intermediate parent must fail (NOT create_dir_all)
        let deep = d.join("x").join("y");
        assert!(create_dir(&s(&deep)).is_err());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn rename_moves_files_and_dirs_and_rejects_existing_dest() {
        let d = tmpdir();
        let a = d.join("a.txt");
        let b = d.join("b.txt");
        fs::write(&a, b"hi").unwrap();
        assert!(rename_path(&s(&a), &s(&b)).is_ok());
        assert!(!a.exists() && b.is_file());
        // dest exists -> refuse; source preserved, dest untouched
        let c = d.join("c.txt");
        fs::write(&c, b"c").unwrap();
        assert!(rename_path(&s(&c), &s(&b)).is_err());
        assert!(c.is_file());
        assert_eq!(fs::read(&b).unwrap(), b"hi");
        // also works for directories
        let dir1 = d.join("dir1");
        fs::create_dir(&dir1).unwrap();
        let dir2 = d.join("dir2");
        assert!(rename_path(&s(&dir1), &s(&dir2)).is_ok());
        assert!(dir2.is_dir() && !dir1.exists());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn delete_removes_files_and_dirs_recursively() {
        let d = tmpdir();
        let f = d.join("f.txt");
        fs::write(&f, b"x").unwrap();
        assert!(delete_path(&s(&f)).is_ok());
        assert!(!f.exists());
        // directories are removed recursively
        let sub = d.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("inner.txt"), b"y").unwrap();
        assert!(delete_path(&s(&sub)).is_ok());
        assert!(!sub.exists());
        // a missing path is an error
        assert!(delete_path(&s(&d.join("nope"))).is_err());
        fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    /// Fresh unique scratch dir under the OS temp dir (mirrors the other test modules).
    fn tmpdir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "conduit-fsops-resolve-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_token_variants() {
        assert_eq!(parse_path_token("src/a.ts"), ("src/a.ts", None, None));
        assert_eq!(
            parse_path_token("src/a.ts:45"),
            ("src/a.ts", Some(45), None)
        );
        assert_eq!(
            parse_path_token("src/a.ts:45:12"),
            ("src/a.ts", Some(45), Some(12))
        );
        assert_eq!(
            parse_path_token("/abs/a.ts:9"),
            ("/abs/a.ts", Some(9), None)
        );
        assert_eq!(parse_path_token("~/a.ts"), ("~/a.ts", None, None));
        // a non-numeric colon suffix stays part of the path (not a line number)
        assert_eq!(parse_path_token("weird:name"), ("weird:name", None, None));
        // an empty/trailing colon group is not a line number either
        assert_eq!(parse_path_token("a.ts:"), ("a.ts:", None, None));
    }

    #[test]
    fn expand_home_variants() {
        let home = dirs::home_dir().expect("home dir");
        // leading ~ and ~/ expand to the home dir
        assert_eq!(expand_home("~"), home.to_string_lossy().into_owned());
        assert_eq!(
            expand_home("~/a/b.ts"),
            home.join("a/b.ts").to_string_lossy().into_owned()
        );
        // absolute and relative paths pass through unchanged
        assert_eq!(expand_home("/abs/x.ts"), "/abs/x.ts");
        assert_eq!(expand_home("rel/x.ts"), "rel/x.ts");
        // ~user is NOT expanded (only a bare ~ or ~/ prefix)
        assert_eq!(expand_home("~bob/x.ts"), "~bob/x.ts");
    }

    #[test]
    fn resolves_relative_against_base_with_line_col() {
        let dir = tmpdir();
        let f = dir.join("hello.txt");
        fs::write(&f, b"hi").unwrap();
        let r = resolve_terminal_path(dir.to_str().unwrap(), "hello.txt:3:2").expect("resolves");
        // Non-canonicalizing: the returned path stays in the same (raw) namespace as `base`.
        assert_eq!(
            r.abs_path,
            dir.join("hello.txt").to_string_lossy().into_owned()
        );
        assert_eq!(r.line, Some(3));
        assert_eq!(r.col, Some(2));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_absolute_ignoring_base() {
        let dir = tmpdir();
        let f = dir.join("x.txt");
        fs::write(&f, b"hi").unwrap();
        let r = resolve_terminal_path("/no/such/base", f.to_str().unwrap()).expect("resolves");
        assert_eq!(r.abs_path, f.to_string_lossy().into_owned());
        assert_eq!(r.line, None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_is_none() {
        let dir = tmpdir();
        assert!(resolve_terminal_path(dir.to_str().unwrap(), "nope.txt").is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn directory_is_none() {
        let dir = tmpdir();
        let sub = dir.join("sub");
        fs::create_dir(&sub).unwrap();
        assert!(resolve_terminal_path(dir.to_str().unwrap(), "sub").is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn resolves_keep_symlink_namespace() {
        use std::os::unix::fs::symlink;
        let real = tmpdir();
        fs::write(real.join("f.txt"), b"hi").unwrap();
        // A sibling symlink pointing at the real dir.
        let link = real
            .parent()
            .unwrap()
            .join(format!("conduit-resolve-link-{}", std::process::id()));
        let _ = fs::remove_file(&link);
        symlink(&real, &link).unwrap();
        // Resolve a relative token against the SYMLINK dir as base.
        let r = resolve_terminal_path(link.to_str().unwrap(), "f.txt").expect("resolves");
        // The returned path stays under the symlink dir (not canonicalized to the real dir).
        assert_eq!(
            r.abs_path,
            link.join("f.txt").to_string_lossy().into_owned()
        );
        assert_ne!(
            r.abs_path,
            fs::canonicalize(link.join("f.txt"))
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
        fs::remove_file(&link).ok();
        fs::remove_dir_all(&real).ok();
    }
}
