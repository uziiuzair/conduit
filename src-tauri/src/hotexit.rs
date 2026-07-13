//! Hot exit: dirty editor buffers are backed up here (debounced, from the frontend)
//! and restored as dirty on the next launch. One JSON file in the app-data dir,
//! replaced wholesale on every flush — dirty sets are small, and a single atomic
//! write is simpler and safer than per-file bookkeeping.

use std::fs;
use std::path::PathBuf;

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
    /// Backup wall-clock ms — informational (shown nowhere yet, useful in triage).
    pub mtime_ms: f64,
}

fn backup_path() -> PathBuf {
    crate::store::data_dir().join("hot-exit.json")
}

/// Replace the backup set. An empty `entries` clears it (the file is still written
/// so a crash right after can't resurrect stale backups).
pub fn save(entries: &[HotExitEntry]) -> Result<(), String> {
    let kept: Vec<&HotExitEntry> = entries
        .iter()
        .filter(|e| e.content.len() <= ENTRY_CAP)
        .collect();
    let json = serde_json::to_vec(&kept).map_err(|e| e.to_string())?;
    let target = backup_path();
    let tmp = target.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("write backup: {e}"))?;
    // Same atomic-replace recipe as Store::save; a torn hot-exit.json must be
    // impossible or a crash during flush destroys the very data it protects.
    #[cfg(windows)]
    {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&tmp, &target).map_err(|e| format!("commit backup: {e}"))?;
    Ok(())
}

/// Load (without consuming) the backup set. Missing or corrupt file -> empty:
/// hot exit must never block launch.
pub fn load() -> Vec<HotExitEntry> {
    let Ok(bytes) = fs::read(backup_path()) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}
