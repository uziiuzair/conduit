# Continuity Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two read-only right-column panels — Decisions and Messages — that surface the running memory continuity records for the active project, hidden entirely when continuity is not installed or has never run.

**Architecture:** A new Rust module reads continuity's SQLite store read-only (reusing `continuity_read`'s path and open helpers), resolves which continuity sessions belong to the active project by exact `agent_label` match plus an unsalted `cwd_hash` match for CLI sessions, and returns capped, newest-first decision and message rows through one Tauri command. A dedicated frontend hook polls it every 4 s, independent of the board's faster poll and its `board_enabled` gate. Conduit never writes the database.

**Tech Stack:** Rust (rusqlite 0.32 bundled, sha2, dashmap, Tauri v2 commands), React 19 + TypeScript, Zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-continuity-panels-design.md`

## Global Constraints

- Conduit **only ever reads** continuity's database. No `INSERT`, `UPDATE`, or `DELETE`, and no write-mode connection. Open exclusively with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_URI`.
- Every failure degrades to `available: false` with empty lists. No `Err` return, no panic, no user-facing error surface.
- Session ids and directories are bound as SQL parameters, never string-interpolated into SQL.
- The database path is `~/.continuity/continuity.db`, overridable by `CONTINUITY_DB_PATH`. `continuity_read::db_path()` already implements this — reuse it, do not duplicate it.
- `cwd_hash` must match continuity's computation exactly: `sha256(<git toplevel>)` hex-encoded, truncated to the first 16 characters, where the toplevel is the **raw trimmed** output of `git -C <dir> rev-parse --show-toplevel`. Do **not** canonicalize the path — continuity does not, and canonicalizing breaks the match on macOS `/tmp` symlinks.
- Row cap: 100 per table, newest first (`ORDER BY created_at DESC LIMIT 100`).
- Poll cadence for the panels: 4000 ms, only while `document.visibilityState === "visible"`.
- Rust must pass `cargo fmt --check` and `cargo clippy -D warnings`; the frontend must pass `pnpm exec tsc --noEmit` and `pnpm test`.
- Never add a `Co-Authored-By: Claude` trailer to any commit.
- Commits follow Conventional Commits with a scope, e.g. `feat(continuity): …`.

---

### Task 1: Rust module skeleton — availability probe and `cwd_hash`

**Files:**
- Create: `src-tauri/src/continuity_feed.rs`
- Modify: `src-tauri/src/continuity_read.rs` (make `open_ro` crate-visible)
- Modify: `src-tauri/src/lib.rs` (register the module)
- Modify: `src-tauri/Cargo.toml` (add `sha2`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/continuity_feed.rs`

**Interfaces:**
- Consumes: `continuity_read::db_path() -> PathBuf` (exists), `continuity_read::open_ro(&Path) -> Option<rusqlite::Connection>` (currently private — this task widens it to `pub(crate)`).
- Produces: `continuity_feed::cwd_hash_of(toplevel: &str) -> String`, `continuity_feed::probe(conn: &rusqlite::Connection) -> bool`.

- [ ] **Step 1: Add the `sha2` dependency**

`sha2` is already present in `Cargo.lock` transitively (pulled in by `tauri-plugin-updater`), so this compiles no new crate — it only makes the existing one directly usable. Add it to the `[dependencies]` block in `src-tauri/Cargo.toml`, immediately after the `dirs = "5"` line:

```toml
dirs = "5"
# Reproduces continuity's cwd_hash (sha256 of the git toplevel, first 16 hex chars) so
# sessions started outside Conduit in the same checkout can be matched. Already in the
# lock file via tauri-plugin-updater — this only makes it a direct dependency.
sha2 = "0.10"
```

- [ ] **Step 2: Widen `open_ro` to crate visibility**

In `src-tauri/src/continuity_read.rs`, change the signature on line 23 from:

```rust
fn open_ro(path: &std::path::Path) -> Option<rusqlite::Connection> {
```

to:

```rust
pub(crate) fn open_ro(path: &std::path::Path) -> Option<rusqlite::Connection> {
```

Leave the body and the doc comment unchanged. One module still owns "where the database is and how we open it".

- [ ] **Step 3: Write the failing tests**

Create `src-tauri/src/continuity_feed.rs` containing only the test module below plus `use` lines. It will not compile yet — that is the point.

```rust
//! Read-only project-scoped view of continuity's decisions and messages.
//!
//! Sibling of `continuity_read` (which serves the board). Conduit only ever READS this
//! database -- continuity owns every write.

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
}
```

- [ ] **Step 4: Register the module and run the tests to verify they fail**

In `src-tauri/src/lib.rs`, add the module declaration directly after the existing `mod continuity_read;` on line 17:

```rust
mod continuity_read;
mod continuity_feed;
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_feed`
Expected: FAIL — `cannot find function 'cwd_hash_of' in this scope`.

- [ ] **Step 5: Implement `cwd_hash_of` and `probe`**

Add above the test module in `src-tauri/src/continuity_feed.rs`:

```rust
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
```

The `query_row` fails (and so returns `false`) both when the table is missing and when the schema has drifted — which is exactly the degradation the spec asks for.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_feed`
Expected: PASS — 2 tests.

Then run: `cargo fmt --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: no output from fmt, no warnings from clippy.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/continuity_feed.rs src-tauri/src/continuity_read.rs src-tauri/src/lib.rs
git commit -m "feat(continuity): cwd_hash + availability probe for the feed reader"
```

---

### Task 2: Scope resolution and the decisions query

**Files:**
- Modify: `src-tauri/src/continuity_feed.rs`
- Test: inline `#[cfg(test)]` in `src-tauri/src/continuity_feed.rs`

**Interfaces:**
- Consumes: `cwd_hash_of`, `probe` (Task 1); `continuity_read::{db_path, open_ro}`.
- Produces: `FeedDecision` (serde struct), `resolve_session_ids(&Connection, &[String], &[String]) -> Vec<String>`, `read_decisions(&Connection, &[String], usize) -> rusqlite::Result<Vec<FeedDecision>>`.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `src-tauri/src/continuity_feed.rs`. The fixture DDL is copied verbatim from continuity's `packages/shared/src/schema.sqlite.ts` (`SQLITE_DDL`) so the column names match reality exactly — the same discipline `continuity_read.rs`'s tests already follow.

```rust
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
        conn.execute_batch(FIXTURE_DDL).expect("create fixture schema");

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
            ("d1", "auth.session-store", "Use the keychain", "sess-a", "2026-08-14T01:00:00Z", "active"),
            ("d2", "build.bundler", "Vite, not webpack", "sess-b", "2026-08-14T02:00:00Z", "active"),
            ("d3", "other.thing", "Not our project", "sess-x", "2026-08-14T03:00:00Z", "active"),
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

        assert!(ids.contains(&"sess-a".to_string()), "label arm missed: {ids:?}");
        assert!(ids.contains(&"sess-b".to_string()), "cwd_hash arm missed: {ids:?}");
        assert!(!ids.contains(&"sess-x".to_string()), "leaked another checkout: {ids:?}");

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_feed`
Expected: FAIL — `cannot find function 'resolve_session_ids'`, `cannot find function 'read_decisions'`.

- [ ] **Step 3: Implement the struct, scope resolution, and the query**

Add to `src-tauri/src/continuity_feed.rs`, above the test module:

```rust
use serde::{Deserialize, Serialize};

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
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| r.get::<_, String>(0));
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
    std::iter::repeat("?").take(n).collect::<Vec<_>>().join(",")
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
```

`limit` is formatted rather than bound because it is a `usize` this code chooses, never user input — but session ids, which *are* external data, are always bound.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_feed`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/continuity_feed.rs
git commit -m "feat(continuity): scope resolution + project-scoped decisions read"
```

---

### Task 3: The messages query and the public entry point

**Files:**
- Modify: `src-tauri/src/continuity_feed.rs`
- Test: inline `#[cfg(test)]` in `src-tauri/src/continuity_feed.rs`

**Interfaces:**
- Consumes: `resolve_session_ids`, `read_decisions`, `probe`, `cwd_hash_of` (Tasks 1-2).
- Produces: `FeedMessage`, `ContinuityFeed { available, decisions, messages }`, `feed_for_project(session_ids: &[String], toplevels: &[String], limit: usize) -> ContinuityFeed`.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block. Extend `build_fixture` first — insert two messages after the decisions loop, inside the same function:

```rust
        for (id, from, to, kind, body, requires, status, created) in [
            ("m1", "sess-a", "sess-b", "collision", "I'm in store.rs too", 1, "pending", "2026-08-14T04:00:00Z"),
            ("m2", "sess-x", "sess-x", "message", "Unrelated chatter", 0, "pending", "2026-08-14T05:00:00Z"),
        ] {
            conn.execute(
                "INSERT INTO messages (id, from_agent_session_id, to_agent_session_id, kind, body, \
                 requires_response, status, created_at, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '2026-08-14T06:00:00Z')",
                rusqlite::params![id, from, to, kind, body, requires, status, created],
            )
            .expect("insert messages");
        }
```

Then add these tests:

```rust
    #[test]
    fn messages_are_scoped_to_either_endpoint() {
        let path = temp_db_path("messages");
        build_fixture(&path);
        let conn = rusqlite::Connection::open(&path).expect("open");

        let ids = resolve_session_ids(
            &conn,
            &["conduit-session-1".to_string()],
            &["/repo/root".to_string()],
        );
        let rows = read_messages(&conn, &ids, 100).expect("read messages");

        assert_eq!(rows.len(), 1, "expected only the in-project message: {rows:?}");
        assert_eq!(rows[0].id, "m1");
        assert_eq!(rows[0].from_label.as_deref(), Some("conduit-session-1"));
        assert_eq!(rows[0].to_label.as_deref(), Some("root-9f2c1a"));
        assert!(rows[0].requires_response);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn feed_reports_available_with_scoped_rows() {
        let path = temp_db_path("feed-ok");
        build_fixture(&path);
        std::env::set_var("CONTINUITY_DB_PATH", &path);

        let feed = feed_for_project(
            &["conduit-session-1".to_string()],
            &["/repo/root".to_string()],
            100,
        );

        assert!(feed.available);
        assert_eq!(feed.decisions.len(), 2);
        assert_eq!(feed.messages.len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_db_is_unavailable_and_does_not_panic() {
        let path = temp_db_path("feed-missing");
        let _ = std::fs::remove_file(&path);
        std::env::set_var("CONTINUITY_DB_PATH", &path);

        let feed = feed_for_project(&["whatever".to_string()], &[], 100);

        assert!(!feed.available);
        assert!(feed.decisions.is_empty());
        assert!(feed.messages.is_empty());
    }

    #[test]
    fn db_with_schema_but_no_sessions_is_unavailable() {
        let path = temp_db_path("feed-empty");
        let conn = rusqlite::Connection::open(&path).expect("open");
        conn.execute_batch(FIXTURE_DDL).expect("schema only, no rows");
        drop(conn);
        std::env::set_var("CONTINUITY_DB_PATH", &path);

        let feed = feed_for_project(&["whatever".to_string()], &[], 100);

        assert!(!feed.available, "an unused continuity db must stay hidden");

        let _ = std::fs::remove_file(&path);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_feed`
Expected: FAIL — `cannot find function 'read_messages'`, `cannot find function 'feed_for_project'`.

- [ ] **Step 3: Implement `FeedMessage`, `read_messages`, `ContinuityFeed`, `feed_for_project`**

Add to `src-tauri/src/continuity_feed.rs`, above the test module:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedMessage {
    pub id: String,
    pub kind: String,
    pub body: String,
    pub requires_response: bool,
    pub related_key: Option<String>,
    pub status: String,
    pub response: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    pub from_label: Option<String>,
    pub to_label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContinuityFeed {
    pub available: bool,
    pub decisions: Vec<FeedDecision>,
    pub messages: Vec<FeedMessage>,
}

pub fn read_messages(
    conn: &rusqlite::Connection,
    session_ids: &[String],
    limit: usize,
) -> rusqlite::Result<Vec<FeedMessage>> {
    if session_ids.is_empty() {
        return Ok(vec![]);
    }
    let ph = placeholders(session_ids.len());
    let sql = format!(
        "SELECT m.id, m.kind, m.body, m.requires_response, m.related_key, m.status, m.response, \
         m.created_at, m.expires_at, f.agent_label, t.agent_label \
         FROM messages m \
         LEFT JOIN agent_sessions f ON f.id = m.from_agent_session_id \
         LEFT JOIN agent_sessions t ON t.id = m.to_agent_session_id \
         WHERE m.from_agent_session_id IN ({ph}) OR m.to_agent_session_id IN ({ph}) \
         ORDER BY m.created_at DESC LIMIT {limit}"
    );
    // The id list is bound TWICE -- once per arm of the OR -- so the parameter vector is
    // the ids repeated, in order.
    let params: Vec<&String> = session_ids.iter().chain(session_ids.iter()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| {
        Ok(FeedMessage {
            id: r.get(0)?,
            kind: r.get(1)?,
            body: r.get(2)?,
            requires_response: r.get::<_, i64>(3)? != 0,
            related_key: r.get(4)?,
            status: r.get(5)?,
            response: r.get(6)?,
            created_at: r.get(7)?,
            expires_at: r.get(8)?,
            from_label: r.get(9)?,
            to_label: r.get(10)?,
        })
    })?;
    rows.collect()
}

/// The whole read, in one call. Never errors: a missing database, a drifted schema, or a
/// continuity install that has never run all produce `available: false` and empty lists,
/// which the UI renders as "no tabs at all".
pub fn feed_for_project(
    session_ids: &[String],
    toplevels: &[String],
    limit: usize,
) -> ContinuityFeed {
    let Some(conn) = crate::continuity_read::open_ro(&crate::continuity_read::db_path()) else {
        return ContinuityFeed::default();
    };
    if !probe(&conn) {
        return ContinuityFeed::default();
    }
    let ids = resolve_session_ids(&conn, session_ids, toplevels);
    ContinuityFeed {
        available: true,
        decisions: read_decisions(&conn, &ids, limit).unwrap_or_default(),
        messages: read_messages(&conn, &ids, limit).unwrap_or_default(),
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml continuity_feed`
Expected: PASS — 9 tests.

Then: `cargo fmt --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/continuity_feed.rs
git commit -m "feat(continuity): project-scoped messages read + feed entry point"
```

---

### Task 4: The Tauri command

**Files:**
- Modify: `src-tauri/src/git.rs` (expose a toplevel helper)
- Modify: `src-tauri/src/lib.rs` (add the command, register it in `generate_handler!`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/git.rs`

**Interfaces:**
- Consumes: `continuity_feed::feed_for_project` (Task 3); `Store::list() -> Vec<Project>` where `Project { id, path, sessions }` and `Session { id, worktree_path: Option<String> }`.
- Produces: Tauri command `continuity_feed(project_id: String) -> Result<ContinuityFeed, String>`; `git::toplevel(dir: &str) -> Option<String>`.

- [ ] **Step 1: Write the failing test for the git helper**

Add to the existing `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/git.rs` (create the block if the file has none):

```rust
    #[test]
    fn toplevel_of_a_non_repo_is_none() {
        // A directory that is definitely not a git checkout. `toplevel` must degrade to
        // None rather than propagating git's error -- the caller treats "no repo" as
        // "nothing to scope by", not as a failure.
        assert!(toplevel("/").is_none());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml toplevel_of_a_non_repo`
Expected: FAIL — `cannot find function 'toplevel' in this scope`.

- [ ] **Step 3: Implement the helper**

Add to `src-tauri/src/git.rs`, next to `repo_relative`:

```rust
/// The git toplevel of `dir`, raw and untrimmed of nothing but whitespace.
///
/// Deliberately NOT canonicalized: continuity hashes exactly this string to build
/// `cwd_hash`, and canonicalizing would break the match on macOS, where /tmp is a
/// symlink to /private/tmp.
pub fn toplevel(dir: &str) -> Option<String> {
    run_checked(&["rev-parse", "--show-toplevel"], dir)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml toplevel_of_a_non_repo`
Expected: PASS.

- [ ] **Step 5: Add the command**

In `src-tauri/src/lib.rs`, directly after the existing `list_continuity` function (which ends around line 796), add:

```rust
/// Read-only continuity feed for a project: the decisions and messages recorded by the
/// sessions that belong to it. Scoped by Conduit session id (exact) plus the git toplevel
/// of the project and each of its worktrees (for sessions started outside Conduit).
/// Best-effort -- see `continuity_feed::feed_for_project`.
#[tauri::command]
fn continuity_feed(
    store: State<Arc<Store>>,
    project_id: String,
) -> Result<continuity_feed::ContinuityFeed, String> {
    let Some(project) = store.list().into_iter().find(|p| p.id == project_id) else {
        return Ok(continuity_feed::ContinuityFeed::default());
    };
    let session_ids: Vec<String> = project.sessions.iter().map(|s| s.id.clone()).collect();

    // The project root plus every worktree that exists on disk. Each is its own git
    // toplevel and so its own cwd_hash.
    let mut dirs: Vec<String> = vec![project.path.clone()];
    dirs.extend(
        project
            .sessions
            .iter()
            .filter_map(|s| s.worktree_path.clone()),
    );
    let mut toplevels: Vec<String> = dirs.iter().filter_map(|d| git::toplevel(d)).collect();
    toplevels.sort();
    toplevels.dedup();

    Ok(continuity_feed::feed_for_project(
        &session_ids,
        &toplevels,
        100,
    ))
}
```

Then register it in the `tauri::generate_handler!` list (around line 1753), immediately after `list_continuity,`:

```rust
            list_continuity,
            continuity_feed,
```

- [ ] **Step 6: Verify the build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: all tests pass, no clippy warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/git.rs src-tauri/src/lib.rs
git commit -m "feat(continuity): continuity_feed command scoped by session ids and worktrees"
```

---

### Task 5: Frontend pure helpers

**Files:**
- Create: `src/continuityFeed.ts`
- Test: `src/continuityFeed.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no imports from the store or Tauri).
- Produces: `FeedDecision`, `FeedMessage`, `ContinuityFeed` (TypeScript mirrors of the Rust serde structs, camelCase); `truncateLine(text: string, max?: number): string`; `timeAgo(iso: string, nowMs: number): string`; `supersededMap(decisions: FeedDecision[]): Record<string, FeedDecision>`.

- [ ] **Step 1: Write the failing tests**

Create `src/continuityFeed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { supersededMap, timeAgo, truncateLine, type FeedDecision } from "./continuityFeed";

const decision = (over: Partial<FeedDecision>): FeedDecision => ({
  id: "d1",
  decisionKey: "k",
  content: "c",
  decisionType: "other",
  status: "active",
  supersedes: null,
  createdAt: "2026-08-14T01:00:00Z",
  authorLabel: null,
  ...over,
});

describe("truncateLine", () => {
  it("collapses newlines so a multi-line decision stays one row", () => {
    expect(truncateLine("first\nsecond\nthird", 80)).toBe("first second third");
  });

  it("leaves text at the limit untouched", () => {
    expect(truncateLine("abcde", 5)).toBe("abcde");
  });

  it("ellipsizes past the limit without exceeding it", () => {
    const out = truncateLine("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });

  it("collapses runs of whitespace", () => {
    expect(truncateLine("a    b", 80)).toBe("a b");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-08-14T12:00:00Z");

  it("reads seconds as now", () => {
    expect(timeAgo("2026-08-14T11:59:30Z", now)).toBe("now");
  });

  it("reads minutes", () => {
    expect(timeAgo("2026-08-14T11:30:00Z", now)).toBe("30m");
  });

  it("reads hours", () => {
    expect(timeAgo("2026-08-14T09:00:00Z", now)).toBe("3h");
  });

  it("reads days", () => {
    expect(timeAgo("2026-08-12T12:00:00Z", now)).toBe("2d");
  });

  it("degrades to an empty string on an unparseable timestamp", () => {
    expect(timeAgo("not a date", now)).toBe("");
  });
});

describe("supersededMap", () => {
  it("maps a superseded decision to the one that replaced it", () => {
    const old = decision({ id: "d1", status: "superseded" });
    const next = decision({ id: "d2", supersedes: "d1" });

    const map = supersededMap([next, old]);

    expect(map.d1?.id).toBe("d2");
    expect(map.d2).toBeUndefined();
  });

  it("ignores a supersedes pointer to a decision outside the loaded page", () => {
    const next = decision({ id: "d2", supersedes: "not-loaded" });

    expect(supersededMap([next])).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- continuityFeed`
Expected: FAIL — cannot resolve `./continuityFeed`.

- [ ] **Step 3: Implement the module**

Create `src/continuityFeed.ts`:

```ts
// Pure helpers for the continuity panels. No store, no Tauri, no DOM — so the formatting
// rules that decide what a row looks like are testable on their own.

/** Mirrors Rust `continuity_feed::FeedDecision` (serde camelCase). */
export interface FeedDecision {
  id: string;
  decisionKey: string;
  content: string;
  decisionType: string;
  status: string;
  supersedes: string | null;
  createdAt: string;
  authorLabel: string | null;
}

/** Mirrors Rust `continuity_feed::FeedMessage` (serde camelCase). */
export interface FeedMessage {
  id: string;
  kind: string;
  body: string;
  requiresResponse: boolean;
  relatedKey: string | null;
  status: string;
  response: string | null;
  createdAt: string;
  expiresAt: string;
  fromLabel: string | null;
  toLabel: string | null;
}

/** Mirrors Rust `continuity_feed::ContinuityFeed`. */
export interface ContinuityFeed {
  available: boolean;
  decisions: FeedDecision[];
  messages: FeedMessage[];
}

/** A decision's prose is paragraphs; a row is one line. Collapse, then ellipsize. */
export function truncateLine(text: string, max = 96): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** Compact relative time. `nowMs` is injected rather than read from the clock so the
 *  formatting rules are testable without freezing time. */
export function timeAgo(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** id of a replaced decision -> the decision that replaced it, for the detail modal.
 *  Only resolves within the loaded page; a pointer past the row cap is simply dropped. */
export function supersededMap(decisions: FeedDecision[]): Record<string, FeedDecision> {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const out: Record<string, FeedDecision> = {};
  for (const d of decisions) {
    if (d.supersedes && byId.has(d.supersedes)) out[d.supersedes] = d;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- continuityFeed`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/continuityFeed.ts src/continuityFeed.test.ts
git commit -m "feat(continuity): pure formatting helpers for the feed panels"
```

---

### Task 6: Store state and the polling hook

**Files:**
- Modify: `src/store.ts` (add `BottomTab` members, feed state, setter)
- Create: `src/hooks/useContinuityFeed.ts`

**Interfaces:**
- Consumes: `ContinuityFeed` from `src/continuityFeed.ts` (Task 5); the `continuity_feed` Tauri command (Task 4).
- Produces: `useStore().continuityFeed: Record<string, ContinuityFeed>`, `setContinuityFeed(projectId, feed)`, `useContinuityFeed(projectId: string | null, enabled: boolean)`.

- [ ] **Step 1: Widen `BottomTab`**

In `src/store.ts`, replace line 309:

```ts
export type BottomTab = "terminal" | "git";
```

with:

```ts
export type BottomTab = "terminal" | "git" | "decisions" | "messages";
```

- [ ] **Step 2: Import and re-export the feed types, then add the state slot**

In `src/store.ts`, add to the imports at the top of the file (a plain re-export would not bring the name into scope for the interface below, so both lines are needed):

```ts
import type { ContinuityFeed } from "./continuityFeed";
```

Then, directly below the existing `export interface ContinuityView { … }` (line 246), add the re-export so consumers can keep importing every store type from one place:

```ts
export type { ContinuityFeed, FeedDecision, FeedMessage } from "./continuityFeed";
```

Next to `continuity: Record<string, ContinuityView>;` in the `AppState` interface (line 1185), add:

```ts
  /** Latest continuity feed (decisions + messages) per project, refreshed by
   *  useContinuityFeed. Separate from `continuity` above: that one rides the board's
   *  1.5 s poll and its board_enabled gate; this one is gated only on the database
   *  being reachable. */
  continuityFeed: Record<string, ContinuityFeed>;
```

And next to `setContinuity` in the same interface (line 1197):

```ts
  setContinuityFeed: (projectId: string, feed: ContinuityFeed) => void;
```

- [ ] **Step 3: Initialize the state and implement the setter**

Find the store's initial-state object where `continuity:` is initialized (search `continuity: {}` in `src/store.ts`) and add beside it:

```ts
    continuityFeed: {},
```

Then, directly after the existing `setContinuity` implementation (around line 2716), add:

```ts
    setContinuityFeed: (projectId, feed) =>
      set((s) => ({ continuityFeed: { ...s.continuityFeed, [projectId]: feed } })),
```

- [ ] **Step 4: Write the hook**

Create `src/hooks/useContinuityFeed.ts`:

```ts
import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { ContinuityFeed } from "../continuityFeed";

/** Slower than the board's 1.5 s: a decision log is a memory, not a live wire. */
const POLL_MS = 4000;

/**
 * Keeps a project's continuity feed fresh while one of the panels is open.
 *
 * Deliberately NOT folded into useBoard: that hook is gated on `board_enabled` and polls
 * at 1.5 s for card state. The panels are gated only on continuity's database being
 * reachable, so they must keep their own cadence and their own gate.
 */
export function useContinuityFeed(projectId: string | null, enabled: boolean) {
  const setContinuityFeed = useStore((s) => s.setContinuityFeed);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      const feed = await invoke<ContinuityFeed>("continuity_feed", { projectId });
      setContinuityFeed(projectId, feed);
    } catch (e) {
      console.error("[continuity] continuity_feed failed", e);
    }
  }, [projectId, setContinuityFeed]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    void reload();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, projectId, reload]);

  return { reload };
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run: `pnpm test`
Expected: the whole suite passes, including `src/store.seam.test.ts` (nothing here touches `workingDirOf` — the directories are resolved Rust-side from `Project.path` and `Session.worktree_path`).

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/hooks/useContinuityFeed.ts
git commit -m "feat(continuity): feed store slot + 4s polling hook"
```

---

### Task 7: The two panels

**Files:**
- Create: `src/components/ContinuityPanels.tsx`
- Modify: `src/components/RightColumn.tsx:259-289` (bottom panel tabs and content)
- Modify: `src/theme.css` (row styles)

**Interfaces:**
- Consumes: `useContinuityFeed` (Task 6), `truncateLine` / `timeAgo` / `FeedDecision` / `FeedMessage` (Task 5), `useStore().continuityFeed`.
- Produces: `<DecisionsPanel projectId onOpen />`, `<MessagesPanel projectId onOpen />` — both take `onOpen: (row) => void`, which Task 8 wires to the modal.

- [ ] **Step 1: Write the panel components**

Create `src/components/ContinuityPanels.tsx`:

```tsx
import { useStore } from "../store";
import { timeAgo, truncateLine, type FeedDecision, type FeedMessage } from "../continuityFeed";

/**
 * The right column's read-only window onto continuity's running memory.
 *
 * Rows are one line each; the prose lives in the modal. Nothing here writes — continuity
 * owns its database, and Conduit only ever reads it.
 */
export function DecisionsPanel({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (d: FeedDecision) => void;
}) {
  const decisions = useStore((s) => s.continuityFeed[projectId]?.decisions) ?? [];
  const now = Date.now();

  if (decisions.length === 0) {
    return <p className="placeholder">No decisions recorded for this project yet.</p>;
  }
  return (
    <div className="continuity-list">
      {decisions.map((d) => (
        <button
          key={d.id}
          className={`continuity-row ${d.status === "superseded" ? "muted" : ""}`}
          onClick={() => onOpen(d)}
          title={d.decisionKey}
        >
          <span className={`continuity-dot ${d.status}`} />
          <span className="continuity-key">{d.decisionKey}</span>
          <span className="continuity-body">{truncateLine(d.content)}</span>
          <span className="continuity-meta">
            {d.authorLabel ?? "unknown"} · {timeAgo(d.createdAt, now)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function MessagesPanel({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (m: FeedMessage) => void;
}) {
  const messages = useStore((s) => s.continuityFeed[projectId]?.messages) ?? [];
  const now = Date.now();

  if (messages.length === 0) {
    return <p className="placeholder">No messages between this project's sessions yet.</p>;
  }
  return (
    <div className="continuity-list">
      {messages.map((m) => {
        const unanswered = m.requiresResponse && m.status === "pending";
        return (
          <button
            key={m.id}
            className={`continuity-row ${m.status === "dismissed" ? "muted" : ""}`}
            onClick={() => onOpen(m)}
            title={`${m.fromLabel ?? "?"} → ${m.toLabel ?? "?"}`}
          >
            <span className={`continuity-badge ${m.kind}`}>{m.kind}</span>
            <span className="continuity-key">
              {m.fromLabel ?? "?"} → {m.toLabel ?? "?"}
            </span>
            <span className="continuity-body">{truncateLine(m.body)}</span>
            <span className="continuity-meta">
              {unanswered ? "needs reply · " : ""}
              {timeAgo(m.createdAt, now)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Wire the tabs into the bottom panel**

In `src/components/RightColumn.tsx`, add to the imports at the top of the file:

```tsx
import { DecisionsPanel, MessagesPanel } from "./ContinuityPanels";
import { useContinuityFeed } from "../hooks/useContinuityFeed";
```

Inside the component body, next to the other hook calls (after the `prevBottomTab` effect around line 59), add:

```tsx
  // Availability is decided by the Rust probe: the tabs do not exist until continuity's
  // database is reachable AND has at least one session in it. Poll only while a panel is
  // actually on screen — an unopened tab costs nothing.
  const feedAvailable = useStore((s) => (projectId ? s.continuityFeed[projectId]?.available : false)) ?? false;
  useContinuityFeed(projectId, true);
```

Note: the hook is enabled unconditionally rather than only while a feed tab is open, because the *first* poll is what decides whether the tabs render at all. Gating it on an open tab would mean the tabs could never appear. The 4 s cadence on one small query is cheap. (`tsconfig.json` sets `noUnusedLocals: true` — do not introduce a `feedTabOpen`-style local unless you use it.)

Replace the tab strip at lines 261-264 with:

```tsx
        <div className="panel-tabs">
          <PanelTab label="Terminal" active={bottomTab === "terminal"} onClick={() => setBottomTab("terminal")} />
          <PanelTab label="Git" active={bottomTab === "git"} onClick={() => setBottomTab("git")} />
          {feedAvailable && (
            <>
              <PanelTab
                label="Decisions"
                active={bottomTab === "decisions"}
                onClick={() => setBottomTab("decisions")}
              />
              <PanelTab
                label="Messages"
                active={bottomTab === "messages"}
                onClick={() => setBottomTab("messages")}
              />
            </>
          )}
        </div>
```

Then, inside `panel-content bottom-content`, directly after the `bottomTab === "git"` block (line 282), add:

```tsx
          {bottomTab === "decisions" && projectId && (
            <DecisionsPanel projectId={projectId} onOpen={setDetail} />
          )}
          {bottomTab === "messages" && projectId && (
            <MessagesPanel projectId={projectId} onOpen={setDetail} />
          )}
```

`setDetail` does not exist yet — Task 8 adds it. Until then, temporarily pass `() => {}` so this task compiles and can be verified on its own:

```tsx
          {bottomTab === "decisions" && projectId && (
            <DecisionsPanel projectId={projectId} onOpen={() => {}} />
          )}
          {bottomTab === "messages" && projectId && (
            <MessagesPanel projectId={projectId} onOpen={() => {}} />
          )}
```

Finally, guard the "No session selected" placeholder so it does not show under a feed tab — it already checks `bottomTab === "terminal"` (line 283), so no change is needed there.

**One more guard:** if continuity becomes unavailable while a feed tab is selected, the tab disappears but `bottomTab` still points at it. Add this effect next to the others in the component body:

```tsx
  // A feed tab can vanish (continuity stops being reachable) while it is selected —
  // fall back to Terminal rather than rendering a headless panel.
  useEffect(() => {
    if (!feedAvailable && (bottomTab === "decisions" || bottomTab === "messages")) {
      setBottomTab("terminal");
    }
  }, [feedAvailable, bottomTab, setBottomTab]);
```

- [ ] **Step 3: Add the row styles**

Append to `src/theme.css`, next to the other panel styles:

The custom properties used below all exist in `:root` at the top of `src/theme.css`: `--border`, `--accent`, `--ui-font`, `--mono-font`, `--panel-bg`, `--selection-bg`, `--text-bright`, `--text-mid`, `--text-dim`. **`--text` is not one of them** — it is undefined despite two existing uses at `theme.css:2970` and `:2992`. Do not use it, and do not define it as a drive-by.

```css
/* Continuity panels — one-line rows; the prose lives in the detail modal. */
.continuity-list { display: flex; flex-direction: column; }
.continuity-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 5px 10px; background: none; border: none; border-bottom: 1px solid var(--border);
  font-family: var(--ui-font); font-size: 12px; color: var(--text-mid); text-align: left; cursor: pointer;
}
.continuity-row:hover { background: var(--selection-bg); }
.continuity-row.muted { opacity: 0.55; }
.continuity-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--accent); }
.continuity-dot.superseded, .continuity-dot.rejected { background: var(--border); }
.continuity-badge {
  flex: none; padding: 1px 5px; border-radius: 4px; font-size: 10px; text-transform: uppercase;
  background: var(--selection-bg); color: var(--text-dim);
}
.continuity-badge.collision { color: var(--accent); }
.continuity-key {
  flex: none; max-width: 30%; font-family: var(--mono-font, monospace); font-size: 11px;
  color: var(--text-bright); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.continuity-body { flex: 1; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.continuity-meta { flex: none; color: var(--text-dim); font-size: 11px; white-space: nowrap; }
```

- [ ] **Step 4: Verify**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: clean.

Then launch and look at it — a typecheck proves nothing about a panel:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Confirm: in a project with continuity sessions, Decisions and Messages tabs appear after Git and list rows. In a project where continuity has never run (or with `CONTINUITY_DB_PATH` pointed at a nonexistent file), the tabs are absent.

- [ ] **Step 5: Commit**

```bash
git add src/components/ContinuityPanels.tsx src/components/RightColumn.tsx src/theme.css
git commit -m "feat(continuity): Decisions and Messages panels in the right column"
```

---

### Task 8: The detail modal

**Files:**
- Modify: `src/components/ContinuityPanels.tsx` (add the modal component)
- Modify: `src/components/RightColumn.tsx` (hold the selected row, render the modal)
- Modify: `src/theme.css` (modal body styles)

**Interfaces:**
- Consumes: `FeedDecision`, `FeedMessage`, `supersededMap`, `timeAgo` (Task 5); the panels from Task 7.
- Produces: `<ContinuityDetail row onClose supersededBy />` where `row: { kind: "decision"; value: FeedDecision } | { kind: "message"; value: FeedMessage }`.

- [ ] **Step 1: Add the modal component**

Append to `src/components/ContinuityPanels.tsx`:

```tsx
export type ContinuityRow =
  | { kind: "decision"; value: FeedDecision }
  | { kind: "message"; value: FeedMessage };

/** Full prose for one row. Reuses the app's existing .modal-backdrop / .modal shell. */
export function ContinuityDetail({
  row,
  supersededBy,
  onClose,
}: {
  row: ContinuityRow;
  supersededBy: FeedDecision | undefined;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal continuity-detail" onClick={(e) => e.stopPropagation()}>
        {row.kind === "decision" ? (
          <>
            <h2>{row.value.decisionKey}</h2>
            <p className="settings-intro">
              {row.value.decisionType} · {row.value.status} ·{" "}
              {row.value.authorLabel ?? "unknown author"} · {row.value.createdAt}
            </p>
            <pre className="continuity-prose">{row.value.content}</pre>
            {supersededBy && (
              <p className="continuity-supersede">
                Superseded by “{truncateLine(supersededBy.content, 120)}”
                {supersededBy.authorLabel ? ` (${supersededBy.authorLabel})` : ""}.
              </p>
            )}
          </>
        ) : (
          <>
            <h2>
              {row.value.fromLabel ?? "?"} → {row.value.toLabel ?? "?"}
            </h2>
            <p className="settings-intro">
              {row.value.kind} · {row.value.status}
              {row.value.requiresResponse ? " · response required" : ""} · {row.value.createdAt}
            </p>
            <pre className="continuity-prose">{row.value.body}</pre>
            {row.value.response && (
              <>
                <h2 className="continuity-response-head">Response</h2>
                <pre className="continuity-prose">{row.value.response}</pre>
              </>
            )}
          </>
        )}
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Hold the selection in `RightColumn`**

In `src/components/RightColumn.tsx`, extend the import from Task 7:

```tsx
import { ContinuityDetail, DecisionsPanel, MessagesPanel, type ContinuityRow } from "./ContinuityPanels";
```

Add to the component body, next to the other state:

```tsx
  const [detail, setDetail] = useState<ContinuityRow | null>(null);
  const decisions = useStore((s) => (projectId ? s.continuityFeed[projectId]?.decisions : undefined)) ?? [];
  const superseded = useMemo(() => supersededMap(decisions), [decisions]);
```

with `supersededMap` imported from `../continuityFeed`, and `useMemo` / `useState` added to the existing `react` import.

Replace the two temporary `onOpen={() => {}}` props from Task 7 with:

```tsx
          {bottomTab === "decisions" && projectId && (
            <DecisionsPanel
              projectId={projectId}
              onOpen={(d) => setDetail({ kind: "decision", value: d })}
            />
          )}
          {bottomTab === "messages" && projectId && (
            <MessagesPanel
              projectId={projectId}
              onOpen={(m) => setDetail({ kind: "message", value: m })}
            />
          )}
```

And render the modal just before the closing `</div>` of `.right-col` (line 290):

```tsx
      {detail && (
        <ContinuityDetail
          row={detail}
          supersededBy={detail.kind === "decision" ? superseded[detail.value.id] : undefined}
          onClose={() => setDetail(null)}
        />
      )}
```

- [ ] **Step 3: Add the modal body styles**

Append to `src/theme.css`:

```css
.modal.continuity-detail { width: min(640px, 90vw); }
.continuity-prose {
  margin: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--panel-bg); font-family: var(--mono-font, monospace); font-size: 12px;
  color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 42vh; overflow-y: auto;
}
.continuity-supersede { margin-top: 10px; color: var(--text-dim); font-size: 12px; }
.continuity-response-head { margin-top: 14px !important; font-size: 13px !important; }
```

- [ ] **Step 4: Verify**

Run: `pnpm exec tsc --noEmit && pnpm test && pnpm build`
Expected: clean.

Then launch and click rows:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Confirm: clicking a decision row opens a modal with its full multi-paragraph content; clicking a message row shows the full body and, where one exists, the response; clicking the backdrop or Close dismisses it; a superseded decision shows the supersede line.

- [ ] **Step 5: Commit**

```bash
git add src/components/ContinuityPanels.tsx src/components/RightColumn.tsx src/theme.css
git commit -m "feat(continuity): detail modal with full recorded prose"
```

---

### Task 9: Documentation, version bump, changelog

**Files:**
- Modify: `CLAUDE.md` (a "where this lives" section)
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (version)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: nothing code-facing.

- [ ] **Step 1: Document the seam in `CLAUDE.md`**

Add a section after "Where the unified session directory lives":

```markdown
## Where the continuity panels live

Two READ-ONLY right-column tabs (Decisions, Messages) mirror continuity's running memory
for the active project. Conduit never writes that database — continuity owns every write.

- Rust: `continuity_read.rs` owns the path + read-only open (board presence/handoffs);
  `continuity_feed.rs` reuses both for the panels (decisions + messages).
  `feed_for_project` degrades to `available: false` on a missing DB, a drifted schema, or
  a continuity install that has never run — the tabs then do not render at all.
- Scoping is two allowlist arms, never a prefix or wildcard: `agent_label IN (this
  project's Conduit session ids)` — exact, because `pty.rs` sets `CONTINUITY_AGENT_ID` to
  the session id — plus `cwd_hash IN (sha256(git toplevel)[..16])` for sessions started
  outside Conduit in the same checkout. Do not canonicalize the toplevel: continuity
  hashes git's raw output, and `/tmp` vs `/private/tmp` would break the match.
- UI: `ContinuityPanels.tsx` (rows + detail modal), tabs in `RightColumn.tsx`, state in
  `store.ts` (`continuityFeed`), polled at 4 s by `hooks/useContinuityFeed.ts` —
  deliberately separate from `useBoard`'s 1.5 s poll and its `board_enabled` gate.
- Design: `docs/superpowers/specs/2026-08-14-continuity-panels-design.md`.
```

- [ ] **Step 2: Bump the version in all three files**

This ships a user-facing feature, so it is a MINOR bump: `0.20.0` → `0.21.0`.

- `package.json`: `"version": "0.21.0"`
- `src-tauri/Cargo.toml`: line 3, `version = "0.21.0"`
- `src-tauri/tauri.conf.json`: `"version": "0.21.0"`

Then update the lock file:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

Verify all three agree:

```bash
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
```

Expected: three lines, all `0.21.0`.

- [ ] **Step 3: Add the changelog entry**

Add at the top of `CHANGELOG.md`, above the current newest entry:

```markdown
## 0.21.0 — 2026-08-14

- **Added — Continuity panels in the right column.** When continuity is installed and has
  run, two new tabs sit beside Terminal and Git: **Decisions** lists the calls your
  sessions have committed to, and **Messages** lists what they have said to each other.
  Each row is one line; clicking it opens the full recorded prose. Both are read-only and
  scoped to the current project — including sessions you started in a plain terminal
  inside the same checkout. Without continuity, the tabs do not appear.
```

- [ ] **Step 4: Run the full pre-PR check**

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "docs(continuity): document the panels, bump to 0.21.0"
```

---

## Done when

- Decisions and Messages tabs appear in the right column's bottom strip only when continuity's database is reachable and has at least one session.
- Both lists show one-line rows scoped to the active project; clicking a row opens a modal with the full recorded prose.
- Rows from sessions in other checkouts never appear.
- Conduit never opens a write connection to continuity's database.
- The full pre-PR check in Task 9 Step 4 passes.
- Merged to `main` only with explicit human approval, via `git merge --no-ff feat/continuity-panels -m "Merge feat/continuity-panels into main"`.
