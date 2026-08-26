//! Root chat: headless spawn-per-message `claude -p` conversations above all projects.
//! Read-only by CLI flag policy; one unified item stream shared with transcript replay.
//! Design: docs/superpowers/specs/2026-08-26-root-chat-design.md

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

/// Live children, one per chat at most. A child exists only while a turn is streaming;
/// idle chats hold no process (spawn-per-message).
#[derive(Default)]
pub struct RootChatState {
    children: Mutex<HashMap<String, Child>>,
}

impl RootChatState {
    /// True if any turn is mid-stream. Reaps exited children first so a finished child
    /// can't hold the quit guard open.
    pub fn any_running(&self) -> bool {
        let mut map = self.children.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, c| matches!(c.try_wait(), Ok(None)));
        !map.is_empty()
    }
}

#[tauri::command(async)]
pub fn root_chat_send(
    app: tauri::AppHandle,
    chat_id: String,
    text: String,
    workspace_root: Option<String>,
    state: State<Arc<RootChatState>>,
    store: State<Arc<crate::store::Store>>,
) -> Result<(), String> {
    use crate::NoWindow;

    store
        .root_chat(&chat_id)
        .ok_or_else(|| format!("unknown root chat {chat_id}"))?;
    {
        // One live child per chat: reject, never queue (the composer is disabled anyway).
        let mut map = state.children.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, c| matches!(c.try_wait(), Ok(None)));
        if map.contains_key(&chat_id) {
            return Err("a turn is already running for this chat".into());
        }
    }

    let cwd = workspace_root
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or("no workspace root and no resolvable home directory")?;
    if !cwd.is_dir() {
        return Err(format!(
            "workspace root {} is not a directory",
            cwd.display()
        ));
    }

    // Transcript home follows the chat's pinned account (same rule as every other
    // transcript consumer); it also decides fresh (--session-id) vs resume.
    let config_dir = store.root_chat_config_dir(&chat_id);
    let projects_dir = match &config_dir {
        Some(cfg) if !cfg.is_empty() => Some(PathBuf::from(cfg).join("projects")),
        _ => crate::pty::claude_projects_dir(),
    };
    let resume = projects_dir
        .as_deref()
        .is_some_and(|d| crate::pty::transcript_exists(&chat_id, d));

    let roster: Vec<(String, String)> = store
        .list()
        .iter()
        .map(|p| (p.name.clone(), p.path.clone()))
        .collect();
    let charter = build_charter(&cwd.to_string_lossy(), &roster);
    let cmd = build_command(&chat_id, resume, &charter);

    // Interactive login shell for PATH parity with the titler / pty.rs (GUI-launched
    // apps get the bare Finder PATH; nvm/Homebrew claude would be missing otherwise).
    #[cfg(windows)]
    let mut builder = {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = Command::new(shell);
        c.args(["/C", &cmd]);
        c
    };
    #[cfg(not(windows))]
    let mut builder = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut c = Command::new(shell);
        c.args(["-i", "-l", "-c", &cmd]);
        c
    };
    builder
        .current_dir(&cwd)
        .env_remove("npm_config_prefix")
        .no_window()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cfg) = config_dir.as_deref().filter(|s| !s.is_empty()) {
        for (k, v) in crate::agent::adapter_for(crate::agent::AgentId::Claude).account_env(cfg) {
            builder.env(k, v);
        }
    }

    let mut child = builder.spawn().map_err(|e| format!("spawn claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
        // Dropped here -> EOF, so `claude -p` reads the full prompt (titler pattern).
    }
    let stdout = child.stdout.take().ok_or("child stdout unavailable")?;
    let stderr = child.stderr.take();

    let state_arc = Arc::clone(state.inner());
    state_arc
        .children
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(chat_id.clone(), child);

    std::thread::spawn(move || {
        let mut saw_done = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match classify_line(&line) {
                LineOut::Items(items) => {
                    for item in items {
                        let _ =
                            app.emit("root-chat-item", json!({ "chatId": chat_id, "item": item }));
                    }
                }
                LineOut::Done(mut done) => {
                    saw_done = true;
                    done["chatId"] = json!(chat_id);
                    let _ = app.emit("root-chat-done", done);
                }
                LineOut::Nothing => {}
            }
        }
        // Stream over: reap the child and surface silent failures (spawn errors land in
        // stderr with no `result` line — e.g. claude not on PATH, bad --resume).
        let status = state_arc
            .children
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&chat_id)
            .and_then(|mut c| c.wait().ok());
        if !saw_done {
            let mut tail = String::new();
            if let Some(mut err) = stderr {
                let mut buf = String::new();
                let _ = err.read_to_string(&mut buf);
                let trimmed = buf.trim();
                let cut = trimmed
                    .char_indices()
                    .rev()
                    .nth(499)
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                tail = trimmed[cut..].to_string();
            }
            let message = match status {
                Some(s) if s.success() => "claude exited without a result".to_string(),
                Some(s) => format!("claude exited with {s}: {tail}"),
                None => format!("claude terminated: {tail}"),
            };
            let _ = app.emit(
                "root-chat-error",
                json!({ "chatId": chat_id, "message": message }),
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn root_chat_stop(chat_id: String, state: State<Arc<RootChatState>>) {
    if let Some(c) = state
        .children
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&chat_id)
    {
        let _ = c.kill();
    }
}

/// Replay a chat's history from its transcript on disk — the same parser the live
/// stream uses, so reopen renders exactly what streaming rendered. Missing transcript
/// (fresh chat, deleted store) degrades to empty, per the transcript-consumer rule.
#[tauri::command]
pub fn root_chat_history(chat_id: String, store: State<Arc<crate::store::Store>>) -> Vec<Value> {
    let projects = match store.root_chat_config_dir(&chat_id) {
        Some(cfg) if !cfg.is_empty() => PathBuf::from(cfg).join("projects"),
        _ => match crate::pty::claude_projects_dir() {
            Some(d) => d,
            None => return Vec::new(),
        },
    };
    let Some(path) = crate::pty::transcript_path(&chat_id, &projects) else {
        return Vec::new();
    };
    let Ok(f) = std::fs::File::open(&path) else {
        return Vec::new();
    };
    BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .flat_map(|l| crate::transcript::parse_line(&l))
        .collect()
}

/// What one stream-json stdout line means to the chat.
pub enum LineOut {
    /// Renderable chat items (bubbles / tool events), via `transcript::parse_line` —
    /// stream-json assistant lines and transcript JSONL lines share the same shape.
    Items(Vec<Value>),
    /// The terminal `result` line: turn finished (cost, turn count, error flag).
    Done(Value),
    Nothing,
}

pub fn classify_line(line: &str) -> LineOut {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return LineOut::Nothing;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("result") => LineOut::Done(json!({
            "isError": v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
            "result": v.get("result").and_then(|r| r.as_str()).unwrap_or(""),
            "costUsd": v.get("total_cost_usd").and_then(|c| c.as_f64()),
            "numTurns": v.get("num_turns").and_then(|n| n.as_i64()),
        })),
        Some("system") => LineOut::Nothing,
        _ => {
            let items = crate::transcript::parse_line(line);
            if items.is_empty() {
                LineOut::Nothing
            } else {
                LineOut::Items(items)
            }
        }
    }
}

/// The per-spawn system prompt: role, workspace root, and the registered-project roster
/// (name, path) — rebuilt every message, so the roster is never stale.
pub fn build_charter(workspace_root: &str, projects: &[(String, String)]) -> String {
    let roster = if projects.is_empty() {
        "(none registered yet)".to_string()
    } else {
        projects
            .iter()
            .map(|(name, path)| format!("- {name}: {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "You are Conduit's root chat: a project-management and ideation partner for the \
         user's whole workspace. You are not a code agent. You never write, edit, or \
         create files, never run shell commands, and never make code changes of any kind \
         — your tools are read-only by policy and you do not attempt to work around \
         that. When a conversation lands on something that should be built, produce a \
         concise implementation brief the user can hand to a coding session in the \
         relevant project; in the future you'll be able to dispatch such work directly.\n\n\
         Workspace root: {workspace_root}\n\n\
         Registered Conduit projects:\n{roster}"
    )
}

/// The full shell command for one message. `resume` = a transcript for this chat id
/// already exists (decided by the caller via `pty::transcript_exists`).
pub fn build_command(chat_id: &str, resume: bool, charter: &str) -> String {
    let id = crate::pty::quote_arg(chat_id);
    let sys = crate::pty::quote_arg(charter);
    let mode = if resume {
        format!("--resume {id}")
    } else {
        format!("--session-id {id}")
    };
    format!(
        "claude -p --output-format stream-json --verbose \
         --allowedTools Read,Glob,Grep,WebSearch,WebFetch \
         --disallowedTools Bash,Write,Edit,NotebookEdit \
         --strict-mcp-config \
         --append-system-prompt {sys} {mode}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_result_line_as_done() {
        let line = json!({
            "type": "result", "subtype": "success", "is_error": false,
            "result": "Here's the brief.", "total_cost_usd": 0.042, "num_turns": 3
        })
        .to_string();
        match classify_line(&line) {
            LineOut::Done(v) => {
                assert_eq!(v["isError"], false);
                assert_eq!(v["costUsd"], 0.042);
                assert_eq!(v["numTurns"], 3);
            }
            _ => panic!("result line must classify as Done"),
        }
    }

    #[test]
    fn classify_assistant_line_as_items_via_transcript_parser() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"Thinking about your roadmap."},
            {"type":"tool_use","name":"Read","input":{"file_path":"/w/app/README.md"}}
        ]}})
        .to_string();
        match classify_line(&line) {
            LineOut::Items(items) => {
                assert_eq!(items[0]["kind"], "bubble");
                assert_eq!(items[1]["kind"], "event");
                assert_eq!(items[1]["event"], "read");
            }
            _ => panic!("assistant line must classify as Items"),
        }
    }

    #[test]
    fn classify_init_junk_and_empty_as_nothing() {
        let init = json!({"type":"system","subtype":"init","session_id":"abc"}).to_string();
        assert!(matches!(classify_line(&init), LineOut::Nothing));
        assert!(matches!(classify_line("not json"), LineOut::Nothing));
        // A user line carrying only tool_results parses to zero items -> Nothing.
        let tr =
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}})
                .to_string();
        assert!(matches!(classify_line(&tr), LineOut::Nothing));
    }

    #[test]
    fn charter_carries_root_roster_and_no_code_rule() {
        let c = build_charter(
            "/Users/u/ooozzy",
            &[("conduit".into(), "/Users/u/ooozzy/conduit".into())],
        );
        assert!(c.contains("/Users/u/ooozzy"));
        assert!(c.contains("- conduit: /Users/u/ooozzy/conduit"));
        assert!(
            c.contains("never write"),
            "charter must state the no-code rule: {c}"
        );
        let empty = build_charter("/Users/u", &[]);
        assert!(empty.contains("(none registered yet)"));
    }

    #[test]
    fn command_pins_session_id_first_then_resumes() {
        let fresh = build_command("abc-123", false, "charter text");
        assert!(fresh.contains("--session-id"), "{fresh}");
        assert!(fresh.contains("--output-format stream-json"));
        assert!(fresh.contains("--allowedTools Read,Glob,Grep,WebSearch,WebFetch"));
        assert!(fresh.contains("--disallowedTools Bash,Write,Edit,NotebookEdit"));
        assert!(fresh.contains("--strict-mcp-config"));
        assert!(fresh.contains("--append-system-prompt"));
        let resumed = build_command("abc-123", true, "charter text");
        assert!(resumed.contains("--resume"));
        assert!(!resumed.contains("--session-id"));
    }
}
