//! Agent provider adapters: how to launch and detect each terminal coding agent.

use std::path::Path;

/// Which coding-agent CLI a session runs. Persisted on each Session; serializes
/// as a lowercase string ("claude"/"codex"). Unknown/absent → Claude (back-compat).
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    #[default]
    Claude,
    Codex,
}

/// Knows how to launch one agent CLI inside Conduit's `sh -c` cold-spawn script.
pub trait ProviderAdapter {
    fn id(&self) -> AgentId;
    /// The binary name to look for on PATH (also used by `detect_agents`).
    fn binary(&self) -> &'static str;
    /// Whether this adapter supports Conduit's `--worktree` isolation (Phase 1: Claude only).
    fn supports_worktree(&self) -> bool {
        false
    }
    /// Extra env vars to set on the child process for this agent.
    fn env_overrides(&self) -> Vec<(&'static str, &'static str)> {
        Vec::new()
    }
    /// The agent command that runs after `cd <dir> &&`, including the `|| <bare>`
    /// fallback. `flags` carries already-quoted extra args (e.g. ` --worktree 'x'`).
    /// `projects_dir` is Claude's transcript store (used only by adapters that resume).
    fn build_invocation(
        &self,
        session_id: &str,
        projects_dir: Option<&Path>,
        flags: &str,
    ) -> String;
}

pub struct ClaudeAdapter;

impl ProviderAdapter for ClaudeAdapter {
    fn id(&self) -> AgentId {
        AgentId::Claude
    }
    fn binary(&self) -> &'static str {
        "claude"
    }
    fn supports_worktree(&self) -> bool {
        true
    }
    fn env_overrides(&self) -> Vec<(&'static str, &'static str)> {
        // Disables the Task-tool migration that breaks the TodoWrite hook (see CLAUDE.md).
        vec![("CLAUDE_CODE_ENABLE_TASKS", "0")]
    }
    fn build_invocation(
        &self,
        session_id: &str,
        projects_dir: Option<&Path>,
        flags: &str,
    ) -> String {
        let id = crate::pty::shell_quote(session_id);
        if projects_dir.is_some_and(|d| crate::pty::transcript_exists(session_id, d)) {
            format!("claude{flags} --resume {id} || claude{flags}")
        } else {
            format!("claude{flags} --session-id {id} || claude{flags}")
        }
    }
}

pub struct CodexAdapter;

impl ProviderAdapter for CodexAdapter {
    fn id(&self) -> AgentId {
        AgentId::Codex
    }
    fn binary(&self) -> &'static str {
        "codex"
    }
    // Phase 1: launch fresh (Codex doesn't accept a caller-pinned session id);
    // worktrees and resume are later phases. `_flags` is unused (no worktree flags
    // are ever passed for an agent whose supports_worktree() is false).
    fn build_invocation(
        &self,
        _session_id: &str,
        _projects_dir: Option<&Path>,
        _flags: &str,
    ) -> String {
        "codex || codex".to_string()
    }
}

/// Resolve the adapter for an agent id.
pub fn adapter_for(agent: AgentId) -> Box<dyn ProviderAdapter> {
    match agent {
        AgentId::Claude => Box::new(ClaudeAdapter),
        AgentId::Codex => Box::new(CodexAdapter),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_spawns_fresh_with_fallback() {
        let cmd = CodexAdapter.build_invocation("sid", None, "");
        assert_eq!(cmd, "codex || codex");
        assert_eq!(CodexAdapter.id(), AgentId::Codex);
        assert_eq!(CodexAdapter.binary(), "codex");
        assert!(!CodexAdapter.supports_worktree());
        assert!(CodexAdapter.env_overrides().is_empty());
    }

    #[test]
    fn claude_pins_a_new_session_when_no_transcript() {
        // projects_dir = None → no transcript → pin a new session id.
        let cmd = ClaudeAdapter.build_invocation("abc-123", None, "");
        assert_eq!(cmd, "claude --session-id 'abc-123' || claude");
    }

    #[test]
    fn claude_applies_flags_to_both_primary_and_fallback() {
        let cmd = ClaudeAdapter.build_invocation("id", None, " --worktree 'wt'");
        assert_eq!(
            cmd,
            "claude --worktree 'wt' --session-id 'id' || claude --worktree 'wt'"
        );
    }

    #[test]
    fn claude_metadata() {
        assert_eq!(ClaudeAdapter.id(), AgentId::Claude);
        assert_eq!(ClaudeAdapter.binary(), "claude");
        assert!(ClaudeAdapter.supports_worktree());
        assert_eq!(
            ClaudeAdapter.env_overrides(),
            vec![("CLAUDE_CODE_ENABLE_TASKS", "0")]
        );
    }
}
