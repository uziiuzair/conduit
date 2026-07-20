# Project Task Board — Plan A: Board Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working, git-shared Kanban task board per Conduit project — humans drag/add/edit cards in a full-screen board view; live CLI sessions self-claim, move, and comment on cards via new `task_*` MCP tools.

**Architecture:** A new `tasks.rs` module owns a `TaskBoard` that reads/writes one YAML file per card under `<repo>/.conduit/board/`, ordered by a fractional index so reorders are single-file and git-merge-clean. Human actions reach it through Tauri commands; AI actions through `task_*` tools grafted onto the existing `fleet_mcp.rs` server. The frontend renders a board overlay over the terminal grid (terminals stay mounted, hidden via CSS) and refreshes on a `board-changed` event plus a lightweight mtime poll.

**Tech Stack:** Rust (Tauri v2, serde_yaml/serde_json, uuid), React 19 + TypeScript + Zustand, native HTML5 drag-and-drop (no new dependency).

**Scope of Plan A:** Flexible board only (columns + cards + claim/move/comment). The optional per-card **stage-gate workflow**, role personas, and OKF knowledge bundle are **Plan B** (`2026-07-16-project-task-board-b-stagegate.md`). Every card in Plan A has `workflow: null`.

**Spec:** `docs/superpowers/specs/2026-07-16-project-task-board-design.md`.

---

## File Structure

**Rust (`src-tauri/src/`):**
- Create `tasks/mod.rs` — `TaskBoard`, `Card`, `Column`, `Claim`, load/save, claim CAS, move. One responsibility: durable board state + file IO.
- Create `tasks/frac.rs` — `key_between()` fractional index. Pure, standalone, heavily tested.
- Modify `Cargo.toml` — add `serde_yaml` (already have serde/serde_json/uuid).
- Modify `lib.rs` — register `tasks::TaskBoard`, the `board-changed` emit, and ~7 Tauri commands; pass `tasks` into `fleet_mcp::start`; widen `gets_fleet_mcp`.
- Modify `fleet_mcp.rs` — `Ctx.tasks`, `task_*` specs + dispatch arms, `WORKER_ALLOWED`.

**Frontend (`src/`):**
- Create `components/BoardView.tsx`, `components/BoardColumn.tsx`, `components/BoardCard.tsx`.
- Create `hooks/useBoard.ts` — load + event + poll refresh.
- Modify `store.ts` — a board slice (`centerMode`, `boardsByProject`, actions).
- Modify `components/WorkspaceCenter.tsx` — mount `BoardView` overlay gated by `centerMode`.
- Modify `App.tsx` — ⇧⌘B menu handler; listen for `board-changed`.

**Data (written at runtime into each project repo):**
- `<repo>/.conduit/board/columns.yaml`
- `<repo>/.conduit/board/cards/<id>.yaml`
- `<repo>/.conduit/board/.claims/<id>.json` (gitignored; volatile lease)
- `<repo>/.conduit/.gitignore` (ignores `board/.claims/`)

---

## Task 1: Fractional index (`frac.rs`)

**Files:**
- Create: `src-tauri/src/tasks/frac.rs`
- Test: same file, `#[cfg(test)]`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/tasks/frac.rs`:

```rust
//! Fractional index keys: given the keys of the two neighbours a card is being placed
//! between, produce a new key that sorts strictly between them. Moving a card rewrites
//! only its own file, so concurrent reorders by different teammates merge cleanly.
//!
//! Keys are byte strings over the contiguous ASCII range 0x30..=0x7a ('0'..='z'); plain
//! `<` / lexicographic ordering on the strings is the sort order. An empty string on the
//! left means "before the first card", on the right means "after the last card".

const LO: u8 = 0x30; // '0' — smallest allowed digit
const HI: u8 = 0x7a; // 'z' — largest allowed digit

/// Return a key `c` such that `a < c < b`, where `""` is treated as unbounded on that side.
/// Precondition: `a < b` (callers order neighbours before calling).
pub fn key_between(a: &str, b: &str) -> String {
    let av = a.as_bytes();
    let bv = b.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0usize;
    loop {
        let x = *av.get(i).unwrap_or(&LO);
        // `HI + 1` is an arithmetic sentinel for "b is unbounded here"; never emitted.
        let y = *bv.get(i).unwrap_or(&(HI + 1));
        if x == y {
            out.push(x);
            i += 1;
            continue;
        }
        let mid = x + (y - x) / 2;
        if mid > x {
            out.push(mid);
            return String::from_utf8(out).unwrap();
        }
        // Neighbours are adjacent at this position (y == x + 1): keep x and descend, with
        // the upper bound now effectively unbounded.
        out.push(x);
        i += 1;
        let a_rest = if i < av.len() {
            std::str::from_utf8(&av[i..]).unwrap()
        } else {
            ""
        };
        out.extend_from_slice(key_between(a_rest, "").as_bytes());
        return String::from_utf8(out).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ordered(a: &str, c: &str, b: &str) -> bool {
        (a.is_empty() || a < c) && (b.is_empty() || c < b)
    }

    #[test]
    fn between_two_empties_is_nonempty() {
        let k = key_between("", "");
        assert!(!k.is_empty());
    }

    #[test]
    fn first_and_last_bounds() {
        let first = key_between("", "U");
        assert!(first < "U".to_string());
        let last = key_between("U", "");
        assert!("U".to_string() < last);
    }

    #[test]
    fn strictly_between_adjacent_keys() {
        let a = "U";
        let b = "V";
        let c = key_between(a, b);
        assert!(ordered(a, &c, b), "expected {a} < {c} < {b}");
    }

    #[test]
    fn repeated_inserts_at_head_stay_ordered() {
        // Insert 20 times always before the current head; each must sort before the last.
        let mut head = key_between("", "");
        for _ in 0..20 {
            let next = key_between("", &head);
            assert!(next < head, "{next} !< {head}");
            head = next;
        }
    }

    #[test]
    fn repeated_inserts_in_the_same_gap_stay_ordered() {
        let a = "U".to_string();
        let b = "V".to_string();
        let mut lo = a.clone();
        for _ in 0..20 {
            let mid = key_between(&lo, &b);
            assert!(ordered(&lo, &mid, &b), "{lo} < {mid} < {b} failed");
            lo = mid;
        }
    }
}
```

- [ ] **Step 2: Wire the module and run the tests to verify they fail**

Add to `src-tauri/src/tasks/mod.rs` (create it if starting here): `pub mod frac;`. Add `mod tasks;` to `lib.rs` near the other `mod` declarations.

Run: `cargo test --manifest-path src-tauri/Cargo.toml frac::`
Expected: compile error (module not yet declared) or FAIL — this confirms the harness sees the tests. If it compiles and fails on assertions, that's also acceptable "red".

- [ ] **Step 3: (implementation already written in Step 1) run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml frac::`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/tasks/frac.rs src-tauri/src/tasks/mod.rs src-tauri/src/lib.rs
git commit -m "feat(board): fractional index keys for merge-clean card ordering"
```

---

## Task 2: Board data types + serde round-trip

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`
- Modify: `src-tauri/Cargo.toml` (add `serde_yaml`)

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml` under `[dependencies]`, add:

```toml
serde_yaml = "0.9"
```

Run `cargo build --manifest-path src-tauri/Cargo.toml` once so `Cargo.lock` updates.

- [ ] **Step 2: Write the failing test**

In `src-tauri/src/tasks/mod.rs`:

```rust
pub mod frac;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A board column (coordination status). Order in `Columns.columns` is display order.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub name: String,
}

/// The volatile part of a claim — kept out of the committed card (see `.claims/` sidecar).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub by: String,        // session id, or "human"
    pub at: u64,
    pub lease_until: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub by: String,
    pub at: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardLinks {
    #[serde(default)]
    pub work_item: Option<String>,
    #[serde(default)]
    pub pr: String,
    #[serde(default)]
    pub branch: String,
}

/// One card = one file at `.conduit/board/cards/<id>.yaml`. `workflow` is always `null` in
/// Plan A; Plan B fills it with the stage-gate overlay.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub column: String,
    pub order: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub created_by: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub workflow: Option<Value>,
    #[serde(default)]
    pub links: CardLinks,
    #[serde(default)]
    pub comments: Vec<Comment>,
    // Populated from the `.claims/` sidecar at load time; skipped on card serialization.
    #[serde(skip)]
    pub claim: Option<Claim>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_yaml_round_trip_is_camel_case_and_lossless() {
        let card = Card {
            id: "c1".into(),
            title: "Do X".into(),
            body: "details".into(),
            column: "todo".into(),
            order: "U".into(),
            labels: vec!["web".into()],
            created_by: "human".into(),
            created_at: 1,
            updated_at: 2,
            workflow: None,
            links: CardLinks::default(),
            comments: vec![],
            claim: None,
        };
        let yaml = serde_yaml::to_string(&card).unwrap();
        assert!(yaml.contains("createdBy:"), "got:\n{yaml}");
        assert!(!yaml.contains("claim:"), "volatile claim must not serialize");
        let back: Card = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(card, back);
    }
}
```

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::card_yaml_round_trip`
Expected: PASS (types + test are in the same step; the "red" here is a compile failure if `serde_yaml` is missing — Step 1 fixes that).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/tasks/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(board): card/column/claim data types with camelCase yaml round-trip"
```

---

## Task 3: `TaskBoard` — load & default columns

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/tasks/mod.rs` (above `#[cfg(test)]`, add imports at top: `use std::collections::HashMap; use std::fs; use std::path::{Path, PathBuf}; use std::sync::Mutex; use std::time::{SystemTime, UNIX_EPOCH};`):

```rust
pub const DEFAULT_COLUMNS: &[(&str, &str)] = &[
    ("backlog", "Backlog"),
    ("todo", "Todo"),
    ("in_progress", "In Progress"),
    ("review", "Review"),
    ("done", "Done"),
];

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Columns {
    pub columns: Vec<Column>,
}

impl Default for Columns {
    fn default() -> Self {
        Columns {
            columns: DEFAULT_COLUMNS
                .iter()
                .map(|(id, name)| Column { id: (*id).into(), name: (*name).into() })
                .collect(),
        }
    }
}

/// A snapshot handed to the UI / MCP: columns in display order + cards sorted by `order`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    pub columns: Vec<Column>,
    pub cards: Vec<Card>,
}

/// Durable, file-backed Kanban board for one project. All mutating methods take a project
/// root and serialize their writes through the board's `Mutex`, so concurrent MCP calls and
/// Tauri commands never interleave a read-modify-write.
#[derive(Default)]
pub struct TaskBoard {
    lock: Mutex<()>,
}

impl TaskBoard {
    fn board_dir(project_root: &str) -> PathBuf {
        Path::new(project_root).join(".conduit").join("board")
    }
    fn cards_dir(project_root: &str) -> PathBuf {
        Self::board_dir(project_root).join("cards")
    }
    fn claims_dir(project_root: &str) -> PathBuf {
        Self::board_dir(project_root).join(".claims")
    }
    fn columns_path(project_root: &str) -> PathBuf {
        Self::board_dir(project_root).join("columns.yaml")
    }

    /// Read columns from disk, falling back to `Columns::default()` when the file is absent.
    fn read_columns(project_root: &str) -> Columns {
        match fs::read_to_string(Self::columns_path(project_root)) {
            Ok(s) => serde_yaml::from_str(&s).unwrap_or_default(),
            Err(_) => Columns::default(),
        }
    }

    /// Full snapshot: every card (claims merged from the sidecar) sorted by `order`, plus
    /// columns in display order. Never returns cards from another project — the caller passes
    /// exactly one project root.
    pub fn snapshot(&self, project_root: &str) -> BoardSnapshot {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let columns = Self::read_columns(project_root).columns;
        let mut cards = Vec::new();
        if let Ok(entries) = fs::read_dir(Self::cards_dir(project_root)) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
                    continue;
                }
                if let Ok(s) = fs::read_to_string(&path) {
                    if let Ok(mut card) = serde_yaml::from_str::<Card>(&s) {
                        card.claim = Self::read_claim(project_root, &card.id);
                        cards.push(card);
                    }
                }
            }
        }
        cards.sort_by(|a, b| a.order.cmp(&b.order));
        BoardSnapshot { columns, cards }
    }

    fn read_claim(project_root: &str, card_id: &str) -> Option<Claim> {
        let path = Self::claims_dir(project_root).join(format!("{card_id}.json"));
        let s = fs::read_to_string(path).ok()?;
        serde_json::from_str(&s).ok()
    }
}
```

Add the test in the `tests` module:

```rust
    fn tmp_root() -> String {
        // A unique temp dir per test; no Date/rand available, so use a static counter.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("conduit-board-test-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn snapshot_of_empty_project_returns_default_columns_no_cards() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let snap = board.snapshot(&root);
        assert_eq!(snap.columns.len(), 5);
        assert_eq!(snap.columns[0].id, "backlog");
        assert!(snap.cards.is_empty());
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::snapshot_of_empty_project`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): TaskBoard snapshot with default columns and claim merge"
```

---

## Task 4: `add_card` (atomic write + fractional append)

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

Add methods to `impl TaskBoard`:

```rust
    /// Atomic write: serialize to a sibling `.tmp` then rename over the target, so a reader
    /// never sees a half-written file (mirrors `store.rs`'s state.json write).
    fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    fn card_path(project_root: &str, id: &str) -> PathBuf {
        Self::cards_dir(project_root).join(format!("{id}.yaml"))
    }

    fn write_card(project_root: &str, card: &Card) -> Result<(), String> {
        let yaml = serde_yaml::to_string(card).map_err(|e| e.to_string())?;
        Self::write_atomic(&Self::card_path(project_root, &card.id), yaml.as_bytes())
    }

    /// The largest existing `order` in a column, so a new card appends after it.
    fn max_order_in_column(cards: &[Card], column: &str) -> String {
        cards
            .iter()
            .filter(|c| c.column == column)
            .map(|c| c.order.clone())
            .max()
            .unwrap_or_default()
    }

    /// Create a card at the end of `column`. `created_by` is a session id or `"human"`.
    pub fn add_card(
        &self,
        project_root: &str,
        title: &str,
        body: &str,
        column: &str,
        created_by: &str,
    ) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let existing = {
            let mut v = Vec::new();
            if let Ok(entries) = fs::read_dir(Self::cards_dir(project_root)) {
                for e in entries.flatten() {
                    if let Ok(s) = fs::read_to_string(e.path()) {
                        if let Ok(c) = serde_yaml::from_str::<Card>(&s) {
                            v.push(c);
                        }
                    }
                }
            }
            v
        };
        let prev = Self::max_order_in_column(&existing, column);
        let now = now_ms();
        let card = Card {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_string(),
            body: body.to_string(),
            column: column.to_string(),
            order: frac::key_between(&prev, ""),
            labels: vec![],
            created_by: created_by.to_string(),
            created_at: now,
            updated_at: now,
            workflow: None,
            links: CardLinks::default(),
            comments: vec![],
            claim: None,
        };
        Self::write_card(project_root, &card)?;
        Ok(card)
    }
```

Test:

```rust
    #[test]
    fn add_card_persists_and_orders_by_insertion() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let a = board.add_card(&root, "first", "", "todo", "human").unwrap();
        let b = board.add_card(&root, "second", "", "todo", "human").unwrap();
        assert!(a.order < b.order, "second card must sort after first");
        let snap = board.snapshot(&root);
        let todo: Vec<_> = snap.cards.iter().filter(|c| c.column == "todo").collect();
        assert_eq!(todo.len(), 2);
        assert_eq!(todo[0].title, "first");
        assert_eq!(todo[1].title, "second");
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::add_card_persists`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): add_card with atomic write and fractional append"
```

---

## Task 5: `move_card` (column + reorder between neighbours)

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

Add to `impl TaskBoard`:

```rust
    fn load_card(project_root: &str, id: &str) -> Result<Card, String> {
        let s = fs::read_to_string(Self::card_path(project_root, id))
            .map_err(|_| format!("card not found: {id}"))?;
        serde_yaml::from_str(&s).map_err(|e| e.to_string())
    }

    /// Move `id` into `column`, positioned between the cards identified by `before`/`after`
    /// (either may be `None` for an end). Rewrites only this card's file — its new `order`
    /// is the fractional key between its new neighbours.
    pub fn move_card(
        &self,
        project_root: &str,
        id: &str,
        column: &str,
        after: Option<&str>,
        before: Option<&str>,
    ) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let snap_cards = {
            let mut v = Vec::new();
            if let Ok(entries) = fs::read_dir(Self::cards_dir(project_root)) {
                for e in entries.flatten() {
                    if let Ok(s) = fs::read_to_string(e.path()) {
                        if let Ok(c) = serde_yaml::from_str::<Card>(&s) {
                            v.push(c);
                        }
                    }
                }
            }
            v
        };
        let order_of = |cid: Option<&str>| -> String {
            cid.and_then(|c| snap_cards.iter().find(|k| k.id == c))
                .map(|k| k.order.clone())
                .unwrap_or_default()
        };
        let lo = order_of(after);
        let hi = order_of(before);
        let mut card = Self::load_card(project_root, id)?;
        card.column = column.to_string();
        card.order = frac::key_between(&lo, &hi);
        card.updated_at = now_ms();
        Self::write_card(project_root, &card)?;
        Ok(card)
    }
```

Test:

```rust
    #[test]
    fn move_card_changes_column_and_reorders() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let a = board.add_card(&root, "a", "", "todo", "human").unwrap();
        let b = board.add_card(&root, "b", "", "todo", "human").unwrap();
        // Move b to the front of "review".
        let moved = board.move_card(&root, &b.id, "review", None, None).unwrap();
        assert_eq!(moved.column, "review");
        // Move a to sit after b in review: a should now sort after b.
        let a2 = board.move_card(&root, &a.id, "review", Some(&b.id), None).unwrap();
        assert!(moved.order < a2.order);
        let snap = board.snapshot(&root);
        let review: Vec<_> = snap.cards.iter().filter(|c| c.column == "review").collect();
        assert_eq!(review.len(), 2);
        assert_eq!(review[0].id, b.id);
        assert_eq!(review[1].id, a.id);
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::move_card_changes_column`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): move_card reorders via fractional key between neighbours"
```

---

## Task 6: Claim CAS + release + lease (sidecar)

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

Add to `impl TaskBoard`:

```rust
    /// Default lease length. A claim older than this (without a heartbeat) is treated as
    /// abandoned and can be re-claimed by another session.
    pub const LEASE_MS: u64 = 5 * 60 * 1000;

    fn claim_path(project_root: &str, card_id: &str) -> PathBuf {
        Self::claims_dir(project_root).join(format!("{card_id}.json"))
    }

    fn write_claim(project_root: &str, card_id: &str, claim: &Claim) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(claim).map_err(|e| e.to_string())?;
        Self::write_atomic(&Self::claim_path(project_root, card_id), &bytes)
    }

    /// Compare-and-set claim. Succeeds when the card is unclaimed, the current claim's lease
    /// has expired, or the caller already holds it (re-claim = heartbeat). Returns Err with a
    /// stable machine-readable reason otherwise. `live` decides whether an existing claim's
    /// holder is still a running session (dead holders are treated as expired).
    pub fn claim_card(
        &self,
        project_root: &str,
        id: &str,
        by: &str,
        live: &dyn Fn(&str) -> bool,
    ) -> Result<Claim, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        // Card must exist.
        Self::load_card(project_root, id)?;
        let now = now_ms();
        if let Some(existing) = Self::read_claim(project_root, id) {
            let expired = now >= existing.lease_until || !live(&existing.by);
            if existing.by != by && !expired {
                return Err(format!("claimed-by:{}", existing.by));
            }
        }
        let claim = Claim { by: by.to_string(), at: now, lease_until: now + Self::LEASE_MS };
        Self::write_claim(project_root, id, &claim)?;
        Ok(claim)
    }

    /// Drop the caller's own claim. No-op if the card is unclaimed; Err if another session
    /// holds it (you can't release someone else's claim).
    pub fn release_card(&self, project_root: &str, id: &str, by: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        match Self::read_claim(project_root, id) {
            None => Ok(()),
            Some(c) if c.by == by => {
                let _ = fs::remove_file(Self::claim_path(project_root, id));
                Ok(())
            }
            Some(c) => Err(format!("claimed-by:{}", c.by)),
        }
    }
```

Test (note the `live` closure — `|_| true` means "all holders alive"):

```rust
    #[test]
    fn claim_is_exclusive_until_released_or_expired() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let a = board.add_card(&root, "a", "", "todo", "human").unwrap();
        let alive = |_: &str| true;

        // s2 claims; s4 is refused.
        board.claim_card(&root, &a.id, "s2", &alive).unwrap();
        let err = board.claim_card(&root, &a.id, "s4", &alive).unwrap_err();
        assert_eq!(err, "claimed-by:s2");

        // The claim shows up in the snapshot.
        let snap = board.snapshot(&root);
        assert_eq!(snap.cards[0].claim.as_ref().unwrap().by, "s2");

        // s2 releases; s4 can now claim.
        board.release_card(&root, &a.id, "s2").unwrap();
        board.claim_card(&root, &a.id, "s4", &alive).unwrap();

        // A dead holder is re-claimable even without release.
        let dead = |who: &str| who != "s4";
        board.claim_card(&root, &a.id, "s7", &dead).unwrap();
        assert_eq!(board.snapshot(&root).cards[0].claim.unwrap().by, "s7");
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::claim_is_exclusive`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): claim CAS with lease + liveness, release, sidecar storage"
```

---

## Task 7: `comment_card` + `edit_card` + `delete_card`

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

Add to `impl TaskBoard` (reuse `truncate_utf8` from `board.rs` — import `use crate::board::truncate_utf8;` at the top of `tasks/mod.rs`):

```rust
    pub const COMMENT_MAX_BYTES: usize = 512;

    pub fn comment_card(&self, project_root: &str, id: &str, by: &str, text: &str) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut card = Self::load_card(project_root, id)?;
        card.comments.push(Comment {
            by: by.to_string(),
            at: now_ms(),
            text: truncate_utf8(text, Self::COMMENT_MAX_BYTES).to_string(),
        });
        card.updated_at = now_ms();
        Self::write_card(project_root, &card)?;
        Ok(card)
    }

    /// Edit human-owned fields. `None` leaves a field unchanged.
    pub fn edit_card(
        &self,
        project_root: &str,
        id: &str,
        title: Option<&str>,
        body: Option<&str>,
        labels: Option<Vec<String>>,
    ) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut card = Self::load_card(project_root, id)?;
        if let Some(t) = title { card.title = t.to_string(); }
        if let Some(b) = body { card.body = b.to_string(); }
        if let Some(l) = labels { card.labels = l; }
        card.updated_at = now_ms();
        Self::write_card(project_root, &card)?;
        Ok(card)
    }

    pub fn delete_card(&self, project_root: &str, id: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = fs::remove_file(Self::card_path(project_root, id));
        let _ = fs::remove_file(Self::claim_path(project_root, id));
        Ok(())
    }
```

Test:

```rust
    #[test]
    fn comment_edit_delete_round_trip() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let a = board.add_card(&root, "a", "body", "todo", "human").unwrap();

        let c = board.comment_card(&root, &a.id, "s2", "on it").unwrap();
        assert_eq!(c.comments.len(), 1);
        assert_eq!(c.comments[0].text, "on it");

        let e = board.edit_card(&root, &a.id, Some("a2"), None, Some(vec!["x".into()])).unwrap();
        assert_eq!(e.title, "a2");
        assert_eq!(e.body, "body"); // untouched
        assert_eq!(e.labels, vec!["x".to_string()]);

        board.delete_card(&root, &a.id).unwrap();
        assert!(board.snapshot(&root).cards.is_empty());
    }

    #[test]
    fn comment_is_capped_at_512_bytes() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let a = board.add_card(&root, "a", "", "todo", "human").unwrap();
        let big = "x".repeat(1000);
        let c = board.comment_card(&root, &a.id, "s2", &big).unwrap();
        assert_eq!(c.comments[0].text.len(), 512);
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::comment`
Expected: PASS (both tests).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): comment (capped), edit, delete card operations"
```

---

## Task 8: Column editing + `.gitignore` bootstrap

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

Add to `impl TaskBoard`:

```rust
    fn write_columns(project_root: &str, columns: &Columns) -> Result<(), String> {
        let yaml = serde_yaml::to_string(columns).map_err(|e| e.to_string())?;
        Self::write_atomic(&Self::columns_path(project_root), yaml.as_bytes())
    }

    /// Replace the column set (rename/add/reorder/remove). Cards in a removed column are left
    /// with a dangling `column` id; the UI shows them in an "Unsorted" fallback lane.
    pub fn set_columns(&self, project_root: &str, columns: Vec<Column>) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Self::write_columns(project_root, &Columns { columns })
    }

    /// Create `.conduit/board/` scaffolding and a `.conduit/.gitignore` that keeps the
    /// volatile claim sidecar out of git. Idempotent — safe to call on every board open.
    pub fn ensure_scaffold(&self, project_root: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        fs::create_dir_all(Self::cards_dir(project_root)).map_err(|e| e.to_string())?;
        fs::create_dir_all(Self::claims_dir(project_root)).map_err(|e| e.to_string())?;
        if !Self::columns_path(project_root).exists() {
            Self::write_columns(project_root, &Columns::default())?;
        }
        let gitignore = Path::new(project_root).join(".conduit").join(".gitignore");
        if !gitignore.exists() {
            Self::write_atomic(&gitignore, b"board/.claims/\n")?;
        }
        Ok(())
    }
```

Test:

```rust
    #[test]
    fn ensure_scaffold_is_idempotent_and_gitignores_claims() {
        let root = tmp_root();
        let board = TaskBoard::default();
        board.ensure_scaffold(&root).unwrap();
        board.ensure_scaffold(&root).unwrap(); // second call must not error
        let gi = std::fs::read_to_string(
            std::path::Path::new(&root).join(".conduit").join(".gitignore"),
        ).unwrap();
        assert!(gi.contains("board/.claims/"));
        assert_eq!(board.snapshot(&root).columns.len(), 5);
    }

    #[test]
    fn set_columns_renames_and_reorders() {
        let root = tmp_root();
        let board = TaskBoard::default();
        board.set_columns(&root, vec![
            Column { id: "todo".into(), name: "Inbox".into() },
            Column { id: "done".into(), name: "Shipped".into() },
        ]).unwrap();
        let cols = board.snapshot(&root).columns;
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0].name, "Inbox");
    }
```

- [ ] **Step 2: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests`
Expected: PASS (all `tasks` tests green).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): column editing + .conduit scaffold with claims gitignore"
```

---

## Task 9: Register `TaskBoard`, emit `board-changed`, add Tauri commands

**Files:**
- Modify: `src-tauri/src/lib.rs`

Context: `TaskBoard` must be a shared `Arc` in Tauri state (like `Store`/`FleetState`), passed to `fleet_mcp::start` (Task 12), and reachable from commands. Commands resolve a project's root from `store` by project id (a project has `path: String`, `store.rs:259`).

- [ ] **Step 1: Add a project-root resolver test helper isn't needed; wire state + commands**

In `lib.rs`, near where `FleetState`/`Store` are constructed and `.manage(...)`-ed:

```rust
// alongside the other module declarations
mod tasks;
use tasks::{BoardSnapshot, Card, Column, TaskBoard};

// in the setup closure, after `let store = ...;`
let task_board = std::sync::Arc::new(tasks::TaskBoard::default());
// pass into fleet_mcp::start (Task 12 changes the signature):
// fleet_mcp::start(app.handle().clone(), store.clone(), pty.clone(), fleet.clone(), board.clone(), task_board.clone());
app.manage(task_board.clone());
```

Helper to resolve a project's on-disk root by id (place near the other `Store` helpers or inline in each command):

```rust
fn project_root(store: &tasks_store_alias, project_id: &str) -> Result<String, String> {
    store
        .projects()
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.path)
        .ok_or_else(|| format!("unknown project: {project_id}"))
}
```

> Note: use the existing accessor for the projects list (the same one `load_projects` uses at `lib.rs:410`). If `Store` has no public `projects()` snapshot method, add a thin one that clones the `Mutex<Vec<Project>>` — do not lock across the board call.

- [ ] **Step 2: Add the commands + the change emit**

```rust
fn emit_board_changed(app: &tauri::AppHandle, project_id: &str) {
    let _ = app.emit("board-changed", serde_json::json!({ "projectId": project_id }));
}

#[tauri::command]
fn list_board(store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String) -> Result<BoardSnapshot, String> {
    let root = project_root(&store, &project_id)?;
    board.ensure_scaffold(&root)?;
    Ok(board.snapshot(&root))
}

#[tauri::command]
fn board_add_card(app: tauri::AppHandle, store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String, title: String, body: String, column: String) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.add_card(&root, &title, &body, &column, "human")?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

#[tauri::command]
fn board_move_card(app: tauri::AppHandle, store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String, id: String, column: String, after: Option<String>, before: Option<String>) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.move_card(&root, &id, &column, after.as_deref(), before.as_deref())?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

#[tauri::command]
fn board_edit_card(app: tauri::AppHandle, store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String, id: String, title: Option<String>, body: Option<String>, labels: Option<Vec<String>>) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.edit_card(&root, &id, title.as_deref(), body.as_deref(), labels)?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

#[tauri::command]
fn board_delete_card(app: tauri::AppHandle, store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String, id: String) -> Result<(), String> {
    let root = project_root(&store, &project_id)?;
    board.delete_card(&root, &id)?;
    emit_board_changed(&app, &project_id);
    Ok(())
}

#[tauri::command]
fn board_set_columns(app: tauri::AppHandle, store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String, columns: Vec<Column>) -> Result<(), String> {
    let root = project_root(&store, &project_id)?;
    board.set_columns(&root, columns)?;
    emit_board_changed(&app, &project_id);
    Ok(())
}

// Human claim/release from the UI (drag a card onto "me" is out of scope; this backs a
// "release" button on a stuck AI claim). `live` = always-true here; the human is authoritative.
#[tauri::command]
fn board_release_card(app: tauri::AppHandle, store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String, id: String) -> Result<(), String> {
    let root = project_root(&store, &project_id)?;
    // Force-release from the UI regardless of holder: delete the claim sidecar.
    board.delete_card_claim(&root, &id)?;
    emit_board_changed(&app, &project_id);
    Ok(())
}
```

Add the small helper `delete_card_claim` to `impl TaskBoard` in `tasks/mod.rs` (human override):

```rust
    pub fn delete_card_claim(&self, project_root: &str, id: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = fs::remove_file(Self::claim_path(project_root, id));
        Ok(())
    }
```

Register all commands in the `invoke_handler![...]` list. Ensure `use tauri::Emitter;` is imported for `app.emit`.

- [ ] **Step 3: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds clean. (These commands are exercised by the UI in Task 11; the `TaskBoard` logic itself is already unit-tested.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/tasks/mod.rs
git commit -m "feat(board): Tauri commands (list/add/move/edit/delete/columns/release) + board-changed event"
```

---

## Task 10: Frontend store slice + types

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: Add the board slice**

Add TypeScript types mirroring the Rust structs (camelCase) and Zustand state. Near the other interfaces in `store.ts`:

```ts
export interface BoardColumn { id: string; name: string }
export interface BoardClaim { by: string; at: number; leaseUntil: number }
export interface BoardComment { by: string; at: number; text: string }
export interface BoardCard {
  id: string; title: string; body: string; column: string; order: string;
  labels: string[]; createdBy: string; createdAt: number; updatedAt: number;
  workflow: unknown | null; links: { workItem: string | null; pr: string; branch: string };
  comments: BoardComment[]; claim: BoardClaim | null;
}
export interface BoardSnapshot { columns: BoardColumn[]; cards: BoardCard[] }

export type CenterMode = "terminals" | "board";
```

Add to the store state + actions (follow the `sidebarCollapsed`/`toggleSidebar` persisted pattern at `store.ts:664,1984` and the localStorage helpers at `store.ts:422-433`):

```ts
// state
centerMode: Record<string, CenterMode>,   // per projectId; default "terminals"
boards: Record<string, BoardSnapshot>,     // per projectId; last loaded snapshot

// actions
setCenterMode: (projectId: string, mode: CenterMode) => void,
toggleCenterMode: (projectId: string) => void,
setBoard: (projectId: string, snapshot: BoardSnapshot) => void,
```

Implementations:

```ts
centerMode: {},
boards: {},
setCenterMode: (projectId, mode) =>
  set((s) => ({ centerMode: { ...s.centerMode, [projectId]: mode } })),
toggleCenterMode: (projectId) =>
  set((s) => {
    const cur = s.centerMode[projectId] ?? "terminals";
    return { centerMode: { ...s.centerMode, [projectId]: cur === "board" ? "terminals" : "board" } };
  }),
setBoard: (projectId, snapshot) =>
  set((s) => ({ boards: { ...s.boards, [projectId]: snapshot } })),
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/store.ts
git commit -m "feat(board): frontend board slice (types, centerMode, snapshot cache)"
```

---

## Task 11: `useBoard` hook (load + event + poll)

**Files:**
- Create: `src/hooks/useBoard.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";
import type { BoardSnapshot } from "../store";

const POLL_MS = 1500;

/** Loads a project's board and keeps it fresh via the `board-changed` event plus a light
 *  mtime-style poll (re-fetch) for teammate/git edits. Only active while `enabled`. */
export function useBoard(projectId: string | null, enabled: boolean) {
  const setBoard = useStore((s) => s.setBoard);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      const snap = await invoke<BoardSnapshot>("list_board", { projectId });
      setBoard(projectId, snap);
    } catch (e) {
      console.error("[board] list_board failed", e);
    }
  }, [projectId, setBoard]);

  // Event-driven refresh (in-app mutations).
  useEffect(() => {
    if (!enabled || !projectId) return;
    let un: (() => void) | undefined;
    listen<{ projectId: string }>("board-changed", (ev) => {
      if (ev.payload.projectId === projectId) reload();
    }).then((u) => { un = u; });
    return () => { if (un) un(); };
  }, [enabled, projectId, reload]);

  // Poll for external/git edits while the board is visible and the window is focused.
  useEffect(() => {
    if (!enabled || !projectId) return;
    reload();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, projectId, reload]);

  return { reload };
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useBoard.ts
git commit -m "feat(board): useBoard hook — event-driven + polled refresh"
```

---

## Task 12: Board UI components + toggle

**Files:**
- Create: `src/components/BoardView.tsx`, `src/components/BoardColumn.tsx`, `src/components/BoardCard.tsx`
- Modify: `src/components/WorkspaceCenter.tsx`, `src/App.tsx`, `src/theme.css`

- [ ] **Step 1: BoardCard**

`src/components/BoardCard.tsx`:

```tsx
import type { BoardCard as Card } from "../store";

export function BoardCard({ card, onDragStart }: { card: Card; onDragStart: (id: string) => void }) {
  const claim = card.claim;
  const who = claim ? (claim.by === "human" ? "you" : claim.by) : null;
  return (
    <div
      className="board-card"
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(card.id); }}
    >
      <div className="board-card-title">{card.title}</div>
      {card.labels.length > 0 && (
        <div className="board-card-labels">
          {card.labels.map((l) => <span key={l} className="board-label">{l}</span>)}
        </div>
      )}
      {who && <span className={`board-claim ${claim!.by === "human" ? "human" : "ai"}`}>{who}</span>}
    </div>
  );
}
```

- [ ] **Step 2: BoardColumn**

`src/components/BoardColumn.tsx`:

```tsx
import type { BoardColumn as Col, BoardCard as Card } from "../store";
import { BoardCard } from "./BoardCard";

export function BoardColumn({
  column, cards, onDragStart, onDropCard,
}: {
  column: Col;
  cards: Card[];
  onDragStart: (id: string) => void;
  onDropCard: (columnId: string, beforeCardId: string | null) => void;
}) {
  return (
    <div
      className="board-column"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onDropCard(column.id, null); }}
    >
      <div className="board-column-head">{column.name}<span className="board-count">{cards.length}</span></div>
      <div className="board-column-body">
        {cards.map((c) => (
          <div
            key={c.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.stopPropagation(); e.preventDefault(); onDropCard(column.id, c.id); }}
          >
            <BoardCard card={c} onDragStart={onDragStart} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: BoardView (columns + DnD + add)**

`src/components/BoardView.tsx`:

```tsx
import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { useBoard } from "../hooks/useBoard";
import { BoardColumn } from "./BoardColumn";

export function BoardView({ projectId }: { projectId: string }) {
  useBoard(projectId, true);
  const snap = useStore((s) => s.boards[projectId]);
  const setCenterMode = useStore((s) => s.setCenterMode);
  const dragId = useRef<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // column id being added to
  const [draft, setDraft] = useState("");

  const cardsByColumn = useMemo(() => {
    const m: Record<string, typeof snap.cards> = {};
    if (snap) for (const c of snap.cards) (m[c.column] ??= []).push(c);
    return m;
  }, [snap]);

  if (!snap) return <div className="board-view board-empty">Loading board…</div>;

  const onDropCard = async (columnId: string, beforeCardId: string | null) => {
    const id = dragId.current;
    dragId.current = null;
    if (!id) return;
    const col = cardsByColumn[columnId] ?? [];
    let after: string | null = null;
    let before: string | null = beforeCardId;
    if (beforeCardId) {
      const idx = col.findIndex((c) => c.id === beforeCardId);
      after = idx > 0 ? col[idx - 1].id : null;
    } else {
      after = col.length ? col[col.length - 1].id : null;
    }
    await invoke("board_move_card", { projectId, id, column: columnId, after, before });
    // board-changed event triggers the reload.
  };

  const addCard = async (columnId: string) => {
    const title = draft.trim();
    setAdding(null); setDraft("");
    if (!title) return;
    await invoke("board_add_card", { projectId, title, body: "", column: columnId });
  };

  return (
    <div className="board-view">
      <div className="board-toolbar">
        <span className="board-title">Board</span>
        <button className="board-close" onClick={() => setCenterMode(projectId, "terminals")}>Terminals ⇧⌘B</button>
      </div>
      <div className="board-columns">
        {snap.columns.map((col) => (
          <div key={col.id} className="board-column-wrap">
            <BoardColumn
              column={col}
              cards={cardsByColumn[col.id] ?? []}
              onDragStart={(id) => { dragId.current = id; }}
              onDropCard={onDropCard}
            />
            {adding === col.id ? (
              <input
                className="board-add-input" autoFocus value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => addCard(col.id)}
                onKeyDown={(e) => { if (e.key === "Enter") addCard(col.id); if (e.key === "Escape") { setAdding(null); setDraft(""); } }}
              />
            ) : (
              <button className="board-add" onClick={() => setAdding(col.id)}>+ Add</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Mount the overlay in WorkspaceCenter (terminals stay mounted)**

In `src/components/WorkspaceCenter.tsx`, read `centerMode` for the active project and render `BoardView` as an absolute overlay inside `.center` (mirrors the `EmptyState` overlay at `WorkspaceCenter.tsx:333`). The `.term-stack` is **not** conditionally rendered — it stays mounted; the overlay simply covers it:

```tsx
// near the top of the component
const centerMode = useStore((s) => (projectId ? s.centerMode[projectId] ?? "terminals" : "terminals"));

// inside the `.center` / `.workspace` container, after the existing `.term-stack` JSX:
{projectId && centerMode === "board" && (
  <div className="board-overlay">
    <BoardView projectId={projectId} />
  </div>
)}
```

Add CSS to `src/theme.css`:

```css
.board-overlay { position: absolute; inset: 0; z-index: 3; background: var(--bg); overflow: hidden; display: flex; }
.board-view { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.board-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.board-title { font-weight: 600; }
.board-close { margin-left: auto; }
.board-columns { flex: 1; display: flex; gap: 10px; padding: 12px; overflow-x: auto; }
.board-column-wrap { display: flex; flex-direction: column; min-width: 220px; }
.board-column { flex: 1; background: rgba(127,127,127,0.08); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; }
.board-column-head { display: flex; justify-content: space-between; font-size: 12px; text-transform: uppercase; opacity: 0.7; margin-bottom: 8px; }
.board-column-body { flex: 1; display: flex; flex-direction: column; gap: 6px; min-height: 20px; }
.board-card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px; cursor: grab; }
.board-card-title { font-size: 13px; }
.board-card-labels { display: flex; gap: 4px; margin-top: 4px; }
.board-label { font-size: 10px; padding: 1px 6px; border-radius: 99px; background: rgba(127,127,127,0.2); }
.board-claim { display: inline-block; margin-top: 6px; font-size: 10px; padding: 1px 6px; border-radius: 99px; }
.board-claim.ai { background: rgba(88,101,242,0.25); }
.board-claim.human { background: rgba(52,199,89,0.22); }
.board-add { margin-top: 6px; font-size: 12px; opacity: 0.75; }
.board-add-input { margin-top: 6px; }
```

- [ ] **Step 5: Wire the ⇧⌘B toggle in App.tsx**

In `src/App.tsx`, add a menu/keyboard handler mirroring `toggle-maximize` (`App.tsx:257`):

```tsx
// where other menu events are handled
case "toggle-board":
  if (selectedProjectId) useStore.getState().toggleCenterMode(selectedProjectId);
  break;
```

Add a keydown listener (or extend the existing one) for ⇧⌘B → `toggleCenterMode(selectedProjectId)`. If Conduit builds its menu in `src-tauri/src/menu.rs`, add a "View → Board (⇧⌘B)" item emitting `"toggle-board"`; otherwise handle the shortcut in the existing global keydown effect.

- [ ] **Step 6: Verify — typecheck + launch**

Run: `pnpm exec tsc --noEmit` → no errors.
Then launch the isolated dev app and verify by hand:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Manual checks: open a project → ⇧⌘B shows the board with 5 default columns → "+ Add" creates a card (a `.conduit/board/cards/<id>.yaml` appears in the repo) → drag a card between columns (the file's `column`/`order` update; terminals are still alive when you toggle back with ⇧⌘B).

- [ ] **Step 7: Commit**

```bash
git add src/components/BoardView.tsx src/components/BoardColumn.tsx src/components/BoardCard.tsx src/components/WorkspaceCenter.tsx src/App.tsx src/theme.css
git commit -m "feat(board): full-screen board view with native DnD, add, and ⇧⌘B toggle"
```

---

## Task 13: `Ctx.tasks` + first `task_*` tool (`task_list`) with project scope

**Files:**
- Modify: `src-tauri/src/fleet_mcp.rs`, `src-tauri/src/lib.rs`

Context: `fleet_mcp::start` gains a `tasks: Arc<TaskBoard>` param; `Ctx` gains `tasks` and a resolved `project_root`. The caller's project is resolved from `store.fleet_snapshot(&ctx.conductor_id)` — **never** from an arg — closing the cross-project scope class (spec §Security).

- [ ] **Step 1: Extend `start` + `Ctx`**

In `fleet_mcp.rs`:

```rust
// signature (fleet_mcp.rs:593) gains tasks:
pub fn start(app: AppHandle, store: Arc<Store>, pty: Arc<PtyManager>, fleet: Arc<FleetState>, board: Arc<BoardState>, tasks: Arc<TaskBoard>) { /* ... */ }

// struct Ctx (fleet_mcp.rs:32) gains:
struct Ctx {
    // ...existing fields...
    tasks: Arc<TaskBoard>,
}
```

In `lib.rs:1278`, update the call:

```rust
fleet_mcp::start(app.handle().clone(), store, pty, fleet, board, task_board.clone());
```

Add a helper in `fleet_mcp.rs` that resolves the caller's project root (and returns an error if the caller belongs to no project — never trusts an arg):

```rust
/// The on-disk root of the project the calling session belongs to. Resolved from the
/// session id baked into the MCP URL (`?conductor=<sid>`), never from tool args — this is
/// the structural project-scope guarantee.
fn caller_project_root(ctx: &Ctx) -> Result<String, String> {
    let snap = ctx.store.fleet_snapshot(&ctx.conductor_id);
    snap.project_path.ok_or_else(|| "caller is not in a project".to_string())
}
```

> If `FleetSnapshot` doesn't already expose the project path, add `project_path: Option<String>` to it in `store.rs` and populate it in `fleet_snapshot` from the owning `Project.path`. This is the same snapshot `board.rs` scoping already uses.

- [ ] **Step 2: Add the `task_list` spec + dispatch arm**

Append to `tool_specs()` (`fleet_mcp.rs:50`):

```rust
json!({
    "name": "task_list",
    "description": "List task-board cards in your project. Optionally filter by column, only your claims, or only unclaimed cards.",
    "inputSchema": { "type": "object", "properties": {
        "column": {"type": "string"},
        "mine": {"type": "boolean"},
        "unclaimed": {"type": "boolean"}
    }, "required": [] }
}),
```

Add a match arm in `dispatch_tool` (`fleet_mcp.rs:231`, after the fleet arms):

```rust
"task_list" => {
    let root = caller_project_root(ctx)?;
    ctx.tasks.ensure_scaffold(&root).ok();
    let mut snap = ctx.tasks.snapshot(&root);
    if let Some(col) = args.get("column").and_then(|v| v.as_str()) {
        snap.cards.retain(|c| c.column == col);
    }
    if args.get("mine").and_then(|v| v.as_bool()) == Some(true) {
        let me = ctx.conductor_id.clone();
        snap.cards.retain(|c| c.claim.as_ref().map(|cl| cl.by == me).unwrap_or(false));
    }
    if args.get("unclaimed").and_then(|v| v.as_bool()) == Some(true) {
        snap.cards.retain(|c| c.claim.is_none());
    }
    Ok(serde_json::to_string(&snap).map_err(|e| e.to_string())?)
}
```

- [ ] **Step 3: Write a scope test**

Add to `fleet_mcp.rs` tests: assert that `caller_project_root` for a session in project A returns A's path, and that a session in no project errors. (Follow the existing `authorize` test style at `fleet_mcp.rs:911`.)

```rust
#[test]
fn task_list_is_scoped_to_the_callers_own_project() {
    // Build a Store with project A (path "/tmp/a") owning session "s-a".
    // A Ctx with conductor_id = "s-a" resolves root "/tmp/a"; conductor_id "ghost" errors.
    // (Mirror the fixture construction used by the existing worker-guardrail tests.)
}
```

Fill the test body using the same `Store`/`FleetSnapshot` fixtures the existing tests use.

- [ ] **Step 4: Run + build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml fleet_mcp::` then `cargo build --manifest-path src-tauri/Cargo.toml`.
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fleet_mcp.rs src-tauri/src/lib.rs src-tauri/src/store.rs
git commit -m "feat(board): task_list MCP tool with structural project scoping"
```

---

## Task 14: Remaining `task_*` tools (get/claim/release/move/comment/add)

**Files:**
- Modify: `src-tauri/src/fleet_mcp.rs`

- [ ] **Step 1: Add specs**

Append these to `tool_specs()`:

```rust
json!({ "name": "task_get", "description": "Get one card by id (full body + comments + claim).",
  "inputSchema": {"type":"object","properties":{"id":{"type":"string"}},"required":["id"]} }),
json!({ "name": "task_claim", "description": "Claim a card so no other session works it. Fails if already claimed by a live session.",
  "inputSchema": {"type":"object","properties":{"id":{"type":"string"}},"required":["id"]} }),
json!({ "name": "task_release", "description": "Release your own claim on a card.",
  "inputSchema": {"type":"object","properties":{"id":{"type":"string"}},"required":["id"]} }),
json!({ "name": "task_move", "description": "Move a card to a column, optionally between two card ids.",
  "inputSchema": {"type":"object","properties":{"id":{"type":"string"},"column":{"type":"string"},"after":{"type":"string"},"before":{"type":"string"}},"required":["id","column"]} }),
json!({ "name": "task_comment", "description": "Append a short comment to a card (max 512 bytes).",
  "inputSchema": {"type":"object","properties":{"id":{"type":"string"},"text":{"type":"string"}},"required":["id","text"]} }),
json!({ "name": "task_add", "description": "Create a card in a column (default backlog).",
  "inputSchema": {"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"},"column":{"type":"string"}},"required":["title"]} }),
```

- [ ] **Step 2: Add dispatch arms**

The liveness closure reuses `FleetState.running_sessions` so a dead session's claim is reclaimable:

```rust
"task_get" => {
    let root = caller_project_root(ctx)?;
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    let snap = ctx.tasks.snapshot(&root);
    let card = snap.cards.into_iter().find(|c| c.id == id).ok_or("card not found")?;
    Ok(serde_json::to_string(&card).map_err(|e| e.to_string())?)
}
"task_claim" => {
    let root = caller_project_root(ctx)?;
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    let running = ctx.fleet.running_sessions();
    let live = |sid: &str| running.iter().any(|r| r == sid);
    let claim = ctx.tasks.claim_card(&root, id, &ctx.conductor_id, &live)?;
    emit_board_changed(&ctx.app, &project_id_of(ctx));
    Ok(serde_json::to_string(&claim).map_err(|e| e.to_string())?)
}
"task_release" => {
    let root = caller_project_root(ctx)?;
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    ctx.tasks.release_card(&root, id, &ctx.conductor_id)?;
    emit_board_changed(&ctx.app, &project_id_of(ctx));
    Ok("released".into())
}
"task_move" => {
    let root = caller_project_root(ctx)?;
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    let column = args.get("column").and_then(|v| v.as_str()).ok_or("missing column")?;
    let after = args.get("after").and_then(|v| v.as_str());
    let before = args.get("before").and_then(|v| v.as_str());
    ctx.tasks.move_card(&root, id, column, after, before)?;
    emit_board_changed(&ctx.app, &project_id_of(ctx));
    Ok("moved".into())
}
"task_comment" => {
    let root = caller_project_root(ctx)?;
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    let text = args.get("text").and_then(|v| v.as_str()).ok_or("missing text")?;
    ctx.tasks.comment_card(&root, id, &ctx.conductor_id, text)?;
    emit_board_changed(&ctx.app, &project_id_of(ctx));
    Ok("commented".into())
}
"task_add" => {
    let root = caller_project_root(ctx)?;
    let title = args.get("title").and_then(|v| v.as_str()).ok_or("missing title")?;
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let column = args.get("column").and_then(|v| v.as_str()).unwrap_or("backlog");
    let card = ctx.tasks.add_card(&root, title, body, column, &ctx.conductor_id)?;
    emit_board_changed(&ctx.app, &project_id_of(ctx));
    Ok(serde_json::to_string(&card).map_err(|e| e.to_string())?)
}
```

Add a `project_id_of(ctx) -> String` helper next to `caller_project_root` that returns the caller's project id from the same `fleet_snapshot` (add `project_id` to the snapshot if absent), and move `emit_board_changed` into a shared location (e.g. `tasks/mod.rs` or a small `events.rs`) so both `lib.rs` and `fleet_mcp.rs` call the same function.

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/fleet_mcp.rs src-tauri/src/tasks/mod.rs
git commit -m "feat(board): task_get/claim/release/move/comment/add MCP tools"
```

---

## Task 15: Authorize `task_*` for workers + widen who receives the MCP config

**Files:**
- Modify: `src-tauri/src/fleet_mcp.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/store.rs`

- [ ] **Step 1: Add `task_*` to `WORKER_ALLOWED` + test**

In `fleet_mcp.rs:182`:

```rust
const WORKER_ALLOWED: &[&str] = &[
    "fleet_result", "fleet_note", "fleet_inbox",
    "task_list", "task_get", "task_claim", "task_release", "task_move", "task_comment", "task_add",
];
```

Add a test mirroring the existing guardrail tests (`fleet_mcp.rs:911`):

```rust
#[test]
fn workers_may_use_task_tools_but_not_orchestration() {
    // A Worker-role caller passes authorize() for each task_* verb...
    for t in ["task_list","task_get","task_claim","task_release","task_move","task_comment","task_add"] {
        assert!(authorize(&store, "w1", t).is_ok(), "worker should be allowed {t}");
    }
    // ...and is still denied the fleet orchestration verbs.
    assert!(authorize(&store, "w1", "fleet_spawn").is_err());
}
```

(Reuse the fixture that constructs a `Store` with a Worker-role session, as the existing tests do.)

- [ ] **Step 2: Widen `gets_fleet_mcp` behind a per-project board flag**

Add `board_enabled: bool` (default `false`) to `Project` (`store.rs:256`) with a Tauri command `set_board_enabled(project_id, enabled)`; opening the board (`list_board`) also flips it true. Then in `lib.rs:181`, widen the MCP-config gate so every session in a board-enabled project receives the config:

```rust
let project_board_on = /* look up the owning Project.board_enabled for this session */;
let gets_fleet_mcp = mission_record.is_some() || opted_into_mailbox || project_board_on;
```

This ensures a manually-opened Claude session in a board-enabled project can call `task_*` (its own session id is written as the `?conductor=` param exactly as today, so scoping + authorize still apply).

- [ ] **Step 3: Extend the tools-list test**

Update the existing `tools_list_includes_all_eleven` test (`fleet_mcp.rs:726`) to assert the new `task_*` names are present too (rename it to `tools_list_includes_fleet_and_task_tools`).

- [ ] **Step 4: Run + build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` then `cargo build --manifest-path src-tauri/Cargo.toml`.
Expected: all PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fleet_mcp.rs src-tauri/src/lib.rs src-tauri/src/store.rs
git commit -m "feat(board): allow workers to call task_* + write MCP config for board-enabled projects"
```

---

## Task 16: End-to-end verification + changelog + version

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `CHANGELOG.md`

- [ ] **Step 1: Full backend test + build**

Run:
```bash
cargo test  --manifest-path src-tauri/Cargo.toml
cargo fmt   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
pnpm exec tsc --noEmit
```
Expected: tests PASS, no clippy errors, no type errors.

- [ ] **Step 2: Two-session live check**

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```
- Open a project; ⇧⌘B → board with default columns.
- Add a card via the UI; confirm `<repo>/.conduit/board/cards/<id>.yaml` exists and `.conduit/.gitignore` ignores `board/.claims/`.
- Start a Claude session in that project; in it, ask it to call `task_list` then `task_claim` the card. Confirm the UI shows the AI claim badge live (via the `board-changed` event).
- Start a second session; confirm `task_claim` on the same card is refused with `claimed-by:<first>`.
- Drag the card in the UI to another column; confirm only that card's file changed (`git status`).

- [ ] **Step 3: Bump version + changelog (MINOR — new user-facing feature)**

Set the version in lockstep in `package.json`, `src-tauri/Cargo.toml` (line 3), `src-tauri/tauri.conf.json` (bump the MINOR, reset PATCH to 0). Run `cargo build --manifest-path src-tauri/Cargo.toml` so `Cargo.lock` updates. Verify:

```bash
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
```

Add a `CHANGELOG.md` top entry `## X.Y.0 — 2026-07-16` with:
```
- **Added — Project task board.** Every project now has a Kanban board stored in its own
  repo (`.conduit/board/`, git-shared with your team). Drag and add cards in a full-screen
  board view (⇧⌘B); live agent sessions claim, move, and comment on cards through new
  task_* MCP tools, so a fleet coordinates on shared work without colliding.
```

- [ ] **Step 4: Commit**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "release: project task board (Plan A substrate)"
```

---

## Self-review notes (coverage against the spec)

- **Data model / `.conduit/` layout** → Tasks 2, 3, 8 (files, columns, gitignore).
- **Fractional order, merge-clean reorders** → Task 1 + Tasks 4/5.
- **Claim + lease + liveness** → Task 6 + Task 14 (`task_claim` liveness closure).
- **`task_*` MCP surface** → Tasks 13, 14.
- **Security: structural project scope** → Task 13 (`caller_project_root`, never trusts args).
- **Security: `WORKER_ALLOWED` + MCP-config widening** → Task 15.
- **Live refresh (event + poll)** → Tasks 9, 11.
- **UI full board view, keep-alive terminals, native DnD** → Task 12.
- **Human commands** → Task 9.
- **Deferred to Plan B (correctly absent here):** stage-gate workflow, role personas, OKF knowledge — every card is `workflow: null`.
