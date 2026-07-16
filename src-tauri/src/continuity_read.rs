//! Read-only adapter over continuity's SQLite DB (`~/.continuity/continuity.db`, WAL mode).
//!
//! Conduit only ever READS this database -- continuity (the MCP plugin/CLI) owns writes.
//! Gives the board card-scoped presence (which Conduit sessions are active) and pending
//! handoffs left for a card, so the UI can surface "another session is here" / "there's a
//! handoff waiting" without Conduit needing its own coordination protocol.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub session_id: String,
    pub status: String,
    pub last_seen_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardHandoff {
    pub card_id: String,
    pub id: String,
    pub from_label: Option<String>,
    pub context: String,
    pub state: Option<String>,
    pub suggested_next_actions: Option<String>,
    pub status: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContinuityView {
    pub presence: Vec<Presence>,
    pub handoffs: Vec<CardHandoff>,
}

/// Presence of the given Conduit session ids (matched by agent_label) + pending handoffs scoped
/// to any card of the project. Never panics: a missing DB / unexpected schema returns default.
pub fn view_for_project(project_id: &str, session_ids: &[String]) -> ContinuityView {
    let Some(conn) = open_ro(&db_path()) else {
        return ContinuityView::default();
    };
    ContinuityView {
        presence: read_presence(&conn, session_ids).unwrap_or_default(),
        handoffs: read_card_handoffs(&conn, project_id).unwrap_or_default(),
    }
}

fn read_presence(
    conn: &rusqlite::Connection,
    session_ids: &[String],
) -> rusqlite::Result<Vec<Presence>> {
    if session_ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = session_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT agent_label, status, last_seen_at FROM agent_sessions \
         WHERE agent_label IN ({placeholders}) AND status <> 'gone'"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(session_ids.iter()), |r| {
        Ok(Presence {
            session_id: r.get(0)?,
            status: r.get(1)?,
            last_seen_at: r.get(2)?,
        })
    })?;
    rows.collect()
}

fn read_card_handoffs(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> rusqlite::Result<Vec<CardHandoff>> {
    let like = format!("conduit:{project_id}:card:%");
    let sql = "SELECT h.id, h.project_scope, h.context, h.state, h.suggested_next_actions, \
               h.status, h.created_at, s.agent_label \
               FROM handoffs h LEFT JOIN agent_sessions s ON s.id = h.from_agent_session_id \
               WHERE h.project_scope LIKE ?1 AND h.status = 'pending'";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([like], |r| {
        let scope: String = r.get(1)?;
        let card_id = scope.rsplit(":card:").next().unwrap_or("").to_string();
        Ok(CardHandoff {
            card_id,
            id: r.get(0)?,
            context: r.get(2)?,
            state: r.get(3)?,
            suggested_next_actions: r.get(4)?,
            status: r.get(5)?,
            created_at: r.get(6)?,
            from_label: r.get(7)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Continuity's real DDL for `agent_sessions` + `handoffs`, copied verbatim from
    /// `continuity-mcp/packages/shared/src/schema.sqlite.ts` (SQLITE_DDL, lines ~187-204 and
    /// ~279-294) so this fixture's column names match reality exactly.
    const FIXTURE_DDL: &str = "
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_label TEXT NOT NULL,
  cwd_hash TEXT NOT NULL,
  project_scope TEXT,
  current_focus TEXT,
  claimed_issue_number INTEGER,
  claimed_repo_full_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','gone')),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_sessions_last_seen_idx ON agent_sessions (last_seen_at);
CREATE INDEX IF NOT EXISTS agent_sessions_status_idx ON agent_sessions (status);
-- At most one live session per checkout. Makes checkin convergence atomic.
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_cwd_live_uq
  ON agent_sessions (cwd_hash) WHERE status <> 'gone';

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  from_agent_session_id TEXT NOT NULL,
  to_agent_session_id TEXT,
  project_scope TEXT,
  context TEXT NOT NULL,
  state TEXT,
  suggested_next_actions TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','completed','expired')),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_status_idx ON handoffs (status);
CREATE INDEX IF NOT EXISTS handoffs_to_agent_idx ON handoffs (to_agent_session_id);
";

    /// Unique temp DB path per call (pid + atomic counter -- no Date/rand needed).
    fn temp_db_path(tag: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "conduit-continuity-read-test-{}-{}-{}.db",
            std::process::id(),
            tag,
            n
        ))
    }

    /// Builds a fixture DB at `path` with continuity's real schema plus:
    /// - an active session `s2` (row id `sess-1`)
    /// - a pending handoff for `projX` card `c1`, authored by `sess-1` (should be returned)
    /// - a pending handoff for a DIFFERENT project (must be excluded)
    /// - a completed handoff for `projX` card `c1` (must be excluded: not pending)
    fn build_fixture(path: &std::path::Path) {
        let conn = rusqlite::Connection::open(path).expect("open fixture db");
        conn.execute_batch(FIXTURE_DDL).expect("create fixture schema");

        conn.execute(
            "INSERT INTO agent_sessions (id, agent_label, cwd_hash, status, started_at, last_seen_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["sess-1", "s2", "hash1", "active", "t0", "t1"],
        )
        .expect("insert agent_sessions");

        conn.execute(
            "INSERT INTO handoffs (id, from_agent_session_id, project_scope, context, status, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["h1", "sess-1", "conduit:projX:card:c1", "did discovery", "pending", "t2"],
        )
        .expect("insert handoff h1 (included)");

        conn.execute(
            "INSERT INTO handoffs (id, from_agent_session_id, project_scope, context, status, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["h2", "sess-1", "conduit:OTHER:card:zz", "wrong project", "pending", "t3"],
        )
        .expect("insert handoff h2 (excluded: other project)");

        conn.execute(
            "INSERT INTO handoffs (id, from_agent_session_id, project_scope, context, status, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["h3", "sess-1", "conduit:projX:card:c1", "already done", "completed", "t4"],
        )
        .expect("insert handoff h3 (excluded: not pending)");
    }

    #[test]
    fn reads_presence_by_label_and_handoffs_by_scope() {
        let path = temp_db_path("presence-handoffs");
        build_fixture(&path);
        std::env::set_var("CONTINUITY_DB_PATH", &path);

        let v = view_for_project("projX", &["s2".into(), "s9".into()]);

        assert_eq!(
            v.presence.iter().find(|p| p.session_id == "s2").unwrap().status,
            "active"
        );
        assert_eq!(v.handoffs.len(), 1);
        assert_eq!(v.handoffs[0].card_id, "c1");
        assert_eq!(v.handoffs[0].context, "did discovery");
        assert_eq!(v.handoffs[0].from_label.as_deref(), Some("s2"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_db_returns_default_no_panic() {
        let path = temp_db_path("missing-db");
        let _ = std::fs::remove_file(&path); // guarantee it doesn't exist
        std::env::set_var("CONTINUITY_DB_PATH", &path);

        let v = view_for_project("whatever", &["x".into()]);

        assert!(v.presence.is_empty());
        assert!(v.handoffs.is_empty());
    }
}
