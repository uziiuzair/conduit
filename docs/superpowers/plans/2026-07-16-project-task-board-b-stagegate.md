# Project Task Board — Plan B: Stage-Gate + Knowledge Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any board card *opt into* the reference project's stage-gate workflow (discovery → requirements → UX → architecture → plan → build → verify), so the session that claims it is handed that stage's role briefing inline, produces the stage artifact under `.conduit/work-items/<id>/`, and advances the card through an authoritative Rust state machine that stops at human gates — backed by a per-project OKF knowledge bundle.

**Architecture:** A pure `stage_machine` module encodes the transition table (advance / human-gate / rework / done) as a tested function. `TaskBoard` gains a typed `Workflow` on the card, `start_workflow`/`advance`/`resolve_gate` methods, and asset writers that scaffold `.conduit/agents/` (5 role personas, bundled via `include_str!`), `.conduit/work-items/<id>/`, and `.conduit/knowledge/` (OKF). `task_claim` returns the role briefing for a workflow card; new `task_workflow_start` / `task_advance` MCP tools drive the machine; the board UI shows a stage sub-badge and a "needs you" gate badge with an approve/request-changes action.

**Tech Stack:** Rust (state machine + `include_str!` assets), React/TypeScript (badges + gate action). No new dependencies.

**Depends on:** Plan A (`2026-07-16-project-task-board-a-substrate.md`) must be complete — this plan extends `tasks/mod.rs`, the `task_*` MCP surface, and `BoardCard.tsx`.

**Spec:** `docs/superpowers/specs/2026-07-16-project-task-board-design.md` (§"Stage-gate" and §"Role personas + OKF knowledge").

---

## Reference: the ported state table

From the reference `WORKFLOW.md`. `stage_machine::next(stage, outcome)` is the single source of truth; personas only guide the session.

| Stage | Role (briefing) | Reads | On success → | Human gate? |
|---|---|---|---|---|
| `requested` | (intake) | — | `discovery` | no |
| `discovery` | delivery-planner | request, knowledge/components, knowledge/domain | `requirement_draft` | no |
| `requirement_draft` | delivery-planner | discovery | `business_clarification` | no |
| `business_clarification` | — (human) | requirements | `ux_input` (approved) / `requirement_draft` (changes) | **yes** |
| `ux_input` | ux-designer | requirements, knowledge/patterns(ux) | `architecture_input` | no |
| `architecture_input` | solution-architect | requirements, ux-spec, knowledge/decisions, patterns(arch), anti-patterns | `implementation_plan` | no |
| `implementation_plan` | delivery-planner | architecture, ux-spec | `implementation` | no |
| `implementation` | implementer | implementation-plan | `verification` | no |
| `verification` | implementer | code, architecture, ux-spec, knowledge/decisions, anti-patterns | `done` (accepted) / rework | **yes (accept)** |
| `blocked` | — (human) | clarifications | `resume_state` | **yes** |
| `done` | — | — | terminal | no |

Rework edges (from `verification`): failing checks → `implementation`; design wrong → `architecture_input`; UX wrong → `ux_input`. From `business_clarification` (changes) → `requirement_draft`.

---

## File Structure

**Rust (`src-tauri/src/`):**
- Create `tasks/stage_machine.rs` — `Stage`, `Outcome`, `Transition`, `next()`, `role_of()`, `reads_of()`. Pure + tested.
- Create `tasks/personas/*.md` (5 files) — role briefings, bundled with `include_str!`.
- Modify `tasks/mod.rs` — typed `Workflow`, `start_workflow`, `advance`, `resolve_gate`, `ensure_agents`, `ensure_knowledge`, `claim_briefing`.
- Modify `fleet_mcp.rs` — `task_workflow_start`, `task_advance` tools; enrich `task_claim` reply.
- Modify `lib.rs` — `board_resolve_gate` command (+ `board_start_workflow`).

**Frontend (`src/`):**
- Modify `components/BoardCard.tsx` — stage sub-badge + "needs you" badge.
- Create `components/GateAction.tsx` — approve / request-changes control shown on a gated card.
- Modify `store.ts` — `Workflow` type on `BoardCard`.

**Data (runtime, into each project repo):**
- `<repo>/.conduit/agents/{orchestrator,delivery-planner,ux-designer,solution-architect,implementer}.md`
- `<repo>/.conduit/work-items/<card-id>/{discovery,requirements,clarifications,ux-spec,architecture,implementation-plan,implementation-log,verification-report}.md`
- `<repo>/.conduit/knowledge/{index.md,log.md,decisions/,patterns/,anti-patterns/,domain/,components/}`

---

## Task 1: `stage_machine` — stages, outcomes, transition table

**Files:**
- Create: `src-tauri/src/tasks/stage_machine.rs`

- [ ] **Step 1: Write the failing tests (table + machine together)**

```rust
//! The authoritative stage-gate transition table, ported from the reference WORKFLOW.md.
//! Pure: no IO, no session judgement. `TaskBoard::advance` calls `next()` and refuses any
//! transition the table doesn't allow, so a mis-behaving agent cannot skip a human gate.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Requested,
    Discovery,
    RequirementDraft,
    BusinessClarification,
    UxInput,
    ArchitectureInput,
    ImplementationPlan,
    Implementation,
    Verification,
    Blocked,
    Done,
}

/// What the acting session (or human, at a gate) reports happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The stage's work is complete; advance along the happy path.
    Completed,
    /// Human approved at a gate.
    Approved,
    /// Human requested changes at a gate.
    ChangesRequested,
    /// Verification failed on automated checks → back to implementation.
    FailedChecks,
    /// Verification found the design wrong → back to architecture.
    DesignConflict,
    /// Verification found the UX spec wrong → back to UX.
    UxConflict,
    /// Human accepted the verification report → done.
    Accepted,
}

/// The result of applying an outcome to a stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "stage")]
pub enum Transition {
    /// Move to an agent-owned stage; the orchestrator may auto-chain.
    Advance(Stage),
    /// Move to a stage that is a human checkpoint; stop and wait.
    HumanGate(Stage),
    /// Move backward for rework.
    Rework(Stage),
    /// Terminal.
    Done,
    /// The outcome is illegal for this stage.
    Illegal,
}

/// Is this stage a human checkpoint (the machine must stop here until a human acts)?
pub fn is_human_gate(stage: Stage) -> bool {
    matches!(stage, Stage::BusinessClarification | Stage::Blocked)
        // Verification is a gate only for its *acceptance*; the self-check itself is agent work.
}

/// The role whose briefing a claiming session receives at this stage; `None` at human gates
/// and terminal/intake stages.
pub fn role_of(stage: Stage) -> Option<&'static str> {
    match stage {
        Stage::Discovery | Stage::RequirementDraft | Stage::ImplementationPlan => Some("delivery-planner"),
        Stage::UxInput => Some("ux-designer"),
        Stage::ArchitectureInput => Some("solution-architect"),
        Stage::Implementation | Stage::Verification => Some("implementer"),
        _ => None,
    }
}

/// The artifacts a session should read at this stage (relative to the work-item dir or the
/// knowledge bundle), mirroring WORKFLOW.md's "Reads" column.
pub fn reads_of(stage: Stage) -> &'static [&'static str] {
    match stage {
        Stage::Discovery => &["request.md", "knowledge/components/", "knowledge/domain/"],
        Stage::RequirementDraft => &["discovery.md"],
        Stage::UxInput => &["requirements.md", "knowledge/patterns/"],
        Stage::ArchitectureInput => &["requirements.md", "ux-spec.md", "knowledge/decisions/", "knowledge/patterns/", "knowledge/anti-patterns/"],
        Stage::ImplementationPlan => &["architecture.md", "ux-spec.md"],
        Stage::Implementation => &["implementation-plan.md"],
        Stage::Verification => &["architecture.md", "ux-spec.md", "knowledge/decisions/", "knowledge/anti-patterns/"],
        _ => &[],
    }
}

pub fn next(stage: Stage, outcome: Outcome) -> Transition {
    use Outcome::*;
    use Stage::*;
    match (stage, outcome) {
        (Requested, Completed) => Transition::Advance(Discovery),
        (Discovery, Completed) => Transition::Advance(RequirementDraft),
        (RequirementDraft, Completed) => Transition::HumanGate(BusinessClarification),
        (BusinessClarification, Approved) => Transition::Advance(UxInput),
        (BusinessClarification, ChangesRequested) => Transition::Rework(RequirementDraft),
        (UxInput, Completed) => Transition::Advance(ArchitectureInput),
        (ArchitectureInput, Completed) => Transition::Advance(ImplementationPlan),
        (ImplementationPlan, Completed) => Transition::Advance(Implementation),
        (Implementation, Completed) => Transition::Advance(Verification),
        (Verification, Accepted) => Transition::Done,
        (Verification, FailedChecks) => Transition::Rework(Implementation),
        (Verification, DesignConflict) => Transition::Rework(ArchitectureInput),
        (Verification, UxConflict) => Transition::Rework(UxInput),
        _ => Transition::Illegal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Stage::*;

    #[test]
    fn happy_path_runs_requested_to_done() {
        // Drive the machine along the happy path, supplying the gate answers a human would.
        let mut stage = Requested;
        let script = [
            (Outcome::Completed, Discovery),
            (Outcome::Completed, RequirementDraft),
            (Outcome::Completed, BusinessClarification),
            (Outcome::Approved, UxInput),
            (Outcome::Completed, ArchitectureInput),
            (Outcome::Completed, ImplementationPlan),
            (Outcome::Completed, Implementation),
            (Outcome::Completed, Verification),
        ];
        for (outcome, expect) in script {
            let t = next(stage, outcome);
            stage = match t {
                Transition::Advance(s) | Transition::HumanGate(s) => s,
                other => panic!("unexpected {other:?} at {stage:?}"),
            };
            assert_eq!(stage, expect);
        }
        assert_eq!(next(Verification, Outcome::Accepted), Transition::Done);
    }

    #[test]
    fn business_clarification_is_a_human_gate() {
        assert!(is_human_gate(BusinessClarification));
        assert_eq!(next(RequirementDraft, Outcome::Completed), Transition::HumanGate(BusinessClarification));
    }

    #[test]
    fn changes_requested_reworks_back_to_draft() {
        assert_eq!(next(BusinessClarification, Outcome::ChangesRequested), Transition::Rework(RequirementDraft));
    }

    #[test]
    fn verification_rework_targets_match_the_failure() {
        assert_eq!(next(Verification, Outcome::FailedChecks), Transition::Rework(Implementation));
        assert_eq!(next(Verification, Outcome::DesignConflict), Transition::Rework(ArchitectureInput));
        assert_eq!(next(Verification, Outcome::UxConflict), Transition::Rework(UxInput));
    }

    #[test]
    fn illegal_transitions_are_rejected() {
        // You cannot "approve" your way out of implementation, or complete a terminal stage.
        assert_eq!(next(Implementation, Outcome::Approved), Transition::Illegal);
        assert_eq!(next(Done, Outcome::Completed), Transition::Illegal);
        assert_eq!(next(Verification, Outcome::Completed), Transition::Illegal); // needs Accepted, not Completed
    }

    #[test]
    fn roles_match_the_reference_table() {
        assert_eq!(role_of(Discovery), Some("delivery-planner"));
        assert_eq!(role_of(UxInput), Some("ux-designer"));
        assert_eq!(role_of(ArchitectureInput), Some("solution-architect"));
        assert_eq!(role_of(Implementation), Some("implementer"));
        assert_eq!(role_of(BusinessClarification), None);
    }
}
```

- [ ] **Step 2: Wire + run**

Add `pub mod stage_machine;` to `tasks/mod.rs`. Run: `cargo test --manifest-path src-tauri/Cargo.toml stage_machine::`
Expected: PASS (6 tests).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tasks/stage_machine.rs src-tauri/src/tasks/mod.rs
git commit -m "feat(board): stage-gate transition machine (ported from reference WORKFLOW.md)"
```

---

## Task 2: Typed `Workflow` on the card

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Replace `workflow: Option<Value>` with a typed struct + test**

In `tasks/mod.rs`, add and swap the `Card.workflow` field type:

```rust
use crate::tasks::stage_machine::{Stage, Transition};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistory {
    pub at: u64,
    pub by: String,
    pub from: Stage,
    pub to: Stage,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub kind: String,              // always "stage-gate" in this plan
    pub stage: Stage,
    #[serde(default)]
    pub resume_state: Option<Stage>,
    #[serde(default)]
    pub blocked_question: Option<String>,
    #[serde(default)]
    pub history: Vec<WorkflowHistory>,
}
```

Change `Card.workflow` to `pub workflow: Option<Workflow>,` (was `Option<Value>` in Plan A). Update the `card_yaml_round_trip` test if needed so it still passes with `workflow: None`.

```rust
    #[test]
    fn workflow_round_trips_with_stage_and_history() {
        let wf = Workflow {
            kind: "stage-gate".into(),
            stage: Stage::ArchitectureInput,
            resume_state: None,
            blocked_question: None,
            history: vec![WorkflowHistory { at: 1, by: "s2", from: Stage::UxInput, to: Stage::ArchitectureInput, note: "ux done".into() }.into_owned_by()],
        };
        let yaml = serde_yaml::to_string(&wf).unwrap();
        assert!(yaml.contains("stage: architecture_input"), "got:\n{yaml}");
        let back: Workflow = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(wf, back);
    }
```

> Simplify the test literal — construct `WorkflowHistory` directly with `by: "s2".into()`; drop the `.into_owned_by()` pseudo-call above (it was shorthand). The point is the round-trip asserts `stage: architecture_input` snake_case serialization.

- [ ] **Step 2: Run**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::workflow_round_trips`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): typed Workflow (stage + history) on the card"
```

---

## Task 3: Bundle the 5 role personas + `ensure_agents`

**Files:**
- Create: `src-tauri/src/tasks/personas/{orchestrator,delivery-planner,ux-designer,solution-architect,implementer}.md`
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Add the persona files**

Copy the five role definitions from the reference project
(`~/ooozzy/Experiments/agent-development/.claude/agents/*.md`) into
`src-tauri/src/tasks/personas/`, reframing the permissions for Conduit:

- Replace "set `item.yaml.status`" language with "call `task_advance` / never advance past a human gate".
- Replace "write `discovery.md`" etc. with "write the artifact under your work-item dir (path is in your claim briefing)".
- Keep the OKF read-before-propose / promote-after duties verbatim.

Each file is a self-contained briefing a claiming session reads. Example header for
`delivery-planner.md`:

```markdown
# Role: Delivery Planner (stage-gate card)

You have claimed a task-board card whose current stage you own. Do ONLY this stage's work,
then report the outcome via `task_advance`. You never write code and never make UX or
architecture decisions.

## This stage
- **discovery** → write `discovery.md`; then `task_advance(outcome="completed")`.
- **requirement_draft** → write `requirements.md` (BABOK split); `task_advance(outcome="completed")`
  moves the card to the human `business_clarification` gate.
- **implementation_plan** → write `implementation-plan.md`; `task_advance(outcome="completed")`.

## Before proposing
Read the paths listed in your claim briefing (the knowledge bundle categories for this
stage). Don't re-derive what `knowledge/components` or `knowledge/domain` already records.

## If blocked
If a requirement is ambiguous or you need a human decision, call
`task_advance(outcome="blocked", question="…")` — do not guess.
```

Author the other four analogously from their reference `.md` files.

- [ ] **Step 2: `ensure_agents` writes them into `.conduit/agents/` (idempotent)**

In `tasks/mod.rs`:

```rust
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

impl TaskBoard {
    fn agents_dir(project_root: &str) -> PathBuf {
        Path::new(project_root).join(".conduit").join("agents")
    }
    /// Write the bundled role personas into `.conduit/agents/`. Overwrites so a Conduit
    /// upgrade ships improved briefings; the files are Conduit-managed, not user-edited.
    pub fn ensure_agents(&self, project_root: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        fs::create_dir_all(Self::agents_dir(project_root)).map_err(|e| e.to_string())?;
        for (name, body) in PERSONAS {
            Self::write_atomic(&Self::agents_dir(project_root).join(format!("{name}.md")), body.as_bytes())?;
        }
        Ok(())
    }
    fn persona_for(role: &str) -> Option<&'static str> {
        PERSONAS.iter().find(|(n, _)| *n == role).map(|(_, b)| *b)
    }
}
```

Test:

```rust
    #[test]
    fn ensure_agents_writes_all_five_personas() {
        let root = tmp_root();
        let board = TaskBoard::default();
        board.ensure_agents(&root).unwrap();
        for name in ["orchestrator","delivery-planner","ux-designer","solution-architect","implementer"] {
            let p = std::path::Path::new(&root).join(".conduit").join("agents").join(format!("{name}.md"));
            assert!(p.exists(), "missing {name}");
        }
    }
```

- [ ] **Step 3: Run + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::ensure_agents`
Expected: PASS.

```bash
git add src-tauri/src/tasks/personas src-tauri/src/tasks/mod.rs
git commit -m "feat(board): bundle 5 role personas + ensure_agents scaffolding"
```

---

## Task 4: OKF knowledge scaffold (`ensure_knowledge`)

**Files:**
- Create: `src-tauri/src/tasks/knowledge/{index.md,log.md}` (bundled templates)
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Bundle the two index templates + write the scaffold**

Copy `knowledge/index.md` and `knowledge/log.md` structure from the reference project into
`src-tauri/src/tasks/knowledge/`. Then:

```rust
const KNOWLEDGE_INDEX: &str = include_str!("knowledge/index.md");
const KNOWLEDGE_LOG: &str = include_str!("knowledge/log.md");

impl TaskBoard {
    fn knowledge_dir(project_root: &str) -> PathBuf {
        Path::new(project_root).join(".conduit").join("knowledge")
    }
    /// Scaffold the OKF bundle: index.md, log.md, and the five (empty) category dirs. Never
    /// overwrites an existing index/log (they accrue project history). Idempotent.
    pub fn ensure_knowledge(&self, project_root: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let kd = Self::knowledge_dir(project_root);
        for cat in ["decisions","patterns","anti-patterns","domain","components"] {
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
}
```

Test:

```rust
    #[test]
    fn ensure_knowledge_scaffolds_okf_bundle_once() {
        let root = tmp_root();
        let board = TaskBoard::default();
        board.ensure_knowledge(&root).unwrap();
        let kd = std::path::Path::new(&root).join(".conduit").join("knowledge");
        assert!(kd.join("index.md").exists());
        assert!(kd.join("decisions").is_dir());
        // Second call must not overwrite index.md — write a marker then re-run.
        std::fs::write(kd.join("index.md"), "EDITED").unwrap();
        board.ensure_knowledge(&root).unwrap();
        assert_eq!(std::fs::read_to_string(kd.join("index.md")).unwrap(), "EDITED");
    }
```

- [ ] **Step 2: Run + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::ensure_knowledge`
Expected: PASS.

```bash
git add src-tauri/src/tasks/knowledge src-tauri/src/tasks/mod.rs
git commit -m "feat(board): OKF knowledge bundle scaffold (ensure_knowledge)"
```

---

## Task 5: `start_workflow` + work-item dir

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

```rust
impl TaskBoard {
    fn work_item_dir(project_root: &str, card_id: &str) -> PathBuf {
        Path::new(project_root).join(".conduit").join("work-items").join(card_id)
    }

    /// Attach a fresh stage-gate workflow to a card (starting at `discovery`), scaffolding the
    /// agents, knowledge bundle, and this card's work-item dir. Idempotent per card: if the
    /// card already has a workflow, this errors rather than resetting its progress.
    pub fn start_workflow(&self, project_root: &str, card_id: &str, by: &str) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut card = Self::load_card(project_root, card_id)?;
        if card.workflow.is_some() {
            return Err("card already has a workflow".into());
        }
        // Scaffold shared + per-card assets (drop the lock guards inside these helpers by
        // inlining their bodies here, or refactor them to `_locked` variants — they must not
        // re-lock `self.lock`).
        fs::create_dir_all(Self::agents_dir(project_root)).ok();
        for (name, body) in PERSONAS {
            let _ = Self::write_atomic(&Self::agents_dir(project_root).join(format!("{name}.md")), body.as_bytes());
        }
        let kd = Self::knowledge_dir(project_root);
        for cat in ["decisions","patterns","anti-patterns","domain","components"] { let _ = fs::create_dir_all(kd.join(cat)); }
        if !kd.join("index.md").exists() { let _ = Self::write_atomic(&kd.join("index.md"), KNOWLEDGE_INDEX.as_bytes()); }
        if !kd.join("log.md").exists() { let _ = Self::write_atomic(&kd.join("log.md"), KNOWLEDGE_LOG.as_bytes()); }
        fs::create_dir_all(Self::work_item_dir(project_root, card_id)).map_err(|e| e.to_string())?;

        let now = now_ms();
        card.workflow = Some(Workflow {
            kind: "stage-gate".into(),
            stage: Stage::Discovery,
            resume_state: None,
            blocked_question: None,
            history: vec![WorkflowHistory { at: now, by: by.to_string(), from: Stage::Requested, to: Stage::Discovery, note: "workflow started".into() }],
        });
        card.updated_at = now;
        Self::write_card(project_root, &card)?;
        Ok(card)
    }
}
```

> Refactor note: `ensure_agents`/`ensure_knowledge` each lock `self.lock`; do NOT call them from inside `start_workflow` (double-lock). Either inline as above, or extract lock-free `_locked` helpers and have both the public `ensure_*` and `start_workflow` call those. Pick one and keep it consistent.

Test:

```rust
    #[test]
    fn start_workflow_sets_discovery_and_scaffolds_dirs() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let c = board.add_card(&root, "feature X", "", "todo", "human").unwrap();
        let started = board.start_workflow(&root, &c.id, "human").unwrap();
        assert_eq!(started.workflow.as_ref().unwrap().stage, Stage::Discovery);
        assert!(std::path::Path::new(&root).join(".conduit").join("work-items").join(&c.id).is_dir());
        // A second start is refused.
        assert!(board.start_workflow(&root, &c.id, "human").is_err());
    }
```

- [ ] **Step 2: Run + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::start_workflow`
Expected: PASS.

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): start_workflow attaches stage-gate + scaffolds work-item dir"
```

---

## Task 6: `advance` + `resolve_gate` (drive the machine, stop at gates)

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

```rust
use crate::tasks::stage_machine::{next as sm_next, Outcome, Transition};

impl TaskBoard {
    /// Advance a workflow card by reporting an `outcome` for its current stage. Applies the
    /// transition table; an illegal outcome for the current stage is rejected. Stops (leaves
    /// the card at the gate stage) when it reaches a human gate. Appends history.
    pub fn advance(&self, project_root: &str, card_id: &str, outcome: Outcome, by: &str, note: &str) -> Result<Card, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut card = Self::load_card(project_root, card_id)?;
        let wf = card.workflow.as_mut().ok_or("card has no workflow")?;
        let from = wf.stage;
        let to = match sm_next(from, outcome) {
            Transition::Advance(s) | Transition::HumanGate(s) | Transition::Rework(s) => s,
            Transition::Done => Stage::Done,
            Transition::Illegal => return Err(format!("illegal outcome {outcome:?} for stage {from:?}")),
        };
        wf.stage = to;
        wf.history.push(WorkflowHistory { at: now_ms(), by: by.to_string(), from, to, note: note.to_string() });
        card.updated_at = now_ms();
        Self::write_card(project_root, &card)?;
        Ok(card)
    }

    /// Human resolves a gate: `business_clarification` (approve → ux_input, else → rework) or
    /// `verification` acceptance (accept → done). Only valid when the card sits at a gate.
    pub fn resolve_gate(&self, project_root: &str, card_id: &str, approved: bool, by: &str) -> Result<Card, String> {
        let stage = {
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
}
```

Test:

```rust
    #[test]
    fn advance_walks_to_gate_then_human_resolves() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let c = board.add_card(&root, "x", "", "todo", "human").unwrap();
        board.start_workflow(&root, &c.id, "human").unwrap(); // at Discovery

        let a = board.advance(&root, &c.id, Outcome::Completed, "s2", "discovery done").unwrap();
        assert_eq!(a.workflow.as_ref().unwrap().stage, Stage::RequirementDraft);
        let b = board.advance(&root, &c.id, Outcome::Completed, "s2", "draft done").unwrap();
        assert_eq!(b.workflow.as_ref().unwrap().stage, Stage::BusinessClarification); // gate

        // An agent cannot push past the gate — only resolve_gate can.
        assert!(board.advance(&root, &c.id, Outcome::Completed, "s2", "").is_err());
        let approved = board.resolve_gate(&root, &c.id, true, "human").unwrap();
        assert_eq!(approved.workflow.as_ref().unwrap().stage, Stage::UxInput);
        // History recorded every hop.
        assert!(approved.workflow.as_ref().unwrap().history.len() >= 4);
    }
```

- [ ] **Step 2: Run + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::advance_walks_to_gate`
Expected: PASS.

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): advance + resolve_gate enforce the stage machine + human gates"
```

---

## Task 7: `claim_briefing` — hand the role instructions back on claim

**Files:**
- Modify: `src-tauri/src/tasks/mod.rs`

- [ ] **Step 1: Write the failing test**

```rust
use crate::tasks::stage_machine::{reads_of, role_of};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimBriefing {
    pub card: Card,
    /// Present only for a workflow card at an agent-owned stage.
    pub stage: Option<Stage>,
    pub role: Option<String>,
    pub persona: Option<String>,     // the role .md body
    pub reads: Vec<String>,          // paths to read before proposing
    pub work_item_dir: Option<String>,
}

impl TaskBoard {
    /// The briefing a session receives when it claims a card: the card itself, plus — if the
    /// card is a stage-gate card at an agent-owned stage — the role persona, the read list,
    /// and the work-item dir so the session knows exactly what to produce.
    pub fn claim_briefing(&self, project_root: &str, card_id: &str) -> Result<ClaimBriefing, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut card = Self::load_card(project_root, card_id)?;
        card.claim = Self::read_claim(project_root, card_id);
        let (stage, role, persona, reads, wid) = match card.workflow.as_ref() {
            Some(wf) => {
                let stage = wf.stage;
                let role = role_of(stage).map(|r| r.to_string());
                let persona = role.as_deref().and_then(Self::persona_for).map(|s| s.to_string());
                let reads = reads_of(stage).iter().map(|s| s.to_string()).collect();
                let wid = Some(Self::work_item_dir(project_root, card_id).to_string_lossy().into_owned());
                (Some(stage), role, persona, reads, wid)
            }
            None => (None, None, None, vec![], None),
        };
        Ok(ClaimBriefing { card, stage, role, persona, reads, work_item_dir: wid })
    }
}
```

Test:

```rust
    #[test]
    fn claim_briefing_carries_role_and_reads_for_workflow_cards() {
        let root = tmp_root();
        let board = TaskBoard::default();
        let c = board.add_card(&root, "x", "", "todo", "human").unwrap();
        // Non-workflow card: no persona.
        let plain = board.claim_briefing(&root, &c.id).unwrap();
        assert!(plain.persona.is_none());
        // Workflow card at discovery: delivery-planner persona + discovery reads.
        board.start_workflow(&root, &c.id, "human").unwrap();
        let b = board.claim_briefing(&root, &c.id).unwrap();
        assert_eq!(b.role.as_deref(), Some("delivery-planner"));
        assert!(b.persona.as_ref().unwrap().contains("Delivery Planner"));
        assert!(b.reads.iter().any(|r| r.contains("request.md")));
    }
```

- [ ] **Step 2: Run + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tasks::tests::claim_briefing`
Expected: PASS.

```bash
git add src-tauri/src/tasks/mod.rs
git commit -m "feat(board): claim_briefing returns role persona + reads for workflow cards"
```

---

## Task 8: MCP — enrich `task_claim`, add `task_workflow_start` + `task_advance`

**Files:**
- Modify: `src-tauri/src/fleet_mcp.rs`

- [ ] **Step 1: `task_claim` returns the briefing**

Replace the Plan A `task_claim` arm's success payload so a workflow card hands back the
briefing (the claim still happens first):

```rust
"task_claim" => {
    let root = caller_project_root(ctx)?;
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    let running = ctx.fleet.running_sessions();
    let live = |sid: &str| running.iter().any(|r| r == sid);
    ctx.tasks.claim_card(&root, id, &ctx.conductor_id, &live)?;
    let briefing = ctx.tasks.claim_briefing(&root, id)?;
    emit_board_changed(&ctx.app, &project_id_of(ctx));
    Ok(serde_json::to_string(&briefing).map_err(|e| e.to_string())?)
}
```

- [ ] **Step 2: Add `task_workflow_start` + `task_advance` specs**

```rust
json!({ "name": "task_workflow_start", "description": "Attach the stage-gate workflow to a card (starts at discovery). Use for work that needs the full requirements→architecture→verify pipeline.",
  "inputSchema": {"type":"object","properties":{"id":{"type":"string"}},"required":["id"]} }),
json!({ "name": "task_advance", "description": "Report the outcome of your current stage on a workflow card you have claimed. outcome ∈ completed|blocked|failed_checks|design_conflict|ux_conflict. Stops at human gates.",
  "inputSchema": {"type":"object","properties":{"id":{"type":"string"},"outcome":{"type":"string"},"note":{"type":"string"}},"required":["id","outcome"]} }),
```

- [ ] **Step 3: Add dispatch arms**

`task_advance` is restricted to the session that holds the card's claim:

```rust
"task_workflow_start" => {
    let root = caller_project_root(ctx)?;
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    let card = ctx.tasks.start_workflow(&root, id, &ctx.conductor_id)?;
    emit_board_changed(&ctx.app, &project_id_of(ctx));
    Ok(serde_json::to_string(&card).map_err(|e| e.to_string())?)
}
"task_advance" => {
    let root = caller_project_root(ctx)?;
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
    // Only the claim holder may advance.
    if let Some(c) = ctx.tasks.snapshot(&root).cards.iter().find(|c| c.id == id) {
        match &c.claim {
            Some(cl) if cl.by == ctx.conductor_id => {}
            _ => return Err("advance requires holding this card's claim".into()),
        }
    }
    let outcome = match args.get("outcome").and_then(|v| v.as_str()).ok_or("missing outcome")? {
        "completed" => crate::tasks::stage_machine::Outcome::Completed,
        "failed_checks" => crate::tasks::stage_machine::Outcome::FailedChecks,
        "design_conflict" => crate::tasks::stage_machine::Outcome::DesignConflict,
        "ux_conflict" => crate::tasks::stage_machine::Outcome::UxConflict,
        // "blocked" and gate answers are handled via block/gate paths, not agent advance.
        other => return Err(format!("outcome not allowed from an agent: {other}")),
    };
    let note = args.get("note").and_then(|v| v.as_str()).unwrap_or("");
    let card = ctx.tasks.advance(&root, id, outcome, &ctx.conductor_id, note)?;
    emit_board_changed(&ctx.app, &project_id_of(ctx));
    Ok(serde_json::to_string(&card).map_err(|e| e.to_string())?)
}
```

- [ ] **Step 4: Allow-list + tools-list test**

Add `"task_workflow_start"` and `"task_advance"` to `WORKER_ALLOWED`. Extend the tools-list
assertion test to include the two new names. Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fleet_mcp.rs
git commit -m "feat(board): task_claim briefing + task_workflow_start/advance MCP tools"
```

---

## Task 9: Human gate command + version/changelog

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the gate + workflow-start commands**

```rust
#[tauri::command]
fn board_start_workflow(app: tauri::AppHandle, store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String, id: String) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.start_workflow(&root, &id, "human")?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

#[tauri::command]
fn board_resolve_gate(app: tauri::AppHandle, store: tauri::State<'_, std::sync::Arc<Store>>, board: tauri::State<'_, std::sync::Arc<TaskBoard>>, project_id: String, id: String, approved: bool) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.resolve_gate(&root, &id, approved, "human")?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}
```

Register both in the `invoke_handler!`.

- [ ] **Step 2: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(board): board_start_workflow + board_resolve_gate commands"
```

---

## Task 10: UI — stage badge, gate badge, gate action

**Files:**
- Modify: `src/store.ts`, `src/components/BoardCard.tsx`
- Create: `src/components/GateAction.tsx`

- [ ] **Step 1: Type the workflow on the frontend card**

In `store.ts`, replace `workflow: unknown | null` with:

```ts
export type Stage =
  | "requested" | "discovery" | "requirement_draft" | "business_clarification"
  | "ux_input" | "architecture_input" | "implementation_plan" | "implementation"
  | "verification" | "blocked" | "done";
export interface Workflow {
  kind: string; stage: Stage; resumeState: Stage | null;
  blockedQuestion: string | null;
  history: { at: number; by: string; from: Stage; to: Stage; note: string }[];
}
// on BoardCard: workflow: Workflow | null;
```

- [ ] **Step 2: Stage + gate badges on the card**

In `BoardCard.tsx`, add (import `GateAction`):

```tsx
const wf = card.workflow;
const HUMAN_GATES: Stage[] = ["business_clarification", "blocked"];
const atGate = wf ? HUMAN_GATES.includes(wf.stage) || wf.stage === "verification" : false;
// ...inside the card body, after the title:
{wf && <span className="board-stage">{wf.stage.replace(/_/g, " ")}</span>}
{atGate && <span className="board-gate">needs you</span>}
{atGate && <GateAction projectId={projectId} cardId={card.id} stage={wf!.stage} />}
```

(Thread `projectId` into `BoardCard` props from `BoardColumn`/`BoardView`.)

- [ ] **Step 3: GateAction component**

`src/components/GateAction.tsx`:

```tsx
import { invoke } from "@tauri-apps/api/core";
import type { Stage } from "../store";

export function GateAction({ projectId, cardId, stage }: { projectId: string; cardId: string; stage: Stage }) {
  const approveLabel = stage === "verification" ? "Accept" : "Approve";
  const rejectLabel = stage === "verification" ? "Send back" : "Request changes";
  const resolve = (approved: boolean) =>
    invoke("board_resolve_gate", { projectId, id: cardId, approved });
  return (
    <div className="board-gate-actions">
      <button onClick={() => resolve(true)}>{approveLabel}</button>
      <button onClick={() => resolve(false)}>{rejectLabel}</button>
    </div>
  );
}
```

- [ ] **Step 4: CSS**

Add to `theme.css`:

```css
.board-stage { display:inline-block; margin-top:6px; font-size:10px; padding:1px 6px; border-radius:99px; background:rgba(127,127,127,0.18); text-transform:capitalize; }
.board-gate { display:inline-block; margin:6px 0 0 6px; font-size:10px; padding:1px 6px; border-radius:99px; background:rgba(255,196,0,0.22); color:#e6b800; font-weight:700; }
.board-gate-actions { display:flex; gap:6px; margin-top:6px; }
.board-gate-actions button { font-size:11px; }
```

- [ ] **Step 5: Typecheck + launch verification**

Run: `pnpm exec tsc --noEmit` → no errors. Then:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```
Manual: add a card → in a Claude session call `task_workflow_start` then `task_claim` (confirm the reply carries the delivery-planner persona + reads) → drive `task_advance(outcome="completed")` twice → the card shows `business clarification` + a "needs you" badge → click **Approve** → card advances to `ux_input`. Confirm `.conduit/work-items/<id>/` and `.conduit/agents/*.md` exist in the repo and `.conduit/knowledge/` is scaffolded.

- [ ] **Step 6: Version bump + changelog (MINOR, or fold into the board release)**

If Plan A already shipped a version, either bump a fresh MINOR or, if unreleased, extend the
board changelog entry. Add a bullet:

```
- **Added — Stage-gate cards.** A board card can opt into a full delivery workflow
  (discovery → requirements → UX → architecture → plan → build → verify). The agent that
  claims it is briefed for the current stage, produces the stage's artifact in
  `.conduit/work-items/`, and advances the card through an enforced state machine that stops
  for your sign-off at requirements and verification. Backed by a per-project knowledge
  bundle in `.conduit/knowledge/`.
```

Bump the three version files in lockstep + `cargo build` for `Cargo.lock`; verify with the grep from CLAUDE.md.

- [ ] **Step 7: Commit**

```bash
git add src/store.ts src/components/BoardCard.tsx src/components/GateAction.tsx src/theme.css package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "feat(board): stage + gate badges, human gate approve/reject action; release stage-gate"
```

---

## Self-review notes (coverage against the spec)

- **Stage-gate transition table (ported)** → Task 1 (`stage_machine`, fully tested incl. rework + gates + illegal).
- **Typed workflow on the card + history** → Task 2.
- **"Briefing IS the persona"** → Tasks 3, 7, 8 (`ensure_agents`, `claim_briefing`, enriched `task_claim`).
- **OKF knowledge bundle** → Task 4 (`ensure_knowledge`, never overwrites accrued history).
- **Work-item artifacts** → Task 5 (`start_workflow` scaffolds `work-items/<id>/`).
- **Authoritative advance + human gates** → Task 6 (`advance` rejects illegal/gate-skipping; `resolve_gate` for humans).
- **MCP surface** → Task 8 (`task_workflow_start`, `task_advance`, claim briefing) with claim-holder restriction + allow-list.
- **Human gate UI** → Tasks 9, 10 (`board_resolve_gate` + badges + `GateAction`).
- **Deferred to Inc 2 (correctly absent):** Conductor-per-project drive, orchestration-v2 fold-in, tiered workers.

## Type-consistency check

- `Stage` / `Outcome` / `Transition` names identical across `stage_machine.rs`, `tasks/mod.rs` (`Workflow.stage`), and `store.ts` (`Stage` union) — snake_case serde on both sides.
- `advance(project_root, card_id, outcome, by, note)` signature matches all call sites (Task 6 def, Task 8 MCP arm).
- `claim_briefing` returns `ClaimBriefing`; `task_claim` serializes exactly that (Task 7 def, Task 8 use).
- `board_resolve_gate(project_id, id, approved)` args match `GateAction`'s `invoke` call (Task 9 def, Task 10 use).
