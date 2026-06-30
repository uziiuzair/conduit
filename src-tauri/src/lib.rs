//! Conduit (Tauri port) — app entry. Ports ConduitApp.swift.
//!
//! Wires together the four owners that the Swift app keeps as singletons:
//!   PtyManager (TerminalLauncher) · Store (AppStore) · HookState/server (HookServer)
//! and exposes them to the React frontend as Tauri commands.

mod agent;
mod bridge;
mod claude_status;
mod claude_usage;
mod fsops;
mod git;
mod hooks;
mod notify;
mod pty;
mod store;
mod telemetry;
mod worktree;

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{Manager, State};

use hooks::HookState;
use pty::PtyManager;
use store::{Project, ProjectLayout, Session, Store};

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
    on_event: Channel<String>,
    pty: State<Arc<PtyManager>>,
    hook_state: State<Arc<HookState>>,
    store: State<Store>,
) -> Result<(), String> {
    let port = hook_state.port.load(Ordering::SeqCst);
    let agent = if shell_only {
        crate::agent::AgentId::Claude // shell companion: agent is irrelevant
    } else {
        store.session_agent(&session_id)
    };
    let adapter = crate::agent::adapter_for(agent);

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
        agent,
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
fn load_projects(store: State<Store>) -> Vec<Project> {
    store.list()
}

#[tauri::command]
fn add_project(path: String, store: State<Store>) -> Project {
    store.add_project(path)
}

#[tauri::command]
fn remove_project(id: String, store: State<Store>, pty: State<Arc<PtyManager>>) {
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
    store: State<Store>,
) -> Option<Session> {
    store.add_session(&project_id, name, use_worktree, agent)
}

#[tauri::command]
fn rename_session(project_id: String, session_id: String, name: String, store: State<Store>) {
    store.rename_session(&project_id, &session_id, name);
}

#[tauri::command]
fn set_project_layout(project_id: String, layout: ProjectLayout, store: State<Store>) {
    store.set_layout(&project_id, layout);
}

#[tauri::command]
fn remove_session(
    project_id: String,
    session_id: String,
    store: State<Store>,
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
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(&shell)
        .args(["-i", "-l", "-c", "claude -p --model haiku"])
        // See pty.rs: strip the package-manager-injected `npm_config_prefix` so nvm
        // initializes and `claude` is on PATH even when Conduit was launched via pnpm.
        .env_remove("npm_config_prefix")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

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
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let out = std::process::Command::new(&shell)
        .args(["-i", "-l", "-c", &cmd])
        .env_remove("npm_config_prefix")
        .output()
        .map_err(|e| format!("spawn {}: {e}", adapter.binary()))?;
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
        c.arg(&dir);
        c
    }) {
        return Ok(());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(PtyManager::new()))
        .manage(Store::new())
        .manage(Arc::new(HookState::default()))
        .manage(Arc::new(claude_usage::ClaudeAuth::default()))
        .setup(|app| {
            let hook_state = app.state::<Arc<HookState>>().inner().clone();
            hooks::start(app.handle().clone(), hook_state);
            let pty = app.state::<Arc<PtyManager>>().inner().clone();
            bridge::start(pty, Arc::new(std::sync::atomic::AtomicU16::new(0)));
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
            set_project_layout,
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
            notify_user,
            open_in_vscode,
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
