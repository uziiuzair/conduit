//! Project-scoped blackboard (SPEC-1): an append-only, provenance-tagged log of tiny
//! structured records -- Mission, Result, Note -- never raw transcripts. Backs the
//! vertical (orchestrator<->worker) and horizontal (worker<->worker) sharing paths.
//!
//! High-churn by design, so it deliberately does NOT live in `state.json` (the durable
//! config file `Store` persists) -- it's a separate, bounded, in-memory ring per project.
//! Cross-project isolation is structural: every method takes a `project_id` explicitly and
//! there is no accessor that iterates records across all projects.
//!
//! Trust filtering (`can_read` + silo/clearance) is deliberately NOT done here -- callers
//! already resolve a `FleetSnapshot` (which sessions belong to the project) via
//! `Store::fleet_snapshot`, so `fleet_mcp.rs` applies `can_read` against that same snapshot
//! rather than this module re-deriving it (would require a `Store` dependency here for no
//! benefit).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

/// Bounded per-project ring size (records, not bytes). Caps unbounded growth from a
/// chatty/buggy worker without needing a time-based eviction policy.
const RING_CAPACITY: usize = 500;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BoardKind {
    Mission,
    Result,
    Note,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardRecord {
    pub id: String,
    pub project_id: String,
    pub author_session: String,
    pub kind: BoardKind,
    #[serde(default)]
    pub payload: Value,
    pub created_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The hard cap on a `Note`'s `text` (SPEC-F). Enforced at every write path -- both
/// `fleet_note`'s MCP arm (Phase 5) and the hook-channel `note` verb's ingestion point
/// (`hooks.rs`) -- since a Tier-2 worker's hook body is attacker-shaped-if-forged.
pub const NOTE_MAX_BYTES: usize = 512;

/// Truncate `s` to at most `max_bytes` bytes, cutting at the nearest UTF-8 char
/// boundary at or before that point (never splitting a multi-byte character, and never
/// panicking on a boundary that doesn't land cleanly).
pub fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

impl BoardRecord {
    fn new(project_id: &str, author_session: &str, kind: BoardKind, payload: Value) -> Self {
        BoardRecord {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            author_session: author_session.to_string(),
            kind,
            payload,
            created_at: now_ms(),
        }
    }

    /// The mandate a spawned worker was given: `{agent, modelTier, objective, outputShape,
    /// boundaries, status}` (SPEC-C). Powers awareness (`fleet_roster`, Phase 7).
    pub fn mission(author_session: &str, project_id: &str, payload: Value) -> Self {
        Self::new(project_id, author_session, BoardKind::Mission, payload)
    }

    /// A worker's structured hand-back: `{status, summary, artifactPaths, tokens}`
    /// (SPEC-C) -- replaces the lossy `fleet_peek` scrape as the primary report-out.
    pub fn result(author_session: &str, project_id: &str, payload: Value) -> Self {
        Self::new(project_id, author_session, BoardKind::Result, payload)
    }

    /// A bare-minimum peer note on a named channel (SPEC-F): `{channel, text}`, `text`
    /// capped at `NOTE_MAX_BYTES` by the caller (via `truncate_utf8`) before this is
    /// constructed -- this constructor does not re-check the cap itself.
    pub fn note(author_session: &str, project_id: &str, channel: &str, text: &str) -> Self {
        Self::new(
            project_id,
            author_session,
            BoardKind::Note,
            json!({ "channel": channel, "text": text }),
        )
    }
}

/// The project-scoped blackboard itself. Cross-project isolation is structural: every
/// method takes a `project_id` explicitly and there is no global accessor.
#[derive(Default)]
pub struct BoardState {
    boards: Mutex<HashMap<String, Vec<BoardRecord>>>,
}

impl BoardState {
    /// Append one record to its own project's ring, evicting the oldest entries first
    /// once the ring exceeds `RING_CAPACITY`.
    pub fn append(&self, record: BoardRecord) {
        let mut boards = self.boards.lock().unwrap_or_else(|e| e.into_inner());
        let ring = boards.entry(record.project_id.clone()).or_default();
        ring.push(record);
        if ring.len() > RING_CAPACITY {
            let excess = ring.len() - RING_CAPACITY;
            ring.drain(0..excess);
        }
    }

    /// Every record for one project, oldest first, optionally filtered to one kind. NOT
    /// trust-filtered -- see the module doc comment; callers apply `can_read` themselves.
    pub fn query(&self, project_id: &str, kind: Option<BoardKind>) -> Vec<BoardRecord> {
        self.boards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(project_id)
            .map(|ring| {
                ring.iter()
                    .filter(|r| kind.is_none_or(|k| r.kind == k))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Note records on one channel within one project, oldest first, optionally only
    /// those strictly after `since` (a record id). Backs `fleet_inbox` (SPEC-F). NOT
    /// trust-filtered, same rule as `query` -- the caller applies `can_read`.
    ///
    /// A `since` id that can't be found (e.g. it aged out of the per-project ring after
    /// enough traffic) returns empty, not everything -- a caller polling incrementally
    /// has no way to tell "nothing new" apart from "your bookmark is stale" otherwise,
    /// and would silently re-process a channel's entire history at that point.
    pub fn query_notes(
        &self,
        project_id: &str,
        channel: &str,
        since: Option<&str>,
    ) -> Vec<BoardRecord> {
        let mut notes: Vec<BoardRecord> = self
            .query(project_id, Some(BoardKind::Note))
            .into_iter()
            .filter(|r| r.payload.get("channel").and_then(|c| c.as_str()) == Some(channel))
            .collect();
        if let Some(since_id) = since {
            notes = match notes.iter().position(|r| r.id == since_id) {
                Some(pos) => notes.split_off(pos + 1),
                None => Vec::new(),
            };
        }
        notes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_and_query_round_trip() {
        let board = BoardState::default();
        board.append(BoardRecord::mission(
            "w1",
            "proj-a",
            json!({"objective": "do X"}),
        ));
        board.append(BoardRecord::result(
            "w1",
            "proj-a",
            json!({"status": "success"}),
        ));

        let all = board.query("proj-a", None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].kind, BoardKind::Mission);
        assert_eq!(all[1].kind, BoardKind::Result);

        let missions = board.query("proj-a", Some(BoardKind::Mission));
        assert_eq!(missions.len(), 1);
        assert_eq!(missions[0].payload["objective"], "do X");
    }

    #[test]
    fn query_never_crosses_projects() {
        let board = BoardState::default();
        board.append(BoardRecord::result(
            "w-a",
            "proj-a",
            json!({"status": "success"}),
        ));
        board.append(BoardRecord::result(
            "w-b",
            "proj-b",
            json!({"status": "failure"}),
        ));

        let a = board.query("proj-a", None);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].author_session, "w-a");

        let b = board.query("proj-b", None);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].author_session, "w-b");

        // No global/all-projects accessor exists on BoardState at all -- the only way to
        // read anything is to name a project_id, so there is structurally no query that
        // could return both proj-a's and proj-b's records together.
        assert!(board.query("nonexistent-project", None).is_empty());
    }

    #[test]
    fn ring_evicts_oldest_once_over_capacity() {
        let board = BoardState::default();
        for i in 0..(RING_CAPACITY + 10) {
            board.append(BoardRecord::note(
                "w1",
                "proj-a",
                "chat",
                &format!("note {i}"),
            ));
        }
        let all = board.query("proj-a", None);
        assert_eq!(all.len(), RING_CAPACITY);
        // The oldest 10 were evicted; the ring keeps the most recent RING_CAPACITY entries.
        assert_eq!(all[0].payload["text"], "note 10");
        assert_eq!(
            all[RING_CAPACITY - 1].payload["text"],
            format!("note {}", RING_CAPACITY + 9)
        );
    }

    #[test]
    fn query_notes_filters_by_channel() {
        let board = BoardState::default();
        board.append(BoardRecord::note("w1", "proj-a", "general", "hi"));
        board.append(BoardRecord::note("w2", "proj-a", "eng", "yo"));
        let general = board.query_notes("proj-a", "general", None);
        assert_eq!(general.len(), 1);
        assert_eq!(general[0].author_session, "w1");
    }

    #[test]
    fn query_notes_since_excludes_up_to_and_including_the_given_id() {
        let board = BoardState::default();
        board.append(BoardRecord::note("w1", "proj-a", "general", "first"));
        let mid_id = board.query_notes("proj-a", "general", None)[0].id.clone();
        board.append(BoardRecord::note("w1", "proj-a", "general", "second"));
        board.append(BoardRecord::note("w1", "proj-a", "general", "third"));

        let after_mid = board.query_notes("proj-a", "general", Some(&mid_id));
        assert_eq!(after_mid.len(), 2);
        assert_eq!(after_mid[0].payload["text"], "second");
        assert_eq!(after_mid[1].payload["text"], "third");
    }

    #[test]
    fn query_notes_with_an_unresolvable_since_returns_empty_not_everything() {
        // Regression test for an audit finding: a `since` id that doesn't match any
        // current record (e.g. it aged out of the ring) must not silently fall back to
        // "return the whole channel" -- a caller polling incrementally can't otherwise
        // tell "nothing new" apart from "your bookmark expired".
        let board = BoardState::default();
        board.append(BoardRecord::note("w1", "proj-a", "general", "first"));
        board.append(BoardRecord::note("w1", "proj-a", "general", "second"));

        let result = board.query_notes("proj-a", "general", Some("never-existed"));
        assert!(result.is_empty());
    }

    #[test]
    fn note_payload_shape() {
        let r = BoardRecord::note("w1", "proj-a", "project", "hi there");
        assert_eq!(r.kind, BoardKind::Note);
        assert_eq!(r.payload["channel"], "project");
        assert_eq!(r.payload["text"], "hi there");
    }

    #[test]
    fn truncate_utf8_leaves_short_strings_untouched() {
        assert_eq!(truncate_utf8("hello", 512), "hello");
    }

    #[test]
    fn truncate_utf8_cuts_at_the_byte_limit() {
        let s = "a".repeat(600);
        let t = truncate_utf8(&s, 512);
        assert_eq!(t.len(), 512);
    }

    #[test]
    fn truncate_utf8_never_splits_a_multibyte_char() {
        // Each '€' is 3 bytes; a 512-byte cut would otherwise land mid-character.
        let s = "€".repeat(200); // 600 bytes
        let t = truncate_utf8(&s, 512);
        assert!(t.len() <= 512);
        assert!(std::str::from_utf8(t.as_bytes()).is_ok());
        assert!(
            t.chars().all(|c| c == '€'),
            "no partial character in the output"
        );
    }

    #[test]
    fn record_serializes_camel_case() {
        let r = BoardRecord::mission("w1", "proj-a", json!({"objective": "x"}));
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("authorSession").is_some(), "got {v}");
        assert!(v.get("projectId").is_some(), "got {v}");
        assert!(v.get("createdAt").is_some(), "got {v}");
    }
}
