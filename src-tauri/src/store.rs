//! Project/session tree + JSON persistence. Ports AppStore.swift + Models.swift.
//!
//! Persists to ~/Library/Application Support/ConduitTauri/state.json — deliberately
//! namespaced away from the Swift app's `Conduit/state.json` so the two apps can run
//! side by side without trampling each other's (different-shaped) state.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Whether a session is a normal worker or the project's orchestrating Conductor.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionRole {
    #[default]
    Worker,
    Conductor,
}

/// Confidentiality level of a session, lowest to highest. Ordered so a clearance comparison
/// (`caller >= target`) gates reads: an agent may only read a session at or below its own
/// clearance. Part of the opt-in trust-boundary regime (see [`TrustSettings`], [`can_read`]);
/// ignored entirely when private mode is off.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "lowercase")]
pub enum Clearance {
    #[default]
    Public,
    Internal,
    Confidential,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub use_worktree: bool,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub agent: crate::agent::AgentId,
    #[serde(default)]
    pub role: SessionRole,
    /// Which registered Claude account this session runs under. None => inherit the global
    /// default account (or Conduit's own env when no default is set).
    #[serde(default)]
    pub account_id: Option<String>,
    // ---- Trust boundaries (Feature 4; only enforced when TrustSettings.private_mode) -------
    /// Confidentiality level. Reads are gated by `caller.clearance >= target.clearance`.
    #[serde(default)]
    pub clearance: Clearance,
    /// Asymmetric silo: this session may read others (per policy) but NO other session may
    /// read its output. Enforced in the fleet MCP `fleet_peek` gate and by suppressing its
    /// remote (mobile-bridge) stream -- never dependent on a soft persona instruction.
    #[serde(default)]
    pub silo: bool,
    /// This session must run against a local model and receive no cloud/network MCP. Set on
    /// siloed sensitive-data agents (OpenCode + Ollama). The model-pinning half composes with
    /// the local-OpenCode feature; Phase 1 enforces "no cloud MCP" + remote-stream suppression.
    #[serde(default)]
    pub local_only: bool,
    /// Named collaboration channels this session belongs to. Reserved for the Phase 3 policy
    /// editor; not yet consulted by `can_read` / `can_inject`.
    #[serde(default)]
    pub channels: Vec<String>,
    /// Preferred model tier: "cheap" | "standard" | "hard" (SPEC-B, §7.5). Mapped to a
    /// concrete per-adapter model id by `agent::model_for_tier`.
    #[serde(default)]
    pub model_tier: Option<String>,
    /// Seeded / "prefixed" memory injected at spawn as an appended system prompt. Phase 5.
    #[serde(default)]
    pub seed_memory: Option<String>,
    /// Effort level: "low" | "medium" | "high" | "xhigh" | "max" (SPEC-B, §7.2). Only
    /// Claude has a per-invocation effort control today (verified: `claude --help` lists
    /// `--effort <level>` with exactly these five values) -- other adapters record this
    /// but don't act on it (`agent::clamp_effort`'s doc comment explains why).
    #[serde(default)]
    pub effort: Option<String>,
}

/// Directed READ policy: may `caller` read `target`'s output? The single source of truth for
/// the silo, consulted only when private mode is on. Phase 1 semantics: a session may read
/// itself; a siloed target is NEVER readable by anyone else (the asymmetric silo); otherwise
/// reads are gated by a clearance ceiling. Channel membership is reserved for Phase 3.
pub fn can_read(caller: &Session, target: &Session) -> bool {
    if caller.id == target.id {
        return true;
    }
    if target.silo {
        return false; // asymmetric: no readback of a siloed session, ever
    }
    caller.clearance >= target.clearance
}

/// Directed INJECT policy: may `caller` type into `target`? Phase 1 keeps the existing
/// self-block; channel/clearance-aware injection is Phase 3. The confidentiality guarantee
/// does not rely on this gate -- siloed data never reaches a cloud agent because `can_read`
/// stops the orchestrator from reading it in the first place.
pub fn can_inject(caller: &Session, target: &Session) -> bool {
    caller.id != target.id
}

/// A trust update applied to one session via `set_session_trust` (the "mark sensitive" action
/// and, later, the policy editor).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionTrust {
    #[serde(default)]
    pub clearance: Clearance,
    #[serde(default)]
    pub silo: bool,
    #[serde(default)]
    pub local_only: bool,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub model_tier: Option<String>,
    #[serde(default)]
    pub seed_memory: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// A hit from the local sensitivity scanner. Surfaced to the UI as an ASSIST for the manual
/// "mark sensitive" action -- never the sole trigger for siloing, and never sent to any cloud
/// agent (the scan runs entirely in-process).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SensitivityHit {
    pub kind: &'static str,
    pub hint: &'static str,
}

/// True if `text` contains `prefix` immediately followed by at least `min_tail` token
/// characters (alnum / - / _) -- i.e. a plausible secret, not just a bare prefix word.
fn contains_token(text: &str, prefix: &str, min_tail: usize) -> bool {
    text.match_indices(prefix).any(|(i, _)| {
        text[i + prefix.len()..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .count()
            >= min_tail
    })
}

/// True if `text` has a credential-looking assignment: a key like password/secret/api_key
/// followed (past quotes/space) by `=` or `:` and a non-empty value.
fn has_credential_assignment(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const KEYS: [&str; 5] = ["password", "passwd", "secret", "api_key", "apikey"];
    KEYS.iter().any(|k| {
        lower.match_indices(k).any(|(i, _)| {
            let rest = lower[i + k.len()..]
                .trim_start_matches(|c: char| c == '"' || c == '\'' || c.is_whitespace());
            rest.strip_prefix('=')
                .or_else(|| rest.strip_prefix(':'))
                .is_some_and(|v| {
                    v.trim_start()
                        .chars()
                        .next()
                        .is_some_and(|c| !c.is_whitespace())
                })
        })
    })
}

/// Scan text for high-signal secret / credential markers, entirely locally. Returns a
/// deduplicated list of hit categories. Pattern-based (no regex dependency, keeping the Rust
/// side lean) and tuned for precision over recall since it only assists a manual decision.
pub fn scan_sensitivity(text: &str) -> Vec<SensitivityHit> {
    let mut hits: Vec<SensitivityHit> = Vec::new();
    let mut push = |kind, hint| {
        if !hits.iter().any(|h| h.kind == kind) {
            hits.push(SensitivityHit { kind, hint });
        }
    };
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY") {
        push("private-key", "PEM private key block");
    }
    if text.contains("AKIA") || text.contains("ASIA") {
        push("aws-access-key", "AWS access-key id prefix");
    }
    if text.contains("sk-ant-") || contains_token(text, "sk-", 20) {
        push("api-key", "secret API key (sk-...)");
    }
    if ["ghp_", "gho_", "ghs_", "github_pat_"]
        .iter()
        .any(|p| text.contains(p))
    {
        push("github-token", "GitHub token");
    }
    if ["xoxb-", "xoxp-", "xoxa-"].iter().any(|p| text.contains(p)) {
        push("slack-token", "Slack token");
    }
    if contains_token(text, "AIza", 30) {
        push("google-api-key", "Google API key");
    }
    if has_credential_assignment(text) {
        push("credential", "password / secret assignment");
    }
    hits
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WsTab {
    pub kind: String, // "session" | "file"
    #[serde(rename = "ref")]
    pub r#ref: String,
    /// Preview (transient, italic) tab — replaced by the next preview open in its
    /// group. Must exist here or serde strips it from persisted layouts.
    #[serde(default)]
    pub preview: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditorGroup {
    pub id: String,
    #[serde(default)]
    pub tabs: Vec<WsTab>,
    #[serde(default)]
    pub active_ref: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLayout {
    #[serde(default)]
    pub groups: Vec<EditorGroup>,
    #[serde(default)]
    pub active_group_id: Option<String>,
    #[serde(default)]
    pub weights: Vec<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub layout: Option<ProjectLayout>,
}

/// A registered Claude account: a `.claude` config dir that holds its own credentials.
/// Selecting it for a session exports its `config_dir` as CLAUDE_CONFIG_DIR at spawn.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub label: String,
    pub config_dir: String,
}

/// Opt-in trust-boundary settings (Feature 4). When `private_mode` is false the entire regime
/// is inert: the `can_read` / `can_inject` gates are skipped and a session's silo / local_only
/// flags have no effect, so OpenCode and every other agent behave like normal sessions.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrustSettings {
    #[serde(default)]
    pub private_mode: bool,
}

/// OpenCode local-provider settings: route `opencode` sessions to a
/// local/self-hosted OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, llama.cpp,
/// OpenWebUI, or a custom URL). Non-secret and persisted in state.json; the API key is
/// deliberately NOT here — it lives only in `Store::opencode_key` (in memory) and reaches
/// the child solely through its process env at spawn.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeSettings {
    /// Master switch. Off = OpenCode spawns untouched (its own config applies).
    #[serde(default)]
    pub enabled: bool,
    /// Preset id: "ollama" | "lmstudio" | "vllm" | "llamacpp" | "openwebui" | "custom".
    /// Only affects labels and how models are listed; the spawn config is uniform.
    #[serde(default)]
    pub preset: String,
    /// Full OpenAI-compatible base URL (e.g. http://localhost:11434/v1).
    #[serde(default)]
    pub base_url: String,
    /// Model id exactly as the server reports it (e.g. "qwen3:30b-a3b").
    #[serde(default)]
    pub model: String,
    /// Optional per-model limits forwarded to OpenCode ("limit": {context, output}).
    #[serde(default)]
    pub context_limit: Option<u32>,
    #[serde(default)]
    pub output_limit: Option<u32>,
    /// Allowlist the injected provider (`enabled_providers: ["conduit"]`) so OpenCode
    /// cannot fall back to cloud providers even if the user has credentials for them.
    #[serde(default)]
    pub pin_local: bool,
}

/// Root of state.json. Was a bare `Vec<Project>`; promoted to an object so the account
/// registry persists alongside projects. Legacy array files migrate on load.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistState {
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub default_account: Option<String>,
    #[serde(default)]
    pub trust: TrustSettings,
    #[serde(default)]
    pub opencode: OpenCodeSettings,
}

pub struct Store {
    projects: Mutex<Vec<Project>>,
    accounts: Mutex<Vec<Account>>,
    default_account: Mutex<Option<String>>,
    trust: Mutex<TrustSettings>,
    opencode: Mutex<OpenCodeSettings>,
    /// The local-endpoint API key, held in memory for the app's lifetime only. Never part
    /// of `PersistState`/`save()`, never logged; injected into an `opencode` child's env.
    opencode_key: Mutex<Option<String>>,
    save_path: PathBuf,
}

/// A read-only view of the project that owns a given Conductor, plus its sessions.
/// Used by the fleet MCP server to answer `fleet_list` / scope `fleet_spawn`.
pub struct FleetSnapshot {
    pub project_id: String,
    pub project_path: String,
    pub sessions: Vec<Session>,
}

/// Conduit's data directory, honoring the CONDUIT_DATA_DIR_NAME override so a
/// dev/test build can run alongside the installed app. Creates it if missing.
pub fn data_dir() -> PathBuf {
    let dir_name =
        std::env::var("CONDUIT_DATA_DIR_NAME").unwrap_or_else(|_| "ConduitTauri".to_string());
    let base = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(dir_name);
    let _ = fs::create_dir_all(&base);
    base
}

/// Push a discovery candidate for `dir` if it is an existing directory not already
/// registered or listed. Used by `Store::discover_accounts`.
fn push_candidate(out: &mut Vec<Account>, registered: &[String], label: &str, dir: PathBuf) {
    if !dir.is_dir() {
        return;
    }
    let config_dir = dir.to_string_lossy().into_owned();
    if registered.iter().any(|r| r == &config_dir) || out.iter().any(|a| a.config_dir == config_dir)
    {
        return;
    }
    out.push(Account {
        id: Uuid::new_v4().to_string(),
        label: label.to_string(),
        config_dir,
    });
}

/// Turn a split-profile folder name (".claude-personal", "claude-work", ...) into a short
/// human label ("Personal", "Work"). Falls back to "Account".
fn pretty_label(profile: &str) -> String {
    let s = profile
        .trim_start_matches('.')
        .trim_start_matches("claude-")
        .trim_start_matches("claude")
        .trim_matches(|c| c == '-' || c == '_');
    if s.is_empty() {
        return "Account".to_string();
    }
    let mut chars = s.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Account".to_string(),
    }
}

impl Store {
    pub fn new() -> Self {
        let save_path = data_dir().join("state.json");

        // Load the new object shape; fall back to the legacy bare `Vec<Project>` array and
        // wrap it (rewritten to the object shape on the next save). An array can't
        // deserialize into a struct and vice-versa, so the two branches are unambiguous.
        let state = fs::read(&save_path)
            .ok()
            .and_then(|data| {
                serde_json::from_slice::<PersistState>(&data)
                    .ok()
                    .or_else(|| {
                        serde_json::from_slice::<Vec<Project>>(&data)
                            .ok()
                            .map(|projects| PersistState {
                                projects,
                                ..Default::default()
                            })
                    })
            })
            .unwrap_or_default();

        Store {
            projects: Mutex::new(state.projects),
            accounts: Mutex::new(state.accounts),
            default_account: Mutex::new(state.default_account),
            trust: Mutex::new(state.trust),
            opencode: Mutex::new(state.opencode),
            opencode_key: Mutex::new(None),
            save_path,
        }
    }

    fn save(&self, projects: &[Project]) {
        // Atomic write: serialize, write a temp file, then rename over the target so
        // a crash mid-write can't corrupt state.json. Errors are surfaced to stderr.
        // Assemble the full persisted object (projects + account registry); the caller
        // already holds the projects lock, so lock only the other two mutexes here.
        let state = PersistState {
            projects: projects.to_vec(),
            accounts: self
                .accounts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            default_account: self
                .default_account
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            trust: self.trust.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            opencode: self
                .opencode
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        };
        let data = match serde_json::to_vec_pretty(&state) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("conduit: failed to serialize state: {e}");
                return;
            }
        };
        let tmp = self.save_path.with_extension("json.tmp");
        if let Err(e) = fs::write(&tmp, &data) {
            eprintln!("conduit: failed to write state: {e}");
            return;
        }
        // Rename over the target. On Windows a transient lock (AV scan / Search indexer /
        // sync client) can make this fail with ERROR_SHARING_VIOLATION even though a POSIX
        // rename-over-open never does; retry briefly before giving up. macOS/Linux keep the
        // single-rename path so their behavior is unchanged.
        #[cfg(windows)]
        {
            for attempt in 0..10 {
                match fs::rename(&tmp, &self.save_path) {
                    Ok(()) => return,
                    Err(e) => {
                        if attempt == 9 {
                            let _ = fs::remove_file(&tmp);
                            eprintln!("conduit: failed to persist state after retries: {e}");
                        } else {
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                    }
                }
            }
        }
        #[cfg(not(windows))]
        if let Err(e) = fs::rename(&tmp, &self.save_path) {
            eprintln!("conduit: failed to persist state: {e}");
        }
    }

    pub fn list(&self) -> Vec<Project> {
        self.projects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn add_project(&self, path: String) -> Project {
        let name = PathBuf::from(&path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name,
            path,
            sessions: Vec::new(),
            layout: None,
        };
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        projects.push(project.clone());
        self.save(&projects);
        project
    }

    pub fn remove_project(&self, project_id: &str) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        projects.retain(|p| p.id != project_id);
        self.save(&projects);
    }

    pub fn add_session(
        &self,
        project_id: &str,
        name: String,
        use_worktree: bool,
        agent: crate::agent::AgentId,
        role: SessionRole,
    ) -> Option<Session> {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        let project = projects.iter_mut().find(|p| p.id == project_id)?;
        // At most one Conductor per project.
        if role == SessionRole::Conductor
            && project
                .sessions
                .iter()
                .any(|s| s.role == SessionRole::Conductor)
        {
            return None;
        }
        let id = Uuid::new_v4().to_string();
        // The Conductor runs in the project root (it orchestrates, it doesn't edit code),
        // so it never gets a worktree even if `use_worktree` is passed.
        let (worktree_path, branch) = if use_worktree && role != SessionRole::Conductor {
            let slug = crate::worktree::slug(&name, &id);
            (
                Some(crate::worktree::worktree_path(&project.path, &slug)),
                Some(crate::worktree::branch_name(&slug)),
            )
        } else {
            (None, None)
        };
        let session = Session {
            id,
            name,
            use_worktree,
            worktree_path,
            branch,
            agent,
            role,
            account_id: None,
            ..Default::default()
        };
        project.sessions.push(session.clone());
        self.save(&projects);
        Some(session)
    }

    /// The agent for a session id, searching all projects. Defaults to Claude for an
    /// unknown id (back-compat / shell-only companions that were never persisted).
    pub fn session_agent(&self, session_id: &str) -> crate::agent::AgentId {
        let projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        projects
            .iter()
            .flat_map(|p| &p.sessions)
            .find(|s| s.id == session_id)
            .map(|s| s.agent)
            .unwrap_or_default()
    }

    // ---- Account registry (Feature 2: Claude account switching) ----------------

    /// Re-serialize the full state to disk after an account/default change. Callers must
    /// NOT hold the accounts / default_account locks (save() re-locks them).
    fn persist(&self) {
        let projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        self.save(&projects);
    }

    /// Resolve a session's Claude account config dir: the session's own `account_id`, else
    /// the global default account, mapped to that account's `config_dir`. None means the
    /// child inherits Conduit's own env (unconfigured / single-account behavior).
    pub fn session_account_config_dir(&self, session_id: &str) -> Option<String> {
        let account_id = {
            let projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
            projects
                .iter()
                .flat_map(|p| &p.sessions)
                .find(|s| s.id == session_id)
                .and_then(|s| s.account_id.clone())
        }
        .or_else(|| {
            self.default_account
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        })?;
        let accounts = self.accounts.lock().unwrap_or_else(|e| e.into_inner());
        accounts
            .iter()
            .find(|a| a.id == account_id)
            .map(|a| a.config_dir.clone())
    }

    pub fn list_accounts(&self) -> Vec<Account> {
        self.accounts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn default_account(&self) -> Option<String> {
        self.default_account
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The config dir of the global default account, or None if no default is set / it no
    /// longer resolves. Used by the (session-less) Claude usage panel so its local-token
    /// read AND its plan-usage token read follow the account the user actually selected --
    /// otherwise both silently read `~/.claude` (the first/only account) and show the wrong
    /// account's usage. Mirrors `session_account_config_dir`'s default-account branch, minus
    /// the per-session lookup (the usage panel is global, not tied to one session).
    pub fn default_account_config_dir(&self) -> Option<String> {
        let account_id = self
            .default_account
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        let accounts = self.accounts.lock().unwrap_or_else(|e| e.into_inner());
        accounts
            .iter()
            .find(|a| a.id == account_id)
            .map(|a| a.config_dir.clone())
    }

    /// Register an account. Errors on an empty / missing / duplicate config dir; else the
    /// new Account. The `.claude` dir need not be authenticated -- an empty one just drops
    /// the user into `claude`'s normal login flow inside the session.
    pub fn add_account(&self, label: String, config_dir: String) -> Result<Account, String> {
        let config_dir = config_dir.trim().to_string();
        if config_dir.is_empty() {
            return Err("A config directory is required.".into());
        }
        if !std::path::Path::new(&config_dir).is_dir() {
            return Err(format!("Directory does not exist: {config_dir}"));
        }
        let account = {
            let mut accounts = self.accounts.lock().unwrap_or_else(|e| e.into_inner());
            if accounts.iter().any(|a| a.config_dir == config_dir) {
                return Err("That config directory is already registered.".into());
            }
            let label = label.trim();
            let account = Account {
                id: Uuid::new_v4().to_string(),
                label: if label.is_empty() {
                    config_dir.clone()
                } else {
                    label.to_string()
                },
                config_dir,
            };
            accounts.push(account.clone());
            account
        };
        self.persist();
        Ok(account)
    }

    /// Remove an account: drop it, clear it as the default if set, and null out any session
    /// that referenced it so no dangling id survives.
    pub fn remove_account(&self, account_id: &str) {
        {
            let mut accounts = self.accounts.lock().unwrap_or_else(|e| e.into_inner());
            accounts.retain(|a| a.id != account_id);
        }
        {
            let mut def = self
                .default_account
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if def.as_deref() == Some(account_id) {
                *def = None;
            }
        }
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        for p in projects.iter_mut() {
            for s in p.sessions.iter_mut() {
                if s.account_id.as_deref() == Some(account_id) {
                    s.account_id = None;
                }
            }
        }
        self.save(&projects);
    }

    pub fn set_default_account(&self, account_id: Option<String>) {
        {
            let mut def = self
                .default_account
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *def = account_id;
        }
        self.persist();
    }

    pub fn set_session_account(&self, session_id: &str, account_id: Option<String>) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        for p in projects.iter_mut() {
            if let Some(s) = p.sessions.iter_mut().find(|s| s.id == session_id) {
                s.account_id = account_id;
                break;
            }
        }
        self.save(&projects);
    }

    // ---- Trust boundaries (Feature 4: multi-agent silo / controlled sharing) -----

    pub fn trust_settings(&self) -> TrustSettings {
        self.trust.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Whether the trust-boundary regime is active. The fleet MCP gates and the spawner's
    /// silo handling all short-circuit to their pre-Feature-4 behavior when this is false.
    pub fn is_private_mode(&self) -> bool {
        self.trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .private_mode
    }

    pub fn set_trust_settings(&self, settings: TrustSettings) {
        {
            let mut t = self.trust.lock().unwrap_or_else(|e| e.into_inner());
            *t = settings;
        }
        self.persist();
    }

    /// Apply a trust update to one session (the "mark sensitive" action; later, the policy
    /// editor). Overwrites the session's clearance / silo / local_only / channels / tier / seed.
    pub fn set_session_trust(&self, session_id: &str, trust: SessionTrust) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        for p in projects.iter_mut() {
            if let Some(s) = p.sessions.iter_mut().find(|s| s.id == session_id) {
                s.clearance = trust.clearance;
                s.silo = trust.silo;
                s.local_only = trust.local_only;
                s.channels = trust.channels;
                s.model_tier = trust.model_tier;
                s.seed_memory = trust.seed_memory;
                s.effort = trust.effort;
                break;
            }
        }
        self.save(&projects);
    }

    /// Whether a session is siloed. Read by the spawner to suppress its remote (bridge) stream.
    pub fn is_session_siloed(&self, session_id: &str) -> bool {
        self.projects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .flat_map(|p| &p.sessions)
            .find(|s| s.id == session_id)
            .map(|s| s.silo)
            .unwrap_or(false)
    }

    /// Whether a session is marked local-only (trust boundaries). Under private mode this makes the
    /// OpenCode spawner pin the injected local provider as the ONLY enabled provider.
    pub fn is_session_local_only(&self, session_id: &str) -> bool {
        self.projects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .flat_map(|p| &p.sessions)
            .find(|s| s.id == session_id)
            .map(|s| s.local_only)
            .unwrap_or(false)
    }

    // ---- OpenCode local provider ---------------------------------------------------

    pub fn opencode_settings(&self) -> OpenCodeSettings {
        self.opencode
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_opencode_settings(&self, settings: OpenCodeSettings) {
        {
            let mut s = self.opencode.lock().unwrap_or_else(|e| e.into_inner());
            *s = settings;
        }
        self.persist();
    }

    /// Set (Some) or clear (None) the in-memory endpoint API key. Never persisted.
    /// Trimmed on the way in — a paste with padding would otherwise ride into the
    /// Authorization header verbatim and 401 with no way to inspect the held value.
    pub fn set_opencode_key(&self, key: Option<String>) {
        let mut k = self.opencode_key.lock().unwrap_or_else(|e| e.into_inner());
        *k = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    }

    /// The in-memory endpoint API key, if one was set this run.
    pub fn opencode_key(&self) -> Option<String> {
        self.opencode_key
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Auto-detect candidate Claude account dirs to prefill the accounts manager (does not
    /// register them): the canonical `~/.claude`, plus any `<profile>/.claude` one level
    /// under a `~/.claude-split*` folder (the pattern the personal-profile launcher uses).
    /// Skips already-registered dirs. No network, no credential reads.
    pub fn discover_accounts(&self) -> Vec<Account> {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return Vec::new(),
        };
        let registered: Vec<String> = self
            .accounts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|a| a.config_dir.clone())
            .collect();
        let mut out: Vec<Account> = Vec::new();
        push_candidate(&mut out, &registered, "Default", home.join(".claude"));
        if let Ok(entries) = fs::read_dir(&home) {
            for entry in entries.flatten() {
                let split = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if split.is_dir() && name.starts_with(".claude-split") {
                    if let Ok(subs) = fs::read_dir(&split) {
                        for sub in subs.flatten() {
                            let profile = sub.path();
                            if profile.is_dir() {
                                let stem = sub.file_name().to_string_lossy().into_owned();
                                push_candidate(
                                    &mut out,
                                    &registered,
                                    &pretty_label(&stem),
                                    profile.join(".claude"),
                                );
                            }
                        }
                    }
                }
            }
        }
        out
    }

    pub fn set_layout(&self, project_id: &str, layout: ProjectLayout) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = projects.iter_mut().find(|p| p.id == project_id) {
            p.layout = Some(layout);
            self.save(&projects);
        }
    }

    pub fn rename_session(&self, project_id: &str, session_id: &str, name: String) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
            if let Some(session) = project.sessions.iter_mut().find(|s| s.id == session_id) {
                session.name = name;
            }
        }
        self.save(&projects);
    }

    pub fn remove_session(&self, project_id: &str, session_id: &str) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
            project.sessions.retain(|s| s.id != session_id);
        }
        self.save(&projects);
    }

    /// Resolve the project that owns `conductor_id` and return its sessions.
    pub fn fleet_snapshot(&self, conductor_id: &str) -> Option<FleetSnapshot> {
        let projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        let project = projects
            .iter()
            .find(|p| p.sessions.iter().any(|s| s.id == conductor_id))?;
        Some(FleetSnapshot {
            project_id: project.id.clone(),
            project_path: project.path.clone(),
            sessions: project.sessions.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Store {
        /// Test-only constructor bypassing `data_dir()`/disk I/O. `pub(crate)` so other
        /// modules' `#[cfg(test)]` code (e.g. `fleet_mcp.rs`'s SPEC-0 regression tests) can
        /// build a real `Store` without touching the user's actual state.json.
        pub(crate) fn for_test(dir: &std::path::Path) -> Self {
            Store {
                projects: Mutex::new(Vec::new()),
                accounts: Mutex::new(Vec::new()),
                default_account: Mutex::new(None),
                trust: Mutex::new(TrustSettings::default()),
                opencode: Mutex::new(OpenCodeSettings::default()),
                opencode_key: Mutex::new(None),
                save_path: dir.join("state.json"),
            }
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conduit_store_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn add_session_without_worktree_leaves_fields_empty() {
        let dir = temp_dir("plain");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Session 1".into(),
                false,
                crate::agent::AgentId::Claude,
                SessionRole::Worker,
            )
            .unwrap();
        assert!(!s.use_worktree);
        assert!(s.worktree_path.is_none());
        assert!(s.branch.is_none());
    }

    #[test]
    fn add_session_with_worktree_computes_path_and_branch() {
        let dir = temp_dir("wt");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "My Feature".into(),
                true,
                crate::agent::AgentId::Claude,
                SessionRole::Worker,
            )
            .unwrap();
        assert!(s.use_worktree);
        let path = s.worktree_path.unwrap();
        // Normalize separators so this holds on Windows (`\`) too; the path is built with
        // `Path::join` (native separator).
        assert!(
            path.replace('\\', "/")
                .starts_with("/repo/.claude/worktrees/"),
            "got {path}"
        );
        assert!(s.branch.unwrap().starts_with("worktree-"));
    }

    #[test]
    fn session_agent_returns_stored_agent_else_claude() {
        let dir = temp_dir("lookup");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "S".into(),
                false,
                crate::agent::AgentId::Codex,
                SessionRole::Worker,
            )
            .unwrap();
        assert_eq!(store.session_agent(&s.id), crate::agent::AgentId::Codex);
        assert_eq!(
            store.session_agent("missing"),
            crate::agent::AgentId::Claude
        );
    }

    #[test]
    fn add_session_defaults_agent_to_claude() {
        let dir = temp_dir("agent_default");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Session 1".into(),
                false,
                crate::agent::AgentId::Claude,
                SessionRole::Worker,
            )
            .unwrap();
        assert_eq!(s.agent, crate::agent::AgentId::Claude);
    }

    #[test]
    fn old_state_json_without_agent_deserializes_as_claude() {
        let json = r#"{"id":"x","name":"n","useWorktree":false}"#;
        let s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.agent, crate::agent::AgentId::Claude);
    }

    #[test]
    fn old_state_json_without_account_deserializes_as_none() {
        let json = r#"{"id":"x","name":"n","useWorktree":false}"#;
        let s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.account_id, None);
    }

    #[test]
    fn session_account_config_dir_resolves_session_then_default() {
        let dir = temp_dir("acct");
        let store = Store::for_test(&dir);
        // add_account validates the dir exists, so create two real dirs to register.
        let work_dir = dir.join("work-dot-claude");
        let personal_dir = dir.join("personal-dot-claude");
        fs::create_dir_all(&work_dir).unwrap();
        fs::create_dir_all(&personal_dir).unwrap();
        let work = store
            .add_account("Work".into(), work_dir.to_string_lossy().into_owned())
            .unwrap();
        let personal = store
            .add_account(
                "Personal".into(),
                personal_dir.to_string_lossy().into_owned(),
            )
            .unwrap();

        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "s".into(),
                false,
                crate::agent::AgentId::Claude,
                SessionRole::Worker,
            )
            .unwrap();

        // No default and no session account -> None (inherit env).
        assert_eq!(store.session_account_config_dir(&s.id), None);
        // The global default applies.
        store.set_default_account(Some(work.id.clone()));
        assert_eq!(
            store.session_account_config_dir(&s.id),
            Some(work_dir.to_string_lossy().into_owned())
        );
        // A session-specific account overrides the default.
        store.set_session_account(&s.id, Some(personal.id.clone()));
        assert_eq!(
            store.session_account_config_dir(&s.id),
            Some(personal_dir.to_string_lossy().into_owned())
        );
        // A duplicate config dir is rejected.
        assert!(store
            .add_account("Dup".into(), work_dir.to_string_lossy().into_owned())
            .is_err());
    }

    #[test]
    fn session_role_defaults_to_worker_for_old_state() {
        // A persisted session from before `role` existed must load as Worker.
        let json = r#"{"id":"s1","name":"old","useWorktree":false}"#;
        let s: Session = serde_json::from_str(json).expect("deserialize");
        assert_eq!(
            s.role,
            SessionRole::Worker,
            "missing role must default to Worker"
        );
    }

    #[test]
    fn fleet_snapshot_returns_project_and_sessions() {
        let dir = temp_dir("fleet_snap");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let c = store
            .add_session(
                &p.id,
                "Conductor".into(),
                false,
                crate::agent::AgentId::Claude,
                SessionRole::Conductor,
            )
            .unwrap();
        store.add_session(
            &p.id,
            "w1".into(),
            false,
            crate::agent::AgentId::Claude,
            SessionRole::Worker,
        );
        let snap = store
            .fleet_snapshot(&c.id)
            .expect("snapshot for conductor id");
        assert_eq!(snap.project_path, "/repo");
        assert_eq!(snap.sessions.len(), 2, "conductor + 1 worker");
        assert!(store.fleet_snapshot("nope").is_none());
    }

    #[test]
    fn add_session_rejects_second_conductor() {
        let dir = temp_dir("conductor_unique");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let c1 = store.add_session(
            &p.id,
            "Conductor".into(),
            false,
            crate::agent::AgentId::Claude,
            SessionRole::Conductor,
        );
        assert!(c1.is_some(), "first conductor should be created");
        let c2 = store.add_session(
            &p.id,
            "Conductor2".into(),
            false,
            crate::agent::AgentId::Claude,
            SessionRole::Conductor,
        );
        assert!(c2.is_none(), "second conductor must be rejected");
        let w = store.add_session(
            &p.id,
            "w".into(),
            false,
            crate::agent::AgentId::Claude,
            SessionRole::Worker,
        );
        assert!(w.is_some(), "workers are unaffected");
    }

    #[test]
    fn conductor_never_gets_a_worktree() {
        let dir = temp_dir("conductor_no_wt");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        // use_worktree=true is ignored for a Conductor.
        let c = store
            .add_session(
                &p.id,
                "Conductor".into(),
                true,
                crate::agent::AgentId::Claude,
                SessionRole::Conductor,
            )
            .unwrap();
        assert!(
            c.worktree_path.is_none(),
            "conductor must run in project root"
        );
        assert!(c.branch.is_none());
    }

    #[test]
    fn session_role_serializes_camel_lowercase() {
        let s = Session {
            id: "c1".into(),
            name: "cond".into(),
            use_worktree: false,
            worktree_path: None,
            branch: None,
            agent: crate::agent::AgentId::Claude,
            role: SessionRole::Conductor,
            account_id: None,
            ..Default::default()
        };
        let v = serde_json::to_string(&s).unwrap();
        assert!(v.contains(r#""role":"conductor""#), "got {v}");
    }

    // ---- Trust boundaries (Feature 4) ----

    fn mk(id: &str) -> Session {
        Session {
            id: id.into(),
            name: id.into(),
            ..Default::default()
        }
    }

    #[test]
    fn can_read_allows_self_and_equal_public_clearance() {
        let a = mk("a");
        let b = mk("b");
        assert!(can_read(&a, &a), "a session can always read itself");
        assert!(can_read(&a, &b), "public reads public");
    }

    #[test]
    fn silo_is_never_readable_by_others_but_reads_others() {
        let conductor = mk("c");
        let mut opencode = mk("oc");
        opencode.silo = true;
        // The crown jewel: no other agent may read the siloed session.
        assert!(!can_read(&conductor, &opencode));
        // Asymmetry: the siloed session may still read non-siloed peers.
        assert!(can_read(&opencode, &conductor));
    }

    #[test]
    fn clearance_ceiling_blocks_reading_up() {
        let public = mk("p"); // Clearance::Public by default
        let mut confidential = mk("k");
        confidential.clearance = Clearance::Confidential;
        assert!(
            !can_read(&public, &confidential),
            "public cannot read confidential"
        );
        assert!(
            can_read(&confidential, &public),
            "confidential can read public"
        );
    }

    #[test]
    fn can_inject_blocks_only_self() {
        let a = mk("a");
        let b = mk("b");
        assert!(!can_inject(&a, &a));
        assert!(can_inject(&a, &b));
    }

    #[test]
    fn clearance_orders_low_to_high() {
        assert!(Clearance::Public < Clearance::Internal);
        assert!(Clearance::Internal < Clearance::Confidential);
    }

    #[test]
    fn old_state_json_defaults_trust_fields() {
        // A session persisted before Feature 4 must load as public / non-silo.
        let json = r#"{"id":"x","name":"n","useWorktree":false}"#;
        let s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.clearance, Clearance::Public);
        assert!(!s.silo);
        assert!(!s.local_only);
        assert!(s.channels.is_empty());
        assert!(s.model_tier.is_none());
        // A state.json with no `trust` key defaults private_mode = false (regime inert).
        let ps: PersistState = serde_json::from_str(r#"{"projects":[]}"#).unwrap();
        assert!(!ps.trust.private_mode);
    }

    #[test]
    fn scanner_flags_secrets_and_ignores_prose() {
        assert!(scan_sensitivity("just some prose about a cat and a hat").is_empty());
        assert!(scan_sensitivity("AKIA1234567890ABCDEF")
            .iter()
            .any(|h| h.kind == "aws-access-key"));
        assert!(scan_sensitivity("token: ghp_abcDEF1234567890")
            .iter()
            .any(|h| h.kind == "github-token"));
        assert!(scan_sensitivity("-----BEGIN RSA PRIVATE KEY-----")
            .iter()
            .any(|h| h.kind == "private-key"));
        assert!(scan_sensitivity("password = hunter2")
            .iter()
            .any(|h| h.kind == "credential"));
        // sk- needs a long token tail to count, so ordinary words don't false-positive.
        assert!(scan_sensitivity("sk-abcdefghijklmnopqrstuvwxyz012345")
            .iter()
            .any(|h| h.kind == "api-key"));
        assert!(scan_sensitivity("please ask-me later about the task")
            .iter()
            .all(|h| h.kind != "api-key"));
    }

    #[test]
    fn set_session_trust_marks_sensitive_and_persists_private_mode() {
        let dir = temp_dir("trust");
        let store = Store::for_test(&dir);
        assert!(!store.is_private_mode());
        store.set_trust_settings(TrustSettings { private_mode: true });
        assert!(store.is_private_mode());

        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "s".into(),
                false,
                crate::agent::AgentId::OpenCode,
                SessionRole::Worker,
            )
            .unwrap();
        assert!(!store.is_session_siloed(&s.id));
        store.set_session_trust(
            &s.id,
            SessionTrust {
                clearance: Clearance::Confidential,
                silo: true,
                local_only: true,
                channels: vec!["collab".into()],
                ..Default::default()
            },
        );
        assert!(store.is_session_siloed(&s.id));
        assert!(store.is_session_local_only(&s.id));
        assert!(!store.is_session_local_only("missing"));
    }

    #[test]
    fn opencode_settings_persist_but_key_never_touches_disk() {
        let dir = temp_dir("oc_settings");
        let store = Store::for_test(&dir);
        assert!(!store.opencode_settings().enabled, "defaults off");

        // Padding is trimmed on the way in (a padded paste would 401 silently).
        store.set_opencode_key(Some("  sk-local-test-XYZ \n".into()));
        store.set_opencode_settings(OpenCodeSettings {
            enabled: true,
            preset: "ollama".into(),
            base_url: "http://localhost:11434/v1".into(),
            model: "qwen3:30b-a3b".into(),
            context_limit: Some(262144),
            output_limit: Some(16384),
            pin_local: true,
        });
        assert_eq!(store.opencode_key().as_deref(), Some("sk-local-test-XYZ"));

        // Settings round-trip through the persisted file; the key must NOT be in it.
        let raw = fs::read_to_string(dir.join("state.json")).unwrap();
        assert!(
            !raw.contains("sk-local-test-XYZ"),
            "API key leaked into state.json"
        );
        let ps: PersistState = serde_json::from_str(&raw).unwrap();
        assert!(ps.opencode.enabled);
        assert_eq!(ps.opencode.model, "qwen3:30b-a3b");
        assert_eq!(ps.opencode.context_limit, Some(262144));
        assert!(ps.opencode.pin_local);

        // Clearing (or setting a blank) key empties the holder.
        store.set_opencode_key(Some("   ".into()));
        assert!(store.opencode_key().is_none());
    }

    #[test]
    fn old_state_json_without_opencode_defaults_disabled() {
        let ps: PersistState = serde_json::from_str(r#"{"projects":[]}"#).unwrap();
        assert!(!ps.opencode.enabled);
        assert!(ps.opencode.base_url.is_empty());
        assert!(ps.opencode.context_limit.is_none());
    }
}
