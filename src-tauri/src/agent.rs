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
    // SPEC-A Tier 2, Phase 4G — **BLOCKED, per the design's own fail-closed rule
    // (2026-07-05): the `gemini` binary is not found on this dev machine (`command -v
    // gemini` / `where gemini` both empty).** Standalone Gemini CLI is reported EOL
    // (retired 2026-06-18) with `agy`/Antigravity as its successor (Phase 4); this dev
    // box has neither confirmed working, so the design's explicit instruction applies:
    // "gemini is EOL / won't launch -> fail closed: do not ship a broken adapter. Leave
    // GeminiAdapter::build_invocation at the constant, mark blocked." `agy` (Phase 4)
    // covers the Google-model routing slot in the interim. Do NOT implement the
    // `--skip-trust --prompt-interactive` rewrite (design doc §2.6) against this
    // unconfirmed binary -- a human with a working `gemini` install must run the Phase
    // 3/task-3a spike first and record the outcome here before this changes.
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
    // SPEC-A Tier 2: with a mission, run the mission headlessly (capturing a
    // schema-constrained structured result to `.conduit/result.json`), curl that result
    // to Conduit's own hook endpoint as the `result` verb, then ALWAYS continue into an
    // interactive `codex` so the worker stays a durable, human-visible terminal (design
    // doc §2.5). Without a mission (manual/non-fleet session), unchanged: launch fresh.
    //
    // **Spike NOT run (`codex` is not installed on this dev machine, 2026-07-05) --
    // implemented verbatim per design doc §2.5, NOT independently verified against a live
    // binary.** Three assumptions this depends on, per the design's own list, need a
    // human to confirm before relying on this in production:
    //   (a) `--output-last-message` + `--output-schema` together actually produce
    //       schema-valid JSON, not plain text, on the installed `codex` build;
    //   (b) `codex exec` doesn't hang on an interactive approval prompt in a non-TTY
    //       context (may need `-a never`/`--full-auto` or similar -- flag name unverified);
    //   (c) on Windows, the `&`-joined `cmd /K` chain below runs all three legs in order
    //       regardless of any leg's exit code (the reason `&` was chosen over `&&`/`||`).
    // If (a)/(b) fail: drop `--output-schema`, curl the plain-text `--output-last-message`
    // wrapped client-side as `{"status":"unknown","summary":"<raw text>",
    // "artifactPaths":[],"tokens":null}`, and note the degraded structuring here.
    #[cfg_attr(windows, allow(unused_variables))]
    fn build_invocation(
        &self,
        session_id: &str,
        _projects_dir: Option<&Path>,
        flags: &str,
        initial_prompt: Option<&str>,
    ) -> String {
        let Some(prompt) = initial_prompt else {
            return "codex || codex".to_string();
        };
        let quoted = crate::pty::quote_arg(prompt);
        // `.conduit/result.schema.json` (and, on Windows, `.conduit\result.cmd`) are
        // provisioned by the same worktree-setup step that installs this adapter's
        // HooksProfile -- see `hooks::write_codex_result_schema`/`write_codex_result_script`
        // and their call site in `lib.rs`'s Conduit-driven worktree branch.
        #[cfg(windows)]
        {
            // The curl call lives in the pre-written `.conduit\result.cmd` (a real file,
            // no shell-escaping needed since Rust writes its bytes directly, not through a
            // shell) so this outer invocation only ever chains three SIMPLE tokens with
            // `&` (cmd.exe's actual separator) -- never an embedded quote-heavy command
            // (pty.rs's own doc comment warns that's fragile under cmd's re-parse). `&`
            // (not `&&`/`||`) runs every leg regardless of the previous leg's exit code:
            // a failed `codex exec` must still be followed by the interactive fallback,
            // and a failed curl must not abort the sequence either.
            format!(
                "codex{flags} exec --json --output-last-message .conduit\\result.json --output-schema .conduit\\result.schema.json {quoted} & call .conduit\\result.cmd & codex{flags}"
            )
        }
        #[cfg(not(windows))]
        {
            let tail = format!(
                "curl -s -m 5 -X POST -H \"Content-Type: application/json\" --data-binary @.conduit/result.json \"http://127.0.0.1:${{CONDUIT_HOOK_PORT:-0}}/hook?session=${{CONDUIT_SESSION_ID:-{session_id}}}&event=result\" >/dev/null 2>&1 || true"
            );
            format!(
                "codex{flags} exec --json --output-last-message .conduit/result.json --output-schema .conduit/result.schema.json {quoted}; {tail}; codex{flags}"
            )
        }
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
                // SPEC-A Tier 2 (shared hook-channel infra): the structured hand-back for
                // an adapter with no MCP. Codex's rollout is unverified for >1 hook per
                // event (flagged in the design doc); if that turns out to be the case, the
                // fallback is folding this into the same command string as the `stop` row
                // above rather than two separate HookRows.
                HookRow {
                    event: "Stop",
                    matcher: None,
                    verb: "result",
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
    // no caller-pinned resume. `--prompt` seeds the message into the TUI session and then
    // STAYS interactive (unlike `opencode run "<msg>"`, which is a one-shot that exits) --
    // keeping fleet workers durable/human-visible per the design's invariant 6. `flags`
    // carries no OpenCode CLI text today (its MCP/local-model wiring is 100% env-var-based)
    // but stays available for future use.
    fn build_invocation(
        &self,
        _session_id: &str,
        _projects_dir: Option<&Path>,
        flags: &str,
        initial_prompt: Option<&str>,
    ) -> String {
        let prompt = initial_prompt
            .map(|p| format!(" --prompt {}", crate::pty::quote_arg(p)))
            .unwrap_or_default();
        format!("opencode{flags}{prompt} || opencode{flags}{prompt}")
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
    //
    // SPEC-A Tier 3, §7.1 reconciliation spike: **NOT run — `agy` is not installed on this
    // dev machine (2026-07-05).** The design's own branching for this exact case ("neither
    // confirmed") says ship exactly the Tier-3/silent behavior below, no wasted work — so
    // that's what this is. Do NOT "helpfully" wire a flag here on the strength of the
    // unverified third-party claim that `agy` plugins live at
    // `~/.gemini/antigravity-cli/<name>/hooks.json` (design doc §1.3) — a human installing
    // `agy` and running `agy plugin import gemini` to actually inspect that directory is
    // the tracked, non-blocking follow-up spike; only promote this adapter to Tier 2/1 once
    // that's been done for real, per the branch it lands on.
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

/// The per-spawn OpenCode local-provider payload: an inline config for the
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
/// it for siloed/local-only sessions under private mode (trust boundaries) or by choice.
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
    // OpenCode's schema requires BOTH keys once `limit` exists ("Missing key ...
    // limit.output" otherwise — verified against opencode 1.17.13). So: emit `limit`
    // only when the context window is known, defaulting output to a safe 8192; a lone
    // output with an invented context would mislead OpenCode's compaction, so it's
    // omitted instead.
    if let Some(c) = s.context_limit {
        model_entry["limit"] = serde_json::json!({
            "context": c,
            "output": s.output_limit.unwrap_or(8192),
        });
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

/// Merge the fleet MCP server into an OpenCode spawn config (or start a fresh one).
/// Independent of `build_opencode_config`/local-model routing -- callable whenever this
/// OpenCode session is a fleet worker, regardless of `OpenCodeSettings.enabled`. Wired as
/// a "remote" (streamable-HTTP) server, matching Conduit's fleet MCP server's own
/// transport (`fleet_mcp.rs`, `"type": "http"` on the Claude side).
///
/// This is a DIFFERENT mechanism from the user-editable MCP matrix (`mcp_apply` /
/// `McpServer`, `lib.rs`) that still reports `supportsMcp: false` for OpenCode per
/// `docs/superpowers/specs/2026-06-30-opencode-integration-tier-2-design.md` -- that
/// remains unsupported and unchanged. This is a single, ephemeral, Conduit-injected `mcp`
/// key that exists only for the lifetime of one fleet-worker spawn, never surfaced in or
/// managed by the MCP matrix UI.
///
/// **Verified spike (2026-07-05), not just asserted:** against the installed opencode
/// 1.17.13, `OPENCODE_CONFIG_CONTENT` with a top-level `"mcp"` key containing a
/// `"remote"`-type server is recognized end-to-end. `opencode debug config` echoed the
/// injected `mcp.fleet` block verbatim in its resolved config. Pointed at a throwaway
/// Python HTTP responder that mirrors this file's own `fleet_mcp.rs` protocol exactly
/// (JSON-RPC 2.0, GET->405, idempotent `initialize`), `opencode mcp list` reported
/// "✓ fleet connected", and the responder's log showed the full real handshake: two
/// `initialize` calls (one from a manual probe, one from opencode itself --
/// `clientInfo: {name: "opencode", version: "1.17.13"}`, `protocolVersion: 2025-11-25`),
/// then `notifications/initialized`, then `tools/list`. This is the same
/// initialize-twice/GET-405 shape the original `claude` MCP spike (conductor design, Task
/// 0) already validated Conduit's server against -- OpenCode's client behaves compatibly.
/// See the Phase 2 plan doc for the exact commands run.
pub fn inject_fleet_mcp(
    base: Option<OpenCodeSpawnConfig>,
    mcp_port: u16,
    conductor_id: &str,
) -> OpenCodeSpawnConfig {
    let mut root: serde_json::Value = base
        .as_ref()
        .and_then(|c| serde_json::from_str(&c.config_json).ok())
        .unwrap_or_else(|| serde_json::json!({ "$schema": "https://opencode.ai/config.json" }));
    root["mcp"] = serde_json::json!({
        "fleet": {
            "type": "remote",
            "url": format!("http://127.0.0.1:{mcp_port}/mcp?conductor={conductor_id}"),
            "enabled": true,
        }
    });
    OpenCodeSpawnConfig {
        config_json: root.to_string(),
        api_key: base.and_then(|c| c.api_key),
    }
}

/// SPEC-B, §7.5: pinned model IDs per (agent, model_tier), not aliases -- aliases drift.
/// `tier` is `"cheap"` | `"standard"` | `"hard"`. `None` for an unrecognized tier/agent
/// pair, or for a case the design deliberately leaves unpinned (OpenCode's "cheap" means
/// "route to the user's configured local model or a Zen free tier" -- a DIFFERENT
/// mechanism, `build_opencode_config`/`OpenCodeSettings`, not a fixed model id string) --
/// callers keep the CLI's own default rather than guessing in either case.
pub fn model_for_tier(agent: AgentId, tier: &str) -> Option<&'static str> {
    match (agent, tier) {
        (AgentId::Claude, "cheap") => Some("claude-haiku-4-5-20251001"),
        (AgentId::Claude, "standard") => Some("claude-sonnet-5"),
        (AgentId::Claude, "hard") => Some("claude-opus-4-8"),
        (AgentId::OpenCode, "standard") => Some("anthropic/claude-sonnet-5"),
        (AgentId::OpenCode, "hard") => Some("anthropic/claude-opus-4-8"),
        (AgentId::Codex, "cheap") => Some("gpt-5-mini"),
        (AgentId::Codex, "standard") => Some("codex-mini-latest"),
        (AgentId::Codex, "hard") => Some("gpt-5.5"),
        // Gemini 3 Flash beats Gemini 3 Pro on SWE-bench Verified (78% vs 76.2%) -- the
        // cheaper model is the better agentic-coding choice, so "hard" is the only tier
        // that reaches Pro; never default to Pro for cost "safety."
        (AgentId::Gemini, "cheap") | (AgentId::Antigravity, "cheap") => Some("gemini-3-flash"),
        (AgentId::Gemini, "standard") | (AgentId::Antigravity, "standard") => {
            Some("gemini-3.5-flash")
        }
        (AgentId::Gemini, "hard") | (AgentId::Antigravity, "hard") => Some("gemini-3.1-pro"),
        _ => None,
    }
}

/// SPEC-B, §7.2: `xhigh` is Opus-only. On any tier other than `"hard"` (Claude's Opus
/// tier), the API silently falls back to `"high"` anyway -- wasting the intent and
/// desyncing what Conduit recorded from what actually happened. Clamp here instead, so
/// the two always agree. `effort` values other than `"xhigh"` pass through unchanged.
pub fn clamp_effort<'a>(effort: &'a str, model_tier: Option<&str>) -> &'a str {
    if effort == "xhigh" && model_tier != Some("hard") {
        "high"
    } else {
        effort
    }
}

/// SPEC-E: a static capability card per agent, exposed via `fleet_capabilities` as an
/// LLM-facing routing trigger. Every card names its tier explicitly (design doc
/// invariant 9: a Tier-2/3 adapter's absence of a structured result/mailbox channel must
/// be STATED, never silently implied to work like Tier 1) via `structuredResult`/
/// `mailbox` booleans a routing decision (or a human reading the tool's output) can check
/// directly, not infer from prose.
pub fn capability_card(agent: AgentId) -> serde_json::Value {
    match agent {
        AgentId::Claude => serde_json::json!({
            "agent": "claude",
            "tier": 1,
            "structuredResult": true,
            "mailbox": true,
            "whenToUse": "Complex multi-file reasoning, GitHub-issue-shaped code fixes, orchestration itself (this is what the Conductor runs on) -- #1 on SWE-bench Verified.",
            "whenNotToUse": "Bulk/mechanical work a $0 local model (OpenCode) handles just as well. For homogeneous Claude parallelism, prefer your OWN native Task subagents over fleet_spawn entirely -- spawning a PTY worker for that just re-pays the multi-agent token multiplier for free."
        }),
        AgentId::OpenCode => serde_json::json!({
            "agent": "opencode",
            "tier": 1,
            "structuredResult": true,
            "mailbox": true,
            "whenToUse": "Cost-sensitive bulk/mechanical work routed to a $0 local model. Also type-heavy or mechanical edits on a typed codebase (TS, Rust) -- OpenCode feeds LSP diagnostics (compiler/type errors) back to the model after each edit, reducing correction round-trips.",
            "whenNotToUse": "Work needing the strongest available reasoning -- route that to Claude Opus or Codex instead."
        }),
        AgentId::Codex => serde_json::json!({
            "agent": "codex",
            "tier": 2,
            "structuredResult": true,
            "mailbox": false,
            "whenToUse": "Terminal / shell / DevOps / git-heavy work -- #1 on Terminal-Bench 2.1. Untrusted code or contributor PRs (kernel-level sandbox).",
            "whenNotToUse": "Anything needing horizontal mailbox participation -- Codex's hook payload has no way to originate a fleet_note, only a one-shot fleet_result."
        }),
        AgentId::Gemini => serde_json::json!({
            "agent": "gemini",
            "tier": 2,
            // Phase 4G shipped BLOCKED (no `gemini` binary to spike against here):
            // build_invocation is still the pre-existing "gemini || gemini" constant
            // with no result HookRow, so there is currently no code path by which a
            // Gemini worker could ever produce a fleet_result. Was `true` before an
            // audit caught the mismatch against this same card's own "BLOCKED" note
            // and the persona's routing advice -- flip back to `true` only once
            // Phase 4G's spike actually confirms and ships the hook-channel wiring.
            "structuredResult": false,
            "mailbox": false,
            "whenToUse": "Cost-optimized coding on a Google model -- prefer Gemini 3 FLASH over Pro (Flash is both cheaper and higher-scoring on SWE-bench Verified). NOTE: this adapter is currently BLOCKED/unverified on this dev machine (`gemini` binary not found) -- treat as unavailable until confirmed.",
            "whenNotToUse": "Anything needing fleet_note/fleet_inbox (no mailbox origination, same limitation as Codex). Anything expecting a fleet_result -- currently BLOCKED, no result path exists yet."
        }),
        AgentId::Antigravity => serde_json::json!({
            "agent": "antigravity",
            "tier": 3,
            "structuredResult": false,
            "mailbox": false,
            "whenToUse": "Cost-optimized coding on a Google model when Gemini CLI is unavailable (Gemini CLI is EOL; agy is its successor).",
            "whenNotToUse": "Anything where you need to know whether the worker succeeded without asking the human or reading fleet_peek -- agy is UNMONITORED: it will never call fleet_result."
        }),
    }
}

/// All five capability cards, for `fleet_capabilities`.
pub fn capability_cards() -> Vec<serde_json::Value> {
    all_adapters()
        .iter()
        .map(|a| capability_card(a.id()))
        .collect()
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
    fn codex_without_prompt_is_unchanged() {
        // Regression guard: a manual/non-fleet Codex session's invocation must stay
        // exactly the pre-Tier-2 constant on every platform.
        assert_eq!(
            CodexAdapter.build_invocation("sid", None, "", None),
            "codex || codex"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn codex_with_prompt_chains_exec_then_interactive() {
        let cmd = CodexAdapter.build_invocation("sid-1", None, "", Some("say hello"));
        assert!(cmd.contains("exec --json"), "{cmd}");
        assert!(
            cmd.contains("--output-schema .conduit/result.schema.json"),
            "{cmd}"
        );
        assert!(cmd.contains("event=result"), "{cmd}");
        assert!(cmd.ends_with("; codex"), "{cmd}");
    }

    #[cfg(not(windows))]
    #[test]
    fn codex_with_prompt_and_flags_ends_with_flagged_fallback() {
        let cmd = CodexAdapter.build_invocation("sid-1", None, " --worktree 'wt'", Some("hi"));
        assert!(cmd.ends_with("; codex --worktree 'wt'"), "{cmd}");
    }

    #[cfg(windows)]
    #[test]
    fn codex_with_prompt_uses_ampersand_chain_on_windows() {
        let cmd = CodexAdapter.build_invocation("sid-1", None, "", Some("say hello"));
        // Every separator is `&` (cmd.exe's actual chain operator) -- never `;`, which
        // cmd.exe doesn't understand as a command separator at all.
        assert!(cmd.contains(" & call .conduit\\result.cmd & "), "{cmd}");
        assert!(
            cmd.contains("--output-schema .conduit\\result.schema.json"),
            "{cmd}"
        );
        // No embedded double-quote inlined into this single `cmd /K` argument -- the curl
        // call itself lives in the pre-written result.cmd file instead.
        assert!(!cmd.contains("curl"), "{cmd}");
        assert!(cmd.ends_with("codex"), "{cmd}");
    }

    #[test]
    fn codex_hooks_profile_result_row_added() {
        let rows = CodexAdapter.hooks_profile().unwrap().rows;
        assert!(
            rows.iter().any(|r| r.event == "Stop" && r.verb == "stop"),
            "existing stop row must survive"
        );
        assert!(
            rows.iter().any(|r| r.event == "Stop" && r.verb == "result"),
            "new result row must be present alongside it"
        );
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
    fn gemini_phase_4g_blocked_manual_invocation_never_contains_skip_trust() {
        // Phase 4G is blocked (gemini not installed on this dev machine) -- build_invocation
        // is untouched. This is a forward-looking regression guard: whenever a future
        // change DOES implement the --skip-trust rewrite, a manual (no initial_prompt)
        // invocation must still never carry it (design doc §2.6's security-relevant
        // constraint -- --skip-trust must never apply outside a Conduit-provisioned
        // worktree).
        let cmd = GeminiAdapter.build_invocation("sid", None, "", None);
        assert!(!cmd.contains("--skip-trust"), "{cmd}");
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
    fn agent_id_string_values_round_trip_for_fleet_spawn() {
        // fleet_spawn's `agent` argument (fleet_mcp.rs) is resolved via
        // `serde_json::from_value::<AgentId>(json!(agent_str))` -- this is the exact
        // mechanism that turns e.g. "antigravity" into `AgentId::Antigravity` (Phase 4:
        // "no code change needed [beyond the generic parsing Phase 2 already added], just
        // a test proving it").
        for (s, expected) in [
            ("claude", AgentId::Claude),
            ("codex", AgentId::Codex),
            ("gemini", AgentId::Gemini),
            ("opencode", AgentId::OpenCode),
            ("antigravity", AgentId::Antigravity),
        ] {
            let parsed: AgentId = serde_json::from_value(serde_json::json!(s)).unwrap();
            assert_eq!(parsed, expected, "agent string {s:?}");
        }
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
        // OpenCode requires both limit keys; unset output falls back to 8192.
        assert_eq!(provider["models"]["qwen3:30b-a3b"]["limit"]["output"], 8192);
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
        // Output without a known context would force an invented context value into
        // OpenCode's schema (both keys required), so no limit is emitted at all.
        assert!(v["provider"]["conduit"]["models"]["qwen3:30b-a3b"]
            .get("limit")
            .is_none());
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
    fn opencode_appends_initial_prompt_via_prompt_flag() {
        let cmd = OpenCodeAdapter.build_invocation("sid", None, "", Some("do X"));
        #[cfg(not(windows))]
        let expected = "opencode --prompt 'do X' || opencode --prompt 'do X'";
        #[cfg(windows)]
        let expected = "opencode --prompt \"do X\" || opencode --prompt \"do X\"";
        assert_eq!(cmd, expected);
    }

    #[test]
    fn inject_fleet_mcp_adds_mcp_key_without_disturbing_provider_config() {
        let base = build_opencode_config(&oc_settings(), None, false);
        let merged = inject_fleet_mcp(base, 8480, "cond-1");
        let v: serde_json::Value = serde_json::from_str(&merged.config_json).unwrap();
        assert_eq!(v["provider"]["conduit"]["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(
            v["mcp"]["fleet"]["url"],
            "http://127.0.0.1:8480/mcp?conductor=cond-1"
        );
        assert_eq!(v["mcp"]["fleet"]["type"], "remote");
        assert_eq!(v["mcp"]["fleet"]["enabled"], true);
    }

    #[test]
    fn inject_fleet_mcp_works_with_no_base_config() {
        // Local-model routing off (or agent != OpenCode's local path) -- fleet MCP must
        // still wire cleanly on top of nothing.
        let merged = inject_fleet_mcp(None, 8480, "cond-2");
        assert!(merged.api_key.is_none());
        let v: serde_json::Value = serde_json::from_str(&merged.config_json).unwrap();
        assert_eq!(
            v["mcp"]["fleet"]["url"],
            "http://127.0.0.1:8480/mcp?conductor=cond-2"
        );
        assert!(
            v.get("provider").is_none(),
            "no provider config was ever given"
        );
    }

    #[test]
    fn inject_fleet_mcp_preserves_the_api_key() {
        let base = build_opencode_config(&oc_settings(), Some("secret-key"), true);
        let merged = inject_fleet_mcp(base, 8480, "cond-3");
        assert_eq!(merged.api_key.as_deref(), Some("secret-key"));
    }

    #[test]
    fn model_tier_cheap_maps_to_haiku() {
        assert_eq!(
            model_for_tier(AgentId::Claude, "cheap"),
            Some("claude-haiku-4-5-20251001")
        );
    }

    #[test]
    fn model_tier_hard_maps_to_opus() {
        assert_eq!(
            model_for_tier(AgentId::Claude, "hard"),
            Some("claude-opus-4-8")
        );
    }

    #[test]
    fn model_tier_bulk_opencode_has_no_fixed_id_by_design() {
        // "cheap" for OpenCode means "route to the local/Zen-free model already
        // configured" -- a different mechanism, not a fixed model id.
        assert_eq!(model_for_tier(AgentId::OpenCode, "cheap"), None);
        assert_eq!(
            model_for_tier(AgentId::OpenCode, "standard"),
            Some("anthropic/claude-sonnet-5")
        );
    }

    #[test]
    fn model_tier_maps_every_pinned_adapter_column() {
        assert_eq!(model_for_tier(AgentId::Codex, "cheap"), Some("gpt-5-mini"));
        assert_eq!(model_for_tier(AgentId::Codex, "hard"), Some("gpt-5.5"));
        assert_eq!(
            model_for_tier(AgentId::Gemini, "cheap"),
            Some("gemini-3-flash")
        );
        assert_eq!(
            model_for_tier(AgentId::Gemini, "hard"),
            Some("gemini-3.1-pro")
        );
        assert_eq!(
            model_for_tier(AgentId::Antigravity, "cheap"),
            Some("gemini-3-flash")
        );
    }

    #[test]
    fn model_tier_unrecognized_tier_or_agent_is_none() {
        assert_eq!(model_for_tier(AgentId::Claude, "ultra"), None);
    }

    #[test]
    fn effort_xhigh_clamped_to_high_on_non_hard_tier() {
        assert_eq!(clamp_effort("xhigh", Some("standard")), "high");
        assert_eq!(clamp_effort("xhigh", None), "high");
    }

    #[test]
    fn effort_xhigh_passes_through_on_hard_tier() {
        assert_eq!(clamp_effort("xhigh", Some("hard")), "xhigh");
    }

    #[test]
    fn effort_non_xhigh_values_are_never_clamped() {
        for e in ["low", "medium", "high", "max"] {
            assert_eq!(clamp_effort(e, Some("cheap")), e);
        }
    }

    #[test]
    fn capability_cards_are_tier_labeled_and_complete() {
        let cards = capability_cards();
        assert_eq!(cards.len(), 5);
        let expected_tiers = [
            (AgentId::Claude, 1),
            (AgentId::OpenCode, 1),
            (AgentId::Codex, 2),
            (AgentId::Gemini, 2),
            (AgentId::Antigravity, 3),
        ];
        for (agent, tier) in expected_tiers {
            let card = capability_card(agent);
            assert_eq!(card["tier"], tier, "agent={agent:?}");
            assert!(card["whenToUse"].is_string(), "agent={agent:?}");
            assert!(card["whenNotToUse"].is_string(), "agent={agent:?}");
            assert!(card["structuredResult"].is_boolean(), "agent={agent:?}");
            assert!(card["mailbox"].is_boolean(), "agent={agent:?}");
        }
    }

    #[test]
    fn capability_cards_state_tier_2_3_asymmetry_explicitly() {
        // Invariant 9: a Tier-2/3 adapter's absence of mailbox/structured-result must be
        // STATED, never silently implied to work like Tier 1.
        assert_eq!(capability_card(AgentId::Codex)["mailbox"], false);
        assert_eq!(capability_card(AgentId::Gemini)["mailbox"], false);
        assert_eq!(capability_card(AgentId::Antigravity)["mailbox"], false);
        assert_eq!(
            capability_card(AgentId::Antigravity)["structuredResult"],
            false
        );
        // Gemini shipped BLOCKED (Phase 4G, no result HookRow, build_invocation
        // unchanged) -- its card must not claim a structured-result path that does
        // not exist yet (an audit caught this mismatch; regression guard).
        assert_eq!(capability_card(AgentId::Gemini)["structuredResult"], false);
        // Tier 1 adapters get both.
        assert_eq!(capability_card(AgentId::Claude)["mailbox"], true);
        assert_eq!(capability_card(AgentId::OpenCode)["mailbox"], true);
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
