pub mod frac;
pub mod stage_machine;

use crate::board::truncate_utf8;
use crate::tasks::stage_machine::{Outcome, Stage, Transition};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
    pub by: String, // session id, or "human"
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

/// One card = one file at `.conduit/board/cards/<id>.yaml`. `workflow` is `null` until
/// `start_workflow` attaches the stage-gate overlay (see `Workflow`).
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
    pub workflow: Option<Workflow>,
    #[serde(default)]
    pub links: CardLinks,
    #[serde(default)]
    pub comments: Vec<Comment>,
    // Populated from the `.claims/` sidecar by `snapshot`; included in JSON API responses so
    // the UI/MCP can show who holds a card. It stays OUT of the persisted YAML because every
    // `write_card` call operates on a card loaded/created with `claim: None` (claims live only
    // in the sidecar, never round-trip through the card file), so `skip_serializing_if` omits it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<Claim>,
}

/// One entry in a workflow's audit trail: who moved the card from which stage to which, and why.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistory {
    pub at: u64,
    pub by: String,
    pub from: Stage,
    pub to: Stage,
    pub note: String,
}

/// The stage-gate overlay attached to a card once `start_workflow` runs. `null` on a card that
/// hasn't opted into the workflow (Plan A default).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub kind: String, // always "stage-gate"
    pub stage: Stage,
    #[serde(default)]
    pub resume_state: Option<Stage>,
    #[serde(default)]
    pub blocked_question: Option<String>,
    #[serde(default)]
    pub history: Vec<WorkflowHistory>,
}

pub const DEFAULT_COLUMNS: &[(&str, &str)] = &[
    ("backlog", "Backlog"),
    ("todo", "Todo"),
    ("in_progress", "In Progress"),
    ("review", "Review"),
    ("done", "Done"),
];

const PERSONA_ORCHESTRATOR: &str = include_str!("personas/orchestrator.md");
const PERSONA_PLANNER: &str = include_str!("personas/delivery-planner.md");
const PERSONA_UX: &str = include_str!("personas/ux-designer.md");
const PERSONA_ARCHITECT: &str = include_str!("personas/solution-architect.md");
const PERSONA_IMPLEMENTER: &str = include_str!("personas/implementer.md");

const PERSONAS: &[(&str, &str)] = &[
    ("orchestrator", PERSONA_ORCHESTRATOR),
    ("delivery-planner", PERSONA_PLANNER),
    ("ux-designer", PERSONA_UX),
    ("solution-architect", PERSONA_ARCHITECT),
    ("implementer", PERSONA_IMPLEMENTER),
];

const KNOWLEDGE_INDEX: &str = include_str!("knowledge/index.md");
const KNOWLEDGE_LOG: &str = include_str!("knowledge/log.md");

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
                .map(|(id, name)| Column {
                    id: (*id).into(),
                    name: (*name).into(),
                })
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
    /// Card ids are server-minted UUIDs; anything else (notably `..` or path separators) is
    /// rejected before it can be joined into a filesystem path. This is the guard that keeps a
    /// caller-supplied `id` from escaping the project's `.conduit/` dir (path traversal).
    fn check_id(id: &str) -> Result<(), String> {
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            Ok(())
        } else {
            Err("invalid-card-id".to_string())
        }
    }

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
        Self::check_id(id)?;
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
        Self::check_id(id)?;
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Self::load_card(project_root, id)?;
        let now = now_ms();
        if let Some(existing) = Self::read_claim(project_root, id) {
            let expired = now >= existing.lease_until || !live(&existing.by);
            if existing.by != by && !expired {
                return Err(format!("claimed-by:{}", existing.by));
            }
        }
        let claim = Claim {
            by: by.to_string(),
            at: now,
            lease_until: now + Self::LEASE_MS,
        };
        Self::write_claim(project_root, id, &claim)?;
        Ok(claim)
    }

    /// Drop the caller's own claim. No-op if unclaimed; Err if another session holds it.
    pub fn release_card(&self, project_root: &str, id: &str, by: &str) -> Result<(), String> {
        Self::check_id(id)?;
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

    /// Force-release a claim from the UI (human override), regardless of holder.
    pub fn delete_card_claim(&self, project_root: &str, id: &str) -> Result<(), String> {
        Self::check_id(id)?;
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = fs::remove_file(Self::claim_path(project_root, id));
        Ok(())
    }

    pub const COMMENT_MAX_BYTES: usize = 512;

    pub fn comment_card(
        &self,
        project_root: &str,
        id: &str,
        by: &str,
        text: &str,
    ) -> Result<Card, String> {
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
        if let Some(t) = title {
            card.title = t.to_string();
        }
        if let Some(b) = body {
            card.body = b.to_string();
        }
        if let Some(l) = labels {
            card.labels = l;
        }
        card.updated_at = now_ms();
        Self::write_card(project_root, &card)?;
        Ok(card)
    }

    pub fn delete_card(&self, project_root: &str, id: &str) -> Result<(), String> {
        Self::check_id(id)?;
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

    fn agents_dir(project_root: &str) -> PathBuf {
        Path::new(project_root).join(".conduit").join("agents")
    }

    /// Write the bundled role personas into `.conduit/agents/`. Overwrites so a Conduit
    /// upgrade ships improved briefings; the files are Conduit-managed, not user-edited.
    pub fn ensure_agents(&self, project_root: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        fs::create_dir_all(Self::agents_dir(project_root)).map_err(|e| e.to_string())?;
        for (name, body) in PERSONAS {
            Self::write_atomic(
                &Self::agents_dir(project_root).join(format!("{name}.md")),
                body.as_bytes(),
            )?;
        }
        Ok(())
    }

    fn persona_for(role: &str) -> Option<&'static str> {
        PERSONAS.iter().find(|(n, _)| *n == role).map(|(_, b)| *b)
    }

    fn knowledge_dir(project_root: &str) -> PathBuf {
        Path::new(project_root).join(".conduit").join("knowledge")
    }

    /// Scaffold the OKF bundle: index.md, log.md, and the five (empty) category dirs. Never
    /// overwrites an existing index/log (they accrue project history). Idempotent.
    pub fn ensure_knowledge(&self, project_root: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let kd = Self::knowledge_dir(project_root);
        for cat in ["decisions", "patterns", "anti-patterns", "domain", "components"] {
            fs::create_dir_all(kd.join(cat)).map_err(|e| e.to_string())?;
        }
        if !kd.join("index.md").exists() {
            Self::write_atomic(&kd.join("index.md"), KNOWLEDGE_INDEX.as_bytes())?;
        }
        if !kd.join("log.md").exists() {
            Self::write_atomic(&kd.join("log.md"), KNOWLEDGE_LOG.as_bytes())?;
        }
        Ok(())
    }

    fn work_item_dir(project_root: &str, card_id: &str) -> PathBuf {
        Path::new(project_root)
            .join(".conduit")
            .join("work-items")
            .join(card_id)
    }

    /// Attach a fresh stage-gate workflow to a card (starting at `discovery`) and create its
    /// work-item dir. Errors if the card already has a workflow. The CALLER is responsible for
    /// `ensure_agents`/`ensure_knowledge` (those take their own lock; calling them here would
    /// double-lock `self.lock`).
    pub fn start_workflow(
        &self,
        project_root: &str,
        card_id: &str,
        by: &str,
    ) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut card = Self::load_card(project_root, card_id)?;
        if card.workflow.is_some() {
            return Err("card already has a workflow".into());
        }
        fs::create_dir_all(Self::work_item_dir(project_root, card_id))
            .map_err(|e| e.to_string())?;
        let now = now_ms();
        card.workflow = Some(Workflow {
            kind: "stage-gate".into(),
            stage: Stage::Discovery,
            resume_state: None,
            blocked_question: None,
            history: vec![WorkflowHistory {
                at: now,
                by: by.to_string(),
                from: Stage::Requested,
                to: Stage::Discovery,
                note: "workflow started".into(),
            }],
        });
        card.updated_at = now;
        Self::write_card(project_root, &card)?;
        Ok(card)
    }

    /// Advance a workflow card by reporting an `outcome` for its current stage. Applies the
    /// transition table; an illegal outcome is rejected; stops at a human gate; appends history.
    pub fn advance(
        &self,
        project_root: &str,
        card_id: &str,
        outcome: Outcome,
        by: &str,
        note: &str,
    ) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut card = Self::load_card(project_root, card_id)?;
        let from = card.workflow.as_ref().ok_or("card has no workflow")?.stage;
        let to = match stage_machine::next(from, outcome) {
            Transition::Advance(s) | Transition::HumanGate(s) | Transition::Rework(s) => s,
            Transition::Done => Stage::Done,
            Transition::Illegal => {
                return Err(format!("illegal outcome {outcome:?} for stage {from:?}"))
            }
        };
        {
            let wf = card.workflow.as_mut().unwrap();
            wf.stage = to;
            wf.history.push(WorkflowHistory {
                at: now_ms(),
                by: by.to_string(),
                from,
                to,
                note: note.to_string(),
            });
        }
        card.updated_at = now_ms();
        Self::write_card(project_root, &card)?;
        Ok(card)
    }

    /// Human resolves a gate: `business_clarification` (approve -> ux_input, else -> rework) or
    /// `verification` acceptance (accept -> done). Only valid when the card sits at a gate.
    pub fn resolve_gate(
        &self,
        project_root: &str,
        card_id: &str,
        approved: bool,
        by: &str,
    ) -> Result<Card, String> {
        let stage = {
            let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
            let card = Self::load_card(project_root, card_id)?;
            card.workflow.as_ref().ok_or("no workflow")?.stage
        };
        let outcome = match (stage, approved) {
            (Stage::BusinessClarification, true) => Outcome::Approved,
            (Stage::BusinessClarification, false) => Outcome::ChangesRequested,
            (Stage::Verification, true) => Outcome::Accepted,
            (Stage::Verification, false) => Outcome::FailedChecks,
            _ => return Err("card is not at a human gate".into()),
        };
        self.advance(project_root, card_id, outcome, by, "human gate resolved")
    }

    /// The briefing a session gets when it claims a card: the card, plus -- for a stage-gate
    /// card at an agent-owned stage -- the role persona, read list, and work-item dir.
    pub fn claim_briefing(
        &self,
        project_root: &str,
        card_id: &str,
    ) -> Result<ClaimBriefing, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut card = Self::load_card(project_root, card_id)?;
        card.claim = Self::read_claim(project_root, card_id);
        let (stage, role, persona, reads, wid) = match card.workflow.as_ref() {
            Some(wf) => {
                let stage = wf.stage;
                let role = stage_machine::role_of(stage).map(|r| r.to_string());
                let persona = role
                    .as_deref()
                    .and_then(Self::persona_for)
                    .map(|s| s.to_string());
                let reads = stage_machine::reads_of(stage)
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                let wid = Some(
                    Self::work_item_dir(project_root, card_id)
                        .to_string_lossy()
                        .into_owned(),
                );
                (Some(stage), role, persona, reads, wid)
            }
            None => (None, None, None, vec![], None),
        };
        Ok(ClaimBriefing {
            card,
            stage,
            role,
            persona,
            reads,
            work_item_dir: wid,
        })
    }
}

/// The briefing a session gets when it claims a card: the card, plus (for a stage-gate card at
/// an agent-owned stage) the role persona, artifacts to read, and work-item dir.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimBriefing {
    pub card: Card,
    pub stage: Option<Stage>,
    pub role: Option<String>,
    pub persona: Option<String>,
    pub reads: Vec<String>,
    pub work_item_dir: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_agents_writes_all_five_personas() {
        let root = tmp_root();
        let board = TaskBoard::default();
        board.ensure_agents(&root).unwrap();
        for name in [
            "orchestrator",
            "delivery-planner",
            "ux-designer",
            "solution-architect",
            "implementer",
        ] {
            let p = std::path::Path::new(&root)
                .join(".conduit")
                .join("agents")
                .join(format!("{name}.md"));
            assert!(p.exists(), "missing {name}");
        }
    }

    #[test]
    fn ensure_knowledge_scaffolds_okf_bundle_once() {
        let root = tmp_root();
        let board = TaskBoard::default();
        board.ensure_knowledge(&root).unwrap();
        let kd = std::path::Path::new(&root).join(".conduit").join("knowledge");
        assert!(kd.join("index.md").exists());
        assert!(kd.join("decisions").is_dir());
        std::fs::write(kd.join("index.md"), "EDITED").unwrap();
        board.ensure_knowledge(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(kd.join("index.md")).unwrap(),
            "EDITED"
        );
    }

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
        assert!(
            !yaml.contains("claim:"),
            "volatile claim must not serialize"
        );
        let back: Card = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(card, back);
    }

    fn tmp_root() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("conduit-board-test-{}-{}", std::process::id(), n));
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
        let b = board
            .add_card(&root, "second", "", "todo", "human")
            .unwrap();
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
        let a2 = board
            .move_card(&root, &a.id, "review", Some(&b.id), None)
            .unwrap();
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
        assert_eq!(
            board.snapshot(&root).cards[0].claim.as_ref().unwrap().by,
            "s7"
        );
    }

    #[test]
    fn comment_edit_delete_round_trip() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let a = board.add_card(&root, "a", "body", "todo", "human").unwrap();
        let c = board.comment_card(&root, &a.id, "s2", "on it").unwrap();
        assert_eq!(c.comments.len(), 1);
        assert_eq!(c.comments[0].text, "on it");
        let e = board
            .edit_card(&root, &a.id, Some("a2"), None, Some(vec!["x".into()]))
            .unwrap();
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
            std::path::Path::new(&root)
                .join(".conduit")
                .join(".gitignore"),
        )
        .unwrap();
        assert!(gi.contains("board/.claims/"));
        assert_eq!(board.snapshot(&root).columns.len(), 5);
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let evil = "../../../../etc/passwd";
        assert!(board
            .claim_card(&root, evil, "s2", &|_: &str| true)
            .is_err());
        assert!(board.move_card(&root, evil, "todo", None, None).is_err());
        assert!(board.comment_card(&root, evil, "s2", "x").is_err());
        assert!(board.release_card(&root, evil, "s2").is_err());
        assert!(board.edit_card(&root, evil, Some("t"), None, None).is_err());
        assert!(board.delete_card(&root, evil).is_err());
        // A legitimate uuid-shaped id is still accepted (created via add_card).
        let c = board.add_card(&root, "ok", "", "todo", "human").unwrap();
        assert!(board
            .claim_card(&root, &c.id, "s2", &|_: &str| true)
            .is_ok());
    }

    #[test]
    fn claim_is_present_in_json_responses() {
        let card = Card {
            id: "c1".into(),
            title: "t".into(),
            body: "".into(),
            column: "todo".into(),
            order: "U".into(),
            labels: vec![],
            created_by: "human".into(),
            created_at: 1,
            updated_at: 1,
            workflow: None,
            links: CardLinks::default(),
            comments: vec![],
            claim: Some(Claim {
                by: "s2".into(),
                at: 1,
                lease_until: 2,
            }),
        };
        let json = serde_json::to_string(&card).unwrap();
        assert!(json.contains("\"claim\""), "claim must be in JSON: {json}");
        assert!(json.contains("\"by\":\"s2\""), "claim.by must be in JSON: {json}");
        // A None-claim card omits it entirely (keeps the YAML file clean).
        let mut none_card = card.clone();
        none_card.claim = None;
        let json2 = serde_json::to_string(&none_card).unwrap();
        assert!(!json2.contains("\"claim\""), "None claim must be omitted: {json2}");
    }

    #[test]
    fn set_columns_renames_and_reorders() {
        let root = tmp_root();
        let board = TaskBoard::default();
        board
            .set_columns(
                &root,
                vec![
                    Column {
                        id: "todo".into(),
                        name: "Inbox".into(),
                    },
                    Column {
                        id: "done".into(),
                        name: "Shipped".into(),
                    },
                ],
            )
            .unwrap();
        let cols = board.snapshot(&root).columns;
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0].name, "Inbox");
    }

    #[test]
    fn workflow_round_trips_with_stage_and_history() {
        let wf = Workflow {
            kind: "stage-gate".into(),
            stage: Stage::ArchitectureInput,
            resume_state: None,
            blocked_question: None,
            history: vec![WorkflowHistory {
                at: 1,
                by: "s2".into(),
                from: Stage::UxInput,
                to: Stage::ArchitectureInput,
                note: "ux done".into(),
            }],
        };
        let yaml = serde_yaml::to_string(&wf).unwrap();
        assert!(yaml.contains("stage: architecture_input"), "got:\n{yaml}");
        let back: Workflow = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(wf, back);
    }

    #[test]
    fn start_workflow_sets_discovery_and_scaffolds_work_item_dir() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let c = board.add_card(&root, "feature X", "", "todo", "human").unwrap();
        let started = board.start_workflow(&root, &c.id, "human").unwrap();
        assert_eq!(started.workflow.as_ref().unwrap().stage, Stage::Discovery);
        let wid = std::path::Path::new(&root)
            .join(".conduit")
            .join("work-items")
            .join(&c.id);
        assert!(wid.is_dir());
        assert!(board.start_workflow(&root, &c.id, "human").is_err());
    }

    #[test]
    fn advance_walks_to_gate_then_human_resolves() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let c = board.add_card(&root, "x", "", "todo", "human").unwrap();
        board.start_workflow(&root, &c.id, "human").unwrap();
        let a = board
            .advance(&root, &c.id, Outcome::Completed, "s2", "discovery done")
            .unwrap();
        assert_eq!(a.workflow.as_ref().unwrap().stage, Stage::RequirementDraft);
        let b = board
            .advance(&root, &c.id, Outcome::Completed, "s2", "draft done")
            .unwrap();
        assert_eq!(
            b.workflow.as_ref().unwrap().stage,
            Stage::BusinessClarification
        );
        assert!(board
            .advance(&root, &c.id, Outcome::Completed, "s2", "")
            .is_err());
        let approved = board.resolve_gate(&root, &c.id, true, "human").unwrap();
        assert_eq!(approved.workflow.as_ref().unwrap().stage, Stage::UxInput);
        assert!(approved.workflow.as_ref().unwrap().history.len() >= 4);
    }

    #[test]
    fn claim_briefing_carries_role_and_reads_for_workflow_cards() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let c = board.add_card(&root, "x", "", "todo", "human").unwrap();
        let plain = board.claim_briefing(&root, &c.id).unwrap();
        assert!(plain.persona.is_none());
        board.start_workflow(&root, &c.id, "human").unwrap();
        let b = board.claim_briefing(&root, &c.id).unwrap();
        assert_eq!(b.role.as_deref(), Some("delivery-planner"));
        let persona = b.persona.as_ref().unwrap().to_lowercase();
        assert!(persona.contains("delivery planner") || persona.contains("delivery-planner"));
        assert!(b.reads.iter().any(|r| r.contains("request.md")));
    }
}
