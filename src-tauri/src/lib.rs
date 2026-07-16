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
mod continuity;
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
mod pty;
mod search;
mod store;
mod tasks;
mod telemetry;
mod transcript;
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
    session_id: String,
    working_directory: String,
    cols: u16,
    rows: u16,
    shell_only: bool,
    worktree_name: Option<String>,
    role: Option<String>,
    initial_prompt: Option<String>,
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
    // SPEC-B: model_tier -> concrete model id + effort, Claude only -- the only adapter
    // with a verified per-invocation flag for either (`claude --help` lists both `--model
    // <model>` and `--effort <low|medium|high|xhigh|max>`). Other adapters have no
    // equivalent CLI knob today; model_tier/effort are still recorded on the Session (by
    // fleet_spawn) so they're visible/queryable, just not acted on here.
    let claude_model = (!shell_only && agent == crate::agent::AgentId::Claude)
        .then(|| {
            this_session
                .as_ref()
                .and_then(|s| s.model_tier.as_deref())
                .and_then(|tier| crate::agent::model_for_tier(agent, tier))
        })
        .flatten();
    let claude_effort = (!shell_only && agent == crate::agent::AgentId::Claude)
        .then(|| this_session.as_ref().and_then(|s| s.effort.as_deref()))
        .flatten();
    let is_conductor = !shell_only
        && role.as_deref() == Some("conductor")
        && agent == crate::agent::AgentId::Claude;
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
    let (mcp_config_path, system_prompt_file) = if is_conductor {
        let mcp_port = fleet.mcp_port.load(Ordering::SeqCst);
        (
            crate::fleet::write_mcp_config(mcp_port, &session_id),
            crate::fleet::write_persona_file(&session_id, crate::fleet::CONDUCTOR_PERSONA),
        )
    } else if gets_fleet_mcp && agent == crate::agent::AgentId::Claude {
        let mcp_port = fleet.mcp_port.load(Ordering::SeqCst);
        (
            crate::fleet::write_mcp_config(mcp_port, &session_id),
            crate::fleet::write_persona_file(&session_id, crate::fleet::WORKER_BRIEF_SUFFIX),
        )
    } else {
        (None, None)
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
    // `--conversation=<id>`; Claude ignores it (keys off session_id). None for shell-only
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
        system_prompt_file,
        initial_prompt,
        account_config_dir,
        agent,
        suppress_remote,
        opencode,
        is_conductor,
        claude_model.map(str::to_string),
        claude_effort.map(str::to_string),
        resume_token,
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

#[tauri::command]
fn pty_kill(session_id: String, pty: State<Arc<PtyManager>>) {
    pty.kill(&session_id);
}

#[tauri::command]
fn pty_is_running(session_id: String, pty: State<Arc<PtyManager>>) -> bool {
    pty.has(&session_id)
}

/// Whether any session with a LIVE PTY is currently marked running. Cross-checks the fleet
/// status against a real process so a stale "running" (an agent killed mid-turn, or a deleted
/// session whose status was never cleared) can't trigger a spurious quit prompt. Fed for agy by
/// its `agent_state`, and for Claude/Codex/etc. by their lifecycle hooks.
pub(crate) fn live_running_agent<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let fleet = app.state::<Arc<crate::fleet::FleetState>>();
    let pty = app.state::<Arc<PtyManager>>();
    fleet.running_sessions().iter().any(|sid| pty.has(sid))
}

/// Whether any agent is actively working (live-PTY-checked). The frontend `live` map can lag
/// the Rust hook mirror, so the shutdown confirm consults this authoritative signal too so a
/// real running agent is never silently killed on quit.
#[tauri::command]
fn any_agent_running(
    fleet: State<Arc<crate::fleet::FleetState>>,
    pty: State<Arc<PtyManager>>,
) -> bool {
    fleet.running_sessions().iter().any(|sid| pty.has(sid))
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

#[tauri::command]
fn add_session(
    project_id: String,
    name: String,
    use_worktree: bool,
    agent: crate::agent::AgentId,
    role: Option<SessionRole>,
    store: State<Arc<Store>>,
) -> Option<Session> {
    store.add_session(
        &project_id,
        name,
        use_worktree,
        agent,
        role.unwrap_or_default(),
    )
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

#[tauri::command]
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

#[tauri::command]
fn worktree_is_dirty(worktree_path: String) -> bool {
    worktree::is_dirty(&worktree_path)
}

#[tauri::command]
fn worktree_remove(repo_path: String, worktree_path: String, force: bool) -> Result<(), String> {
    worktree::remove(&repo_path, &worktree_path, force)
}

// ---- Read-only filesystem (Files tab + viewer) ------------------------------

#[tauri::command]
fn list_dir(dir: String) -> Vec<fsops::DirEntry> {
    fsops::list_dir(&dir)
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
        return match Command::new("open")
            .args(["-R", &path])
            .no_window()
            .status()
        {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("opener exited with {s}")),
            Err(e) => Err(format!("failed to launch opener: {e}")),
        };
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
        return c
            .no_window()
            .status()
            .map(|_| ())
            .map_err(|e| format!("failed to launch explorer: {e}"));
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
            pty_is_running,
            any_agent_running,
            load_projects,
            add_project,
            remove_project,
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
            hotexit_save,
            hotexit_load,
            worktree_is_dirty,
            worktree_remove,
            list_dir,
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
            claude_usage::connect_claude_plan_usage,
            agy_usage::fetch_agy_usage,
            agy_usage::agy_usage_tracking_enabled,
            agy_usage::set_agy_usage_tracking,
            mcp_apply,
            install_agent,
            telemetry::telemetry_ping,
            updates::update_should_notify,
            clipboard::clipboard_read_for_paste,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Conduit")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<Arc<PtyManager>>().kill_all();
            }
        });
}
