//! Read-only adapter over continuity's SQLite DB (`~/.continuity/continuity.db`, WAL mode).
//!
//! Conduit only ever READS this database -- continuity (the MCP plugin/CLI) owns writes.
//! Gives the board card-scoped presence (which Conduit sessions are active) and pending
//! handoffs left for a card, so the UI can surface "another session is here" / "there's a
//! handoff waiting" without Conduit needing its own coordination protocol.

use std::path::PathBuf;

pub fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("CONTINUITY_DB_PATH") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join(".continuity")
        .join("continuity.db")
}

/// Open the continuity DB read-only. None if it doesn't exist yet (no sessions have run).
fn open_ro(path: &std::path::Path) -> Option<rusqlite::Connection> {
    if !path.exists() {
        return None;
    }
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()
}
