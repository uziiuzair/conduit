//! Claude Code hook integration — ports HookServer.swift + HooksInstaller.swift.
//!
//! Why a real HTTP server (and not Tauri IPC): the hook events are POSTed by
//! *external* `curl` processes that `claude` spawns from entries we write into the
//! project's `.claude/settings.local.json`. Those child processes can only reach a
//! real TCP endpoint, so the embedded listener is preserved here in Rust.
//!
//! Events are routed to the right session via the CONDUIT_SESSION_ID query param,
//! then re-emitted to the frontend as a Tauri `hook` event. The frontend owns the
//! UI reaction (todos, status dots, notifications) — it knows window focus and the
//! selected session, which is what gates "notify only when away".

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tiny_http::{Method, Response, Server};

/// Holds the port the listener actually bound to, so pty spawns can inject it.
pub struct HookState {
    pub port: AtomicU16,
}

impl Default for HookState {
    fn default() -> Self {
        HookState {
            port: AtomicU16::new(0),
        }
    }
}

/// Boot the listener on the first free port in 8423..=8443 (same range as Swift).
pub fn start(app: AppHandle, state: Arc<HookState>) {
    thread::spawn(move || {
        let mut server: Option<Server> = None;
        for candidate in 8423u16..=8443 {
            if let Ok(s) = Server::http(("127.0.0.1", candidate)) {
                state.port.store(candidate, Ordering::SeqCst);
                server = Some(s);
                break;
            }
        }
        let Some(server) = server else {
            eprintln!("conduit: no free hook port in 8423..=8443");
            return;
        };

        for mut request in server.incoming_requests() {
            if request.method() != &Method::Post {
                let _ = request.respond(Response::from_string("ok"));
                continue;
            }

            // Parse query string: /hook?session=<id>&event=<name>
            let url = request.url().to_string();
            let (session, event) = parse_query(&url);

            // Cap the body so a runaway/malicious POST can't exhaust memory.
            let mut body = String::new();
            let _ = request
                .as_reader()
                .take(1024 * 1024)
                .read_to_string(&mut body);
            let _ = request.respond(Response::from_string("ok"));

            let Some(session) = session else { continue };
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

            let _ = app.emit(
                "hook",
                json!({
                    "session": session,
                    "event": event,
                    "body": parsed,
                }),
            );
        }
    });
}

fn parse_query(url: &str) -> (Option<String>, String) {
    let mut session = None;
    let mut event = String::new();
    if let Some(q) = url.split('?').nth(1) {
        for pair in q.split('&') {
            let mut it = pair.splitn(2, '=');
            match (it.next(), it.next()) {
                (Some("session"), Some(v)) => session = Some(v.to_string()),
                (Some("event"), Some(v)) => event = v.to_string(),
                _ => {}
            }
        }
    }
    (session, event)
}

/// Write Conduit's hooks into <dir>/.claude/settings.local.json.
/// Ports HooksInstaller.swift: backs up once, preserves non-hook keys, and is
/// idempotent (our prior entries are stripped before re-adding).
pub fn install(dir: &str, port: u16) {
    let claude_dir = Path::new(dir).join(".claude");
    let settings_path = claude_dir.join("settings.local.json");
    let _ = fs::create_dir_all(&claude_dir);

    let mut root: Value = json!({});
    if let Ok(data) = fs::read(&settings_path) {
        if let Ok(parsed) = serde_json::from_slice::<Value>(&data) {
            root = parsed;
            let backup = settings_path.with_extension("json.conduit-backup");
            if !backup.exists() {
                let _ = fs::write(&backup, &data);
            }
        }
    }

    if !root.is_object() {
        root = json!({});
    }
    let Some(obj) = root.as_object_mut() else {
        return;
    };
    let mut hooks = obj
        .get("hooks")
        .and_then(|h| h.as_object())
        .cloned()
        .unwrap_or_default();

    hooks.insert(
        "PostToolUse".into(),
        merged(
            hooks.get("PostToolUse"),
            vec![
                json!({ "matcher": "TodoWrite", "hooks": [command("todos", port)] }),
                json!({ "hooks": [command("tooluse", port)] }),
            ],
        ),
    );
    hooks.insert(
        "UserPromptSubmit".into(),
        merged(
            hooks.get("UserPromptSubmit"),
            vec![json!({ "hooks": [command("prompt", port)] })],
        ),
    );
    hooks.insert(
        "Stop".into(),
        merged(hooks.get("Stop"), vec![json!({ "hooks": [command("stop", port)] })]),
    );
    hooks.insert(
        "Notification".into(),
        merged(
            hooks.get("Notification"),
            vec![json!({ "hooks": [command("notification", port)] })],
        ),
    );

    obj.insert("hooks".into(), Value::Object(hooks));

    if let Ok(out) = serde_json::to_vec_pretty(&root) {
        let _ = fs::write(&settings_path, out);
    }
}

/// A command hook that pipes the event JSON (stdin) to Conduit's server, tagged
/// with this session via env vars resolved at run time.
fn command(event: &str, port: u16) -> Value {
    let url = format!(
        "http://127.0.0.1:${{CONDUIT_HOOK_PORT:-{port}}}/hook?session=${{CONDUIT_SESSION_ID:-unknown}}&event={event}"
    );
    let cmd = format!(
        "curl -s -m 2 -X POST -H \"Content-Type: application/json\" --data-binary @- \"{url}\" >/dev/null 2>&1 || true"
    );
    json!({ "type": "command", "command": cmd })
}

/// Strip any prior Conduit entries (idempotent), then append ours.
fn merged(existing: Option<&Value>, entries: Vec<Value>) -> Value {
    let mut array: Vec<Value> = existing
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();
    array.retain(|entry| !is_conduit_entry(entry));
    array.extend(entries);
    Value::Array(array)
}

fn is_conduit_entry(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains("CONDUIT_SESSION_ID"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}
