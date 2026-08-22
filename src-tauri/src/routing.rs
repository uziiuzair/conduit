//! Agent routing preferences: which agent and model should take which kind of work.
//!
//! A session picks one agent at creation and runs everything on it, so in practice a single
//! subscription absorbs planning, implementation, review and mechanical edits alike -- the
//! most expensive way to buy those tokens and the fastest way to close a five-hour window.
//!
//! A ROUTE maps a task kind to an ORDERED list of targets (an agent, optionally a model).
//! The order is the fallback chain, and one mechanism covers three questions that are
//! otherwise asked separately: what do I prefer, what if it is not installed, and what if I
//! have hit my limit.
//!
//! This module owns the first of the two decisions in that sentence -- WHAT the preferences
//! are (defaults, overlaid by global, overlaid by per-project). WHICH target is usable right
//! now depends on live quota and belongs to `src/routing.ts`, next to the usage snapshot and
//! the dialog that renders it. Neither side re-implements the other; see the design doc.
//!
//! Design: docs/superpowers/specs/2026-08-23-agent-routing-preferences-design.md

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::agent::AgentId;

/// The kinds of work a session is created to do.
///
/// Five, deliberately. Each is a distinction people already make out loud when they say what
/// they want, and each has a different right answer. "Debugging" was considered and cut: in
/// practice it routes exactly like implementation, and a distinction nobody can apply
/// consistently is a setting nobody sets correctly.
#[derive(
    Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Default,
)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    /// Decide before writing. The strongest reasoning earns its cost here.
    Planning,
    /// Write the code. Wants speed and volume more than peak reasoning.
    #[default]
    Implementation,
    /// Check the work. Short, frequent, cheap.
    Review,
    /// Find things out. Large context, low stakes, no reason to spend a coding quota.
    Research,
    /// Mechanical, repetitive, high-volume. The obvious home for a $0 local model.
    Bulk,
}

impl TaskKind {
    /// Every kind, in the order the settings UI lists them (roughly the order work happens).
    pub const ALL: [TaskKind; 5] = [
        TaskKind::Planning,
        TaskKind::Implementation,
        TaskKind::Review,
        TaskKind::Research,
        TaskKind::Bulk,
    ];

    pub fn label(self) -> &'static str {
        match self {
            TaskKind::Planning => "Planning",
            TaskKind::Implementation => "Implementation",
            TaskKind::Review => "Review",
            TaskKind::Research => "Research",
            TaskKind::Bulk => "Bulk / mechanical",
        }
    }

    /// One line on what belongs here, shown under the picker.
    pub fn hint(self) -> &'static str {
        match self {
            TaskKind::Planning => "Design, architecture, deciding an approach before writing.",
            TaskKind::Implementation => "Writing and changing code.",
            TaskKind::Review => "Reading a diff, running checks, catching mistakes.",
            TaskKind::Research => {
                "Reading docs, exploring an unfamiliar codebase, finding things out."
            }
            TaskKind::Bulk => {
                "Repetitive edits across many files, migrations, mechanical refactors."
            }
        }
    }
}

/// One step in a fallback chain: an agent, and optionally the model to pin on it.
///
/// `model` is the agent's own identifier -- `sonnet` for Claude, `deepseek/deepseek-v4-flash`
/// for Command Code -- because that is what its `--model` flag takes. None means "whatever
/// that agent is already configured to use", which is the right default for an agent whose
/// model choice lives in its own settings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouteTarget {
    pub agent: AgentId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl RouteTarget {
    fn new(agent: AgentId, model: Option<&str>) -> Self {
        Self {
            agent,
            model: model.map(str::to_string),
        }
    }
}

/// A task kind's ordered fallback chain. An empty chain means "no preference": the caller
/// falls back to whatever it would have done without routing at all.
pub type Chain = Vec<RouteTarget>;

/// A full routing table. Sparse on purpose: a scope only stores the kinds it actually
/// overrides, so a project that pins `review` alone keeps inheriting everything else --
/// including later changes to the defaults.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(transparent)]
pub struct AgentRoutes {
    pub by_task: HashMap<TaskKind, Chain>,
}

/// The built-in table, derived from the strengths already recorded in
/// `agent::capability_card` -- so an opinion about an agent lives in one place rather than
/// being invented twice.
///
/// Two rules shaped these chains beyond "best first":
///
/// - **The second entry is a DIFFERENT agent wherever one exists.** Three Claude models in a
///   row is not a fallback chain: when Claude's five-hour window closes it closes on all
///   three at once. Command Code sits second almost everywhere precisely because it reaches
///   the same frontier models through a separate subscription.
/// - **Uninstalled agents are fine to name.** Resolution skips them, so listing an agent
///   someone does not have costs nothing and makes the chain right the day they install it.
pub fn default_routes() -> AgentRoutes {
    use AgentId::*;
    let mut by_task = HashMap::new();

    // Planning: peak reasoning, and it is worth paying for -- planning is a small fraction
    // of tokens and decides how the rest are spent.
    by_task.insert(
        TaskKind::Planning,
        vec![
            RouteTarget::new(Claude, Some("opus")),
            RouteTarget::new(CommandCode, Some("claude-opus-5")),
            RouteTarget::new(Codex, None),
        ],
    );

    // Implementation: Claude's own card calls Sonnet the best speed/intelligence combination,
    // and this is where the volume is.
    by_task.insert(
        TaskKind::Implementation,
        vec![
            RouteTarget::new(Claude, Some("sonnet")),
            RouteTarget::new(CommandCode, Some("claude-sonnet-5")),
            RouteTarget::new(Codex, None),
        ],
    );

    // Review: short and frequent, so the cheap fast model, then a $0 local one. OpenCode
    // ranks here rather than lower because its card notes it feeds LSP diagnostics back to
    // the model -- which is most of what a review pass is doing anyway.
    by_task.insert(
        TaskKind::Review,
        vec![
            RouteTarget::new(Claude, Some("haiku")),
            RouteTarget::new(CommandCode, Some("claude-haiku-4-5")),
            RouteTarget::new(OpenCode, None),
        ],
    );

    // Research: there is no reason for reading and exploring to spend a coding quota.
    // Gemini-family models are cheap and long-context; agy is the supported way to reach
    // them (the Gemini CLI is EOL per its own capability card).
    by_task.insert(
        TaskKind::Research,
        vec![
            RouteTarget::new(Antigravity, None),
            RouteTarget::new(CommandCode, Some("google/gemini-3.7-flash")),
            RouteTarget::new(Gemini, None),
        ],
    );

    // Bulk: mechanical work is exactly what a local model is for, and what every card warns
    // against spending a frontier quota on.
    by_task.insert(
        TaskKind::Bulk,
        vec![
            RouteTarget::new(OpenCode, None),
            RouteTarget::new(CommandCode, Some("deepseek/deepseek-v4-flash")),
            RouteTarget::new(Antigravity, None),
        ],
    );

    AgentRoutes { by_task }
}

/// Overlay `over` on `base`, per task kind.
///
/// Whole-chain replacement, not element merging: a chain is an ordered preference, and
/// "merging" two orderings has no meaning anyone could predict. Overriding `review` in a
/// project therefore replaces that one chain and leaves the other four inherited -- which is
/// what makes a later change to the defaults still reach a project that customized one kind.
pub fn merge(base: &AgentRoutes, over: &AgentRoutes) -> AgentRoutes {
    let mut out = base.clone();
    for (task, chain) in &over.by_task {
        out.by_task.insert(*task, chain.clone());
    }
    out
}

/// The table a project actually runs on: defaults, then global, then the project.
pub fn effective(global: &AgentRoutes, project: Option<&AgentRoutes>) -> AgentRoutes {
    let merged = merge(&default_routes(), global);
    match project {
        Some(p) => merge(&merged, p),
        None => merged,
    }
}

/// Everything the settings UI needs in one call.
///
/// All four tables are sent, not just the effective one, because the UI has to show WHERE a
/// chain came from -- a panel that cannot distinguish "inherited from the defaults" from
/// "pinned in this project" cannot offer a meaningful Reset.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutesView {
    /// Defaults + global + project, with every task kind present.
    pub effective: AgentRoutes,
    /// The built-in table, so the UI can label a chain as unmodified.
    pub defaults: AgentRoutes,
    /// Overrides pinned globally (sparse).
    pub global: AgentRoutes,
    /// Overrides pinned on this project (sparse; empty when no project was named).
    pub project: AgentRoutes,
}

/// One task kind, described for the UI so the labels are not duplicated in TypeScript.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskKindInfo {
    pub id: TaskKind,
    pub label: &'static str,
    pub hint: &'static str,
}

/// Tauri command: the routing tables for a project (or global-only when `project_id` is None).
#[tauri::command]
pub fn agent_routes(
    project_id: Option<String>,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> RoutesView {
    let global = store.global_routes();
    let project = project_id
        .as_deref()
        .map(|id| store.project_routes(id))
        .unwrap_or_default();
    RoutesView {
        effective: effective(&global, Some(&project)),
        defaults: default_routes(),
        global,
        project,
    }
}

/// Tauri command: pin or clear one task kind's chain.
///
/// `chain: None` CLEARS the override so the scope inherits again. That is deliberately not
/// the same as an empty chain, which would mean "this kind routes nowhere" -- the UI needs
/// both, and collapsing them would make Reset impossible to express.
#[tauri::command]
pub fn set_agent_route(
    project_id: Option<String>,
    task: TaskKind,
    chain: Option<Chain>,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> RoutesView {
    match project_id.as_deref() {
        Some(id) => store.set_project_route(id, task, chain),
        None => store.set_global_route(task, chain),
    }
    agent_routes(project_id, store)
}

/// Tauri command: the task kinds and their copy, so labels live in one language.
#[tauri::command]
pub fn task_kinds() -> Vec<TaskKindInfo> {
    TaskKind::ALL
        .into_iter()
        .map(|id| TaskKindInfo {
            id,
            label: id.label(),
            hint: id.hint(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_task_kind_has_a_default_chain() {
        let d = default_routes();
        for task in TaskKind::ALL {
            let chain = d.by_task.get(&task).unwrap_or_else(|| {
                panic!("{task:?} has no default chain, so choosing it would do nothing")
            });
            assert!(!chain.is_empty(), "{task:?} chain is empty");
        }
        assert_eq!(d.by_task.len(), TaskKind::ALL.len());
    }

    #[test]
    fn a_chain_never_stacks_one_agent_against_its_own_quota() {
        // The point of a fallback is to survive an exhausted window, and one agent's
        // windows all close together. Every default chain must therefore reach a second
        // AGENT, not merely a second model.
        for (task, chain) in default_routes().by_task {
            let first = chain[0].agent;
            assert!(
                chain.iter().any(|t| t.agent != first),
                "{task:?} falls back only within {first:?}, which shares one quota"
            );
        }
    }

    #[test]
    fn defaults_name_only_agents_that_exist() {
        // A chain naming an agent the registry does not have would silently never resolve.
        let known: Vec<AgentId> = crate::agent::all_adapters()
            .iter()
            .map(|a| a.id())
            .collect();
        for (task, chain) in default_routes().by_task {
            for t in chain {
                assert!(
                    known.contains(&t.agent),
                    "{task:?} names unknown {:?}",
                    t.agent
                );
            }
        }
    }

    #[test]
    fn project_overrides_global_overrides_defaults() {
        let mut global = AgentRoutes::default();
        global.by_task.insert(
            TaskKind::Review,
            vec![RouteTarget::new(AgentId::Codex, None)],
        );
        let mut project = AgentRoutes::default();
        project.by_task.insert(
            TaskKind::Review,
            vec![RouteTarget::new(AgentId::OpenCode, None)],
        );

        let g = effective(&global, None);
        assert_eq!(g.by_task[&TaskKind::Review][0].agent, AgentId::Codex);

        let p = effective(&global, Some(&project));
        assert_eq!(p.by_task[&TaskKind::Review][0].agent, AgentId::OpenCode);
        // The kinds nobody overrode still come from the defaults, so improving a default
        // later still reaches this project.
        assert_eq!(
            p.by_task[&TaskKind::Planning],
            default_routes().by_task[&TaskKind::Planning]
        );
    }

    #[test]
    fn an_override_replaces_a_chain_rather_than_merging_into_it() {
        // Merging two orderings has no predictable meaning. Pinning review to a single
        // target must yield exactly one target, not that target plus the inherited tail.
        let mut project = AgentRoutes::default();
        project.by_task.insert(
            TaskKind::Review,
            vec![RouteTarget::new(AgentId::OpenCode, None)],
        );
        let r = effective(&AgentRoutes::default(), Some(&project));
        assert_eq!(r.by_task[&TaskKind::Review].len(), 1);
    }

    #[test]
    fn empty_scopes_change_nothing() {
        assert_eq!(effective(&AgentRoutes::default(), None), default_routes());
        assert_eq!(
            effective(&AgentRoutes::default(), Some(&AgentRoutes::default())),
            default_routes()
        );
    }

    #[test]
    fn routes_survive_a_json_round_trip() {
        // These persist in state.json, so the wire form is part of the contract -- and the
        // frontend resolver reads exactly this shape.
        let routes = default_routes();
        let json = serde_json::to_string(&routes).expect("serialize");
        let back: AgentRoutes = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, routes);
        // Task kinds are the JSON object's KEYS, so they must be plain lowercase strings.
        assert!(json.contains("\"implementation\""), "got {json}");
        assert!(json.contains("\"agent\":\"commandcode\""), "got {json}");
    }

    #[test]
    fn a_target_without_a_model_omits_the_key() {
        // `null` and "absent" must not both appear on the wire: the frontend treats absent
        // as "leave the agent's own model choice alone", and two spellings of that invite a
        // consumer to handle only one.
        let t = RouteTarget::new(AgentId::OpenCode, None);
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            r#"{"agent":"opencode"}"#
        );
    }
}
