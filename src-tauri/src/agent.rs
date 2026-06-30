//! Agent provider adapters: how to launch and detect each terminal coding agent.

use std::path::Path;

/// Which coding-agent CLI a session runs. Persisted on each Session; serializes
/// as a lowercase string ("claude"/"codex"/"gemini"). Unknown/absent → Claude (back-compat).
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    #[default]
    Claude,
    Codex,
    Gemini,
}

/// Descriptor for a single MCP server passed to the CLI command builders.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub transport: String, // "stdio" | "http"
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub env: Vec<(String, String)>, // [(K, V)]
}

/// Shell-quote a single token: return it bare if it's safe, otherwise single-quote it.
fn sh_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:@=".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
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
    /// The lifecycle hooks this adapter installs at session spawn.
    /// Returns None for agents that have no hooks support yet.
    fn hooks_profile(&self) -> Option<crate::hooks::HooksProfile> {
        None
    }
    /// The agent command that runs after `cd <dir> &&`, including the `|| <bare>`
    /// fallback. `flags` carries already-quoted extra args (e.g. ` --worktree 'x'`).
    /// `projects_dir` is Claude's transcript store (used only by adapters that resume).
    fn build_invocation(
        &self,
        session_id: &str,
        projects_dir: Option<&Path>,
        flags: &str,
        initial_prompt: Option<&str>,
    ) -> String;
    /// Build the CLI command string to register an MCP server at user scope.
    /// Returns `None` if this adapter doesn't support the given transport yet.
    fn mcp_add_command(&self, _s: &McpServer) -> Option<String> {
        None
    }
    /// Build the CLI command string to remove an MCP server at user scope.
    /// Returns `None` for adapters that don't support MCP management.
    fn mcp_remove_command(&self, _name: &str) -> Option<String> {
        None
    }
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
        initial_prompt: Option<&str>,
    ) -> String {
        let id = crate::pty::shell_quote(session_id);
        // An initial prompt rides as a quoted positional so the worker starts working
        // immediately (used by the Conductor's fleet_spawn). Applied to both branches.
        let prompt = initial_prompt
            .map(|p| format!(" {}", crate::pty::shell_quote(p)))
            .unwrap_or_default();
        if projects_dir.is_some_and(|d| crate::pty::transcript_exists(session_id, d)) {
            format!("claude{flags} --resume {id}{prompt} || claude{flags}{prompt}")
        } else {
            format!("claude{flags} --session-id {id}{prompt} || claude{flags}{prompt}")
        }
    }
    fn hooks_profile(&self) -> Option<crate::hooks::HooksProfile> {
        Some(crate::hooks::claude_profile())
    }
    fn mcp_add_command(&self, s: &McpServer) -> Option<String> {
        let env: String = s
            .env
            .iter()
            .map(|(k, v)| format!(" -e {}={}", sh_quote(k), sh_quote(v)))
            .collect();
        match s.transport.as_str() {
            "stdio" => {
                let args: String = s.args.iter().map(|a| format!(" {}", sh_quote(a))).collect();
                Some(format!(
                    "claude mcp add -s user{env} {} -- {}{}",
                    sh_quote(&s.name),
                    sh_quote(&s.command),
                    args
                ))
            }
            "http" => Some(format!(
                "claude mcp add -s user --transport http {} {}",
                sh_quote(&s.name),
                sh_quote(&s.url)
            )),
            _ => None,
        }
    }
    fn mcp_remove_command(&self, name: &str) -> Option<String> {
        Some(format!("claude mcp remove -s user {}", sh_quote(name)))
    }
}

pub struct GeminiAdapter;

impl ProviderAdapter for GeminiAdapter {
    fn id(&self) -> AgentId {
        AgentId::Gemini
    }
    fn binary(&self) -> &'static str {
        "gemini"
    }
    fn build_invocation(
        &self,
        _session_id: &str,
        _projects_dir: Option<&Path>,
        _flags: &str,
        _initial_prompt: Option<&str>,
    ) -> String {
        "gemini || gemini".to_string()
    }
    fn hooks_profile(&self) -> Option<crate::hooks::HooksProfile> {
        use crate::hooks::{HookRow, HooksProfile};
        Some(HooksProfile {
            config_rel_path: ".gemini/settings.json",
            structured_todos: true,
            rows: vec![
                HookRow {
                    event: "BeforeTool",
                    matcher: None,
                    verb: "pretool",
                },
                HookRow {
                    event: "AfterTool",
                    matcher: Some("write_todos"),
                    verb: "todos",
                },
                HookRow {
                    event: "AfterTool",
                    matcher: None,
                    verb: "tooluse",
                },
                HookRow {
                    event: "BeforeAgent",
                    matcher: None,
                    verb: "prompt",
                },
                HookRow {
                    event: "AfterAgent",
                    matcher: None,
                    verb: "stop",
                },
                HookRow {
                    event: "SessionStart",
                    matcher: None,
                    verb: "sessionstart",
                },
                HookRow {
                    event: "PreCompress",
                    matcher: None,
                    verb: "precompact",
                },
                HookRow {
                    event: "Notification",
                    matcher: None,
                    verb: "notification",
                },
            ],
        })
    }
    fn mcp_add_command(&self, s: &McpServer) -> Option<String> {
        let env: String = s
            .env
            .iter()
            .map(|(k, v)| format!(" -e {}={}", sh_quote(k), sh_quote(v)))
            .collect();
        match s.transport.as_str() {
            "stdio" => {
                let args: String = s.args.iter().map(|a| format!(" {}", sh_quote(a))).collect();
                Some(format!(
                    "gemini mcp add -s user{env} {} {}{}",
                    sh_quote(&s.name),
                    sh_quote(&s.command),
                    args
                ))
            }
            "http" => Some(format!(
                "gemini mcp add -s user --transport http {} {}",
                sh_quote(&s.name),
                sh_quote(&s.url)
            )),
            _ => None,
        }
    }
    fn mcp_remove_command(&self, name: &str) -> Option<String> {
        Some(format!("gemini mcp remove {}", sh_quote(name)))
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
        _initial_prompt: Option<&str>,
    ) -> String {
        "codex || codex".to_string()
    }
    fn hooks_profile(&self) -> Option<crate::hooks::HooksProfile> {
        use crate::hooks::{HookRow, HooksProfile};
        Some(HooksProfile {
            config_rel_path: ".codex/hooks.json",
            structured_todos: false,
            rows: vec![
                HookRow {
                    event: "PreToolUse",
                    matcher: None,
                    verb: "pretool",
                },
                HookRow {
                    event: "PostToolUse",
                    matcher: None,
                    verb: "tooluse",
                },
                HookRow {
                    event: "UserPromptSubmit",
                    matcher: None,
                    verb: "prompt",
                },
                HookRow {
                    event: "Stop",
                    matcher: None,
                    verb: "stop",
                },
                HookRow {
                    event: "PreCompact",
                    matcher: None,
                    verb: "precompact",
                },
                HookRow {
                    event: "SessionStart",
                    matcher: None,
                    verb: "sessionstart",
                },
            ],
        })
    }
    fn mcp_add_command(&self, s: &McpServer) -> Option<String> {
        let env: String = s
            .env
            .iter()
            .map(|(k, v)| format!(" --env {}={}", sh_quote(k), sh_quote(v)))
            .collect();
        match s.transport.as_str() {
            "stdio" => {
                let args: String = s.args.iter().map(|a| format!(" {}", sh_quote(a))).collect();
                Some(format!(
                    "codex mcp add{env} {} -- {}{}",
                    sh_quote(&s.name),
                    sh_quote(&s.command),
                    args
                ))
            }
            "http" => Some(format!(
                "codex mcp add --transport http {} {}",
                sh_quote(&s.name),
                sh_quote(&s.url)
            )),
            _ => None,
        }
    }
    fn mcp_remove_command(&self, name: &str) -> Option<String> {
        Some(format!("codex mcp remove {}", sh_quote(name)))
    }
}

/// Resolve the adapter for an agent id.
pub fn adapter_for(agent: AgentId) -> Box<dyn ProviderAdapter> {
    match agent {
        AgentId::Claude => Box::new(ClaudeAdapter),
        AgentId::Codex => Box::new(CodexAdapter),
        AgentId::Gemini => Box::new(GeminiAdapter),
    }
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: AgentId,
    pub label: String,
    pub binary: String,
    pub found: bool,
    pub path: Option<String>,
}

impl AgentInfo {
    /// Build from the stdout of `command -v <binary>` (empty = not found).
    pub fn from_probe(id: AgentId, binary: &str, label: &str, probe_stdout: &str) -> Self {
        let path = probe_stdout.trim();
        AgentInfo {
            id,
            label: label.to_string(),
            binary: binary.to_string(),
            found: !path.is_empty(),
            path: (!path.is_empty()).then(|| path.to_string()),
        }
    }
}

/// All known agents, for the UI to label/detect. Order = display order.
pub fn all_adapters() -> Vec<Box<dyn ProviderAdapter>> {
    vec![
        Box::new(ClaudeAdapter),
        Box::new(CodexAdapter),
        Box::new(GeminiAdapter),
    ]
}

fn label_for(id: AgentId) -> &'static str {
    match id {
        AgentId::Claude => "Claude Code",
        AgentId::Codex => "Codex CLI",
        AgentId::Gemini => "Gemini CLI",
    }
}

/// Scan the user's LOGIN-shell PATH for every agent binary in a SINGLE shell
/// invocation. Shell init (`zsh -i -l` sourcing rc/nvm) dominates the cost — ~0.5s —
/// so one shell for all binaries is far cheaper than one shell per binary. Scrubs
/// npm_config_prefix so detection sees the same PATH the spawned sessions will.
pub fn detect_agents() -> Vec<AgentInfo> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let adapters = all_adapters();
    let bins: Vec<&str> = adapters.iter().map(|a| a.binary()).collect();
    // One shell prints "<binary>\t<resolved-path-or-empty>" for each binary.
    let script = format!(
        "for b in {}; do printf '%s\\t%s\\n' \"$b\" \"$(command -v \"$b\" 2>/dev/null)\"; done",
        bins.join(" ")
    );
    let stdout = std::process::Command::new(&shell)
        .args(["-i", "-l", "-c", &script])
        .env_remove("npm_config_prefix")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    adapters
        .iter()
        .map(|a| {
            let bin = a.binary();
            AgentInfo::from_probe(a.id(), bin, label_for(a.id()), probe_path(&stdout, bin))
        })
        .collect()
}

/// Extract the path the batched probe printed for `binary` ("" when not found).
fn probe_path<'a>(stdout: &'a str, binary: &str) -> &'a str {
    stdout
        .lines()
        .find_map(|l| {
            l.split_once('\t')
                .filter(|(b, _)| *b == binary)
                .map(|(_, p)| p)
        })
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_one_marks_found_when_path_nonempty() {
        let info = AgentInfo::from_probe(
            AgentId::Codex,
            "codex",
            "Codex CLI",
            "/opt/homebrew/bin/codex\n",
        );
        assert!(info.found);
        assert_eq!(info.path.as_deref(), Some("/opt/homebrew/bin/codex"));
        let missing = AgentInfo::from_probe(AgentId::Codex, "codex", "Codex CLI", "");
        assert!(!missing.found);
        assert!(missing.path.is_none());
    }

    #[test]
    fn probe_path_extracts_per_binary_path() {
        let out = "claude\t/usr/bin/claude\ncodex\t\n";
        assert_eq!(probe_path(out, "claude"), "/usr/bin/claude");
        assert_eq!(probe_path(out, "codex"), "");
        assert_eq!(probe_path(out, "missing"), "");
    }

    #[test]
    fn codex_spawns_fresh_with_fallback() {
        let cmd = CodexAdapter.build_invocation("sid", None, "", None);
        assert_eq!(cmd, "codex || codex");
        assert_eq!(CodexAdapter.id(), AgentId::Codex);
        assert_eq!(CodexAdapter.binary(), "codex");
        assert!(!CodexAdapter.supports_worktree());
        assert!(CodexAdapter.env_overrides().is_empty());
    }

    #[test]
    fn claude_pins_a_new_session_when_no_transcript() {
        // projects_dir = None → no transcript → pin a new session id.
        let cmd = ClaudeAdapter.build_invocation("abc-123", None, "", None);
        assert_eq!(cmd, "claude --session-id 'abc-123' || claude");
    }

    #[test]
    fn claude_applies_flags_to_both_primary_and_fallback() {
        let cmd = ClaudeAdapter.build_invocation("id", None, " --worktree 'wt'", None);
        assert_eq!(
            cmd,
            "claude --worktree 'wt' --session-id 'id' || claude --worktree 'wt'"
        );
    }

    #[test]
    fn claude_appends_initial_prompt_as_quoted_positional() {
        let cmd = ClaudeAdapter.build_invocation("id", None, "", Some("write a haiku"));
        assert_eq!(
            cmd,
            "claude --session-id 'id' 'write a haiku' || claude 'write a haiku'"
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

    #[test]
    fn codex_profile_has_no_todos_and_uses_codex_path() {
        let p = ClaudeAdapter.hooks_profile().unwrap();
        assert_eq!(p.config_rel_path, ".claude/settings.local.json");
        let cp = CodexAdapter.hooks_profile().unwrap();
        assert_eq!(cp.config_rel_path, ".codex/hooks.json");
        assert!(!cp.structured_todos);
        assert!(
            cp.rows.iter().all(|r| r.verb != "todos"),
            "codex has no todos event"
        );
        let gp = GeminiAdapter.hooks_profile().unwrap();
        assert_eq!(gp.config_rel_path, ".gemini/settings.json");
        assert!(gp.structured_todos);
        assert!(gp
            .rows
            .iter()
            .any(|r| r.event == "AfterTool" && r.verb == "tooluse"));
    }

    #[test]
    fn gemini_spawns_fresh_and_has_no_worktree() {
        assert_eq!(GeminiAdapter.id(), AgentId::Gemini);
        assert_eq!(GeminiAdapter.binary(), "gemini");
        assert!(!GeminiAdapter.supports_worktree());
        assert_eq!(
            GeminiAdapter.build_invocation("sid", None, "", None),
            "gemini || gemini"
        );
        assert_eq!(adapter_for(AgentId::Gemini).id(), AgentId::Gemini);
    }

    #[test]
    fn mcp_command_builders_per_agent() {
        let s = crate::agent::McpServer {
            name: "context7".into(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "@upstash/context7-mcp".into()],
            url: String::new(),
            env: vec![("API_KEY".into(), "x".into())],
        };
        // Claude: user scope, env via -e, stdio after `--`
        assert_eq!(
            ClaudeAdapter.mcp_add_command(&s).unwrap(),
            "claude mcp add -s user -e API_KEY=x context7 -- npx -y @upstash/context7-mcp"
        );
        assert_eq!(
            ClaudeAdapter.mcp_remove_command("context7").unwrap(),
            "claude mcp remove -s user context7"
        );
        // Codex: home scope (no -s), env via --env
        assert_eq!(
            CodexAdapter.mcp_add_command(&s).unwrap(),
            "codex mcp add --env API_KEY=x context7 -- npx -y @upstash/context7-mcp"
        );
        // Gemini: user scope, env via -e
        assert!(GeminiAdapter
            .mcp_add_command(&s)
            .unwrap()
            .starts_with("gemini mcp add -s user"));
    }
}
