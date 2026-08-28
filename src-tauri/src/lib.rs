//! Conduit (Tauri port) — app entry. Ports ConduitApp.swift.
//!
//! Wires together the four owners that the Swift app keeps as singletons:
//!   PtyManager (TerminalLauncher) · Store (AppStore) · HookState/server (HookServer)
//! and exposes them to the React frontend as Tauri commands.

mod agent;
mod agy_usage;
mod board;
mod bridge;
mod broker;
mod claude_status;
mod claude_usage;
mod clipboard;
mod commandcode_config;
mod commandcode_usage;
mod context_window;
mod continuity;
mod continuity_feed;
mod continuity_read;
mod fleet;
mod fleet_mcp;
mod format;
mod fsops;
mod git;
mod git_mut;
mod hookbus;
mod hooks;
mod hotexit;
mod local_llm;
mod menu;
mod notify;
mod plugins;
mod pty;
mod root_chat;
mod routing;
mod scrollback;
mod search;
#[cfg_attr(windows, allow(dead_code))]
mod session_budget;
mod status_rules;
mod store;
mod subagents;
mod tasks;
mod telemetry;
#[cfg_attr(windows, allow(dead_code))]
mod tmux;
mod transcript;
mod transcript_index;
mod updates;
mod usage_tally;
mod worktree;

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};

use hooks::HookState;
use pty::PtyManager;
use store::{Project, ProjectLayout, Session, SessionRole, Store};
use tasks::{BoardSnapshot, Card, Column, TaskBoard};

/// Suppress the console window Windows flashes when a GUI app spawns a console child
/// (`where`, `curl`, `git`, `cmd`, ...). Applies CREATE_NO_WINDOW on Windows; a no-op
/// everywhere else. Not needed for PTY sessions — portable-pty's ConPTY is already
/// headless. Apply to every `std::process::Command` before `output()`/`status()`/`spawn()`.
pub(crate) trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        self
    }
}

/// Unsaved-buffer count pushed from the frontend (`set_dirty_count`). Rust has no
/// other view of editor dirtiness; the quit paths (menu.rs `quit` arm and the
/// `CloseRequested` handler below) consult it so a clean quit stays instant and
/// webview-independent, while a dirty quit round-trips for a confirm dialog.
#[derive(Default)]
pub(crate) struct DirtyGuard(pub std::sync::atomic::AtomicUsize);

/// SPEC-F: does a WORKER session qualify for fleet MCP via mailbox opt-in (as opposed to
/// a fleet mission)? True iff it has no mission AND has explicitly joined at least one
/// channel (the Sidebar "Share in project" toggle sets `channels: ["project"]`). Pure so
/// it's unit-testable without touching `Store`/Tauri.
fn opts_into_mailbox(has_mission: bool, channels: &[String]) -> bool {
    !has_mission && !channels.is_empty()
}

// ---- Terminal / PTY commands -------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    app: tauri::AppHandle,
    session_id: String,
    working_directory: String,
    cols: u16,
    rows: u16,
    shell_only: bool,
    worktree_name: Option<String>,
    role: Option<String>,
    initial_prompt: Option<String>,
    // Feature C: resolved MCP server definitions for this session's allowlist. The registry
    // lives in the frontend's localStorage, so Rust can't resolve names itself -- the caller
    // sends the definitions it already holds, looked up fresh at every spawn. None =
    // inherit (no MCP flags), which is the pre-allowlist behavior.
    mcp_allowlist: Option<Vec<crate::agent::McpServer>>,
    on_event: Channel<String>,
    pty: State<Arc<PtyManager>>,
    hook_state: State<Arc<HookState>>,
    fleet: State<Arc<crate::fleet::FleetState>>,
    board: State<Arc<crate::board::BoardState>>,
    store: State<Arc<Store>>,
    agy_resume: State<Arc<crate::agy_usage::AgyResumeState>>,
) -> Result<(), String> {
    let port = hook_state.port.load(Ordering::SeqCst);
    let agent = if shell_only {
        crate::agent::AgentId::Claude // shell companion: agent is irrelevant
    } else {
        store.session_agent(&session_id)
    };
    let adapter = crate::agent::adapter_for(agent);

    // Account selection: the session's registered Claude account (its own, else the global
    // default), resolved from the store; falls back to the CONDUIT_CLAUDE_CONFIG_DIR env
    // override. Points Claude at a specific config/credentials dir without disturbing the
    // user's default `claude`. Never applied to a plain shell companion.
    let account_config_dir = if shell_only {
        None
    } else {
        store.session_account_config_dir(&session_id).or_else(|| {
            std::env::var("CONDUIT_CLAUDE_CONFIG_DIR")
                .ok()
                .filter(|s| !s.is_empty())
        })
    };

    // agy usage tracking: sync the status-line hook into the home THIS agy session will
    // actually read from (respecting the per-account HOME redirect pty.rs applies below).
    // The global toggle writes to the default account's home, but a session bound to a
    // different account uses a different `.gemini` — so install/remove per-spawn where
    // agy looks, or the panel silently never populates under the two-account split.
    if !shell_only && agent == crate::agent::AgentId::Antigravity {
        if let Some(home) = crate::agy_usage::resolve_agy_home(account_config_dir.as_deref()) {
            let enabled = crate::agy_usage::tracking_enabled(&store);
            if let Err(e) = crate::agy_usage::configure_in_home(&home, enabled) {
                eprintln!("conduit: agy usage tracking sync failed: {e}");
            }
            // Resume bookkeeping. If our captured conversation id's db is gone (agy rotated /
            // the user deleted it), clear it so we start fresh and re-capture instead of
            // resuming a dead id forever. If there's nothing to resume, snapshot the existing
            // conversations so the first agyusage hook can tell which new db is THIS session's
            // (disambiguates a shared agy home -- see AgyResumeState).
            match store.session_agent_conversation_id(&session_id) {
                Some(id) if !crate::agy_usage::conversation_db_exists(&home, &id) => {
                    store.clear_session_agent_conversation_id(&session_id);
                    agy_resume.snapshot(&session_id, &home);
                }
                None => agy_resume.snapshot(&session_id, &home),
                _ => {} // valid resume in flight; nothing to capture
            }
        }
    }

    // A Conductor session gets the fleet MCP server (scoped to it via --mcp-config) and
    // the full orchestration persona. A WORKER gets the SAME MCP server, scoped to its own
    // id, but only a tiny brief instead of the Conductor's persona -- `authorize()`
    // server-side restricts it to fleet_result/fleet_note/fleet_inbox, never the
    // orchestration tools, so attaching the connection at all is safe even though the
    // persona here is minimal. A worker qualifies one of two ways: (a) it was spawned via
    // fleet_spawn (SPEC-C: it has a Mission record on the project's board), or (b) it's a
    // manual/custom session that explicitly opted into the horizontal mailbox (SPEC-F: the
    // Sidebar "Share in project" toggle sets non-empty `channels`) -- a manual session with
    // no opt-in gets neither and stays fully isolated, per the baseline design's invariant 3.
    // One session lookup, reused below for the mailbox opt-in check and the model_tier/
    // effort resolution -- avoids repeating the fleet_snapshot scan three times.
    let this_session = store
        .fleet_snapshot(&session_id)
        .and_then(|snap| snap.sessions.into_iter().find(|s| s.id == session_id));
    let mission_record = if !shell_only && role.as_deref() == Some("worker") {
        store.fleet_snapshot(&session_id).and_then(|snap| {
            board
                .query(&snap.project_id, Some(crate::board::BoardKind::Mission))
                .into_iter()
                .find(|m| m.author_session == session_id)
        })
    } else {
        None
    };
    let opted_into_mailbox = !shell_only
        && role.as_deref() == Some("worker")
        && this_session
            .as_ref()
            .is_some_and(|s| opts_into_mailbox(mission_record.is_some(), &s.channels));
    // Task 15: a session belonging to a project whose task board has been opened at least
    // once (`list_board` -> `Store::set_board_enabled`) also qualifies for the fleet MCP
    // server -- board-enabled projects want every session to be able to call `task_*`, not
    // only Conductor/mission/mailbox sessions. Resolved from `store` by session id rather
    // than threading a `Project` through the spawn path, mirroring
    // `session_account_config_dir`'s session->project lookup.
    let project_board_on = !shell_only && store.board_enabled_for_session(&session_id);
    let gets_fleet_mcp = mission_record.is_some() || opted_into_mailbox || project_board_on;
    // `--model` / `--effort`, for the adapters that verifiably take them (Claude and
    // Command Code). This used to be spelled `agent == Claude`; asking the ADAPTER means
    // adding a sixth agent with the same flags is a one-line capability rather than another
    // condition to remember here. An adapter that does not take them still RECORDS
    // model_tier/effort on the Session (fleet_spawn sets them), so they stay visible and
    // queryable -- they are simply not acted on.
    //
    // Two sources, in precedence order. A concrete `model` is what a route pins ("sonnet",
    // "google/gemini-3.7-flash"), and it wins because the user chose it for THIS session.
    // `model_tier` is the fleet's coarse cheap/standard/hard, resolved per agent.
    let takes_model_flags = !shell_only && crate::agent::adapter_for(agent).supports_model_flags();
    let agent_model = takes_model_flags
        .then(|| {
            let s = this_session.as_ref()?;
            s.model.clone().or_else(|| {
                s.model_tier
                    .as_deref()
                    .and_then(|tier| crate::agent::model_for_tier(agent, tier))
                    .map(str::to_string)
            })
        })
        .flatten();
    let agent_effort = takes_model_flags
        .then(|| this_session.as_ref().and_then(|s| s.effort.as_deref()))
        .flatten();
    let is_conductor = !shell_only
        && role.as_deref() == Some("conductor")
        && agent == crate::agent::AgentId::Claude;

    // C1 continuity: a real (non-shell) Claude session in a board-enabled project gets the
    // bundled continuity plugin's MCP tools + presence hooks via `--plugin-dir`, gated on
    // the host having Node >=22.5 (node:sqlite). `continuity_enabled` takes the RAW board
    // flag (not `project_board_on`, which already ANDs in `!shell_only`) and re-applies
    // `shell_only` itself -- passing `project_board_on` here would double-gate on
    // `!shell_only` harmlessly, but this keeps the two independent and unambiguous.
    // The Node probe shells out, so it's only run once the cheap gates already hold.
    let board_enabled_raw = store.board_enabled_for_session(&session_id);
    let is_claude_session = agent == crate::agent::AgentId::Claude;
    let continuity_precheck = !shell_only && is_claude_session && board_enabled_raw;
    let continuity_node = continuity_precheck.then(continuity::detect_node).flatten();
    let continuity_on = continuity::continuity_enabled(
        board_enabled_raw,
        is_claude_session,
        shell_only,
        continuity_node,
    );
    let continuity_plugin_dir: Option<String> = if continuity_on {
        continuity::continuity_asset_dir(&app).map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };
    // Graceful skip: board-enabled Claude session, but no usable Node -- the board still
    // works, just without continuity's MCP tools/presence hooks. Never errors the spawn.
    if continuity_precheck && continuity_node.is_none() {
        eprintln!(
            "conduit: continuity coordination needs Node >=22.5; skipping -- the board still works."
        );
    }

    // `--mcp-config`/`--append-system-prompt-file` are Claude CLI flags, carried through
    // `flags` into `build_invocation` -- ONLY meaningful for Claude. OpenCode's fleet-MCP
    // wiring goes entirely through `OPENCODE_CONFIG_CONTENT` (see the `opencode` block
    // below); passing these as bogus CLI flags to `opencode` itself would break its
    // invocation outright, so this branch is deliberately Claude-only.
    //
    // The persona rides as a FILE (`--append-system-prompt-file`), never inline: inline
    // `--append-system-prompt <~5KB persona>` overflowed cmd.exe's 8191-char command-line
    // limit on Windows once `build_invocation` doubled the flag string for its `||`
    // fallback -- the "command line is too long" Conductor-spawn failure. See
    // `fleet::write_persona_file`.
    let fleet_mcp_port = fleet.mcp_port.load(Ordering::SeqCst);
    let wants_fleet_mcp =
        (is_conductor || gets_fleet_mcp) && agent == crate::agent::AgentId::Claude;
    let system_prompt_file = if is_conductor {
        crate::fleet::write_persona_file(&session_id, crate::fleet::CONDUCTOR_PERSONA)
    } else if wants_fleet_mcp {
        crate::fleet::write_persona_file(&session_id, crate::fleet::WORKER_BRIEF_SUFFIX)
    } else {
        None
    };
    // Feature C: a session with its own MCP allowlist gets a GENERATED config (the fleet
    // block, when it has one, merged with exactly the servers it allows) plus
    // `--strict-mcp-config`. Without an allowlist this resolves to precisely what it
    // resolved to before the feature existed: the fleet-only config, unstrict.
    //
    // Claude-only, deliberately: `--strict-mcp-config` is verified in `claude --help`, and
    // guessing the equivalent flag for another CLI would break its invocation outright.
    //
    // The STORE decides whether there's an allowlist and which names are in it; the caller's
    // `mcp_allowlist` is only a dictionary of how to launch them (the registry lives in the
    // frontend's localStorage, so Rust can't resolve a name to a command on its own). If the
    // two disagree -- stale frontend state, a server deleted from the registry since -- the
    // persisted names win and an unresolvable one is simply dropped.
    let allowlist = (!shell_only && agent == crate::agent::AgentId::Claude)
        .then(|| store.session_mcp_servers(&session_id))
        .flatten()
        .map(|names| {
            let defs = mcp_allowlist.unwrap_or_default();
            let mut chosen: Vec<crate::agent::McpServer> = names
                .iter()
                .filter_map(|n| defs.iter().find(|d| &d.name == n).cloned())
                .collect();
            // `--strict-mcp-config` suppresses PLUGIN-provided MCP servers (verified against
            // Claude Code v2.1.222 -- see `plugin_mcp_servers`). Continuity's coordination
            // tools arrive that way, so without this a session that merely trimmed its MCP
            // list would silently lose them while its prompt still claimed to have them.
            // Carrying the plugin's own declarations into the generated config keeps the
            // allowlist a statement about the USER's servers, not a hidden opt-out from a
            // feature the project turned on.
            if let Some(dir) = continuity_plugin_dir.as_deref() {
                match std::fs::read_to_string(std::path::Path::new(dir).join(".mcp.json")) {
                    Ok(manifest) => chosen.extend(crate::agent::plugin_mcp_servers(dir, &manifest)),
                    Err(e) => eprintln!("conduit: continuity plugin .mcp.json unreadable ({e}); its tools will be missing under a session MCP allowlist"),
                }
            }
            chosen
        });
    let fleet_only_config =
        || wants_fleet_mcp.then(|| crate::fleet::write_mcp_config(fleet_mcp_port, &session_id));
    let (mcp_config_path, strict_mcp) = match allowlist {
        Some(servers) => {
            let fleet_block =
                wants_fleet_mcp.then(|| crate::fleet::mcp_config_json(fleet_mcp_port, &session_id));
            let json = crate::agent::session_mcp_config_json(&servers, fleet_block.as_deref());
            let path = crate::store::data_dir().join(format!("session-mcp-{session_id}.json"));
            match std::fs::write(&path, json) {
                Ok(()) => (Some(path.to_string_lossy().to_string()), true),
                Err(e) => {
                    // Never fail a spawn over MCP: fall back to inherit-everything.
                    eprintln!("conduit: session mcp-config write failed ({e}); inheriting MCP");
                    (fleet_only_config().flatten(), false)
                }
            }
        }
        None => (fleet_only_config().flatten(), false),
    };

    // Feature 4 silo: a siloed session (under private mode) must not stream its output to any
    // remote (mobile-bridge) viewer. Resolved here so the PTY reader can gate its fan-out.
    let suppress_remote =
        !shell_only && store.is_private_mode() && store.is_session_siloed(&session_id);

    // OpenCode local provider: route the session to the configured local/self-hosted
    // endpoint. None (feature off / not an OpenCode session / settings incomplete) spawns
    // untouched. Pinning (`enabled_providers: ["conduit"]`) applies globally by user
    // choice, or is forced for a local-only (siloed) session under private mode — the
    // "guaranteed local model" half of the trust-boundary silo.
    let opencode = if !shell_only && agent == crate::agent::AgentId::OpenCode {
        let settings = store.opencode_settings();
        let pin = settings.pin_local
            || (store.is_private_mode() && store.is_session_local_only(&session_id));
        let base =
            crate::agent::build_opencode_config(&settings, store.opencode_key().as_deref(), pin);
        if gets_fleet_mcp {
            // SPEC-A Tier 1 / SPEC-F: an OpenCode fleet worker (or a manual worker opted
            // into the mailbox) gets the SAME fleet MCP server a Claude worker does,
            // layered on top of whatever local-model config applies (or nothing, if
            // local-model routing is off) -- Tier-1 participation must
            // work independently of that feature.
            let mcp_port = fleet.mcp_port.load(Ordering::SeqCst);
            Some(crate::agent::inject_fleet_mcp(base, mcp_port, &session_id))
        } else {
            base
        }
    } else {
        None
    };

    let (cwd, worktree_arg, settings_path) = if shell_only {
        (working_directory.clone(), None, None)
    } else if worktree_name.is_some() && adapter.supports_worktree() {
        let slug = worktree_name.as_deref().unwrap();
        let settings = hooks::write_settings_file(port);
        let wt_path = worktree::worktree_path(&working_directory, slug);
        let exists = Path::new(&wt_path).exists();
        let (cwd, worktree_arg) =
            worktree::spawn_target(&working_directory, slug, &wt_path, exists);
        (cwd, worktree_arg, settings)
    } else if worktree_name.is_some() && !adapter.supports_worktree() {
        // SPEC-A: Conduit-driven worktree isolation for the four adapters with no
        // built-in `--worktree` flag. `Store::add_session` already computes
        // `worktree_path`/`branch` agent-agnostically when `use_worktree=true` -- this is
        // the first place that path is actually REALIZED on disk for a non-Claude agent
        // (previously silently inert; see Audit Finding 1).
        let slug = worktree_name.as_deref().unwrap();
        let wt_path = worktree::worktree_path(&working_directory, slug);
        let branch = worktree::branch_name(slug);
        if !Path::new(&wt_path).exists() {
            let base_ref =
                crate::git::current_branch(&working_directory).unwrap_or_else(|| "HEAD".into());
            if let Err(e) = worktree::add(&working_directory, &wt_path, &branch, &base_ref) {
                eprintln!("conduit: git worktree add failed for {slug}: {e}");
                // Fail-safe: surface the error rather than silently spawning unisolated in
                // the shared project root -- an isolation failure must be visible, never
                // quietly downgraded to "no isolation".
                return Err(format!("worktree setup failed: {e}"));
            }
        }
        // Install this adapter's status/result/note channel INTO the worktree, not the
        // repo root -- routing must be scoped to the worker's own tree.
        if let Some(profile) = adapter.hooks_profile() {
            hooks::install_profile(&wt_path, port, &profile);
        }
        if let Some(plugin) = adapter.plugin_profile() {
            hooks::install_plugin(&wt_path, port, &plugin);
        }
        // §7.4: brief a Tier-2/3 worker via AGENTS.md since it has no MCP channel to learn
        // its mission from. Only fires for a real fleet_spawn mission -- never for a
        // manual/custom session that merely happens to use a worktree.
        if let Some(mission) = &mission_record {
            hooks::write_mission_context(&wt_path, &mission.payload);
        }
        // SPEC-A Tier 1 for a non-Claude adapter: Command Code has no `--mcp-config`
        // flag, but it does read `<cwd>/.mcp.json`, and a Conduit-driven worktree IS this
        // worker's cwd -- so the same session-scoped fleet MCP server a Claude worker gets
        // is delivered as a file instead of a flag. That is what turns a Command Code
        // worker from "status only, hand back nothing" into a real fleet participant with
        // `fleet_result` and the mailbox.
        //
        // Deliberately only on the WORKTREE path. The non-worktree branch below runs in
        // the shared project root, where writing `.mcp.json` would both drop an untracked
        // file into the user's checkout and give every session in that project the same
        // session-scoped callback URL -- so a manual Command Code session stays on the
        // status channel alone.
        if gets_fleet_mcp {
            if let Some(rel) = adapter.project_mcp_config_rel_path() {
                let mcp_port = fleet.mcp_port.load(Ordering::SeqCst);
                crate::fleet::write_project_mcp_config(&wt_path, rel, mcp_port, &session_id);
                // The tools are useless if the worker does not know it has them, and
                // this adapter has no system-prompt flag to be told through.
                hooks::write_worker_brief_context(&wt_path);
            }
        }
        // SPEC-A Tier 2: Codex has no MCP, so its structured result rides the hook
        // channel instead -- provision the schema (and, on Windows, the curl helper
        // script) its build_invocation references, for every Codex worktree spawn, not
        // only a fleet-spawned one (a manual Codex session run with "use worktree" gets
        // the same `codex exec` result-reporting behavior for free).
        if agent == crate::agent::AgentId::Codex {
            if let Err(e) = hooks::write_codex_result_schema(&wt_path) {
                eprintln!("conduit: failed to write codex result schema: {e}");
            }
            #[cfg(windows)]
            if let Err(e) = hooks::write_codex_result_script(&wt_path, port) {
                eprintln!("conduit: failed to write codex result script: {e}");
            }
        }
        (wt_path, None, None)
    } else {
        // Normal session: install this agent's status integration. Hook-based agents
        // (Claude/Codex/Gemini) write a settings/hooks file; OpenCode installs a JS
        // status plugin instead. An agent has one or the other, never both.
        if let Some(profile) = adapter.hooks_profile() {
            hooks::install_profile(&working_directory, port, &profile);
        }
        if let Some(plugin) = adapter.plugin_profile() {
            hooks::install_plugin(&working_directory, port, &plugin);
        }
        (working_directory.clone(), None, None)
    };

    // Resume token: the agent's own captured conversation id. agy resumes via
    // `--conversation=<id>` and Command Code via `--session <id>`; Claude ignores it (it
    // keys off session_id, which Conduit gets to pin itself). None for shell-only
    // companions and for a session we haven't captured an id for yet.
    let resume_token = (!shell_only)
        .then(|| store.session_agent_conversation_id(&session_id))
        .flatten();
    pty.spawn(
        session_id,
        cwd,
        cols,
        rows,
        port,
        shell_only,
        worktree_arg,
        settings_path,
        mcp_config_path,
        continuity_plugin_dir,
        system_prompt_file,
        initial_prompt,
        account_config_dir,
        agent,
        suppress_remote,
        opencode,
        is_conductor,
        agent_model,
        agent_effort.map(str::to_string),
        resume_token,
        strict_mcp,
        on_event,
    )
}

#[tauri::command]
fn pty_write(session_id: String, data: String, pty: State<Arc<PtyManager>>) -> Result<(), String> {
    pty.write(&session_id, &data)
}

#[tauri::command]
fn pty_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    pty: State<Arc<PtyManager>>,
) -> Result<(), String> {
    pty.resize(&session_id, cols, rows)
}

// Thread pool, not the main thread: see the note on `remove_session`.
#[tauri::command(async)]
fn pty_kill(session_id: String, pty: State<Arc<PtyManager>>) {
    pty.kill(&session_id);
}

#[tauri::command]
fn pty_is_running(session_id: String, pty: State<Arc<PtyManager>>) -> bool {
    pty.has(&session_id)
}

/// What the Settings toggle needs to know: can this machine persist sessions at all, and
/// which tmux would it use. `available: false` is what makes the toggle render disabled
/// with an install hint instead of silently doing nothing when switched on.
#[derive(serde::Serialize)]
struct TmuxInfo {
    /// Can this platform persist sessions AT ALL. False on Windows, where tmux does not
    /// exist and no install would change that.
    ///
    /// Separate from `available` because the two call for opposite UI: `available: false`
    /// with `supported: true` is a fixable gap and earns an install hint, while
    /// `supported: false` is a property of the OS and must NOT tell someone to go install
    /// tmux with their package manager.
    supported: bool,
    available: bool,
    path: Option<String>,
    /// How to install tmux on this host, when there is a sensible suggestion. Resolved here
    /// rather than in the UI because the right answer depends on the platform AND on what is
    /// already installed -- a hardcoded `brew install tmux` is wrong on every Linux and on a
    /// Mac without Homebrew.
    install: Option<tmux::InstallHint>,
}

#[tauri::command]
fn tmux_available(pty: State<Arc<PtyManager>>) -> TmuxInfo {
    #[cfg(not(windows))]
    {
        let path = pty.tmux_path().map(|p| p.to_string_lossy().into_owned());
        let available = path.is_some();
        TmuxInfo {
            supported: true,
            available,
            path,
            install: if available {
                None
            } else {
                tmux::install_hint_here()
            },
        }
    }
    // tmux is Unix-only, and Conduit on Windows keeps the non-persistent path.
    #[cfg(windows)]
    {
        let _ = pty;
        TmuxInfo {
            supported: false,
            available: false,
            path: None,
            install: None,
        }
    }
}

/// Push the frontend's `persistSessions` setting down to the PTY manager. Called at boot
/// and whenever the toggle changes. Turning it off never kills a running session — see
/// the field note on `PtyManager::persist`.
#[tauri::command]
fn set_session_persistence(enabled: bool, pty: State<Arc<PtyManager>>) {
    #[cfg(not(windows))]
    pty.set_persist(enabled);
    #[cfg(windows)]
    {
        let _ = (enabled, pty);
    }
}

/// One session's context-window fill, read from its Claude transcript.
///
/// `None` covers every uninteresting case identically -- no transcript yet, a session that
/// has not had an assistant turn, a non-Claude agent, an unreadable file -- because the
/// caller's response to all of them is the same: draw no meter.
///
/// The transcript store is resolved per session rather than from the app's own environment,
/// since a session assigned to a non-default account writes under that account's
/// `CLAUDE_CONFIG_DIR` and its transcript is simply not in the default tree.
#[tauri::command]
fn session_context(
    session_id: String,
    store: State<Arc<store::Store>>,
) -> Option<context_window::ContextUsage> {
    let projects = match store.session_account_config_dir(&session_id) {
        Some(cfg) if !cfg.is_empty() => std::path::PathBuf::from(cfg).join("projects"),
        _ => pty::claude_projects_dir()?,
    };
    let path = pty::transcript_path(&session_id, &projects)?;
    context_window::for_transcript(&path)
}

/// A session's Task subagents and what each is doing.
///
/// Empty for the overwhelmingly common case of a session that has not fanned out. Resolved
/// against the session's own account config dir for the same reason `session_context` is.
#[tauri::command]
fn session_subagents(
    session_id: String,
    store: State<Arc<store::Store>>,
) -> Vec<subagents::Subagent> {
    let projects = match store.session_account_config_dir(&session_id) {
        Some(cfg) if !cfg.is_empty() => std::path::PathBuf::from(cfg).join("projects"),
        _ => match pty::claude_projects_dir() {
            Some(d) => d,
            None => return Vec::new(),
        },
    };
    subagents::for_session(&projects, &session_id)
}

/// Search past conversations for a phrase.
///
/// Searches the DEFAULT transcript store plus every registered account's, deduplicated by
/// session id — a session's transcript lives under whichever account ran it, and someone
/// searching their own history does not think in accounts.
#[tauri::command]
fn search_transcripts(
    query: String,
    limit: usize,
    store: State<Arc<store::Store>>,
) -> Vec<transcript_index::TranscriptHit> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(d) = pty::claude_projects_dir() {
        roots.push(d);
    }
    for account in store.list_accounts() {
        let p = std::path::PathBuf::from(&account.config_dir).join("projects");
        if !roots.contains(&p) {
            roots.push(p);
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut hits = Vec::new();
    for root in roots {
        for hit in transcript_index::search(&root, &query, limit) {
            if seen.insert(hit.session_id.clone()) {
                hits.push(hit);
            }
        }
    }
    hits.sort_by_key(|h| std::cmp::Reverse(h.updated_at));
    hits.truncate(limit);
    hits
}

/// Whether any session with a LIVE PTY is currently marked running. Cross-checks the fleet
/// status against a real process so a stale "running" (an agent killed mid-turn, or a deleted
/// session whose status was never cleared) can't trigger a spurious quit prompt. Fed for agy by
/// its `agent_state`, and for Claude/Codex/etc. by their lifecycle hooks.
pub(crate) fn live_running_agent<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let fleet = app.state::<Arc<crate::fleet::FleetState>>();
    let pty = app.state::<Arc<PtyManager>>();
    let root = app.state::<Arc<crate::root_chat::RootChatState>>();
    fleet.running_sessions().iter().any(|sid| pty.has(sid)) || root.any_running()
}

/// Whether any agent is actively working (live-PTY-checked). The frontend `live` map can lag
/// the Rust hook mirror, so the shutdown confirm consults this authoritative signal too so a
/// real running agent is never silently killed on quit.
#[tauri::command]
fn any_agent_running(
    fleet: State<Arc<crate::fleet::FleetState>>,
    pty: State<Arc<PtyManager>>,
    root: State<Arc<crate::root_chat::RootChatState>>,
) -> bool {
    fleet.running_sessions().iter().any(|sid| pty.has(sid)) || root.any_running()
}

// ---- Project / session store commands ---------------------------------------

#[tauri::command]
fn load_projects(store: State<Arc<Store>>) -> Vec<Project> {
    store.list()
}

#[tauri::command]
fn add_project(path: String, store: State<Arc<Store>>) -> Project {
    store.add_project(path)
}

#[tauri::command]
fn remove_project(id: String, store: State<Arc<Store>>, pty: State<Arc<PtyManager>>) {
    if let Some(p) = store.list().into_iter().find(|p| p.id == id) {
        for s in p.sessions {
            pty.kill(&s.id);
            pty.kill(&format!("{}::term", s.id));
        }
    }
    store.remove_project(&id);
}

// ---- Root chat commands -------------------------------------------------------

#[tauri::command]
fn list_root_chats(store: State<Arc<Store>>) -> Vec<store::RootChat> {
    store.list_root_chats()
}

#[tauri::command]
fn add_root_chat(store: State<Arc<Store>>) -> store::RootChat {
    store.add_root_chat()
}

#[tauri::command]
fn rename_root_chat(id: String, name: String, store: State<Arc<Store>>) {
    store.rename_root_chat(&id, &name);
}

#[tauri::command]
fn remove_root_chat(id: String, store: State<Arc<Store>>) {
    store.remove_root_chat(&id);
}

#[tauri::command]
fn set_project_color(id: String, color: Option<String>, store: State<Arc<Store>>) -> bool {
    store.set_project_color(&id, color)
}

// ---- Profile commands ---------------------------------------------------------

#[tauri::command]
fn list_profiles(store: State<Arc<Store>>) -> Vec<store::Profile> {
    store.list_profiles()
}

#[tauri::command]
fn add_profile(name: String, store: State<Arc<Store>>) -> store::Profile {
    store.add_profile(&name)
}

#[tauri::command]
fn remove_profile(id: String, store: State<Arc<Store>>) -> bool {
    store.remove_profile(&id)
}

#[tauri::command]
fn get_active_profile(store: State<Arc<Store>>) -> Option<String> {
    store.active_profile()
}

#[tauri::command]
fn set_active_profile(id: Option<String>, store: State<Arc<Store>>) -> bool {
    store.set_active_profile(id)
}

// ---- Project task board commands ---------------------------------------------

/// Resolve a project id to its on-disk repo root, using the same `Store` accessor
/// `load_projects` uses to read the project list.
fn project_root(store: &Store, project_id: &str) -> Result<String, String> {
    store
        .list()
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.path)
        .ok_or_else(|| format!("project not found: {project_id}"))
}

fn emit_board_changed(app: &tauri::AppHandle, project_id: &str) {
    let _ = app.emit(
        "board-changed",
        serde_json::json!({ "projectId": project_id }),
    );
}

#[tauri::command]
fn list_board(
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
) -> Result<BoardSnapshot, String> {
    let root = project_root(&store, &project_id)?;
    board.ensure_scaffold(&root)?;
    // Opening the board at least once enables the fleet MCP server (and `task_*`) for
    // every session this project spawns from now on -- see `gets_fleet_mcp` in `pty_spawn`.
    store.set_board_enabled(&project_id, true);
    Ok(board.snapshot(&root))
}

/// Toggle a project's task-board flag directly (e.g. if the UI ever wants to disable it
/// again). `list_board` already turns this on the first time the board is opened.
#[tauri::command]
fn set_board_enabled(project_id: String, enabled: bool, store: State<Arc<Store>>) {
    store.set_board_enabled(&project_id, enabled);
}

#[tauri::command]
fn board_add_card(
    app: tauri::AppHandle,
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
    title: String,
    body: String,
    column: String,
) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.add_card(&root, &title, &body, &column, "human")?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn board_move_card(
    app: tauri::AppHandle,
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
    id: String,
    column: String,
    after: Option<String>,
    before: Option<String>,
) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.move_card(&root, &id, &column, after.as_deref(), before.as_deref())?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn board_edit_card(
    app: tauri::AppHandle,
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
    id: String,
    title: Option<String>,
    body: Option<String>,
    labels: Option<Vec<String>>,
) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.edit_card(&root, &id, title.as_deref(), body.as_deref(), labels)?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

#[tauri::command]
fn board_delete_card(
    app: tauri::AppHandle,
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let root = project_root(&store, &project_id)?;
    board.delete_card(&root, &id)?;
    emit_board_changed(&app, &project_id);
    Ok(())
}

#[tauri::command]
fn board_set_columns(
    app: tauri::AppHandle,
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
    columns: Vec<Column>,
) -> Result<(), String> {
    let root = project_root(&store, &project_id)?;
    board.set_columns(&root, columns)?;
    emit_board_changed(&app, &project_id);
    Ok(())
}

#[tauri::command]
fn board_release_card(
    app: tauri::AppHandle,
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let root = project_root(&store, &project_id)?;
    board.delete_card_claim(&root, &id)?;
    emit_board_changed(&app, &project_id);
    Ok(())
}

#[tauri::command]
fn board_start_workflow(
    app: tauri::AppHandle,
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
    id: String,
) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    board.ensure_agents(&root).ok();
    board.ensure_knowledge(&root).ok();
    let card = board.start_workflow(&root, &id, "human")?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

#[tauri::command]
fn board_resolve_gate(
    app: tauri::AppHandle,
    store: State<Arc<Store>>,
    board: State<Arc<TaskBoard>>,
    project_id: String,
    id: String,
    approved: bool,
) -> Result<Card, String> {
    let root = project_root(&store, &project_id)?;
    let card = board.resolve_gate(&root, &id, approved, "human")?;
    emit_board_changed(&app, &project_id);
    Ok(card)
}

/// Read-only continuity view for a project's board: which of its sessions are present
/// (per continuity, matched by agent_label == Conduit session id) and pending handoffs
/// scoped to any of its cards. Best-effort -- see `continuity_read::view_for_project`.
#[tauri::command]
fn list_continuity(
    store: State<Arc<Store>>,
    project_id: String,
) -> Result<continuity_read::ContinuityView, String> {
    let session_ids: Vec<String> = store
        .list()
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.sessions.into_iter().map(|s| s.id).collect())
        .unwrap_or_default();
    Ok(continuity_read::view_for_project(&project_id, &session_ids))
}

/// Read-only continuity feed for a project: the decisions and messages recorded by the
/// sessions that belong to it. Scoped by Conduit session id (exact) plus the git toplevel
/// of the project and each of its worktrees (for sessions started outside Conduit).
/// Best-effort -- see `continuity_feed::feed_for_project`.
#[tauri::command]
fn continuity_feed(
    store: State<Arc<Store>>,
    project_id: String,
) -> Result<continuity_feed::ContinuityFeed, String> {
    let Some(project) = store.list().into_iter().find(|p| p.id == project_id) else {
        return Ok(continuity_feed::ContinuityFeed::default());
    };
    let session_ids: Vec<String> = project.sessions.iter().map(|s| s.id.clone()).collect();

    // The project root plus every worktree. Each is its own git toplevel and so its own
    // cwd_hash; a path that isn't a checkout (a pending worktree) simply drops out.
    let mut dirs: Vec<String> = vec![project.path.clone()];
    dirs.extend(
        project
            .sessions
            .iter()
            .filter_map(|s| s.worktree_path.clone()),
    );
    let mut toplevels: Vec<String> = dirs.iter().filter_map(|d| git::toplevel(d)).collect();
    toplevels.sort();
    toplevels.dedup();

    Ok(continuity_feed::feed_for_project(
        &session_ids,
        &toplevels,
        CONTINUITY_FEED_LIMIT,
    ))
}

/// Rows per table in one `continuity_feed` read. A memory panel, not an archive browser --
/// deep history lives in continuity itself.
const CONTINUITY_FEED_LIMIT: usize = 100;

/// `model` is a concrete model id chosen by a route. It is applied HERE rather than in a
/// second call from the frontend so the session is never briefly persisted without it --
/// and so nothing can spawn in between reading a model that was not chosen.
///
/// The parameter list of a `#[tauri::command]` IS its IPC payload, so folding these into a
/// struct would change what the frontend sends for no behavioural gain; every other
/// wide command in this file takes the same allow.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn add_session(
    project_id: String,
    name: String,
    use_worktree: bool,
    agent: crate::agent::AgentId,
    role: Option<SessionRole>,
    // Feature C: MCP registry names this session may load. None = inherit everything
    // (today's behavior). See `Session::mcp_servers` for why None != Some(<everything>).
    mcp_servers: Option<Vec<String>>,
    model: Option<String>,
    store: State<Arc<Store>>,
) -> Option<Session> {
    let mut session = store.add_session(
        &project_id,
        name,
        use_worktree,
        agent,
        role.unwrap_or_default(),
    )?;
    // Both applied as follow-up writes rather than `add_session` parameters: that function
    // has 40+ call sites (nearly all tests) and none of the others carries either. The
    // returned session must carry them too -- the frontend merges THIS object into its
    // project list, and a stale None there would make the very first spawn inherit
    // everything (allowlist) or ignore the routed model.
    if let Some(list) = mcp_servers {
        store.set_session_mcp_servers(&session.id, Some(list.clone()));
        session.mcp_servers = Some(list);
    }
    if model.is_some() {
        store.set_session_model(&session.id, model.clone());
        session.model = model;
    }
    Some(session)
}

#[tauri::command]
fn rename_session(project_id: String, session_id: String, name: String, store: State<Arc<Store>>) {
    store.rename_session(&project_id, &session_id, name);
}

#[tauri::command]
fn rename_project(project_id: String, name: String, store: State<Arc<Store>>) {
    store.rename_project(&project_id, name);
}

#[tauri::command]
fn reorder_project(project_id: String, to_index: usize, store: State<Arc<Store>>) {
    store.reorder_project(&project_id, to_index);
}

#[tauri::command]
fn reorder_session(
    project_id: String,
    session_id: String,
    to_index: usize,
    store: State<Arc<Store>>,
) {
    store.reorder_session(&project_id, &session_id, to_index);
}

/// The frontend's reply to a Conductor `fleet_stop` confirmation prompt.
#[tauri::command]
fn conductor_confirm_response(
    request_id: String,
    approved: bool,
    fleet: State<Arc<crate::fleet::FleetState>>,
) {
    if let Some(tx) = fleet
        .pending_confirms
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id)
    {
        let _ = tx.send(approved);
    }
}

#[tauri::command]
fn set_project_layout(project_id: String, layout: ProjectLayout, store: State<Arc<Store>>) {
    store.set_layout(&project_id, layout);
}

// ---- Claude account registry (Feature 2: account switching) ------------------

#[tauri::command]
fn list_accounts(store: State<Arc<Store>>) -> Vec<crate::store::Account> {
    store.list_accounts()
}

/// Per-agent global default accounts (agent -> account id), e.g. `{ "claude": "…" }`.
#[tauri::command]
fn get_default_accounts(
    store: State<Arc<Store>>,
) -> std::collections::HashMap<crate::agent::AgentId, String> {
    store.default_accounts()
}

/// Auto-detected candidate accounts (not yet registered), for the "Detect" button.
#[tauri::command]
fn discover_accounts(store: State<Arc<Store>>) -> Vec<crate::store::Account> {
    store.discover_accounts()
}

#[tauri::command]
fn add_account(
    label: String,
    config_dir: String,
    store: State<Arc<Store>>,
) -> Result<crate::store::Account, String> {
    store.add_account(label, config_dir)
}

#[tauri::command]
fn remove_account(
    account_id: String,
    store: State<Arc<Store>>,
    agy_usage: State<Arc<crate::agy_usage::AgyUsageState>>,
    auth: State<Arc<crate::claude_usage::ClaudeAuth>>,
) {
    store.remove_account(&account_id);
    // Evict the removed account's cached usage/token so its row/limits don't linger.
    agy_usage.evict(&account_id);
    auth.evict(&account_id);
}

#[tauri::command]
fn set_default_account(
    agent: crate::agent::AgentId,
    account_id: Option<String>,
    store: State<Arc<Store>>,
) {
    store.set_default_account(agent, account_id);
}

#[tauri::command]
fn set_project_default_account(
    project_id: String,
    agent: crate::agent::AgentId,
    account_id: Option<String>,
    store: State<Arc<Store>>,
) {
    store.set_project_default_account(&project_id, agent, account_id);
}

#[tauri::command]
fn set_account_agents(
    account_id: String,
    agents: Vec<crate::agent::AgentId>,
    store: State<Arc<Store>>,
) {
    store.set_account_agents(&account_id, agents);
}

#[tauri::command]
fn set_session_account(session_id: String, account_id: Option<String>, store: State<Arc<Store>>) {
    store.set_session_account(&session_id, account_id);
}

// ---- Trust boundaries (Feature 4: multi-agent silo / controlled sharing) ------

#[tauri::command]
fn get_trust_settings(store: State<Arc<Store>>) -> crate::store::TrustSettings {
    store.trust_settings()
}

#[tauri::command]
fn set_trust_settings(settings: crate::store::TrustSettings, store: State<Arc<Store>>) {
    store.set_trust_settings(settings);
}

/// Set a session's trust (clearance / silo / local_only / channels / tier / seed). If the
/// session is running, also flip its remote-stream suppression live, so marking it sensitive
/// stops any paired phone from receiving further output immediately.
#[tauri::command]
fn set_session_trust(
    session_id: String,
    trust: crate::store::SessionTrust,
    store: State<Arc<Store>>,
    pty: State<Arc<PtyManager>>,
) {
    let siloed = trust.silo;
    store.set_session_trust(&session_id, trust);
    pty.set_remote_suppressed(&session_id, store.is_private_mode() && siloed);
}

/// Scan text for secret / credential markers, entirely in-process (never sent to any cloud
/// agent). Assists — but does not replace — the manual "mark sensitive" decision.
#[tauri::command]
fn scan_sensitivity(text: String) -> Vec<crate::store::SensitivityHit> {
    crate::store::scan_sensitivity(&text)
}

// ---- OpenCode local provider (local GPU / self-hosted endpoint) ----------------

#[tauri::command]
fn get_opencode_settings(store: State<Arc<Store>>) -> crate::store::OpenCodeSettings {
    store.opencode_settings()
}

#[tauri::command]
fn set_opencode_settings(settings: crate::store::OpenCodeSettings, store: State<Arc<Store>>) {
    store.set_opencode_settings(settings);
}

/// Hold the endpoint API key in memory for this app run. An empty/blank key clears it.
/// Deliberately NOT persisted anywhere; it reaches an `opencode` child only via its env.
#[tauri::command]
fn set_opencode_key(key: String, store: State<Arc<Store>>) {
    store.set_opencode_key(Some(key));
}

#[tauri::command]
fn clear_opencode_key(store: State<Arc<Store>>) {
    store.set_opencode_key(None);
}

/// Whether a key is currently held (the UI shows set/not-set, never the key itself).
#[tauri::command]
fn opencode_key_set(store: State<Arc<Store>>) -> bool {
    store.opencode_key().is_some()
}

// `(async)` on a sync fn: run it on the thread pool instead of inline on the IPC (main)
// thread. Destroying a session SIGKILLs a child, reaps it, tears down its tmux session and
// rewrites state.json -- seconds of work in the worst case, and every one of them a frozen
// window if it happens on the main thread. Same reasoning for `pty_kill` and the two
// worktree commands below; the delete path calls all four in a row.
#[tauri::command(async)]
fn remove_session(
    project_id: String,
    session_id: String,
    store: State<Arc<Store>>,
    pty: State<Arc<PtyManager>>,
) {
    pty.kill(&session_id);
    pty.kill(&format!("{session_id}::term"));
    store.remove_session(&project_id, &session_id);
}

// ---- Session hibernate (stop without delete) ---------------------------------
//
// A session's PTYs used to live exactly as long as the session record: nothing but
// deletion, project removal, `fleet_stop` or app exit ever killed an agent. That made a
// finished session cost ~600 MB (the agent plus its MCP servers) until the user threw its
// history away. These three commands separate "stop the processes" from "delete the
// session"; the conversation comes back through the adapters' existing resume path.

/// Which of `session_ids` a bulk "stop idle sessions" should stop: those with a live PTY
/// that the fleet does not report as running. A session with no live PTY is skipped -- it
/// costs nothing, and marking it stopped would silently opt it out of restore-on-open.
fn idle_stop_targets(
    session_ids: &[String],
    alive: &std::collections::HashSet<String>,
    running: &std::collections::HashSet<String>,
) -> Vec<String> {
    session_ids
        .iter()
        .filter(|id| alive.contains(*id) && !running.contains(*id))
        .cloned()
        .collect()
}

/// Kill a session's agent PTY and its companion shell, and persist the intent so the
/// restore-on-open path leaves it alone. The transcript, worktree and session record are
/// untouched -- the next spawn resumes the conversation (`claude --resume <id>`, agy
/// `--conversation=<id>`). Idempotent: stopping an already-stopped session is a no-op.
#[tauri::command]
fn stop_session(
    session_id: String,
    store: State<Arc<Store>>,
    pty: State<Arc<PtyManager>>,
    fleet: State<Arc<crate::fleet::FleetState>>,
) {
    // `retire`, never `kill`: the session is coming back, so its scrollback snapshot has to
    // outlive the teardown. `kill` means destroy and deletes it.
    pty.retire(&session_id);
    pty.retire(&format!("{session_id}::term"));
    // The status mirror is hook-driven; with the agent gone no hook will ever clear a
    // stale "running", which would keep the quit guard warning about a dead process.
    fleet.set_running(&session_id, false);
    store.set_session_stopped(&session_id, true);
}

/// Clear the stopped flag. Spawning stays with the frontend -- `TerminalView` owns the
/// cols/rows a spawn needs -- so this only records intent.
#[tauri::command]
fn start_session(session_id: String, store: State<Arc<Store>>) {
    store.set_session_stopped(&session_id, false);
}

/// Stop every idle session in one project. Returns the ids actually stopped, so the UI can
/// report a count instead of guessing.
#[tauri::command]
fn stop_idle_sessions(
    project_id: String,
    store: State<Arc<Store>>,
    pty: State<Arc<PtyManager>>,
    fleet: State<Arc<crate::fleet::FleetState>>,
) -> Vec<String> {
    let session_ids: Vec<String> = store
        .list()
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.sessions.into_iter().map(|s| s.id).collect())
        .unwrap_or_default();
    let alive: std::collections::HashSet<String> = pty.session_ids().into_iter().collect();
    let running: std::collections::HashSet<String> = fleet.running_sessions().into_iter().collect();
    let targets = idle_stop_targets(&session_ids, &alive, &running);
    for id in &targets {
        // Same contract as stop_session: retire, don't destroy.
        pty.retire(id);
        pty.retire(&format!("{id}::term"));
        fleet.set_running(id, false);
        store.set_session_stopped(id, true);
    }
    targets
}

/// Suggest a short session title from the first prompt. Tries a tiny `claude -p`
/// (Haiku) call for a clean title, and falls back to a local heuristic on any
/// error/empty output so the caller always gets something usable.
#[tauri::command]
async fn suggest_session_name(prompt: String) -> String {
    let fallback = heuristic_name(&prompt);
    let p = prompt.clone();
    match tauri::async_runtime::spawn_blocking(move || claude_title(&p)).await {
        Ok(Some(name)) => name,
        _ => fallback,
    }
}

/// First few words of the first non-empty line, length-capped.
fn heuristic_name(prompt: &str) -> String {
    let first = prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let mut name: String = first
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    if name.chars().count() > 32 {
        name = name
            .chars()
            .take(32)
            .collect::<String>()
            .trim_end()
            .to_string();
    }
    if name.is_empty() {
        "Session".to_string()
    } else {
        name
    }
}

/// Pipe an instruction to `claude -p --model haiku` and sanitize the title.
/// Returns None on spawn failure / non-zero exit / empty output.
fn claude_title(prompt: &str) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let instruction = format!(
        "Reply with ONLY a short title, 2 to 5 words, Title Case, no quotes and no trailing \
         punctuation, summarizing this coding task. Task:\n{prompt}"
    );

    // Launch through an interactive login shell — exactly like pty.rs does — so the
    // GUI-launched app inherits the user's real PATH. Spawning `claude` directly uses
    // the bare Finder/Dock PATH (/usr/bin:/bin:/usr/sbin:/sbin), which doesn't include
    // where `claude` actually lives (~/.nvm, ~/.local, Homebrew, …), so the titler
    // silently fails and every session falls back to the first-words heuristic.
    // Windows runs the titler through cmd.exe (resolves the `claude.cmd` shim via PATHEXT);
    // other platforms use an interactive login shell so a GUI-launched app inherits the
    // user's real PATH (nvm/Homebrew). Same reasoning as pty.rs.
    #[cfg(windows)]
    let mut builder = {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = Command::new(shell);
        c.args(["/C", "claude -p --model haiku"]);
        c
    };
    #[cfg(not(windows))]
    let mut builder = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut c = Command::new(shell);
        c.args(["-i", "-l", "-c", "claude -p --model haiku"]);
        c
    };
    // See pty.rs: strip the package-manager-injected `npm_config_prefix` so nvm
    // initializes and `claude` is on PATH even when Conduit was launched via pnpm.
    builder
        .env_remove("npm_config_prefix")
        .no_window()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Title against the same account the sessions use (Feature 1 interim env selector).
    if let Ok(dir) = std::env::var("CONDUIT_CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            builder.env("CLAUDE_CONFIG_DIR", dir);
        }
    }
    let mut child = builder.spawn().ok()?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(instruction.as_bytes());
        // stdin dropped here → EOF, so `claude -p` reads the full prompt.
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }

    let title = sanitize_title(&String::from_utf8_lossy(&output.stdout));
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

/// First non-empty line, stripped of wrapping quotes, length/word capped.
fn sanitize_title(raw: &str) -> String {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim();
    let mut title: String = line
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ");
    if title.chars().count() > 40 {
        title = title
            .chars()
            .take(40)
            .collect::<String>()
            .trim_end()
            .to_string();
    }
    title
}

// ---- Git (read-only) ---------------------------------------------------------

#[tauri::command]
fn git_branch(dir: String) -> Option<String> {
    git::current_branch(&dir)
}

#[tauri::command]
fn git_changes(dir: String) -> Vec<git::Change> {
    git::changes(&dir)
}

#[tauri::command]
fn git_commits(dir: String) -> Vec<git::Commit> {
    git::commits(&dir, 8)
}

#[tauri::command]
fn git_graph(dir: String) -> Vec<git::GraphCommit> {
    git::graph(&dir, 80)
}

/// Diff original (left) side: file content at HEAD. `(async)`: `git show` on a big
/// file shouldn't stall the main thread.
#[tauri::command(async)]
fn git_show_head(dir: String, path: String) -> Result<String, String> {
    git::show_head(&dir, &path)
}

#[tauri::command(async)]
fn git_diff_hunks(dir: String, path: String) -> Result<Vec<git::Hunk>, String> {
    git::diff_hunks(&dir, &path)
}

/// Quick Open corpus: `git ls-files` in a repo, bounded walk elsewhere.
#[tauri::command(async)]
fn list_project_files(dir: String) -> Vec<String> {
    match git::ls_files(&dir) {
        Ok(files) if !files.is_empty() => files,
        _ => fsops::walk_files(&dir, git::LS_FILES_CAP / 2),
    }
}

/// Find in Files. `(async)`: a cold rg over a big tree can take a second.
#[tauri::command(async)]
fn search_content(dir: String, query: String) -> Result<search::SearchResult, String> {
    search::search(&dir, &query)
}

// ---- Git (mutating — confirm-guarded in the UI) --------------------------------

#[tauri::command(async)]
fn git_discard_file(dir: String, path: String) -> Result<String, String> {
    git_mut::discard_file(&dir, &path)
}

// ---- Format Document -----------------------------------------------------------

#[tauri::command(async)]
fn format_content(
    dir: String,
    path: String,
    content: String,
) -> Result<format::FormatResult, String> {
    format::format_content(&dir, &path, &content)
}

#[tauri::command]
fn resolve_prettier_options(path: String) -> Option<format::PrettierConfig> {
    format::resolve_prettier_config(std::path::Path::new(&path))
}

// ---- Hot exit -------------------------------------------------------------------

#[tauri::command]
fn hotexit_save(entries: Vec<hotexit::HotExitEntry>) -> Result<(), String> {
    hotexit::save(&entries)
}

#[tauri::command]
fn hotexit_load() -> Vec<hotexit::HotExitEntry> {
    hotexit::load()
}

// ---- Worktree lifecycle ------------------------------------------------------

// Both shell out to git against a whole checkout -- `remove` deletes every file in it --
// so both run on the thread pool. See the note on `remove_session`.
#[tauri::command(async)]
fn worktree_is_dirty(worktree_path: String) -> bool {
    worktree::is_dirty(&worktree_path)
}

#[tauri::command(async)]
fn worktree_remove(repo_path: String, worktree_path: String, force: bool) -> Result<(), String> {
    worktree::remove(&repo_path, &worktree_path, force)
}

// ---- Read-only filesystem (Files tab + viewer) ------------------------------

#[tauri::command]
fn list_dir(dir: String) -> Vec<fsops::DirEntry> {
    fsops::list_dir(&dir)
}

#[tauri::command]
fn dir_exists(path: String) -> bool {
    fsops::dir_exists(&path)
}

#[tauri::command]
fn read_file(path: String) -> fsops::FileContent {
    fsops::read_file(&path)
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<fsops::FileStat, String> {
    fsops::write_file(&path, &content)
}

#[tauri::command]
fn stat_file(path: String) -> fsops::FileStat {
    fsops::stat_file(&path)
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    fsops::create_file(&path)
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fsops::create_dir(&path)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    fsops::rename_path(&from, &to)
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    fsops::delete_path(&path)
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<fsops::FileBase64, String> {
    fsops::read_file_base64(&path)
}

#[tauri::command]
fn resolve_terminal_path(base: String, token: String) -> Option<fsops::ResolvedPath> {
    fsops::resolve_terminal_path(&base, &token)
}

// ---- Quit guard ----------------------------------------------------------------

#[tauri::command]
fn set_dirty_count(count: usize, dirty: State<DirtyGuard>) {
    dirty.0.store(count, Ordering::SeqCst);
}

/// Actually quit, invoked by the frontend after the dirty-buffer confirm. Preserves
/// the PTY-cleanup-before-exit ordering of the direct quit path.
#[tauri::command]
fn quit_app(app: tauri::AppHandle, pty: State<Arc<PtyManager>>) {
    pty.kill_all();
    app.exit(0);
}

// ---- Notifications -----------------------------------------------------------

#[tauri::command]
fn notify_user(app: tauri::AppHandle, title: String, subtitle: Option<String>, body: String) {
    notify::send(&app, &title, subtitle.as_deref(), &body);
}

// `(async)` runs this blocking command on a worker thread instead of the main
// thread, so the login-shell PATH probe never freezes the webview.
#[tauri::command(async)]
fn detect_agents() -> Vec<crate::agent::AgentInfo> {
    crate::agent::detect_agents()
}

/// Write or remove an MCP server for a given agent by shelling out to that
/// agent's own `mcp add`/`mcp remove` CLI (user scope). Mirrors the
/// login-shell handling used by `detect_agents` and the PTY spawner,
/// including the `npm_config_prefix` scrub so nvm-managed binaries are found.
#[tauri::command(async)]
fn mcp_apply(
    agent: crate::agent::AgentId,
    action: String,
    server: crate::agent::McpServer,
) -> Result<(), String> {
    let adapter = crate::agent::adapter_for(agent);
    let cmd = match action.as_str() {
        "add" => adapter.mcp_add_command(&server),
        "remove" => adapter.mcp_remove_command(&server.name),
        _ => return Err(format!("unknown action {action}")),
    }
    .ok_or_else(|| {
        format!(
            "{} can't write MCP for transport {}",
            adapter.binary(),
            server.transport
        )
    })?;
    // Windows resolves the agent's `.cmd` shim through cmd.exe; other platforms go through
    // an interactive login shell for PATH parity with detect_agents / the PTY spawner.
    #[cfg(windows)]
    let out = {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        std::process::Command::new(shell)
            .args(["/C", &cmd])
            .env_remove("npm_config_prefix")
            .no_window()
            .output()
            .map_err(|e| format!("spawn {}: {e}", adapter.binary()))?
    };
    #[cfg(not(windows))]
    let out = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        std::process::Command::new(shell)
            .args(["-i", "-l", "-c", &cmd])
            .env_remove("npm_config_prefix")
            .no_window()
            .output()
            .map_err(|e| format!("spawn {}: {e}", adapter.binary()))?
    };
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Install an agent's CLI by running its official installer, on explicit user action. Mirrors
/// `mcp_apply`'s shell handling (scrub `npm_config_prefix`, `no_window`). Windows runs through
/// Windows PowerShell (present on every box) so one path serves both the npm installs AND the
/// vendor PowerShell one-liner (agy's `irm … | iex`); other platforms use an interactive login
/// shell for PATH parity with `detect_agents` / the PTY spawner. Returns the installer's combined
/// output; the caller then re-runs `detect_agents`. Install != ready: every agent still needs
/// sign-in on first launch inside its session.
#[tauri::command(async)]
fn install_agent(agent: crate::agent::AgentId) -> Result<String, String> {
    let adapter = crate::agent::adapter_for(agent);
    let cmd = adapter
        .install_command()
        .ok_or_else(|| format!("No known installer for {}.", adapter.binary()))?;
    #[cfg(windows)]
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &cmd])
        .env_remove("npm_config_prefix")
        .no_window()
        .output()
        .map_err(|e| format!("spawn installer: {e}"))?;
    #[cfg(not(windows))]
    let out = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        std::process::Command::new(&shell)
            .args(["-i", "-l", "-c", &cmd])
            .env_remove("npm_config_prefix")
            .no_window()
            .output()
            .map_err(|e| format!("spawn installer: {e}"))?
    };
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(combined.trim().to_string())
    } else if combined.trim().is_empty() {
        Err(format!("installer exited with {}", out.status))
    } else {
        Err(combined.trim().to_string())
    }
}

/// Open a directory in VS Code. Tries the `code` CLI first (cross-platform), then
/// falls back to launching by macOS bundle id / app name so it still works when the
/// `code` shell command isn't installed.
#[tauri::command]
fn open_in_vscode(dir: String) -> Result<(), String> {
    use std::process::Command;

    let ran = |mut cmd: Command| cmd.status().map(|s| s.success()).unwrap_or(false);

    if ran({
        let mut c = Command::new("code");
        c.arg(&dir).no_window();
        c
    }) {
        return Ok(());
    }

    #[cfg(windows)]
    {
        // `code` is a `.cmd` shim on Windows, which `Command::new("code")` above won't
        // resolve (std only tries `.exe`); go through cmd.exe so PATHEXT applies.
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        if ran({
            let mut c = Command::new(shell);
            c.args(["/C", "code", &dir]).no_window();
            c
        }) {
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    {
        for args in [
            vec!["-b", "com.microsoft.VSCode", dir.as_str()],
            vec!["-a", "Visual Studio Code", dir.as_str()],
        ] {
            if ran({
                let mut c = Command::new("open");
                c.args(args);
                c
            }) {
                return Ok(());
            }
        }
    }

    Err(
        "Couldn't launch VS Code. Install the `code` command (VS Code → Cmd+Shift+P → \
         \"Shell Command: Install 'code' command in PATH\") or make sure VS Code is installed."
            .into(),
    )
}

/// Open an http(s) URL in the user's default browser. Mirrors `open_in_vscode`'s
/// shell-out approach (no `tauri-plugin-opener`/`shell` dependency): Windows via cmd's
/// `start`, macOS via `open`, Linux via `xdg-open`. Only http(s) URLs are ever passed
/// to the shell.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    use std::process::Command;

    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("refusing to open a non-http(s) url".into());
    }

    #[cfg(windows)]
    let res = {
        // Use rundll32's URL handler rather than `cmd /C start`: cmd would re-parse query
        // metacharacters (& | ^ < >) in the URL, truncating it and possibly running part
        // of it as a command. rundll32 takes the URL as a single argument, no re-parse.
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .no_window()
            .status()
    };
    #[cfg(target_os = "macos")]
    let res = Command::new("open").arg(&url).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let res = Command::new("xdg-open").arg(&url).status();

    match res {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("opener exited with {s}")),
        Err(e) => Err(format!("failed to launch opener: {e}")),
    }
}

/// Reveal a file or directory in the OS file manager, selecting it where the
/// platform supports selection (Finder `open -R`, Explorer `/select,`). Same
/// shell-out doctrine as `open_external`: args passed positionally, never through
/// a shell.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    use std::process::Command;

    if !Path::new(&path).exists() {
        return Err("path does not exist".into());
    }

    #[cfg(target_os = "macos")]
    {
        match Command::new("open")
            .args(["-R", &path])
            .no_window()
            .status()
        {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("opener exited with {s}")),
            Err(e) => Err(format!("failed to launch opener: {e}")),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // raw_arg, not arg: std would quote the WHOLE "/select,…" token when the path
        // contains a space, and Explorer's nonstandard comma-splitting parser then
        // fails to select (or opens Documents). Quote only the path; Windows file
        // names cannot contain '"'. explorer.exe exits nonzero even on success, so
        // only launch failures are reported.
        let mut c = Command::new("explorer.exe");
        c.raw_arg(format!("/select,\"{path}\""));
        c.no_window()
            .status()
            .map(|_| ())
            .map_err(|e| format!("failed to launch explorer: {e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // xdg-open has no selection concept; open the containing directory.
        let parent = Path::new(&path)
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_path_buf();
        return match Command::new("xdg-open").arg(parent).no_window().status() {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("opener exited with {s}")),
            Err(e) => Err(format!("failed to launch opener: {e}")),
        };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::new(PtyManager::new()))
        .manage(Arc::new(Store::new()))
        .manage(Arc::new(HookState::default()))
        .manage(Arc::new(crate::fleet::FleetState::default()))
        .manage(Arc::new(crate::board::BoardState::default()))
        .manage(Arc::new(TaskBoard::default()))
        .manage(Arc::new(claude_usage::ClaudeAuth::default()))
        .manage(Arc::new(agy_usage::AgyUsageState::default()))
        .manage(Arc::new(agy_usage::AgyResumeState::default()))
        .manage(Arc::new(root_chat::RootChatState::default()))
        .manage(Arc::new(hookbus::HookBus::default()))
        .manage(Arc::new(broker::Broker::default()))
        .manage(Arc::new(broker::Presence::default()))
        .manage(DirtyGuard::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Closing the (only) window quits the app; give dirty buffers AND any actively
                // running agent the same confirm round-trip as Cmd+Q. Clean+idle windows close
                // instantly. The frontend decides the exact prompt (unsaved files vs running
                // agents) from the "quit" event.
                let app = window.app_handle();
                let dirty = app.state::<DirtyGuard>().0.load(Ordering::SeqCst);
                let running = live_running_agent(app);
                if dirty > 0 || running {
                    api.prevent_close();
                    let _ = app.emit("menu", "quit");
                }
            }
        })
        .setup(|app| {
            let fleet = app.state::<Arc<crate::fleet::FleetState>>().inner().clone();
            let board = app.state::<Arc<crate::board::BoardState>>().inner().clone();
            let hook_state = app.state::<Arc<HookState>>().inner().clone();
            let bus = app.state::<Arc<hookbus::HookBus>>().inner().clone();
            let broker = app.state::<Arc<broker::Broker>>().inner().clone();
            let presence = app.state::<Arc<broker::Presence>>().inner().clone();
            let pty = app.state::<Arc<PtyManager>>().inner().clone();
            let store = app.state::<Arc<Store>>().inner().clone();
            let tasks = app.state::<Arc<TaskBoard>>().inner().clone();
            let agy_usage = app
                .state::<Arc<crate::agy_usage::AgyUsageState>>()
                .inner()
                .clone();
            let agy_resume = app
                .state::<Arc<crate::agy_usage::AgyResumeState>>()
                .inner()
                .clone();
            hooks::start(
                app.handle().clone(),
                hook_state,
                bus,
                broker,
                presence,
                fleet.clone(),
                store.clone(),
                pty.clone(),
                board.clone(),
                agy_usage,
                agy_resume,
            );
            bridge::start(app.handle().clone());

            // Sweep tmux sessions whose Conduit session no longer exists. Persistence
            // means a tmux session outlives the app, so one whose owner was deleted while
            // the app was closed would otherwise hold its agent (and whatever it spawned)
            // running forever with nothing able to reattach. Off the main thread: the
            // probe shells out, and boot should not wait on it.
            #[cfg(not(windows))]
            {
                let store_for_sweep = store.clone();
                let pty_for_sweep = pty.clone();
                std::thread::spawn(move || {
                    let Some(tmux) = pty_for_sweep.tmux_path() else {
                        return;
                    };
                    let live: Vec<String> = store_for_sweep
                        .list()
                        .into_iter()
                        .flat_map(|p| p.sessions)
                        .flat_map(|s| [format!("{}::term", s.id), s.id])
                        .collect();
                    crate::tmux::sweep_orphans(tmux, &live);

                    // Session budget. The orphan sweep above only removes sessions whose
                    // Conduit session was deleted; this retires ones that still exist but
                    // have been abandoned long enough to be costing the host memory it
                    // needs. Nothing is reaped on a healthy machine -- see session_budget.
                    let cfg = crate::session_budget::Config::from_env();
                    loop {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);
                        let reaped = crate::session_budget::sweep(tmux, &cfg, now);
                        if !reaped.is_empty()
                            && std::env::var("CONDUIT_HOOK_LOG").as_deref() == Ok("1")
                        {
                            eprintln!("[reap] retired {} idle session(s)", reaped.len());
                        }
                        std::thread::sleep(std::time::Duration::from_secs(300));
                    }
                });
            }

            // Cold-restore scrollback: keep each terminal's recent output on disk so a
            // launch after a REBOOT (no tmux left to reattach to) doesn't come back empty.
            // Also sweeps snapshots belonging to sessions that no longer exist.
            {
                let store_for_sb = store.clone();
                let pty_for_sb = pty.clone();
                std::thread::spawn(move || {
                    let live: Vec<String> = store_for_sb
                        .list()
                        .into_iter()
                        .flat_map(|p| p.sessions)
                        .flat_map(|s| [format!("{}::term", s.id), s.id])
                        .collect();
                    crate::scrollback::sweep(&live);
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(20));
                        pty_for_sb.save_scrollback();
                    }
                });
            }

            // Stale-working watchdog. A session leaves `running` only when something says
            // so, and several exits say nothing at all -- Esc during a tool call (Claude
            // aborts the tool and never runs `Stop`), a killed CLI, a slept machine. The
            // sweep is the single decider (see `status_rules`); the broadcast is what keeps
            // the frontend's own `live` map from disagreeing with `fleet_list`.
            {
                let fleet_for_sweep = fleet.clone();
                let app_for_sweep = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    let swept = fleet_for_sweep.sweep_stale_working();
                    if !swept.is_empty() {
                        let _ = app_for_sweep.emit("session-stale", swept);
                    }
                });
            }

            fleet_mcp::start(app.handle().clone(), store, pty, fleet, board, tasks);

            // Native menu bar. Custom items forward to the frontend as a single "menu"
            // event (payload = item id); Quit kills PTYs before exiting (see menu.rs).
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            stop_session,
            start_session,
            stop_idle_sessions,
            pty_is_running,
            tmux_available,
            session_context,
            session_subagents,
            search_transcripts,
            set_session_persistence,
            any_agent_running,
            load_projects,
            add_project,
            remove_project,
            list_root_chats,
            add_root_chat,
            rename_root_chat,
            remove_root_chat,
            list_profiles,
            add_profile,
            remove_profile,
            get_active_profile,
            set_active_profile,
            set_project_color,
            root_chat::root_chat_send,
            root_chat::root_chat_stop,
            root_chat::root_chat_history,
            list_board,
            set_board_enabled,
            board_add_card,
            board_move_card,
            board_edit_card,
            board_delete_card,
            board_set_columns,
            board_release_card,
            board_start_workflow,
            board_resolve_gate,
            list_continuity,
            continuity_feed,
            add_session,
            detect_agents,
            rename_session,
            rename_project,
            reorder_project,
            reorder_session,
            conductor_confirm_response,
            set_project_layout,
            list_accounts,
            get_default_accounts,
            discover_accounts,
            add_account,
            remove_account,
            set_default_account,
            set_project_default_account,
            set_account_agents,
            set_session_account,
            get_trust_settings,
            set_trust_settings,
            set_session_trust,
            scan_sensitivity,
            get_opencode_settings,
            set_opencode_settings,
            set_opencode_key,
            clear_opencode_key,
            opencode_key_set,
            local_llm::detect_local_providers,
            local_llm::list_local_models,
            local_llm::probe_tool_call,
            remove_session,
            suggest_session_name,
            git_branch,
            git_changes,
            git_commits,
            git_graph,
            git_show_head,
            git_diff_hunks,
            git_discard_file,
            list_project_files,
            search_content,
            format_content,
            resolve_prettier_options,
            hotexit_save,
            hotexit_load,
            worktree_is_dirty,
            worktree_remove,
            list_dir,
            dir_exists,
            read_file,
            write_file,
            stat_file,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            read_file_base64,
            set_dirty_count,
            quit_app,
            resolve_terminal_path,
            notify_user,
            open_in_vscode,
            open_external,
            reveal_path,
            claude_status::fetch_claude_status,
            claude_usage::fetch_claude_usage,
            transcript::session_transcript,
            routing::agent_routes,
            routing::set_agent_route,
            routing::task_kinds,
            commandcode_config::command_code_config,
            commandcode_config::set_command_code_config,
            commandcode_config::command_code_models,
            commandcode_usage::fetch_command_code_usage,
            claude_usage::connect_claude_plan_usage,
            agy_usage::fetch_agy_usage,
            agy_usage::agy_usage_tracking_enabled,
            agy_usage::set_agy_usage_tracking,
            mcp_apply,
            install_agent,
            telemetry::telemetry_ping,
            updates::update_should_notify,
            clipboard::clipboard_read_for_paste,
            plugins::list_plugins,
            plugins::read_plugin_source,
            plugins::set_plugin_enabled,
            plugins::set_plugin_grants,
            plugins::remove_plugin,
            plugins::open_plugins_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Conduit")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<Arc<PtyManager>>().kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opts_into_mailbox_requires_channels_and_no_mission() {
        assert!(
            !opts_into_mailbox(false, &[]),
            "no channels -> not opted in"
        );
        assert!(
            opts_into_mailbox(false, &["project".to_string()]),
            "channels + no mission -> opted in"
        );
        assert!(
            !opts_into_mailbox(true, &["project".to_string()]),
            "a fleet mission already grants fleet MCP -- this predicate is mailbox-opt-in specifically"
        );
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn id_set(v: &[&str]) -> std::collections::HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn idle_targets_stops_alive_and_not_running() {
        let got = idle_stop_targets(&ids(&["a", "b"]), &id_set(&["a", "b"]), &id_set(&["b"]));
        assert_eq!(got, ids(&["a"]), "b is running, so only a is stopped");
    }

    #[test]
    fn idle_targets_skips_sessions_with_no_pty() {
        // `c` was never spawned: it costs nothing, and marking it stopped would silently
        // opt it out of restore-on-open.
        let got = idle_stop_targets(&ids(&["a", "c"]), &id_set(&["a"]), &id_set(&[]));
        assert_eq!(got, ids(&["a"]));
    }

    #[test]
    fn idle_targets_empty_project_stops_nothing() {
        assert!(idle_stop_targets(&[], &id_set(&[]), &id_set(&[])).is_empty());
    }
}
