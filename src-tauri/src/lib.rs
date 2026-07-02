//! Conduit (Tauri port) — app entry. Ports ConduitApp.swift.
//!
//! Wires together the four owners that the Swift app keeps as singletons:
//!   PtyManager (TerminalLauncher) · Store (AppStore) · HookState/server (HookServer)
//! and exposes them to the React frontend as Tauri commands.

mod agent;
mod bridge;
mod broker;
mod claude_status;
mod claude_usage;
mod fleet;
mod fleet_mcp;
mod fsops;
mod git;
mod hookbus;
mod hooks;
mod menu;
mod notify;
mod pty;
mod store;
mod telemetry;
mod transcript;
mod worktree;

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{Manager, State};

use hooks::HookState;
use pty::PtyManager;
use store::{Project, ProjectLayout, Session, SessionRole, Store};

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
    store: State<Arc<Store>>,
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

    // A Conductor session gets the fleet MCP server (scoped to it via --mcp-config)
    // and the orchestration persona; workers get neither.
    let (mcp_config_path, system_prompt) = if !shell_only && role.as_deref() == Some("conductor") {
        let mcp_port = fleet.mcp_port.load(Ordering::SeqCst);
        (
            crate::fleet::write_mcp_config(mcp_port, &session_id),
            Some(crate::fleet::CONDUCTOR_PERSONA.to_string()),
        )
    } else {
        (None, None)
    };

    // Feature 4 silo: a siloed session (under private mode) must not stream its output to any
    // remote (mobile-bridge) viewer. Resolved here so the PTY reader can gate its fan-out.
    let suppress_remote =
        !shell_only && store.is_private_mode() && store.is_session_siloed(&session_id);

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
        system_prompt,
        initial_prompt,
        account_config_dir,
        agent,
        suppress_remote,
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

#[tauri::command]
fn get_default_account(store: State<Arc<Store>>) -> Option<String> {
    store.default_account()
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
fn remove_account(account_id: String, store: State<Arc<Store>>) {
    store.remove_account(&account_id);
}

#[tauri::command]
fn set_default_account(account_id: Option<String>, store: State<Arc<Store>>) {
    store.set_default_account(account_id);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(PtyManager::new()))
        .manage(Arc::new(Store::new()))
        .manage(Arc::new(HookState::default()))
        .manage(Arc::new(crate::fleet::FleetState::default()))
        .manage(Arc::new(claude_usage::ClaudeAuth::default()))
        .manage(Arc::new(hookbus::HookBus::default()))
        .manage(Arc::new(broker::Broker::default()))
        .manage(Arc::new(broker::Presence::default()))
        .setup(|app| {
            let fleet = app.state::<Arc<crate::fleet::FleetState>>().inner().clone();
            let hook_state = app.state::<Arc<HookState>>().inner().clone();
            let bus = app.state::<Arc<hookbus::HookBus>>().inner().clone();
            let broker = app.state::<Arc<broker::Broker>>().inner().clone();
            let presence = app.state::<Arc<broker::Presence>>().inner().clone();
            hooks::start(
                app.handle().clone(),
                hook_state,
                bus,
                broker,
                presence,
                fleet.clone(),
            );
            bridge::start(app.handle().clone());
            let pty = app.state::<Arc<PtyManager>>().inner().clone();
            let store = app.state::<Arc<Store>>().inner().clone();
            fleet_mcp::start(app.handle().clone(), store, pty, fleet);

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
            load_projects,
            add_project,
            remove_project,
            add_session,
            detect_agents,
            rename_session,
            conductor_confirm_response,
            set_project_layout,
            list_accounts,
            get_default_account,
            discover_accounts,
            add_account,
            remove_account,
            set_default_account,
            set_session_account,
            get_trust_settings,
            set_trust_settings,
            set_session_trust,
            scan_sensitivity,
            remove_session,
            suggest_session_name,
            git_branch,
            git_changes,
            git_commits,
            git_graph,
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
            notify_user,
            open_in_vscode,
            open_external,
            claude_status::fetch_claude_status,
            claude_usage::fetch_claude_usage,
            claude_usage::connect_claude_plan_usage,
            mcp_apply,
            telemetry::telemetry_ping,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Conduit")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<Arc<PtyManager>>().kill_all();
            }
        });
}
