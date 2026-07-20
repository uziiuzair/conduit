# Continuity C2 — Surface Handoffs & Presence on the Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Show continuity state on the board: a **↪ handoff** badge + incoming-handoff **context** on cards that have a pending card-scoped handoff, and a **presence dot** (live/idle/gone) for a card's claimant. Read-only — Conduit never writes continuity.

**Architecture:** A single read-only Rust module (`continuity_read.rs`, `rusqlite` bundled) opens `~/.continuity/continuity.db` and runs a fixed pair of `SELECT`s: handoffs filtered by `project_scope LIKE 'conduit:<projectId>:card:%'` (matched to cards by the scope suffix — no session-id mapping needed), and presence by `agent_label` (which C1 sets to the Conduit session id). A `list_continuity` command feeds a `ContinuityView` to the board UI, refreshed on the same event+poll cadence as the board.

**Tech Stack:** Rust (`rusqlite` with `bundled`), React/TS.

**Depends on:**
- C1 shipped, and C1's spawn env exports **both** `CONTINUITY_SESSION_ID=<sid>` (distinct rows) **and** `CONTINUITY_AGENT_ID=<sid>` (so `agent_sessions.agent_label` == the Conduit session id, which is how presence joins to a card's `claim.by`). ← confirm C1 does this.
- Agents scope card handoffs as `project_scope = "conduit:<projectId>:card:<cardId>"` (documented for agents in C1/personas).

**GATE (flagged in the spec):** this plan adds the `rusqlite` dependency. If the user vetoed it, do NOT start — switch to the fallback (agents mirror handoff state into the card file via `task_comment`; drop live presence) and re-plan.

**Spec:** `docs/superpowers/specs/2026-07-17-continuity-board-integration-design.md` (§Data flow, §Card anatomy).

---

## Task 1: `rusqlite` dep + read-only DB open

**Files:** `src-tauri/Cargo.toml`; create `src-tauri/src/continuity_read.rs` (`mod continuity_read;` in `lib.rs`).

- [ ] **Step 1** — Add to `Cargo.toml`:
```toml
rusqlite = { version = "0.32", features = ["bundled"] }
```
Run `cargo build --manifest-path src-tauri/Cargo.toml` once (compiles bundled SQLite). Confirm it builds.

- [ ] **Step 2** — In `continuity_read.rs`, the DB path + read-only open:
```rust
use std::path::PathBuf;
pub fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("CONTINUITY_DB_PATH") { return PathBuf::from(p); }
    dirs::home_dir().unwrap_or_default().join(".continuity").join("continuity.db")
}
/// Open the continuity DB read-only. Returns None if it doesn't exist yet (no sessions have
/// run) — the board simply shows no continuity state.
fn open_ro(path: &std::path::Path) -> Option<rusqlite::Connection> {
    if !path.exists() { return None; }
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ).ok()
}
```

- [ ] **Step 3** — Commit.
```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/continuity_read.rs src-tauri/src/lib.rs
git commit -m "feat(continuity): rusqlite read-only adapter scaffold"
```

---

## Task 2: `ContinuityView` queries (fixture-tested)

**Files:** `src-tauri/src/continuity_read.rs`

- [ ] **Step 1: Write the failing test** (a fixture DB built with the same DDL columns continuity uses):
```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Presence { pub session_id: String, pub status: String, pub last_seen_at: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardHandoff {
    pub card_id: String, pub id: String, pub from_label: Option<String>,
    pub context: String, pub state: Option<String>,
    pub suggested_next_actions: Option<String>, pub status: String, pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContinuityView { pub presence: Vec<Presence>, pub handoffs: Vec<CardHandoff> }

/// Query continuity for one project: presence of the given Conduit session ids (matched by
/// agent_label) and pending handoffs scoped to any card of the project.
pub fn view_for_project(project_id: &str, session_ids: &[String]) -> ContinuityView {
    let path = db_path();
    let Some(conn) = open_ro(&path) else { return ContinuityView::default() };
    let presence = read_presence(&conn, session_ids).unwrap_or_default();
    let handoffs = read_card_handoffs(&conn, project_id).unwrap_or_default();
    ContinuityView { presence, handoffs }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile_path, ) { /* see Step 2 */ }

    #[test]
    fn reads_presence_by_label_and_handoffs_by_scope() {
        // Build a temp DB with agent_sessions + handoffs, insert:
        //  - session agent_label="s2" status="active"
        //  - handoff project_scope="conduit:projX:card:c1" status="pending" context="did discovery"
        //  - handoff project_scope="conduit:OTHER:card:zz" status="pending"  (must be excluded)
        //  - handoff project_scope="conduit:projX:card:c1" status="completed" (excluded: not pending)
        // Point CONTINUITY_DB_PATH at it, then:
        let v = view_for_project("projX", &["s2".into(), "s9".into()]);
        assert_eq!(v.presence.iter().find(|p| p.session_id == "s2").unwrap().status, "active");
        assert_eq!(v.handoffs.len(), 1);
        assert_eq!(v.handoffs[0].card_id, "c1");
        assert_eq!(v.handoffs[0].context, "did discovery");
    }
}
```

- [ ] **Step 2: Write the fixture helper** — create a temp file, `Connection::open`, run the minimal DDL for the two tables (copy the exact column names from continuity's `schema.sqlite.ts:187-204` for `agent_sessions` and `:279-294` for `handoffs`), `INSERT` the rows above, set `std::env::set_var("CONTINUITY_DB_PATH", path)` for the test. Use a unique temp path per test (process id + atomic counter, no `Date`/rand).

- [ ] **Step 3: Implement the two readers:**
```rust
fn read_presence(conn: &rusqlite::Connection, session_ids: &[String]) -> rusqlite::Result<Vec<Presence>> {
    if session_ids.is_empty() { return Ok(vec![]); }
    // agent_label == the Conduit session id (C1 sets CONTINUITY_AGENT_ID=<sid>).
    let placeholders = session_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT agent_label, status, last_seen_at FROM agent_sessions \
         WHERE agent_label IN ({placeholders}) AND status <> 'gone'"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params = rusqlite::params_from_iter(session_ids.iter());
    let rows = stmt.query_map(params, |r| Ok(Presence {
        session_id: r.get(0)?, status: r.get(1)?, last_seen_at: r.get(2)?,
    }))?;
    rows.collect()
}

fn read_card_handoffs(conn: &rusqlite::Connection, project_id: &str) -> rusqlite::Result<Vec<CardHandoff>> {
    let like = format!("conduit:{project_id}:card:%");
    let sql = "SELECT h.id, h.project_scope, h.context, h.state, h.suggested_next_actions, \
               h.status, h.created_at, s.agent_label \
               FROM handoffs h LEFT JOIN agent_sessions s ON s.id = h.from_agent_session_id \
               WHERE h.project_scope LIKE ?1 AND h.status = 'pending'";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([like], |r| {
        let scope: String = r.get(1)?;
        // "conduit:<proj>:card:<cardId>" -> cardId is everything after the last ":card:"
        let card_id = scope.rsplit(":card:").next().unwrap_or("").to_string();
        Ok(CardHandoff {
            card_id, id: r.get(0)?, context: r.get(2)?, state: r.get(3)?,
            suggested_next_actions: r.get(4)?, status: r.get(5)?, created_at: r.get(6)?,
            from_label: r.get(7)?,
        })
    })?;
    rows.collect()
}
```

- [ ] **Step 4** — `cargo test --manifest-path src-tauri/Cargo.toml continuity_read::` → PASS. This module is the ONLY place that knows continuity's schema (spec §isolate the alpha coupling).

- [ ] **Step 5** — Commit.
```bash
git add src-tauri/src/continuity_read.rs
git commit -m "feat(continuity): read-only ContinuityView (presence by label, handoffs by card scope)"
```

---

## Task 3: `list_continuity` Tauri command

**Files:** `src-tauri/src/lib.rs`

- [ ] **Step 1** — Add a command that resolves the project's Conduit session ids from the store and returns the view:
```rust
#[tauri::command]
fn list_continuity(store: State<Arc<Store>>, project_id: String) -> Result<continuity_read::ContinuityView, String> {
    // Session ids of this project (the same ids used as claim.by + CONTINUITY_AGENT_ID).
    let session_ids: Vec<String> = store
        .list()
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.sessions.into_iter().map(|s| s.id).collect())
        .unwrap_or_default();
    Ok(continuity_read::view_for_project(&project_id, &session_ids))
}
```
Register it in `generate_handler!`.

- [ ] **Step 2** — `cargo build` → clean.
- [ ] **Step 3** — Commit.
```bash
git add src-tauri/src/lib.rs
git commit -m "feat(continuity): list_continuity command (presence + card handoffs for a project)"
```

---

## Task 4: Frontend — fetch + store the continuity view

**Files:** `src/store.ts`, `src/hooks/useBoard.ts` (or new `src/hooks/useContinuity.ts`)

- [ ] **Step 1** — Types in `store.ts`:
```ts
export interface Presence { sessionId: string; status: "active" | "idle" | "gone"; lastSeenAt: string }
export interface CardHandoff {
  cardId: string; id: string; fromLabel: string | null; context: string;
  state: string | null; suggestedNextActions: string | null; status: string; createdAt: string;
}
export interface ContinuityView { presence: Presence[]; handoffs: CardHandoff[] }
```
Store slice: `continuity: Record<string, ContinuityView>` + `setContinuity(projectId, view)`.

- [ ] **Step 2** — In `useBoard` (already polls while the board is open), on each reload ALSO `invoke<ContinuityView>("list_continuity", { projectId })` and `setContinuity(projectId, view)`. Same 1.5s cadence + `board-changed` event; also re-fetch when a `continuity.db` mtime poll changes (optional — the shared 1.5s poll is enough for v1). Tolerate errors (log; leave prior view).

- [ ] **Step 3** — `pnpm exec tsc --noEmit` → clean. Commit.
```bash
git add src/store.ts src/hooks/useBoard.ts
git commit -m "feat(continuity): frontend fetches + caches the continuity view"
```

---

## Task 5: Frontend — presence dot + handoff badge + light detail panel

**Files:** `src/components/BoardCard.tsx`, `src/components/BoardView.tsx`, create `src/components/BoardCardDetail.tsx`, `src/theme.css`

- [ ] **Step 1: Presence dot + handoff badge on the card.** In `BoardCard`, read the project's `ContinuityView` from the store. Presence: find `presence` whose `sessionId === card.claim?.by` → dot color (`active`→green, `idle`→amber, `gone`/none→gray). Handoff: if any `handoffs` has `cardId === card.id` → render a `↪` badge. Add classes `board-presence`, `board-presence.active/idle/gone`, `board-handoff-badge` to `theme.css` (palette-native: green `--green`, amber `--amber`, gray `--text-dim`; handoff badge uses `--chip-bg`/`--chip-text`).

- [ ] **Step 2: Open a detail panel on card click.** Add per-project UI state `openCardId: Record<projectId, string | null>` to the store (or local to `BoardView`). Clicking a card (not its drag handle) sets it; render `<BoardCardDetail>` as a right-side panel inside `.board-view` (flex row: columns + panel, panel ~360px, `overflow:auto`).

- [ ] **Step 3: `BoardCardDetail.tsx`** — read-only:
```tsx
// Shows: title, id, stage; claim + presence status; INCOMING HANDOFF (fromLabel, context,
// suggestedNextActions, state as plain <pre>) if a pending handoff exists for this card;
// comments; links; workflow history. Markdown rendered as plain text in v1.
// NO "Accept" button — accepting a handoff is an agent action (handoff_accept via its tools),
// and Conduit only READS continuity. A short hint tells the human to assign the card to a session.
```
Thread the card + the matching `CardHandoff` + presence in as props (from `BoardView`).

- [ ] **Step 4** — CSS for `.board-detail` (panel), handoff block, presence row — palette-native, matching the board's existing style. Ensure the columns area shrinks (`flex:1; min-width:0`) so the panel fits without horizontal page scroll.

- [ ] **Step 5** — `pnpm exec tsc --noEmit` + `pnpm build` → clean.

- [ ] **Step 6: Live verify** (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, two sessions): session A `handoff_create` scoped to card c1 → card shows `↪`; presence dot green while A is live; click the card → detail shows A's context + suggested next actions; kill A → dot goes gray. Confirm no horizontal overflow with the panel open.

- [ ] **Step 7** — Commit.
```bash
git add src/components/BoardCard.tsx src/components/BoardView.tsx src/components/BoardCardDetail.tsx src/store.ts src/theme.css
git commit -m "feat(continuity): presence dot, handoff badge, and read-only card detail panel"
```

---

## Task 6: Changelog + version

- [ ] **Step 1** — `cargo test` + `cargo clippy` + `pnpm exec tsc --noEmit` → green.
- [ ] **Step 2** — Bump the three Conduit version files (MINOR) + `cargo build` for `Cargo.lock`. CHANGELOG:
```
- **Added — handoffs & presence on the board.** Cards now show who's live on them and a ↪ badge
  when another session has handed the work off with context; click a card to read the incoming
  handoff (what was done, suggested next steps) in a detail panel.
```
- [ ] **Step 3** — Commit.
```bash
git add -A && git commit -m "release: continuity handoffs + presence on the board"
```

---

## Self-review (coverage)
- rusqlite + RO open → Task 1. Queries + fixture test (the only schema-coupled code) → Task 2. Command → Task 3. FE fetch/cache → Task 4. Presence dot + handoff badge + read-only detail panel → Task 5. Release → Task 6.
- **Read-only invariant:** no continuity write anywhere in Conduit; `handoff_accept` stays an agent tool action (Task 5 Step 3). Presence join depends on C1 exporting `CONTINUITY_AGENT_ID=<sid>` — verify before Task 2.
- **Alpha-coupling isolation:** `continuity_read.rs` is the sole place that names continuity's tables/columns; a schema break degrades the board to "no presence/handoffs," never a crash (queries return `.unwrap_or_default()`).
