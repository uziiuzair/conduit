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
    Completed,
    Approved,
    ChangesRequested,
    FailedChecks,
    DesignConflict,
    UxConflict,
    Accepted,
}

/// The result of applying an outcome to a stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "stage")]
pub enum Transition {
    Advance(Stage),
    HumanGate(Stage),
    Rework(Stage),
    Done,
    Illegal,
}

/// Is this stage a human checkpoint (the machine must stop here until a human acts)?
pub fn is_human_gate(stage: Stage) -> bool {
    matches!(stage, Stage::BusinessClarification | Stage::Blocked)
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
        assert_eq!(next(Implementation, Outcome::Approved), Transition::Illegal);
        assert_eq!(next(Done, Outcome::Completed), Transition::Illegal);
        assert_eq!(next(Verification, Outcome::Completed), Transition::Illegal);
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
