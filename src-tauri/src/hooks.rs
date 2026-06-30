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
pub fn start(app: AppHandle, state: Arc<HookState>, fleet: Arc<crate::fleet::FleetState>) {
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

            // Mirror status into the fleet map so the Conductor can read it (fleet_list).
            fleet.record(&session, &event, &parsed);

            // Dev-only raw capture so we can inspect undocumented payloads
            // (Task*, SessionStart, Subagent*). Enable with CONDUIT_HOOK_LOG=1.
            if std::env::var("CONDUIT_HOOK_LOG").as_deref() == Ok("1") {
                eprintln!("[hook] session={session} event={event} body={body}");
            }

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

/// One native hook event → Conduit verb, with an optional tool-name matcher.
pub struct HookRow {
    pub event: &'static str,
    pub matcher: Option<&'static str>,
    pub verb: &'static str,
}

/// What an agent installs as lifecycle hooks: a config file (relative to the working
/// dir) + the native-event→verb rows + whether it emits a structured todos list.
pub struct HooksProfile {
    pub config_rel_path: &'static str,
    pub rows: Vec<HookRow>,
    /// Whether the agent emits a structured todo list. The capability flag for the
    /// (deferred) Codex empty-todos-panel gating; not yet consumed.
    #[allow(dead_code)]
    pub structured_todos: bool,
}

/// Group rows by event into the JSON hook entries shape used by install_profile.
fn entries_for(rows: &[HookRow], port: u16) -> Vec<(&'static str, Vec<Value>)> {
    let mut out: Vec<(&'static str, Vec<Value>)> = Vec::new();
    for r in rows {
        let mut entry = serde_json::Map::new();
        if let Some(m) = r.matcher {
            entry.insert("matcher".into(), Value::String(m.to_string()));
        }
        entry.insert("hooks".into(), Value::Array(vec![command(r.verb, port)]));
        match out.iter_mut().find(|(e, _)| *e == r.event) {
            Some((_, v)) => v.push(Value::Object(entry)),
            None => out.push((r.event, vec![Value::Object(entry)])),
        }
    }
    out
}

/// Claude's profile = the original conduit_hook_entries, expressed as rows.
pub fn claude_profile() -> HooksProfile {
    HooksProfile {
        config_rel_path: ".claude/settings.local.json",
        structured_todos: true,
        rows: vec![
            HookRow {
                event: "PostToolUse",
                matcher: Some("TodoWrite"),
                verb: "todos",
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
                event: "Notification",
                matcher: None,
                verb: "notification",
            },
            HookRow {
                event: "PreToolUse",
                matcher: None,
                verb: "pretool",
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
            HookRow {
                event: "SessionEnd",
                matcher: None,
                verb: "sessionend",
            },
        ],
    }
}

/// Single source of truth for the (event, entries) Conduit installs. Used by both the
/// project-file installer and the `--settings` writer so worktree and normal sessions
/// get identical hook behavior.
fn conduit_hook_entries(port: u16) -> Vec<(&'static str, Vec<Value>)> {
    entries_for(&claude_profile().rows, port)
}

/// Generalized installer: write the profile's hooks into <dir>/<config_rel_path>,
/// backing up once, preserving foreign keys, idempotent (same as `install`).
pub fn install_profile(dir: &str, port: u16, profile: &HooksProfile) {
    let path = Path::new(dir).join(profile.config_rel_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut root: Value = json!({});
    if let Ok(data) = fs::read(&path) {
        if let Ok(parsed) = serde_json::from_slice::<Value>(&data) {
            root = parsed;
            let backup = path.with_extension("json.conduit-backup");
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
    for (event, entries) in entries_for(&profile.rows, port) {
        let merged = merged(hooks.get(event), entries);
        hooks.insert(event.to_string(), merged);
    }
    obj.insert("hooks".into(), Value::Object(hooks));
    if let Ok(out) = serde_json::to_vec_pretty(&root) {
        let _ = fs::write(&path, out);
    }
}

/// Write Conduit's hooks into <dir>/.claude/settings.local.json.
/// Ports HooksInstaller.swift: backs up once, preserves non-hook keys, and is
/// idempotent (our prior entries are stripped before re-adding).
/// Production spawns via `install_profile(&claude_profile())`; this Claude-scoped
/// wrapper is retained for the hooks regression tests.
#[allow(dead_code)]
pub fn install(dir: &str, port: u16) {
    install_profile(dir, port, &claude_profile());
}

/// A settings object containing only Conduit's hooks, for `claude --settings <file>`.
fn settings_value(port: u16) -> Value {
    let mut hooks = serde_json::Map::new();
    for (event, entries) in conduit_hook_entries(port) {
        hooks.insert(event.to_string(), Value::Array(entries));
    }
    json!({ "hooks": Value::Object(hooks) })
}

/// Write Conduit's hooks to a settings file in the app data dir and return its path.
/// Worktree sessions pass this via `claude --settings`, since a worktree is a separate
/// working tree that doesn't see the project's settings.local.json.
pub fn write_settings_file(port: u16) -> Option<String> {
    let base = dirs::data_dir()?.join("ConduitTauri");
    let _ = fs::create_dir_all(&base);
    let path = base.join("conduit-hooks.json");
    let data = serde_json::to_vec_pretty(&settings_value(port)).ok()?;
    fs::write(&path, data).ok()?;
    Some(path.to_string_lossy().into_owned())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A unique, empty temp directory for one test. Removed if a stale copy exists.
    fn fresh_test_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "conduit_hooks_test_{tag}_{}_{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn settings_path(dir: &Path) -> PathBuf {
        dir.join(".claude").join("settings.local.json")
    }

    fn write_settings(dir: &Path, v: &Value) {
        let p = settings_path(dir);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, serde_json::to_vec_pretty(v).unwrap()).unwrap();
    }

    fn read_settings(dir: &Path) -> Value {
        serde_json::from_slice(&fs::read(settings_path(dir)).unwrap()).unwrap()
    }

    fn read_settings_at(dir: &Path, rel: &str) -> Value {
        let p = dir.join(rel);
        serde_json::from_slice(&fs::read(&p).unwrap()).unwrap()
    }

    fn hooks_obj(v: &Value) -> &serde_json::Map<String, Value> {
        v.get("hooks")
            .and_then(|h| h.as_object())
            .expect("hooks object")
    }

    #[test]
    fn install_wires_lifecycle_events() {
        let dir = fresh_test_dir("lifecycle");
        install(dir.to_str().unwrap(), 8423);

        let v = read_settings(&dir);
        let hooks = hooks_obj(&v);
        for ev in ["PreToolUse", "PreCompact", "SessionStart", "SessionEnd"] {
            assert!(
                hooks.contains_key(ev),
                "expected hook event {ev} to be installed"
            );
        }
    }

    #[test]
    fn lifecycle_command_carries_session_event_and_port() {
        let dir = fresh_test_dir("routing");
        install(dir.to_str().unwrap(), 8431);

        let v = read_settings(&dir);
        let cmd = hooks_obj(&v)["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .expect("SessionStart command string");
        assert!(
            cmd.contains("event=sessionstart"),
            "event tag missing: {cmd}"
        );
        assert!(
            cmd.contains("CONDUIT_SESSION_ID"),
            "session routing missing: {cmd}"
        );
        assert!(cmd.contains("8431"), "fallback port missing: {cmd}");
    }

    // ---- regression guards: "don't break what was working" ----

    #[test]
    fn install_still_wires_the_original_events() {
        let dir = fresh_test_dir("original");
        install(dir.to_str().unwrap(), 8423);

        let hooks = read_settings(&dir);
        let hooks = hooks_obj(&hooks);
        for ev in ["PostToolUse", "UserPromptSubmit", "Stop", "Notification"] {
            assert!(
                hooks.contains_key(ev),
                "original event {ev} must remain installed"
            );
        }
        // PostToolUse keeps both entries: the TodoWrite matcher and the generic catch-all.
        assert_eq!(
            hooks["PostToolUse"].as_array().map(|a| a.len()),
            Some(2),
            "PostToolUse should keep both Conduit entries"
        );
    }

    #[test]
    fn install_preserves_unrelated_settings_keys() {
        let dir = fresh_test_dir("preserve");
        write_settings(
            &dir,
            &json!({ "permissions": { "allow": ["Read(*)"] }, "model": "opus" }),
        );
        install(dir.to_str().unwrap(), 8423);

        let v = read_settings(&dir);
        assert_eq!(v["model"].as_str(), Some("opus"), "unrelated key dropped");
        assert_eq!(
            v["permissions"]["allow"].as_array().map(|a| a.len()),
            Some(1),
            "nested unrelated key altered"
        );
    }

    #[test]
    fn install_is_idempotent() {
        let dir = fresh_test_dir("idempotent");
        install(dir.to_str().unwrap(), 8423);
        install(dir.to_str().unwrap(), 8423);

        let v = read_settings(&dir);
        let conduit_in = |event: &str| -> usize {
            v["hooks"][event]
                .as_array()
                .map(|a| a.iter().filter(|e| is_conduit_entry(e)).count())
                .unwrap_or(0)
        };
        assert_eq!(
            conduit_in("PostToolUse"),
            2,
            "re-install duplicated PostToolUse entries"
        );
        assert_eq!(conduit_in("Stop"), 1, "re-install duplicated Stop entry");
        assert_eq!(
            conduit_in("SessionStart"),
            1,
            "re-install duplicated SessionStart entry"
        );
    }

    #[test]
    fn install_keeps_foreign_hooks() {
        let dir = fresh_test_dir("foreign");
        write_settings(
            &dir,
            &json!({
                "hooks": {
                    "Stop": [ { "hooks": [ { "type": "command", "command": "echo external" } ] } ]
                }
            }),
        );
        install(dir.to_str().unwrap(), 8423);

        let v = read_settings(&dir);
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        let has = |needle: &str| {
            stop.iter()
                .any(|e| serde_json::to_string(e).unwrap().contains(needle))
        };
        assert!(
            has("echo external"),
            "a third-party Stop hook must survive install"
        );
        assert!(
            has("CONDUIT_SESSION_ID"),
            "Conduit's own Stop hook must be added alongside"
        );
    }

    #[test]
    fn install_backs_up_pristine_file_once() {
        let dir = fresh_test_dir("backup");
        write_settings(&dir, &json!({ "model": "opus" }));
        install(dir.to_str().unwrap(), 8423);
        install(dir.to_str().unwrap(), 8423); // second pass must not clobber the backup

        let backup = settings_path(&dir).with_extension("json.conduit-backup");
        let saved = fs::read_to_string(&backup).expect("backup file should exist");
        assert!(
            saved.contains("opus"),
            "backup should hold the original content"
        );
        assert!(
            !saved.contains("CONDUIT_SESSION_ID"),
            "backup must be the pre-Conduit file, not a post-install one"
        );
    }

    #[test]
    fn settings_value_carries_all_events() {
        let v = settings_value(8423);
        let hooks = v
            .get("hooks")
            .and_then(|h| h.as_object())
            .expect("hooks object");
        for ev in [
            "PostToolUse",
            "UserPromptSubmit",
            "Stop",
            "Notification",
            "PreToolUse",
            "PreCompact",
            "SessionStart",
            "SessionEnd",
        ] {
            assert!(hooks.contains_key(ev), "settings missing event {ev}");
        }
    }

    #[test]
    fn install_profile_matches_legacy_claude_install() {
        let dir = fresh_test_dir("profile_claude");
        install_profile(dir.to_str().unwrap(), 8423, &claude_profile());
        let v = read_settings_at(&dir, ".claude/settings.local.json");
        let hooks = v.get("hooks").and_then(|h| h.as_object()).unwrap();
        for ev in [
            "PostToolUse",
            "UserPromptSubmit",
            "Stop",
            "Notification",
            "PreToolUse",
            "PreCompact",
            "SessionStart",
            "SessionEnd",
        ] {
            assert!(hooks.contains_key(ev), "missing {ev}");
        }
        assert_eq!(
            hooks["PostToolUse"].as_array().map(|a| a.len()),
            Some(2),
            "TodoWrite matcher + catch-all"
        );
    }

    #[test]
    fn settings_value_command_carries_routing() {
        let v = settings_value(8431);
        let cmd = v["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .expect("command string");
        assert!(cmd.contains("event=sessionstart"));
        assert!(cmd.contains("CONDUIT_SESSION_ID"));
        assert!(cmd.contains("8431"));
    }
}
