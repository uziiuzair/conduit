//! Conduit (Tauri port) — app entry. Ports ConduitApp.swift.
//!
//! Wires together the four owners that the Swift app keeps as singletons:
//!   PtyManager (TerminalLauncher) · Store (AppStore) · HookState/server (HookServer)
//! and exposes them to the React frontend as Tauri commands.

mod fsops;
mod git;
mod hooks;
mod notify;
mod pty;
mod store;

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
    on_event: Channel<String>,
    pty: State<PtyManager>,
    hook_state: State<Arc<HookState>>,
) -> Result<(), String> {
    let port = hook_state.port.load(Ordering::SeqCst);
    // Install Claude Code hooks before launching `claude` (not for plain shells).
    if !shell_only {
        hooks::install(&working_directory, port);
    }
    pty.spawn(
        session_id,
        working_directory,
        cols,
        rows,
        port,
        shell_only,
        on_event,
    )
}

#[tauri::command]
fn pty_write(session_id: String, data: String, pty: State<PtyManager>) -> Result<(), String> {
    pty.write(&session_id, &data)
}

#[tauri::command]
fn pty_resize(session_id: String, cols: u16, rows: u16, pty: State<PtyManager>) -> Result<(), String> {
    pty.resize(&session_id, cols, rows)
}

#[tauri::command]
fn pty_kill(session_id: String, pty: State<PtyManager>) {
    pty.kill(&session_id);
}

#[tauri::command]
fn pty_is_running(session_id: String, pty: State<PtyManager>) -> bool {
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
fn remove_project(id: String, store: State<Store>, pty: State<PtyManager>) {
    if let Some(p) = store.list().into_iter().find(|p| p.id == id) {
        for s in p.sessions {
            pty.kill(&s.id);
            pty.kill(&format!("{}::term", s.id));
        }
    }
    store.remove_project(&id);
}

#[tauri::command]
fn add_session(project_id: String, name: String, store: State<Store>) -> Option<Session> {
    store.add_session(&project_id, name)
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
    pty: State<PtyManager>,
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
    let mut name: String = first.split_whitespace().take(6).collect::<Vec<_>>().join(" ");
    if name.chars().count() > 32 {
        name = name.chars().take(32).collect::<String>().trim_end().to_string();
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

    let mut child = Command::new("claude")
        .args(["-p", "--model", "haiku"])
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
    let mut title: String = line.split_whitespace().take(6).collect::<Vec<_>>().join(" ");
    if title.chars().count() > 40 {
        title = title.chars().take(40).collect::<String>().trim_end().to_string();
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

    Err("Couldn't launch VS Code. Install the `code` command (VS Code → Cmd+Shift+P → \
         \"Shell Command: Install 'code' command in PATH\") or make sure VS Code is installed."
        .into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PtyManager::new())
        .manage(Store::new())
        .manage(Arc::new(HookState::default()))
        .setup(|app| {
            let hook_state = app.state::<Arc<HookState>>().inner().clone();
            hooks::start(app.handle().clone(), hook_state);
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
            rename_session,
            set_project_layout,
            remove_session,
            suggest_session_name,
            git_branch,
            git_changes,
            git_commits,
            git_graph,
            list_dir,
            read_file,
            notify_user,
            open_in_vscode,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Conduit")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<PtyManager>().kill_all();
            }
        });
}
