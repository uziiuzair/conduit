pub mod frac;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use crate::board::truncate_utf8;

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
/// Plan A; a later plan fills it with the stage-gate overlay.
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

    fn read_columns(project_root: &str) -> Columns {
        match fs::read_to_string(Self::columns_path(project_root)) {
            Ok(s) => serde_yaml::from_str(&s).unwrap_or_default(),
            Err(_) => Columns::default(),
        }
    }

    /// Full snapshot: every card (claims merged from the sidecar) sorted by `order`, plus
    /// columns in display order.
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

    /// Atomic write: serialize to a sibling `.tmp` then rename over the target.
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
        let existing = Self::load_all(project_root);
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

    /// Load every card file (no claim merge, no sort) — a shared helper for the mutators.
    fn load_all(project_root: &str) -> Vec<Card> {
        let mut v = Vec::new();
        if let Ok(entries) = fs::read_dir(Self::cards_dir(project_root)) {
            for e in entries.flatten() {
                if e.path().extension().and_then(|x| x.to_str()) != Some("yaml") {
                    continue;
                }
                if let Ok(s) = fs::read_to_string(e.path()) {
                    if let Ok(c) = serde_yaml::from_str::<Card>(&s) {
                        v.push(c);
                    }
                }
            }
        }
        v
    }

    fn load_card(project_root: &str, id: &str) -> Result<Card, String> {
        let s = fs::read_to_string(Self::card_path(project_root, id))
            .map_err(|_| format!("card not found: {id}"))?;
        serde_yaml::from_str(&s).map_err(|e| e.to_string())
    }

    /// Move `id` into `column`, positioned between `after`/`before` (either may be `None`).
    /// Rewrites only this card's file.
    pub fn move_card(
        &self,
        project_root: &str,
        id: &str,
        column: &str,
        after: Option<&str>,
        before: Option<&str>,
    ) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let all = Self::load_all(project_root);
        let order_of = |cid: Option<&str>| -> String {
            cid.and_then(|c| all.iter().find(|k| k.id == c))
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

    /// Default lease length. A claim older than this (without a heartbeat) is abandoned.
    pub const LEASE_MS: u64 = 5 * 60 * 1000;

    fn claim_path(project_root: &str, card_id: &str) -> PathBuf {
        Self::claims_dir(project_root).join(format!("{card_id}.json"))
    }

    fn write_claim(project_root: &str, card_id: &str, claim: &Claim) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(claim).map_err(|e| e.to_string())?;
        Self::write_atomic(&Self::claim_path(project_root, card_id), &bytes)
    }

    /// Compare-and-set claim. Succeeds when unclaimed, the current lease expired, the holder
    /// is not live, or the caller already holds it. `live` decides holder liveness.
    pub fn claim_card(
        &self,
        project_root: &str,
        id: &str,
        by: &str,
        live: &dyn Fn(&str) -> bool,
    ) -> Result<Claim, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
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

    /// Drop the caller's own claim. No-op if unclaimed; Err if another session holds it.
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

    fn write_columns(project_root: &str, columns: &Columns) -> Result<(), String> {
        let yaml = serde_yaml::to_string(columns).map_err(|e| e.to_string())?;
        Self::write_atomic(&Self::columns_path(project_root), yaml.as_bytes())
    }

    /// Replace the column set (rename/add/reorder/remove).
    pub fn set_columns(&self, project_root: &str, columns: Vec<Column>) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Self::write_columns(project_root, &Columns { columns })
    }

    /// Create `.conduit/board/` scaffolding + a `.conduit/.gitignore` that keeps the claim
    /// sidecar out of git. Idempotent.
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

    fn tmp_root() -> String {
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

    #[test]
    fn move_card_changes_column_and_reorders() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let a = board.add_card(&root, "a", "", "todo", "human").unwrap();
        let b = board.add_card(&root, "b", "", "todo", "human").unwrap();
        let moved = board.move_card(&root, &b.id, "review", None, None).unwrap();
        assert_eq!(moved.column, "review");
        let a2 = board.move_card(&root, &a.id, "review", Some(&b.id), None).unwrap();
        assert!(moved.order < a2.order);
        let snap = board.snapshot(&root);
        let review: Vec<_> = snap.cards.iter().filter(|c| c.column == "review").collect();
        assert_eq!(review.len(), 2);
        assert_eq!(review[0].id, b.id);
        assert_eq!(review[1].id, a.id);
    }

    #[test]
    fn claim_is_exclusive_until_released_or_expired() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let a = board.add_card(&root, "a", "", "todo", "human").unwrap();
        let alive = |_: &str| true;
        board.claim_card(&root, &a.id, "s2", &alive).unwrap();
        let err = board.claim_card(&root, &a.id, "s4", &alive).unwrap_err();
        assert_eq!(err, "claimed-by:s2");
        let snap = board.snapshot(&root);
        assert_eq!(snap.cards[0].claim.as_ref().unwrap().by, "s2");
        board.release_card(&root, &a.id, "s2").unwrap();
        board.claim_card(&root, &a.id, "s4", &alive).unwrap();
        let dead = |who: &str| who != "s4";
        board.claim_card(&root, &a.id, "s7", &dead).unwrap();
        assert_eq!(board.snapshot(&root).cards[0].claim.as_ref().unwrap().by, "s7");
    }

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
        assert_eq!(e.body, "body");
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

    #[test]
    fn ensure_scaffold_is_idempotent_and_gitignores_claims() {
        let root = tmp_root();
        let board = TaskBoard::default();
        board.ensure_scaffold(&root).unwrap();
        board.ensure_scaffold(&root).unwrap();
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
}
