# Continuity panels — a running memory in the right column

**Status:** design
**Date:** 2026-08-14

## Why

Conduit already injects the continuity plugin into Claude sessions and reads its
SQLite store for the board (presence, card handoffs). Everything else continuity
records — the decisions sessions have committed to, the messages they have sent each
other — is written by agents, read by agents, and invisible to the human sitting in
front of the app.

Two new tabs in the right column's bottom row make that record visible: **Decisions**
and **Messages**. Each is a truncated list; clicking a row opens a modal with the full
prose that was recorded. When continuity is not installed or has never run, the tabs do
not exist.

This is a read-only window onto someone else's database. Conduit observes; continuity
owns every write.

## What already exists

| Piece | Where | What it does |
| --- | --- | --- |
| Plugin injection | `src-tauri/src/continuity.rs` | Bundles the continuity plugin and passes `--plugin-dir` to Claude sessions in board-enabled projects, gated on Node >= 22.5 |
| Identity | `src-tauri/src/pty.rs:413-414` | Sets `CONTINUITY_SESSION_ID` and `CONTINUITY_AGENT_ID` to the Conduit session id on spawn |
| Read adapter | `src-tauri/src/continuity_read.rs` | Opens `~/.continuity/continuity.db` read-only; reads presence by `agent_label` and pending handoffs by card scope |
| Command | `list_continuity` in `lib.rs` | Feeds `useBoard.ts` at a 1.5 s poll, gated on `board_enabled` |

Two facts from that integration decide most of this design:

- **`agent_sessions.agent_label` is the Conduit session id.** Because `pty.rs` sets
  `CONTINUITY_AGENT_ID`, joining continuity rows back to a Conduit project is an exact
  match on a set of ids, not a heuristic on paths or repo names.
- **`decisions` and `messages` are never deleted.** The local backend's `maybeSweep`
  marks sessions gone, releases expired claims, and prunes `file_activity` — nothing
  else. `messages.expires_at` gates *delivery*, not retention. Both tables are a durable
  transcript, which is what makes a "running memory" panel worth building.

## Scope

**In:** two read-only panels (Decisions, Messages), scoped to the active project,
hidden when continuity is unavailable, with a detail modal per row.

**Out:** writes of any kind (no responding to messages, no authoring decisions from the
UI); Sessions / Handoffs / Tasks panels; team-flavor (Cloudflare Worker) reads. Local
SQLite only.

## Architecture

### Why a second read seam, not a wider first one

`list_continuity` is polled every 1.5 s by `useBoard` and is gated on `board_enabled`.
The panels need neither: their gate is "the database is reachable", and a 4 s cadence is
plenty for a memory log. Widening `ContinuityView` would make the board's fast poll carry
decision and message rows it never renders, and would tie panel visibility to a board
setting the user explicitly does not want it tied to.

So: a new module, a new command, a new hook. It reuses `continuity_read`'s `db_path()`
and `open_ro()` — one place still owns "where the database is and how we open it".

Reading through continuity's MCP tools instead was considered and rejected. Every read
tool there is session-scoped: `checkin` registers a session row, so reading through the
public API would require Conduit to *be* an agent, polluting the very presence data the
feature exists to display.

### Rust — `src-tauri/src/continuity_feed.rs`

```rust
pub struct ContinuityFeed {
    pub available: bool,
    pub decisions: Vec<FeedDecision>,
    pub messages: Vec<FeedMessage>,
}

pub fn feed_for_project(
    session_ids: &[String],
    dirs: &[String],
    limit: usize,
) -> ContinuityFeed
```

`FeedDecision` carries `id`, `decision_key`, `content`, `decision_type`, `status`,
`supersedes`, `created_at`, and the author's `agent_label`. `FeedMessage` carries `id`,
`kind`, `body`, `requires_response`, `related_key`, `status`, `response`, `created_at`,
`expires_at`, and both endpoints' `agent_label`.

**Availability probe.** `available` is true when the file opens read-only *and* the
`agent_sessions` table exists *and* holds at least one row. A file that exists but has
never been written to is not "continuity working". Any failure at any step yields
`available: false` and empty vectors — never an `Err`, never a panic. This mirrors the
degradation contract `continuity_read` already keeps.

**Scope resolution, two arms.** Resolve the set of continuity session row ids belonging
to this project, then filter both tables by it:

1. `agent_label IN (session_ids)` — every session Conduit spawned for this project.
   Exact, courtesy of `CONTINUITY_AGENT_ID`.
2. `cwd_hash IN (sha256(toplevel)[..16] for each dir)` — sessions started from a plain
   terminal inside the same checkout or one of its worktrees. Continuity computes
   `cwd_hash` as `sha256(toplevel)` truncated to 16 hex chars, salted with
   `CONTINUITY_SESSION_ID` when set; the unsalted form is exactly what a CLI session
   produces. Conduit's own sessions are salted and so are never matched by this arm —
   arm 1 already has them.

`dirs` is the project root plus each session's `worktree_path`, resolved through
`git rev-parse --show-toplevel` and memoized (directories change rarely; the poll does
not need to re-shell every 4 s).

The queries are then:

```sql
SELECT ... FROM decisions d LEFT JOIN agent_sessions s ON s.id = d.author_agent_session_id
WHERE d.author_agent_session_id IN (<ids>)
ORDER BY d.created_at DESC LIMIT ?

SELECT ... FROM messages m
  LEFT JOIN agent_sessions f ON f.id = m.from_agent_session_id
  LEFT JOIN agent_sessions t ON t.id = m.to_agent_session_id
WHERE m.from_agent_session_id IN (<ids>) OR m.to_agent_session_id IN (<ids>)
ORDER BY m.created_at DESC LIMIT ?
```

Ids are bound as parameters, never interpolated — the same discipline that produced the
LIKE-escaping fix in `continuity_read`.

**New direct dependency:** `sha2`. It is already in `Cargo.lock` transitively, so this
adds no compilation the tree does not already do. The alternative — shelling out to
`shasum` once per directory per poll — is worse on every axis.

### IPC and state

One command:

```rust
#[tauri::command]
fn continuity_feed(store: State<Arc<Store>>, project_id: String)
    -> Result<continuity_feed::ContinuityFeed, String>
```

It reads the project's session ids and directories from the store itself, so the
frontend passes only the project id. Default `limit` is 100 rows per table.

Frontend state lives in `src/store.ts` as `continuityFeed: Record<string,
ContinuityFeed>` with a `setContinuityFeed` setter, matching the existing `continuity`
map. A new hook `src/hooks/useContinuityFeed.ts` polls every 4 s while the window is
visible and one of the two tabs is active, following `useBoard`'s
`document.visibilityState` guard.

### UI

Two tabs in `RightColumn.tsx`'s bottom strip, after Terminal and Git, rendered only when
`available`:

- **Decisions.** One row per decision: a status dot (active / superseded), the
  `decision_key` in monospace, the content truncated to a single line, relative time, and
  the author's label. Superseded rows are dimmed.
- **Messages.** One row per message: `from -> to` labels, a kind badge (message /
  collision / decision), the body truncated to a single line, and a marker when
  `requires_response` is set and the status is still `pending`.

Clicking a row opens a modal reusing the existing `.modal-backdrop` / `.modal` styles in
`theme.css`. The decision modal shows the full content, type, author, timestamp, and what
it supersedes. The message modal shows the full body and the response, when one exists.

Truncation, relative-time formatting, and supersede grouping are pure functions in
`src/continuityFeed.ts` so they can be tested without a DOM.

## Error handling

Every failure degrades to a hidden panel, never to an error surface:

| Failure | Behaviour |
| --- | --- |
| Database file absent | `available: false`; tabs hidden |
| Database present, no sessions ever | `available: false`; tabs hidden |
| Schema drift (missing table or column) | `available: false`; tabs hidden; the query error is swallowed |
| Database locked mid-write | The read-only connection reads the last committed state; a failed read returns the previous poll's data |
| Project has no sessions and no resolvable directories | `available: true`, both lists empty; panels show an empty state |

## Testing

**Rust** (`#[cfg(test)]` in `continuity_feed.rs`, following the fixture pattern already
in `continuity_read.rs`): a fixture database built from continuity's real DDL, then
assertions that decisions and messages authored by in-project sessions are returned;
that rows from an out-of-project session are excluded; that the `cwd_hash` arm picks up a
CLI session in the same checkout; that a missing database returns `available: false`
without panicking; and that a database with the table but no rows also returns
`available: false`.

**Frontend** (`src/continuityFeed.test.ts`): truncation at the boundary, relative-time
formatting, supersede grouping, and the empty-list case.

**Manual:** launch with `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev` in a
project with live continuity sessions; confirm the tabs appear, rows populate, the modal
renders full prose, and the tabs vanish when `CONTINUITY_DB_PATH` points somewhere empty.

## Risks

- **Schema coupling.** Conduit reads tables continuity owns and may change; continuity is
  explicitly alpha and says so. The mitigation is the availability probe plus swallowed
  query errors: a schema change hides the panels rather than breaking the app. The Rust
  fixture DDL is copied verbatim from continuity's `SQLITE_DDL`, as `continuity_read`
  already does, so a drift shows up as a test that no longer matches upstream.
- **Scope arm two is best-effort.** A CLI session that set `CONTINUITY_SESSION_ID`
  manually will not match by `cwd_hash`. Its decisions simply will not appear; nothing
  breaks.
- **Cross-project leakage** is the failure that would matter, and both arms are
  allowlists over ids Conduit itself owns or hashes it computes from its own directories.
  No wildcard, no prefix matching.
