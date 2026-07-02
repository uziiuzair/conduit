//! Agent provider adapters: how to launch and detect each terminal coding agent.

use std::path::Path;

/// Which coding-agent CLI a session runs. Persisted on each Session; serializes
/// as a lowercase string ("claude"/"codex"/"gemini"/"opencode"). Unknown/absent → Claude (back-compat).
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    #[default]
    Claude,
    Codex,
    Gemini,
    OpenCode,
    Antigravity,
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
    /// The status plugin this adapter installs at spawn. OpenCode has no shell-hook
    /// config, so it ships a JS plugin instead of a `hooks_profile()`. None for
    /// hook-based agents (Claude/Codex/Gemini).
    fn plugin_profile(&self) -> Option<crate::hooks::PluginProfile> {
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
    /// The OS-appropriate shell command that installs this agent's CLI, for Conduit's one-click
    /// in-app install (Settings → Agents / onboarding). `None` => no known auto-installer, so the
    /// UI shows a manual hint instead. The command is non-interactive and needs no elevation; it
    /// is run via the platform install shell (see `install_agent` in lib.rs). Note that install
    /// != ready: every agent still requires sign-in on first launch inside its session.
    fn install_command(&self) -> Option<String> {
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
    fn install_command(&self) -> Option<String> {
        Some("npm install -g @anthropic-ai/claude-code".into())
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
        let id = crate::pty::quote_arg(session_id);
        // An initial prompt rides as a quoted positional so the worker starts working
        // immediately (used by the Conductor's fleet_spawn). Applied to both branches.
        // `quote_arg` is POSIX single-quoting under `sh -c` and cmd.exe quoting under
        // `cmd /K`, so this one invocation string serves both platforms.
        let prompt = initial_prompt
            .map(|p| format!(" {}", crate::pty::quote_arg(p)))
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
    fn install_command(&self) -> Option<String> {
        Some("npm install -g @google/gemini-cli".into())
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
    fn install_command(&self) -> Option<String> {
        Some("npm install -g @openai/codex".into())
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

pub struct OpenCodeAdapter;

impl ProviderAdapter for OpenCodeAdapter {
    fn id(&self) -> AgentId {
        AgentId::OpenCode
    }
    fn binary(&self) -> &'static str {
        "opencode"
    }
    fn install_command(&self) -> Option<String> {
        Some("npm install -g opencode-ai@latest".into())
    }
    // Fresh launch like Codex/Gemini: opencode generates its own session ids, so there is
    // no caller-pinned resume; worktree isolation is out of scope for this tier.
    fn build_invocation(
        &self,
        _session_id: &str,
        _projects_dir: Option<&Path>,
        _flags: &str,
        _initial_prompt: Option<&str>,
    ) -> String {
        "opencode || opencode".to_string()
    }
    fn plugin_profile(&self) -> Option<crate::hooks::PluginProfile> {
        Some(crate::hooks::PluginProfile {
            config_rel_path: ".opencode/plugin/conduit-status.js",
        })
    }
}

pub struct AntigravityAdapter;

impl ProviderAdapter for AntigravityAdapter {
    fn id(&self) -> AgentId {
        AgentId::Antigravity
    }
    fn binary(&self) -> &'static str {
        "agy"
    }
    // Antigravity has no official npm package; install is the vendor's script. Run on explicit
    // user action only (Conduit surfaces the exact command in the UI). Post-install, `agy`
    // forces an interactive Google Sign-In on first launch -- which happens in the PTY session.
    fn install_command(&self) -> Option<String> {
        #[cfg(windows)]
        {
            Some("irm https://antigravity.google/cli/install.ps1 | iex".into())
        }
        #[cfg(not(windows))]
        {
            Some("curl -fsSL https://antigravity.google/cli/install.sh | bash".into())
        }
    }
    // The Antigravity CLI (`agy`) is Google's headless terminal agent that signs in with a
    // Google account (i.e. a Gemini subscription), unlike the API-key `gemini` CLI. Fresh
    // launch like Gemini/OpenCode, no caller-pinned resume. Hooks and MCP are left to the
    // trait defaults (None) until `agy`'s integration surface is verified, so its sessions
    // run as plain terminals for now.
    fn build_invocation(
        &self,
        _session_id: &str,
        _projects_dir: Option<&Path>,
        _flags: &str,
        _initial_prompt: Option<&str>,
    ) -> String {
        "agy || agy".to_string()
    }
}

/// The per-spawn OpenCode local-provider payload (Feature 3): an inline config for the
/// child's OPENCODE_CONFIG_CONTENT env var, plus the endpoint API key that rides in a
/// SEPARATE env var (CONDUIT_OC_APIKEY) referenced from the config as an `{env:...}`
/// placeholder. Nothing here is ever written to disk or logged.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenCodeSpawnConfig {
    pub config_json: String,
    pub api_key: Option<String>,
}

/// Human label for a local-provider preset id, shown as the provider name inside OpenCode.
fn preset_label(preset: &str) -> &'static str {
    match preset {
        "ollama" => "Ollama",
        "lmstudio" => "LM Studio",
        "vllm" => "vLLM",
        "llamacpp" => "llama.cpp",
        "openwebui" => "OpenWebUI",
        _ => "Local endpoint",
    }
}

/// Build the inline OpenCode config that routes a session to the user's local/self-hosted
/// endpoint. Injected via OPENCODE_CONFIG_CONTENT, which deep-merges ABOVE the user's
/// global and project opencode.json (only managed/MDM config outranks it), so it wins
/// without touching their files. Returns None when the feature is off or incomplete —
/// the session then spawns exactly as before this feature.
///
/// The provider id is a fixed "conduit" (not the preset name) so the merge can never
/// collide with a provider the user defined themselves. `small_model` is pinned too so
/// title-generation etc. can't silently route to a cloud model. `pin_local` emits
/// `enabled_providers: ["conduit"]` — an allowlist that keeps OpenCode from loading ANY
/// other provider even when cloud credentials exist in its auth store; the spawner sets
/// it for siloed/local-only sessions under private mode (Feature 4) or globally by choice.
pub fn build_opencode_config(
    s: &crate::store::OpenCodeSettings,
    api_key: Option<&str>,
    pin_local: bool,
) -> Option<OpenCodeSpawnConfig> {
    if !s.enabled {
        return None;
    }
    let base_url = s.base_url.trim();
    let model_id = s.model.trim();
    if base_url.is_empty() || model_id.is_empty() {
        return None;
    }

    let mut options = serde_json::json!({ "baseURL": base_url });
    if api_key.is_some() {
        // Keep the placeholder in the JSON — the real key lives in exactly one child env
        // var, so it is trivially redactable and never duplicated into the config blob.
        options["apiKey"] = serde_json::json!("{env:CONDUIT_OC_APIKEY}");
    }

    let mut model_entry = serde_json::json!({ "name": model_id });
    let mut limit = serde_json::Map::new();
    if let Some(c) = s.context_limit {
        limit.insert("context".into(), c.into());
    }
    if let Some(o) = s.output_limit {
        limit.insert("output".into(), o.into());
    }
    if !limit.is_empty() {
        model_entry["limit"] = serde_json::Value::Object(limit);
    }

    let model_ref = format!("conduit/{model_id}");
    let mut root = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            "conduit": {
                "npm": "@ai-sdk/openai-compatible",
                "name": format!("{} via Conduit", preset_label(&s.preset)),
                "options": options,
                "models": { model_id: model_entry },
            }
        },
        "model": model_ref,
        "small_model": model_ref,
    });
    if pin_local {
        root["enabled_providers"] = serde_json::json!(["conduit"]);
    }

    Some(OpenCodeSpawnConfig {
        config_json: root.to_string(),
        api_key: api_key.map(str::to_string),
    })
}

/// Resolve the adapter for an agent id.
pub fn adapter_for(agent: AgentId) -> Box<dyn ProviderAdapter> {
    match agent {
        AgentId::Claude => Box::new(ClaudeAdapter),
        AgentId::Codex => Box::new(CodexAdapter),
        AgentId::Gemini => Box::new(GeminiAdapter),
        AgentId::OpenCode => Box::new(OpenCodeAdapter),
        AgentId::Antigravity => Box::new(AntigravityAdapter),
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
    /// The one-click install command for this agent, or None when there's no known installer.
    /// The UI offers an "Install" button only for a not-found agent that has one.
    pub install_command: Option<String>,
}

impl AgentInfo {
    /// Build from the stdout of `command -v <binary>` (empty = not found).
    pub fn from_probe(
        id: AgentId,
        binary: &str,
        label: &str,
        probe_stdout: &str,
        install_command: Option<String>,
    ) -> Self {
        let path = probe_stdout.trim();
        AgentInfo {
            id,
            label: label.to_string(),
            binary: binary.to_string(),
            found: !path.is_empty(),
            path: (!path.is_empty()).then(|| path.to_string()),
            install_command,
        }
    }
}

/// All known agents, for the UI to label/detect. Order = display order.
pub fn all_adapters() -> Vec<Box<dyn ProviderAdapter>> {
    vec![
        Box::new(ClaudeAdapter),
        Box::new(CodexAdapter),
        Box::new(GeminiAdapter),
        Box::new(OpenCodeAdapter),
        Box::new(AntigravityAdapter),
    ]
}

fn label_for(id: AgentId) -> &'static str {
    match id {
        AgentId::Claude => "Claude Code",
        AgentId::Codex => "Codex CLI",
        AgentId::Gemini => "Gemini CLI",
        AgentId::OpenCode => "OpenCode",
        AgentId::Antigravity => "Antigravity (agy)",
    }
}

/// Windows: resolve each agent binary with `where` (the `command -v` analogue). Unlike a
/// zsh login shell there is no per-call rc/nvm init cost, so one `where` per binary is
/// cheap; `where` finds the `.cmd`/`.exe` shims via PATHEXT, matching how `cmd.exe`
/// resolves the agents at spawn. Scrubs npm_config_prefix for PATH parity with sessions.
#[cfg(windows)]
pub fn detect_agents() -> Vec<AgentInfo> {
    all_adapters()
        .iter()
        .map(|a| {
            use crate::NoWindow;
            let bin = a.binary();
            let stdout = std::process::Command::new("where")
                .arg(bin)
                .env_remove("npm_config_prefix")
                .no_window()
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            // `where` prints one match per line; the first is enough to mark it found.
            let first = stdout.lines().next().unwrap_or("");
            AgentInfo::from_probe(a.id(), bin, label_for(a.id()), first, a.install_command())
        })
        .collect()
}

/// Scan the user's LOGIN-shell PATH for every agent binary in a SINGLE shell
/// invocation. Shell init (`zsh -i -l` sourcing rc/nvm) dominates the cost — ~0.5s —
/// so one shell for all binaries is far cheaper than one shell per binary. Scrubs
/// npm_config_prefix so detection sees the same PATH the spawned sessions will.
#[cfg(not(windows))]
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
            AgentInfo::from_probe(
                a.id(),
                bin,
                label_for(a.id()),
                probe_path(&stdout, bin),
                a.install_command(),
            )
        })
        .collect()
}

/// Extract the path the batched probe printed for `binary` ("" when not found).
/// (Only the POSIX `detect_agents` uses this; Windows resolves per-binary via `where`.)
#[cfg_attr(windows, allow(dead_code))]
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
            None,
        );
        assert!(info.found);
        assert_eq!(info.path.as_deref(), Some("/opt/homebrew/bin/codex"));
        let missing = AgentInfo::from_probe(AgentId::Codex, "codex", "Codex CLI", "", None);
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
        // Quoting is OS-aware (POSIX single-quote vs cmd bare/double-quote).
        #[cfg(not(windows))]
        let expected = "claude --session-id 'abc-123' || claude";
        #[cfg(windows)]
        let expected = "claude --session-id abc-123 || claude";
        assert_eq!(cmd, expected);
    }

    #[test]
    fn claude_applies_flags_to_both_primary_and_fallback() {
        let cmd = ClaudeAdapter.build_invocation("id", None, " --worktree 'wt'", None);
        // The flags arg is pre-quoted by the caller; only the session id is quoted here,
        // and that quoting is OS-aware.
        #[cfg(not(windows))]
        let expected = "claude --worktree 'wt' --session-id 'id' || claude --worktree 'wt'";
        #[cfg(windows)]
        let expected = "claude --worktree 'wt' --session-id id || claude --worktree 'wt'";
        assert_eq!(cmd, expected);
    }

    #[test]
    fn claude_appends_initial_prompt_as_quoted_positional() {
        let cmd = ClaudeAdapter.build_invocation("id", None, "", Some("write a haiku"));
        // The spaced prompt is quoted as a single positional; quoting is OS-aware.
        #[cfg(not(windows))]
        let expected = "claude --session-id 'id' 'write a haiku' || claude 'write a haiku'";
        #[cfg(windows)]
        let expected = "claude --session-id id \"write a haiku\" || claude \"write a haiku\"";
        assert_eq!(cmd, expected);
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
    fn opencode_metadata_and_plugin_profile() {
        assert_eq!(OpenCodeAdapter.id(), AgentId::OpenCode);
        assert_eq!(OpenCodeAdapter.binary(), "opencode");
        assert!(!OpenCodeAdapter.supports_worktree());
        assert_eq!(
            OpenCodeAdapter.build_invocation("sid", None, "", None),
            "opencode || opencode"
        );
        assert!(
            OpenCodeAdapter.hooks_profile().is_none(),
            "opencode uses a plugin, not a hooks profile"
        );
        let pp = OpenCodeAdapter
            .plugin_profile()
            .expect("opencode must supply a plugin profile");
        assert_eq!(pp.config_rel_path, ".opencode/plugin/conduit-status.js");
        assert_eq!(adapter_for(AgentId::OpenCode).id(), AgentId::OpenCode);
        assert!(all_adapters().iter().any(|a| a.id() == AgentId::OpenCode));
    }

    #[test]
    fn hook_agents_have_no_plugin_profile() {
        assert!(ClaudeAdapter.plugin_profile().is_none());
        assert!(CodexAdapter.plugin_profile().is_none());
        assert!(GeminiAdapter.plugin_profile().is_none());
    }

    #[test]
    fn adapters_report_install_commands() {
        assert_eq!(
            ClaudeAdapter.install_command().as_deref(),
            Some("npm install -g @anthropic-ai/claude-code")
        );
        assert_eq!(
            CodexAdapter.install_command().as_deref(),
            Some("npm install -g @openai/codex")
        );
        assert_eq!(
            GeminiAdapter.install_command().as_deref(),
            Some("npm install -g @google/gemini-cli")
        );
        assert_eq!(
            OpenCodeAdapter.install_command().as_deref(),
            Some("npm install -g opencode-ai@latest")
        );
        // Antigravity uses the vendor script (OS-specific); assert it offers one and flows
        // through detect into AgentInfo.
        assert!(AntigravityAdapter.install_command().is_some());
        let info = AgentInfo::from_probe(
            AgentId::OpenCode,
            "opencode",
            "OpenCode",
            "",
            OpenCodeAdapter.install_command(),
        );
        assert_eq!(
            info.install_command.as_deref(),
            Some("npm install -g opencode-ai@latest")
        );
    }

    fn oc_settings() -> crate::store::OpenCodeSettings {
        crate::store::OpenCodeSettings {
            enabled: true,
            preset: "ollama".into(),
            base_url: "http://localhost:11434/v1".into(),
            model: "qwen3:30b-a3b".into(),
            context_limit: Some(262144),
            output_limit: None,
            pin_local: false,
        }
    }

    #[test]
    fn opencode_config_local_no_key_no_pin() {
        let cfg = build_opencode_config(&oc_settings(), None, false).unwrap();
        assert!(cfg.api_key.is_none());
        let v: serde_json::Value = serde_json::from_str(&cfg.config_json).unwrap();
        let provider = &v["provider"]["conduit"];
        assert_eq!(provider["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(provider["name"], "Ollama via Conduit");
        assert_eq!(provider["options"]["baseURL"], "http://localhost:11434/v1");
        assert!(
            provider["options"].get("apiKey").is_none(),
            "no key configured -> no apiKey entry at all"
        );
        assert_eq!(
            provider["models"]["qwen3:30b-a3b"]["limit"]["context"],
            262144
        );
        assert!(
            provider["models"]["qwen3:30b-a3b"]["limit"]
                .get("output")
                .is_none(),
            "unset output limit is omitted"
        );
        assert_eq!(v["model"], "conduit/qwen3:30b-a3b");
        assert_eq!(v["small_model"], "conduit/qwen3:30b-a3b");
        assert!(
            v.get("enabled_providers").is_none(),
            "no pin -> other providers stay usable"
        );
    }

    #[test]
    fn opencode_config_remote_key_and_pin() {
        let mut s = oc_settings();
        s.preset = "openwebui".into();
        s.base_url = " http://gpu-box:3000/api ".into(); // whitespace is trimmed
        s.context_limit = None;
        s.output_limit = Some(8192);
        let cfg = build_opencode_config(&s, Some("secret-key"), true).unwrap();
        // The raw key rides ONLY in api_key (-> child env); the JSON carries a placeholder.
        assert_eq!(cfg.api_key.as_deref(), Some("secret-key"));
        assert!(!cfg.config_json.contains("secret-key"));
        let v: serde_json::Value = serde_json::from_str(&cfg.config_json).unwrap();
        assert_eq!(
            v["provider"]["conduit"]["options"]["apiKey"],
            "{env:CONDUIT_OC_APIKEY}"
        );
        assert_eq!(
            v["provider"]["conduit"]["options"]["baseURL"],
            "http://gpu-box:3000/api"
        );
        assert_eq!(v["provider"]["conduit"]["name"], "OpenWebUI via Conduit");
        assert_eq!(
            v["provider"]["conduit"]["models"]["qwen3:30b-a3b"]["limit"]["output"],
            8192
        );
        assert_eq!(v["enabled_providers"], serde_json::json!(["conduit"]));
    }

    #[test]
    fn opencode_config_none_when_disabled_or_incomplete() {
        let mut s = oc_settings();
        s.enabled = false;
        assert!(build_opencode_config(&s, None, false).is_none());
        let mut s = oc_settings();
        s.model = "  ".into();
        assert!(build_opencode_config(&s, None, false).is_none());
        let mut s = oc_settings();
        s.base_url = String::new();
        assert!(build_opencode_config(&s, None, false).is_none());
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
