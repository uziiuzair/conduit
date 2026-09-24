//! Hot exit: dirty editor buffers are backed up here (debounced, from the frontend)
//! and restored as dirty on the next launch.
//!
//! A profile opens a second window (a second webview), and each window flushes its
//! OWN dirty set independently. The on-disk file is still one flat `Vec<HotExitEntry>`
//! -- old files load unchanged, no migration -- but writing it used to replace the
//! file wholesale from whichever window flushed last, so window B's flush (even an
//! empty one, e.g. on close) silently wiped out window A's backups. `HotExitState`
//! keeps each label's set in memory and writes the UNION of every label's set on
//! every flush, so one window's save can never clobber another's.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Skip pathological buffers; matches fsops::read_file's editor-size bound.
const ENTRY_CAP: usize = 24 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotExitEntry {
    /// Absolute file path (the registry key).
    pub path: String,
    /// Full buffer content at backup time.
    pub content: String,
    /// Backup wall-clock ms -- informational (shown nowhere yet, useful in triage),
    /// and also the tie-break `union_of` uses when the same path is dirty under two
    /// labels at once.
    pub mtime_ms: f64,
}

/// Per-label (per-window) dirty sets. Managed as Tauri state so `hotexit_save` can
/// union a label's flush against every other live window's set before writing.
#[derive(Default)]
pub struct HotExitState {
    by_label: Mutex<HashMap<String, Vec<HotExitEntry>>>,
}

impl HotExitState {
    /// Replace `label`'s set and persist the union of every label's set to the real
    /// backup file. An empty `entries` clears only `label`'s own set -- a window with
    /// nothing dirty flushing (e.g. on close) must not blank out another window's
    /// backups, which a wholesale replace used to do.
    pub fn save_for(&self, label: &str, entries: &[HotExitEntry]) -> Result<(), String> {
        self.save_for_at(label, entries, &backup_path())
    }

    /// `save_for`, but against an explicit path -- the seam tests use so they never
    /// touch the real `data_dir()`.
    ///
    /// The lock is held across the update, the union, AND the write: `hotexit_save`
    /// is registered as a synchronous `#[tauri::command]` today, so Tauri already
    /// serializes calls on the main thread and this can't interleave -- but holding
    /// the lock through the write (rather than dropping it right after computing the
    /// union) makes that true regardless, so the command can later move to `async`
    /// (the codebase's usual pattern for file I/O) without silently reopening the
    /// exact clobber this type exists to close: two concurrent flushes racing to
    /// write the union each computed from a stale map.
    fn save_for_at(
        &self,
        label: &str,
        entries: &[HotExitEntry],
        target: &Path,
    ) -> Result<(), String> {
        let kept: Vec<HotExitEntry> = entries
            .iter()
            .filter(|e| e.content.len() <= ENTRY_CAP)
            .cloned()
            .collect();
        let mut by_label = self.by_label.lock().unwrap_or_else(|e| e.into_inner());
        if kept.is_empty() {
            by_label.remove(label);
        } else {
            by_label.insert(label.to_string(), kept);
        }
        let union = union_of(&by_label);
        write_backup(&union, target)
    }
}

/// Union of every label's set, deduped by path. The same path dirty under two labels
/// at once (rare: the same file open in two windows) keeps only the entry with the
/// LATEST `mtime_ms` -- an arbitrary "whichever label iterates last" pick would make
/// restore nondeterministic. Note this is flush time, not edit time (both callers in
/// `store.ts` stamp `Date.now()` when they flush, not when the buffer last changed),
/// so the tie-break is really "most recently flushed", not "most recently edited" --
/// close enough for the common case (one window's buffer wins over a stale unconsumed
/// backup) but not a perfect resolution of a genuine two-window same-file collision.
fn union_of(by_label: &HashMap<String, Vec<HotExitEntry>>) -> Vec<HotExitEntry> {
    let mut newest: HashMap<&str, &HotExitEntry> = HashMap::new();
    for entries in by_label.values() {
        for entry in entries {
            match newest.get(entry.path.as_str()) {
                Some(existing) if existing.mtime_ms >= entry.mtime_ms => {}
                _ => {
                    newest.insert(&entry.path, entry);
                }
            }
        }
    }
    newest.into_values().cloned().collect()
}

fn backup_path() -> PathBuf {
    crate::store::data_dir().join("hot-exit.json")
}

/// Same atomic-replace recipe as `Store::save`; a torn hot-exit.json must be
/// impossible or a crash during flush destroys the very data it protects.
fn write_backup(entries: &[HotExitEntry], target: &Path) -> Result<(), String> {
    let json = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write backup: {e}"))?;
    #[cfg(windows)]
    {
        let _ = fs::remove_file(target);
    }
    fs::rename(&tmp, target).map_err(|e| format!("commit backup: {e}"))?;
    Ok(())
}

/// Load (without consuming) the backup set -- the union across every window, with no
/// notion of labels at all: a restore doesn't care which window a backup came from.
/// Missing or corrupt file -> empty: hot exit must never block launch.
pub fn load() -> Vec<HotExitEntry> {
    load_at(&backup_path())
}

fn load_at(path: &Path) -> Vec<HotExitEntry> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique path under the OS temp dir -- never `data_dir()` -- so these tests
    /// can run concurrently with each other and with anything else touching the real
    /// hot-exit file.
    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "conduit-hotexit-test-{name}-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(path.with_extension("json.tmp"));
    }

    fn entry(path: &str, content: &str, mtime_ms: f64) -> HotExitEntry {
        HotExitEntry {
            path: path.to_string(),
            content: content.to_string(),
            mtime_ms,
        }
    }

    #[test]
    fn two_labels_saving_disjoint_sets_union_on_disk() {
        let target = test_path("two-labels-union");
        let state = HotExitState::default();
        state
            .save_for_at("main", &[entry("/a.txt", "A", 1.0)], &target)
            .unwrap();
        state
            .save_for_at("profile-x", &[entry("/b.txt", "B", 2.0)], &target)
            .unwrap();

        let mut on_disk = load_at(&target);
        on_disk.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(on_disk.len(), 2, "expected both labels' entries on disk");
        assert_eq!(on_disk[0].path, "/a.txt");
        assert_eq!(on_disk[1].path, "/b.txt");

        cleanup(&target);
    }

    #[test]
    fn resaving_empty_clears_only_that_labels_entries() {
        let target = test_path("resave-empty");
        let state = HotExitState::default();
        state
            .save_for_at("main", &[entry("/a.txt", "A", 1.0)], &target)
            .unwrap();
        state
            .save_for_at("profile-x", &[entry("/b.txt", "B", 2.0)], &target)
            .unwrap();

        // "main" now has nothing dirty; its flush must not touch "profile-x"'s set.
        state.save_for_at("main", &[], &target).unwrap();

        let on_disk = load_at(&target);
        assert_eq!(on_disk.len(), 1, "only main's entry should be gone");
        assert_eq!(on_disk[0].path, "/b.txt");

        cleanup(&target);
    }

    #[test]
    fn old_flat_file_loads_unchanged() {
        let target = test_path("old-flat-file");
        // What the pre-union code wrote: a bare flat Vec, no label wrapper at all.
        let legacy = vec![entry("/old.txt", "legacy", 0.0)];
        fs::write(&target, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let loaded = load_at(&target);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].path, "/old.txt");
        assert_eq!(loaded[0].content, "legacy");

        cleanup(&target);
    }

    #[test]
    fn path_collision_across_labels_keeps_the_latest_mtime() {
        let target = test_path("path-collision");
        let state = HotExitState::default();
        state
            .save_for_at("main", &[entry("/shared.txt", "old", 1.0)], &target)
            .unwrap();
        state
            .save_for_at("profile-x", &[entry("/shared.txt", "new", 2.0)], &target)
            .unwrap();

        let on_disk = load_at(&target);
        assert_eq!(on_disk.len(), 1, "the same path must not appear twice");
        assert_eq!(on_disk[0].content, "new", "the newer mtime must win");

        cleanup(&target);
    }

    #[test]
    fn path_collision_dedupe_is_order_independent() {
        // Same scenario as above, but the newer entry is saved FIRST -- the dedupe
        // must key off mtime_ms, not "whichever label saved last".
        let target = test_path("path-collision-reverse");
        let state = HotExitState::default();
        state
            .save_for_at("profile-x", &[entry("/shared.txt", "new", 2.0)], &target)
            .unwrap();
        state
            .save_for_at("main", &[entry("/shared.txt", "old", 1.0)], &target)
            .unwrap();

        let on_disk = load_at(&target);
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0].content, "new");

        cleanup(&target);
    }

    #[test]
    fn oversized_entry_is_still_filtered_out() {
        let target = test_path("entry-cap");
        let state = HotExitState::default();
        let huge = "x".repeat(ENTRY_CAP + 1);
        state
            .save_for_at("main", &[entry("/huge.txt", &huge, 1.0)], &target)
            .unwrap();

        let on_disk = load_at(&target);
        assert!(on_disk.is_empty(), "an over-cap entry must be dropped");

        cleanup(&target);
    }
}
