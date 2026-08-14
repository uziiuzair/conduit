//! Read-only project-scoped view of continuity's decisions and messages.
//!
//! Sibling of `continuity_read` (which serves the board). Conduit only ever READS this
//! database -- continuity owns every write.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Continuity's session-to-checkout key: sha256 of the git toplevel, hex, first 16 chars.
///
/// Continuity salts this with `CONTINUITY_SESSION_ID` when that env var is set, and
/// `pty.rs` sets it for every Conduit spawn -- so this UNSALTED form deliberately matches
/// only sessions started outside Conduit. Conduit's own sessions are matched by
/// `agent_label` instead, which `pty.rs` pins to the Conduit session id.
pub fn cwd_hash_of(toplevel: &str) -> String {
    let digest = Sha256::digest(toplevel.as_bytes());
    let hex = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    hex[..16].to_string()
}

/// Is continuity actually working? The file existing is not enough: a database that has
/// never had a session checked in has nothing to show, and the panels should stay hidden
/// rather than render an empty shell.
pub fn probe(conn: &rusqlite::Connection) -> bool {
    conn.query_row("SELECT COUNT(*) FROM agent_sessions", [], |r| {
        r.get::<_, i64>(0)
    })
    .map(|n| n > 0)
    .unwrap_or(false)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedDecision {
    pub id: String,
    pub decision_key: String,
    pub content: String,
    pub decision_type: String,
    pub status: String,
    pub supersedes: Option<String>,
    pub created_at: String,
    pub author_label: Option<String>,
}

/// Which continuity session rows belong to this project. Two arms, both allowlists:
///   1. `agent_label IN (session_ids)` -- Conduit's own sessions. `pty.rs` sets
///      CONTINUITY_AGENT_ID to the Conduit session id, so this is an exact match.
///   2. `cwd_hash IN (hash(toplevel))` -- sessions started from a plain terminal in the
///      same checkout or one of its worktrees.
///
/// No wildcards, no prefix matching: a cross-project leak here would be the one failure
/// that actually matters.
pub fn resolve_session_ids(
    conn: &rusqlite::Connection,
    session_ids: &[String],
    toplevels: &[String],
) -> Vec<String> {
    let hashes: Vec<String> = toplevels.iter().map(|t| cwd_hash_of(t)).collect();
    if session_ids.is_empty() && hashes.is_empty() {
        return vec![];
    }
    let label_ph = placeholders(session_ids.len());
    let hash_ph = placeholders(hashes.len());
    let sql = format!(
        "SELECT id FROM agent_sessions WHERE agent_label IN ({label_ph}) OR cwd_hash IN ({hash_ph})"
    );
    let params: Vec<&String> = session_ids.iter().chain(hashes.iter()).collect();
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return vec![];
    };
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| {
        r.get::<_, String>(0)
    });
    match rows {
        Ok(it) => it.filter_map(Result::ok).collect(),
        Err(_) => vec![],
    }
}

/// `?,?,?` for n bindings. An empty list yields `NULL`, which matches nothing -- so an
/// empty arm contributes no rows instead of producing invalid SQL.
fn placeholders(n: usize) -> String {
    if n == 0 {
        return "NULL".to_string();
    }
    std::iter::repeat_n("?", n).collect::<Vec<_>>().join(",")
}

pub fn read_decisions(
    conn: &rusqlite::Connection,
    session_ids: &[String],
    limit: usize,
) -> rusqlite::Result<Vec<FeedDecision>> {
    if session_ids.is_empty() {
        return Ok(vec![]);
    }
    let ph = placeholders(session_ids.len());
    let sql = format!(
        "SELECT d.id, d.decision_key, d.content, d.decision_type, d.status, d.supersedes, \
         d.created_at, s.agent_label \
         FROM decisions d LEFT JOIN agent_sessions s ON s.id = d.author_agent_session_id \
         WHERE d.author_agent_session_id IN ({ph}) \
         ORDER BY d.created_at DESC LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(session_ids.iter()), |r| {
        Ok(FeedDecision {
            id: r.get(0)?,
            decision_key: r.get(1)?,
            content: r.get(2)?,
            decision_type: r.get(3)?,
            status: r.get(4)?,
            supersedes: r.get(5)?,
            created_at: r.get(6)?,
            author_label: r.get(7)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    /// (the canonical FIPS-180 test vector). Pinning the first 16 hex chars proves our
    /// hash matches continuity's `createHash("sha256").update(x).digest("hex").slice(0,16)`
    /// without either side having to trust the other's implementation.
    #[test]
    fn cwd_hash_matches_the_sha256_vector() {
        assert_eq!(cwd_hash_of("abc"), "ba7816bf8f01cfea");
    }

    #[test]
    fn cwd_hash_is_sixteen_hex_chars() {
        let h = cwd_hash_of("/Users/someone/repo");
        assert_eq!(h.len(), 16);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  decision_key TEXT NOT NULL,
  content TEXT NOT NULL,
  decision_type TEXT NOT NULL DEFAULT 'other'
    CHECK (decision_type IN ('architecture','tooling','process','scope','other')),
  project_scope TEXT,
  author_agent_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','pending','superseded','rejected')),
  supersedes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent_session_id TEXT NOT NULL,
  to_agent_session_id TEXT NOT NULL,
  repo_full_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message','collision','decision')),
  body TEXT NOT NULL,
  requires_response INTEGER NOT NULL DEFAULT 0,
  related_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','responded','dismissed')),
  response TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT,
  expires_at TEXT NOT NULL
);
";

    /// Unique temp DB path per call (pid + atomic counter -- no Date/rand needed).
    fn temp_db_path(tag: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "conduit-continuity-feed-test-{}-{}-{}.db",
            std::process::id(),
            tag,
            n
        ))
    }

    /// Three sessions:
    ///   sess-a  -- a Conduit session of this project (agent_label == Conduit session id)
    ///   sess-b  -- a plain CLI session in the SAME checkout (unsalted cwd_hash)
    ///   sess-x  -- a session in a different checkout entirely (must be excluded)
    /// Plus one decision authored by each.
    fn build_fixture(path: &std::path::Path) {
        let conn = rusqlite::Connection::open(path).expect("open fixture db");
        conn.execute_batch(FIXTURE_DDL)
            .expect("create fixture schema");

        let mine = cwd_hash_of("/repo/root");
        let theirs = cwd_hash_of("/somewhere/else");
        for (id, label, hash) in [
            ("sess-a", "conduit-session-1", "salted-hash-conduit"),
            ("sess-b", "root-9f2c1a", mine.as_str()),
            ("sess-x", "other-11bb22", theirs.as_str()),
        ] {
            conn.execute(
                "INSERT INTO agent_sessions (id, agent_label, cwd_hash, status, started_at, last_seen_at) \
                 VALUES (?1, ?2, ?3, 'active', 't0', 't1')",
                rusqlite::params![id, label, hash],
            )
            .expect("insert agent_sessions");
        }

        for (id, key, content, author, created, status) in [
            (
                "d1",
                "auth.session-store",
                "Use the keychain",
                "sess-a",
                "2026-08-14T01:00:00Z",
                "active",
            ),
            (
                "d2",
                "build.bundler",
                "Vite, not webpack",
                "sess-b",
                "2026-08-14T02:00:00Z",
                "active",
            ),
            (
                "d3",
                "other.thing",
                "Not our project",
                "sess-x",
                "2026-08-14T03:00:00Z",
                "active",
            ),
        ] {
            conn.execute(
                "INSERT INTO decisions (id, decision_key, content, decision_type, author_agent_session_id, status, created_at) \
                 VALUES (?1, ?2, ?3, 'architecture', ?4, ?5, ?6)",
                rusqlite::params![id, key, content, author, status, created],
            )
            .expect("insert decisions");
        }
    }

    #[test]
    fn resolves_sessions_by_label_and_by_cwd_hash() {
        let path = temp_db_path("resolve");
        build_fixture(&path);
        let conn = rusqlite::Connection::open(&path).expect("open");

        let ids = resolve_session_ids(
            &conn,
            &["conduit-session-1".to_string()],
            &["/repo/root".to_string()],
        );

        assert!(
            ids.contains(&"sess-a".to_string()),
            "label arm missed: {ids:?}"
        );
        assert!(
            ids.contains(&"sess-b".to_string()),
            "cwd_hash arm missed: {ids:?}"
        );
        assert!(
            !ids.contains(&"sess-x".to_string()),
            "leaked another checkout: {ids:?}"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn decisions_are_scoped_and_newest_first() {
        let path = temp_db_path("decisions");
        build_fixture(&path);
        let conn = rusqlite::Connection::open(&path).expect("open");

        let ids = resolve_session_ids(
            &conn,
            &["conduit-session-1".to_string()],
            &["/repo/root".to_string()],
        );
        let rows = read_decisions(&conn, &ids, 100).expect("read decisions");

        let keys: Vec<&str> = rows.iter().map(|d| d.decision_key.as_str()).collect();
        assert_eq!(keys, vec!["build.bundler", "auth.session-store"]);
        assert_eq!(rows[0].author_label.as_deref(), Some("root-9f2c1a"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn no_sessions_means_no_decisions() {
        let path = temp_db_path("empty-scope");
        build_fixture(&path);
        let conn = rusqlite::Connection::open(&path).expect("open");

        let rows = read_decisions(&conn, &[], 100).expect("read decisions");

        assert!(rows.is_empty(), "unscoped read leaked rows: {rows:?}");

        let _ = std::fs::remove_file(&path);
    }
}
