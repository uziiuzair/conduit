# Conduit-as-Claude-Code-IDE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Claude session Conduit spawns connects back to Conduit over WS/MCP as its IDE — diff review in a Monaco overlay, selection context, at-mentions, openFile.

**Architecture:** One in-process WS listener per running Claude session (ephemeral port, per-session lock file + auth token = identity). Sync `tungstenite`, `bridge.rs` poll-loop pattern, MCP dispatch shaped like `fleet_mcp.rs`. Frontend pushes editor context down; diff verdicts come back through one Tauri command.

**Tech Stack:** Rust (tungstenite 0.23, serde_json), React/TS (Monaco already present), Tauri events/commands.

**Spec:** `docs/superpowers/specs/2026-09-23-ide-integration-design.md` — the protocol section there is EMPIRICAL (verified against claude 2.1.267); when this plan and the spec disagree on a wire detail, the spec wins.

## Global Constraints

- No new crates. No tokio, no async runtime, no HTTP client. `tungstenite = "0.23"` is already a dependency.
- Never log or persist the auth token (`state.json` gets the PORT only; the token lives in memory + the 0600 lock file).
- Keep-alive rule: nothing here may respawn/reparent a terminal; the overlay is an absolutely positioned sibling.
- Windows arm compiles only on the Windows CI leg — keep `#[cfg(windows)]` blocks minimal; prefer cross-platform code (the TCP-probe sweep exists precisely to avoid a pid-liveness syscall split).
- Clippy is `-D warnings`; run fmt+clippy before every commit.
- `openDiff` accept reply MUST be two text items `[FILE_SAVED, <final contents>]`; Conduit never writes the file.
- Handshake must echo WebSocket subprotocol `mcp` and enforce header `X-Claude-Code-Ide-Authorization`.

---

### Task 1: `ide_host.rs` pure foundations (token, lock JSON, lock dir, sweep predicate)

**Files:**
- Create: `src-tauri/src/ide_host.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod ide_host;` beside the other mods)

**Interfaces:**
- Produces: `mint_token() -> String` (32 lowercase hex); `lock_json(pid: u32, dir: &str, token: &str) -> String`; `lock_dir(account_config_dir: Option<&str>, home: &Path) -> PathBuf`; `is_conduit_lock(contents: &str) -> bool`; `sweep_lock_dir(dir: &Path, probe: &dyn Fn(u16) -> bool)`.

- [ ] **Step 1: Write failing tests** at the bottom of the new `src-tauri/src/ide_host.rs` (module skeleton: just the `#[cfg(test)] mod tests`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_32_lowercase_hex() {
        let t = mint_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(mint_token(), t); // not constant
    }

    #[test]
    fn lock_json_has_exact_field_names() {
        let j: serde_json::Value =
            serde_json::from_str(&lock_json(42, "/w", "abc")).unwrap();
        assert_eq!(j["pid"], 42);
        assert_eq!(j["workspaceFolders"], serde_json::json!(["/w"]));
        assert_eq!(j["ideName"], "Conduit");
        assert_eq!(j["transport"], "ws");
        assert_eq!(j["authToken"], "abc");
        // exactly the five keys claude reads (+ runningInWindows on windows builds)
        let n = j.as_object().unwrap().len();
        assert_eq!(n, if cfg!(windows) { 6 } else { 5 });
    }

    #[test]
    fn lock_dir_follows_the_profile_redirect() {
        let home = Path::new("/home/u");
        // ambient: ~/.claude/ide
        assert_eq!(lock_dir(None, home), home.join(".claude/ide"));
        // `.claude`-rooted profile: HOME is redirected, so the lock goes to the profile
        assert_eq!(
            lock_dir(Some("/profiles/work/.claude"), home),
            Path::new("/profiles/work/.claude/ide")
        );
        // custom dir (CLAUDE_CONFIG_DIR case): <config_dir>/ide
        assert_eq!(
            lock_dir(Some("/opt/claudecfg"), home),
            Path::new("/opt/claudecfg/ide")
        );
    }

    #[test]
    fn only_conduit_locks_are_sweepable() {
        assert!(is_conduit_lock(r#"{"ideName":"Conduit","pid":1}"#));
        assert!(!is_conduit_lock(r#"{"ideName":"VS Code","pid":1}"#));
        assert!(!is_conduit_lock("not json"));
    }

    #[test]
    fn sweep_removes_only_dead_conduit_locks() {
        let dir = std::env::temp_dir().join(format!("ide-sweep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("1001.lock"), r#"{"ideName":"Conduit"}"#).unwrap();
        std::fs::write(dir.join("1002.lock"), r#"{"ideName":"Conduit"}"#).unwrap();
        std::fs::write(dir.join("1003.lock"), r#"{"ideName":"VS Code"}"#).unwrap();
        // probe: 1002 is "still listening", everything else dead
        sweep_lock_dir(&dir, &|port| port == 1002);
        assert!(!dir.join("1001.lock").exists(), "dead Conduit lock swept");
        assert!(dir.join("1002.lock").exists(), "live Conduit lock kept");
        assert!(dir.join("1003.lock").exists(), "other IDE's lock never touched");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test --manifest-path src-tauri/Cargo.toml ide_host` → compile error (functions missing).

- [ ] **Step 3: Implement**

```rust
//! Conduit-as-IDE host: per-session WebSocket/MCP servers the `claude` CLI connects
//! back to. Protocol notes live in the 2026-09-23 spec; wire details there are
//! empirical against claude 2.1.267 — trust them over intuition.

use std::path::{Path, PathBuf};

/// 128-bit auth token as 32 lowercase hex chars — the shape claude's own IDE
/// extensions mint. Never logged, never persisted to state.json.
pub fn mint_token() -> String {
    // No `rand` dep: mix OS entropy sources we already have. /dev/urandom on unix;
    // fall back to hashing time+pid if unreadable (still unguessable enough for a
    // localhost-only, per-boot token, and the read failing is effectively unheard of).
    let mut buf = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .is_ok();
    if !ok {
        let seed = format!(
            "{:?}-{}-{:?}",
            std::time::SystemTime::now(),
            std::process::id(),
            std::time::Instant::now()
        );
        let mut h: u128 = 0xcbf29ce484222325cbf29ce484222325;
        for b in seed.bytes() {
            h ^= b as u128;
            h = h.wrapping_mul(0x100000001b3);
        }
        buf = h.to_le_bytes();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn lock_json(pid: u32, dir: &str, token: &str) -> String {
    let mut v = serde_json::json!({
        "pid": pid,
        "workspaceFolders": [dir],
        "ideName": "Conduit",
        "transport": "ws",
        "authToken": token,
    });
    if cfg!(windows) {
        v["runningInWindows"] = serde_json::Value::Bool(true);
    }
    v.to_string()
}

/// Where THIS session's claude looks for lock files. Mirrors
/// `agent::claude_profile_env`: a `.claude`-rooted account redirects HOME (so the
/// lock must live inside the profile); any other explicit dir becomes
/// CLAUDE_CONFIG_DIR (lock inside it); ambient is ~/.claude/ide.
pub fn lock_dir(account_config_dir: Option<&str>, home: &Path) -> PathBuf {
    match account_config_dir {
        Some(d) => PathBuf::from(d).join("ide"),
        None => home.join(".claude").join("ide"),
    }
}

pub fn is_conduit_lock(contents: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(contents)
        .ok()
        .is_some_and(|v| v["ideName"] == "Conduit")
}

/// Startup hygiene: remove OUR stale lock files (ideName == "Conduit") whose port no
/// longer answers. The probe is injected so tests need no sockets; production passes a
/// TCP connect. Deliberately never keyed on pid liveness — that would need a
/// platform-split syscall, and "is anything listening" is the actual question.
pub fn sweep_lock_dir(dir: &Path, probe: &dyn Fn(u16) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(port) = name
            .to_str()
            .and_then(|n| n.strip_suffix(".lock"))
            .and_then(|p| p.parse::<u16>().ok())
        else {
            continue;
        };
        let Ok(contents) = std::fs::read_to_string(e.path()) else { continue };
        if is_conduit_lock(&contents) && !probe(port) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
```

Note `lock_dir`'s `.claude` case: `claude_profile_env` redirects HOME to the profile ROOT for a dir ending in `.claude`, and claude then reads `<HOME>/.claude/ide` — which IS `<config_dir>/ide`. The custom-dir case sets `CLAUDE_CONFIG_DIR=<dir>` and claude reads `<dir>/ide`. Both collapse to `config_dir/ide`, which is why the implementation needs no suffix branch — the test documents both routes.

- [ ] **Step 4: Register the module** — in `src-tauri/src/lib.rs`, add `mod ide_host;` in the mod list (alphabetical, near `mod hooks;`).

- [ ] **Step 5: Run tests** — `cargo test --manifest-path src-tauri/Cargo.toml ide_host` → 5 pass. Also `cargo fmt` + `cargo clippy --manifest-path src-tauri/Cargo.toml`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(ide): lock-file + token + sweep foundations for IDE host"`

---

### Task 2: MCP dispatcher (pure, sink-free)

**Files:**
- Modify: `src-tauri/src/ide_host.rs`

**Interfaces:**
- Consumes: nothing outside the module.
- Produces:
  - `pub struct EditorContext` (deserialized from the frontend push; all fields optional/defaulted):
    ```rust
    #[derive(Default, Clone, serde::Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct EditorContext {
        pub active_file: Option<String>,
        pub selection: Option<serde_json::Value>, // {text,filePath,fileUrl,selection:{start,end,isEmpty}}
        pub open_files: Vec<serde_json::Value>,   // [{path,label,languageId,active}]
        pub diagnostics: Vec<serde_json::Value>,  // [{uri,diagnostics:[…]}]
    }
    ```
  - `pub enum Action { Reply(serde_json::Value), DeferDiff { diff_id: String, args: serde_json::Value }, CloseDiff { tab_name: Option<String> } }`
  - `pub fn dispatch(msg: &serde_json::Value, workspace_dir: &str, ctx: &EditorContext, next_diff_id: &mut u64) -> Vec<Action>`
  - `pub fn tool_result(id: &serde_json::Value, texts: &[&str]) -> serde_json::Value` (JSON-RPC result with `content: [{type:"text",text},…]`)

**Wire behavior implemented (all from the spec's empirical section):**
- `initialize` → echo `params.protocolVersion` (default `"2025-11-25"`), `capabilities: {tools:{listChanged:true}}`, `serverInfo {name:"Conduit", version: env!("CARGO_PKG_VERSION")}`.
- `notifications/initialized`, `ide_connected` → no reply.
- `tools/list` → the 10 tools (NO `executeCode`), each with a JSON-schema `inputSchema`.
- `tools/call`:
  - `getWorkspaceFolders` → `{"success":true,"folders":[dir],"rootPath":dir}` as one text item.
  - `getCurrentSelection` / `getLatestSelection` → `ctx.selection` if present, else `{"success":false,"message":"No selection"}`.
  - `getOpenEditors` → `{"tabs": ctx.open_files}`.
  - `getDiagnostics` → `ctx.diagnostics` (filtered to `params.arguments.uri` when given).
  - `checkDocumentDirty` → `{"success":true,"isDirty":false}` (Conduit's editor autosaves).
  - `saveDocument` → `{"success":true,"saved":true}`.
  - `openFile` → `Action::Reply(tool_result(id,&["FILE_OPENED"]))` — the caller (loop) ALSO emits the open-file event; dispatch stays pure by returning the reply and the loop inspecting the tool name (see Task 3's `EventSink`). To keep dispatch the single decision point, return BOTH `Reply` and a marker the loop maps to the sink: model it as `Action::OpenFile { path } ` followed by `Action::Reply(...)` — add that variant.
  - `openDiff` → `Action::DeferDiff { diff_id: format!("d{}", *next_diff_id), args }` (increment the counter; NO reply now).
  - `close_tab` → `Action::CloseDiff { tab_name: Some(name) }` + `Reply(tool_result(id,&["TAB_CLOSED"]))`.
  - `closeAllDiffTabs` → `Action::CloseDiff { tab_name: None }` + `Reply(tool_result(id,&["TAB_CLOSED"]))`.
  - unknown tool → JSON-RPC error `{code:-32602, message:"unknown tool"}`.
- `ping` → `{}` result.
- any other request WITH an id → `{}` result (claude tolerates this; never hang a request).
- notification (no id) we don't know → no reply.

- [ ] **Step 1: Write failing tests** (same `tests` mod):

```rust
fn req(method: &str, id: u64, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
}

#[test]
fn initialize_echoes_protocol_version() {
    let mut n = 0;
    let a = dispatch(
        &req("initialize", 0, serde_json::json!({"protocolVersion":"2025-11-25"})),
        "/w", &EditorContext::default(), &mut n,
    );
    let Action::Reply(r) = &a[0] else { panic!("expected reply") };
    assert_eq!(r["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(r["result"]["serverInfo"]["name"], "Conduit");
    assert_eq!(r["id"], 0);
}

#[test]
fn tools_list_has_ten_tools_and_no_execute_code() {
    let mut n = 0;
    let a = dispatch(&req("tools/list", 1, serde_json::json!({})), "/w",
                     &EditorContext::default(), &mut n);
    let Action::Reply(r) = &a[0] else { panic!() };
    let tools = r["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 10);
    assert!(tools.iter().all(|t| t["name"] != "executeCode"));
    assert!(tools.iter().any(|t| t["name"] == "openDiff"));
}

#[test]
fn open_diff_defers_instead_of_replying() {
    let mut n = 0;
    let args = serde_json::json!({"name":"openDiff","arguments":
        {"old_file_path":"/w/a.txt","new_file_path":"/w/a.txt",
         "new_file_contents":"hi","tab_name":"t1"}});
    let a = dispatch(&req("tools/call", 3, args), "/w", &EditorContext::default(), &mut n);
    assert!(matches!(&a[0], Action::DeferDiff { diff_id, .. } if diff_id == "d0"));
    assert_eq!(a.len(), 1, "no reply until the human answers");
}

#[test]
fn unknown_request_gets_empty_result_never_silence() {
    let mut n = 0;
    let a = dispatch(&req("some/future_method", 9, serde_json::json!({})), "/w",
                     &EditorContext::default(), &mut n);
    let Action::Reply(r) = &a[0] else { panic!() };
    assert_eq!(r["result"], serde_json::json!({}));
}

#[test]
fn selection_answers_from_pushed_context() {
    let mut n = 0;
    let ctx = EditorContext {
        selection: Some(serde_json::json!({"text":"x","filePath":"/w/a.ts"})),
        ..Default::default()
    };
    let a = dispatch(&req("tools/call", 4,
        serde_json::json!({"name":"getCurrentSelection","arguments":{}})), "/w", &ctx, &mut n);
    let Action::Reply(r) = &a[0] else { panic!() };
    let text = r["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("/w/a.ts"));
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test --manifest-path src-tauri/Cargo.toml ide_host` → compile error.

- [ ] **Step 3: Implement** `Action`, `EditorContext`, `tool_result`, `dispatch`, plus a private `fn tool_defs() -> serde_json::Value` listing the 10 tools with input schemas (openDiff's schema: the four string properties from the spec; the read-only tools: `{type:"object",properties:{},additionalProperties:false}`; openFile: `{filePath: {type:"string"}}` + optional `preview`, `startText`, `endText` strings; close_tab: `{tab_name:{type:"string"}}` required).

- [ ] **Step 4: Run tests** — all ide_host tests pass. fmt + clippy.

- [ ] **Step 5: Commit** — `git commit -am "feat(ide): pure MCP dispatcher for the IDE tool surface"`

---

### Task 3: listener, handshake, poll loop, host registry + real-socket integration test

**Files:**
- Modify: `src-tauri/src/ide_host.rs`
- Create: `src-tauri/tests/ide_host.rs`

**Interfaces:**
- Produces:
  - `pub trait IdeEvents: Send + Sync + 'static { fn open_diff(&self, session_id: &str, diff_id: &str, args: &serde_json::Value); fn open_file(&self, session_id: &str, path: &str); fn diff_closed(&self, session_id: &str, tab_name: Option<&str>); }`
  - `pub struct IdeHost` with:
    - `pub fn new() -> Arc<IdeHost>`
    - `pub fn start_for_session(&self, session_id: &str, workspace_dir: &str, lock_dir: &Path, preferred_port: Option<u16>, events: Arc<dyn IdeEvents>) -> Option<u16>` — binds `127.0.0.1:preferred_port.unwrap_or(0)` (falling back to `:0` if the preferred bind fails), mints a token, writes the lock file (0600 on unix), spawns the accept thread, registers the session, returns the port. Idempotent: if the session already has a live server, rewrites the lock and returns the existing port.
    - `pub fn stop_for_session(&self, session_id: &str)` — sets shutdown, drops the listener (bind a throwaway connect to unblock `accept` if needed — simpler: the accept loop uses `listener.set_nonblocking(true)` + 100 ms sleep polls so shutdown is observed), removes the lock file, forgets the session.
    - `pub fn update_context(&self, session_ids: &[String], ctx: EditorContext, selection_changed: bool)` — stores ctx per session; when `selection_changed`, queues a `selection_changed` notification on each live connection.
    - `pub fn at_mention(&self, session_id: &str, file_path: &str, line_start: u64, line_end: u64)` — queues `at_mentioned`.
    - `pub fn resolve_diff(&self, session_id: &str, diff_id: &str, keep: bool, contents: Option<&str>) -> bool` — builds the reply (keep ⇒ `[FILE_SAVED, contents]`, reject ⇒ `[DIFF_REJECTED]`), sends it on the outbound queue, forgets the pending entry.
    - `pub fn reject_all(&self, session_id: &str)` — teardown path: every pending diff answered `DIFF_REJECTED`.
    - `pub fn remove_all_locks(&self)` — app-exit tidiness.

**Connection loop (per accepted socket, one thread):**
1. `tungstenite::accept_hdr` with a callback that (a) checks `X-Claude-Code-Ide-Authorization` equals the session token — else return an HTTP 401 error response; (b) if the client offered `Sec-WebSocket-Protocol` containing `mcp`, add `Sec-WebSocket-Protocol: mcp` to the response.
2. `stream.set_read_timeout(Some(Duration::from_millis(50)))` before the WS wrap (the `bridge.rs` pattern).
3. Loop: drain outbound `mpsc::Receiver` (send each as a text frame); then `ws.read()`; on text, `dispatch(...)` and act on each `Action` (Reply → send; DeferDiff → register pending {rpc id, tab_name} and `events.open_diff(...)`; OpenFile → `events.open_file(...)`; CloseDiff → answer any matching pending diffs as rejected? NO — `close_tab` after a verdict is bookkeeping; just `events.diff_closed(...)` so the UI can drop a stale card); on `WouldBlock`/`TimedOut` io errors, continue; on close/other errors, break. Check the shutdown flag every iteration.
4. A second connection for the same session replaces the outbound sender (old loop notices its receiver hung up… simpler and sufficient: keep at most one accept at a time — the accept loop only accepts when no live connection, else drops the new socket. claude reconnects rarely; last-wins complexity is not worth it. Document this.)

**Pending diffs on disconnect:** when the read loop exits, DO NOT auto-reject pending diffs (claude may reconnect after an app-side hiccup and the terminal prompt still stands); they are rejected on session teardown (`reject_all` from the pty hook in Task 4) or answered by the user.

- [ ] **Step 1: Write the integration test** `src-tauri/tests/ide_host.rs` (tungstenite is already a dependency, usable from tests):

```rust
use std::sync::Arc;

struct RecEvents(std::sync::Mutex<Vec<(String, String, serde_json::Value)>>);
impl conduit_tauri::ide_host::IdeEvents for RecEvents {
    fn open_diff(&self, s: &str, d: &str, a: &serde_json::Value) {
        self.0.lock().unwrap().push((s.into(), d.into(), a.clone()));
    }
    fn open_file(&self, _: &str, _: &str) {}
    fn diff_closed(&self, _: &str, _: Option<&str>) {}
}

#[test]
fn full_session_handshake_tools_and_deferred_diff() {
    let tmp = std::env::temp_dir().join(format!("ide-int-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let host = conduit_tauri::ide_host::IdeHost::new();
    let events = Arc::new(RecEvents(Default::default()));
    let port = host
        .start_for_session("s1", "/w", &tmp, None, events.clone())
        .expect("server started");
    // token comes from the lock file exactly as claude reads it
    let lock: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(tmp.join(format!("{port}.lock"))).unwrap(),
    ).unwrap();
    let token = lock["authToken"].as_str().unwrap();

    // wrong token → refused
    let bad = tungstenite::client::connect(
        format!("ws://127.0.0.1:{port}"), // no header at all
    );
    assert!(bad.is_err(), "unauthenticated connect must fail");

    // proper connect with header + subprotocol
    let req = tungstenite::handshake::client::Request::builder()
        .uri(format!("ws://127.0.0.1:{port}"))
        .header("Host", format!("127.0.0.1:{port}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", tungstenite::handshake::client::generate_key())
        .header("Sec-WebSocket-Protocol", "mcp")
        .header("X-Claude-Code-Ide-Authorization", token)
        .body(()).unwrap();
    let (mut ws, resp) = tungstenite::connect(req).unwrap();
    assert_eq!(
        resp.headers().get("Sec-WebSocket-Protocol").map(|v| v.to_str().unwrap()),
        Some("mcp")
    );

    ws.send(tungstenite::Message::Text(
        r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#.into(),
    )).unwrap();
    let r: serde_json::Value = match ws.read().unwrap() {
        tungstenite::Message::Text(t) => serde_json::from_str(&t).unwrap(),
        m => panic!("unexpected {m:?}"),
    };
    assert_eq!(r["result"]["serverInfo"]["name"], "Conduit");

    // openDiff parks; the event fires; resolve_diff(keep) answers with two items
    ws.send(tungstenite::Message::Text(
        r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"openDiff","arguments":{"old_file_path":"/w/x","new_file_path":"/w/x","new_file_contents":"NEW","tab_name":"T"}}}"#.into(),
    )).unwrap();
    // wait for the event registration
    for _ in 0..50 {
        if !events.0.lock().unwrap().is_empty() { break; }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let (sid, diff_id, _) = events.0.lock().unwrap()[0].clone();
    assert_eq!(sid, "s1");
    assert!(host.resolve_diff("s1", &diff_id, true, Some("NEW-EDITED")));
    let r: serde_json::Value = match ws.read().unwrap() {
        tungstenite::Message::Text(t) => serde_json::from_str(&t).unwrap(),
        m => panic!("unexpected {m:?}"),
    };
    assert_eq!(r["id"], 7);
    assert_eq!(r["result"]["content"][0]["text"], "FILE_SAVED");
    assert_eq!(r["result"]["content"][1]["text"], "NEW-EDITED");

    host.stop_for_session("s1");
    assert!(!tmp.join(format!("{port}.lock")).exists(), "lock removed on stop");
    std::fs::remove_dir_all(&tmp).unwrap();
}
```

(If the crate name for the lib target differs, check `src-tauri/Cargo.toml` `[lib] name` and use it; existing `src-tauri/tests/cli_open.rs` shows the exact import path used today.)

- [ ] **Step 2: Run to verify failure** — `cargo test --manifest-path src-tauri/Cargo.toml --test ide_host` → compile error.

- [ ] **Step 3: Implement** the registry + accept loop + connection loop per the interface block above. Structure:

```rust
struct IdeSessionState {
    token: String,
    lock_path: PathBuf,
    port: u16,
    workspace_dir: Mutex<String>,
    context: Mutex<EditorContext>,
    outbound: Mutex<Option<std::sync::mpsc::Sender<String>>>,
    pending: Mutex<Vec<PendingDiff>>, // {rpc_id: Value, diff_id: String, tab_name: String}
    shutdown: AtomicBool,
    connected: AtomicBool,
}
pub struct IdeHost { sessions: Mutex<HashMap<String, Arc<IdeSessionState>>> }
```

Accept loop: nonblocking listener, 100 ms sleep between polls, single live connection at a time. Notifications (`selection_changed`, `at_mentioned`) are JSON-RPC notifications (`{"jsonrpc":"2.0","method":…,"params":…}`) pushed onto the outbound sender if one is live (silently dropped otherwise — claude re-reads context via tools anyway).

- [ ] **Step 4: Run** — `cargo test --manifest-path src-tauri/Cargo.toml` (unit + integration). fmt + clippy.

- [ ] **Step 5: Commit** — `git commit -am "feat(ide): per-session WS/MCP server with auth, subprotocol echo, deferred openDiff"`

---

### Task 4: spawn + teardown wiring (Rust)

**Files:**
- Modify: `src-tauri/src/lib.rs` (pty_spawn, managed state, run(), new commands)
- Modify: `src-tauri/src/pty.rs` (spawn signature: `ide_port: Option<u16>`; tear_down hook; build_script)
- Modify: `src-tauri/src/store.rs` (Session.ide_port)

**Interfaces:**
- Consumes: `IdeHost` (Task 3), `ide_host::lock_dir` (Task 1).
- Produces:
  - `Session.ide_port: Option<u16>` (`#[serde(default)] #[serde(skip_serializing_if = "Option::is_none")]`), `Store::session_ide_port(&self, id) -> Option<u16>`, `Store::set_session_ide_port(&self, id, port: u16)`.
  - `pty::PtyManager::set_ide_host(&self, host: Arc<IdeHost>)` (a `OnceLock` field).
  - Tauri commands: `ide_diff_verdict { session_id, diff_id, keep: bool, contents: Option<String> }`, `ide_editor_context { project_id: String, context: EditorContext, selection_changed: bool }`, `ide_at_mention { session_id, file_path, line_start, line_end }`.
  - Tauri events emitted: `ide-open-diff` payload `{sessionId, diffId, oldFilePath, newFilePath, newFileContents, tabName}`; `ide-open-file` payload `{sessionId, filePath}`; `ide-diff-closed` payload `{sessionId, tabName|null}`.
  - `pty_spawn` gains `announce_ide: Option<bool>` (None ⇒ true).

- [ ] **Step 1: store test first** — in `store.rs`'s tests, extend the session round-trip pattern (find the existing `projectId`-absence test for `WsTab`/Session fields and mirror it):

```rust
#[test]
fn ide_port_absent_for_old_sessions_and_round_trips() {
    let old: Session = serde_json::from_str(r#"{"id":"s","name":"n"}"#).unwrap();
    assert_eq!(old.ide_port, None);
    let mut s = old.clone();
    s.ide_port = Some(61234);
    let j = serde_json::to_string(&s).unwrap();
    assert!(j.contains("\"ide_port\":61234"));
    let none_json = serde_json::to_string(&old).unwrap();
    assert!(!none_json.contains("ide_port"), "absent field must not serialize");
}
```

(Adjust the minimal-JSON literal to whatever the existing Session round-trip tests use — copy their minimal fixture.)

- [ ] **Step 2: Run to verify failure**, then add the field + accessors; run to pass.

- [ ] **Step 3: build_script test first** — in `pty.rs` tests, near `build_script_wraps_adapter_invocation_with_conduit_env`:

```rust
#[test]
fn build_script_exports_ide_port_when_present() {
    // call build_script exactly as the existing test does, adding ide_port: Some(61234)
    // assert the output contains "CLAUDE_CODE_SSE_PORT=61234" and
    // "ENABLE_IDE_INTEGRATION=true" on the same export line as CONDUIT_SESSION_ID,
    // and that ide_port: None leaves both strings absent.
}
```

Copy the existing test's argument list verbatim, adding the new parameter. Implementation: `build_script` takes `ide_port: Option<u16>`; the export line becomes:

```rust
format!(
    "export CONDUIT_SESSION_ID={sid} CONDUIT_HOOK_PORT={port}{ide}; cd {dir} && {invocation}; exec {shell} -i -l",
    ide = ide_port
        .map(|p| format!(" CLAUDE_CODE_SSE_PORT={p} ENABLE_IDE_INTEGRATION=true"))
        .unwrap_or_default(),
    ...
)
```

Windows arm: in `PtyManager::spawn`, next to the other `cmd.env` calls, `if let Some(p) = ide_port { cmd.env("CLAUDE_CODE_SSE_PORT", p.to_string()); cmd.env("ENABLE_IDE_INTEGRATION", "true"); }` (applies to both arms harmlessly — `cmd.env` is set on the CommandBuilder before the cfg split; put it in the shared `!shell_only` env block at the `CONDUIT_SESSION_ID` site so POSIX-tmux redundancy is irrelevant and Windows gets it natively).

- [ ] **Step 4: teardown** — `PtyManager` gets `ide_host: OnceLock<Arc<crate::ide_host::IdeHost>>` + `pub fn set_ide_host`. In `tear_down`, after the tmux kill:

```rust
if !how.keeps_snapshot() {
    if let Some(h) = self.ide_host.get() {
        h.reject_all(session_id);
        h.stop_for_session(session_id);
    }
}
```

Retire (hibernate/reap) keeps the listener — the persisted port makes the resume spawn reuse it (`start_for_session` is idempotent). Test: the `Teardown` table already has tests; add one asserting retire does NOT call stop (via a small `#[cfg(test)]` observation or by unit-testing `Teardown::keeps_snapshot()` gating logic if the manager is hard to instantiate — acceptable to cover this branch by the integration of `start_for_session` idempotency instead; do not over-mock).

- [ ] **Step 5: pty_spawn wiring** — in `lib.rs::pty_spawn`, after the `(cwd, worktree_arg, settings_path)` resolution (so `cwd` is the effective dir):

```rust
let ide_state: State<Arc<crate::ide_host::IdeHost>> = app.state();
let ide_port = if !shell_only
    && agent == crate::agent::AgentId::Claude
    && announce_ide.unwrap_or(true)
{
    let home = dirs_home(); // however store.rs/pty.rs get $HOME today — reuse that helper
    let lock_dir = crate::ide_host::lock_dir(account_config_dir.as_deref(), &home);
    let preferred = store.session_ide_port(&session_id);
    let events = Arc::new(TauriIdeEvents { app: app.clone() });
    let port = ide_state.start_for_session(&session_id, &cwd, &lock_dir, preferred, events);
    if let Some(p) = port {
        store.set_session_ide_port(&session_id, p);
    }
    port
} else {
    None
};
```

(`dirs_home`: `pty.rs` and `store.rs` already resolve home dirs — grep for how `claude_projects_dir` does it and reuse; do not add a `dirs` crate.)

`TauriIdeEvents` implements `IdeEvents` by emitting the three events with `app.emit(...)` — payload shapes above, camelCase keys.

Thread `ide_port` into `pty.spawn(...)` and `build_script`. Register `IdeHost::new()` as managed state in `run()` beside `PtyManager`, call `pty.set_ide_host(...)` right after both exist, and run the startup sweep in a `std::thread::spawn` (probe = `TcpStream::connect_timeout(("127.0.0.1", port), 300ms).is_ok()`) over: the ambient `~/.claude/ide` dir AND every registered account's `lock_dir` (`store` exposes accounts; if enumerating accounts is awkward, ambient-only is acceptable for this task with a `// TODO(next)` — NO: global constraint forbids TODOs. Enumerate the accounts: `store.accounts()` exists for the account list UI; use each `config_dir`).

- [ ] **Step 6: commands** — add the three Tauri commands; `ide_editor_context` resolves the project's session ids via the store (same lookup shape as `board_enabled_for_session` — sessions of `project_id` that currently have an IDE server) and calls `host.update_context`. `ide_diff_verdict` calls `resolve_diff` and emits nothing (the frontend already knows). `ide_at_mention` calls `host.at_mention`. Register all three + `announce_ide` param in the `invoke_handler` list.

- [ ] **Step 7: Run** — `cargo test --manifest-path src-tauri/Cargo.toml`, fmt, clippy. Expected: all green; no frontend yet (spawn arg is optional so the existing invoke keeps working).

- [ ] **Step 8: Commit** — `git commit -am "feat(ide): announce per-session IDE server at spawn; teardown + sweep + verdict commands"`

---

### Task 5: frontend pref + spawn arg + pure bridge helpers

**Files:**
- Modify: `src/store.ts` (pref `announceAsIde`, key `conduit.announceAsIde`, default on — mirror `RESTORE_SESSIONS_KEY` exactly: reader, state field, setter)
- Modify: `src/components/GeneralSettings.tsx` (toggle row "Announce as IDE to Claude sessions", copying the restore-sessions row)
- Modify: `src/components/Terminal.tsx` (the `invoke("pty_spawn", {...})` call gains `announceIde: useStore.getState().announceAsIde`)
- Create: `src/ideBridge.ts` + `src/ideBridge.test.ts`

**Interfaces:**
- Produces (in `ideBridge.ts`, importable WITHOUT `store.ts` — node-env vitest rule):
  ```ts
  export type IdeSelection = { text: string; filePath: string; fileUrl: string;
    selection: { start: {line: number; character: number};
                 end: {line: number; character: number}; isEmpty: boolean } };
  export type IdeEditorContext = {
    activeFile: string | null;
    selection: IdeSelection | null;
    openFiles: { path: string; label: string; languageId: string; active: boolean }[];
    diagnostics: unknown[];
  };
  export function buildEditorContext(args: {
    openPaths: { path: string; language: string; active: boolean }[];
    selection: IdeSelection | null;
    markers: unknown[];
  }): IdeEditorContext;
  export type PendingDiff = { sessionId: string; diffId: string; oldFilePath: string;
    newFilePath: string; newFileContents: string; tabName: string };
  // queue semantics: one visible per session, FIFO behind it; close_tab removes by tabName
  export function pushDiff(q: PendingDiff[], d: PendingDiff): PendingDiff[];
  export function popDiff(q: PendingDiff[], sessionId: string, diffId: string): PendingDiff[];
  export function closeDiffs(q: PendingDiff[], sessionId: string, tabName: string | null): PendingDiff[];
  export function visibleDiff(q: PendingDiff[], sessionId: string): PendingDiff | null;
  ```

- [ ] **Step 1: Write `src/ideBridge.test.ts` first** — cover: `buildEditorContext` labels a file by basename and marks the active one; queue push/pop/visible ordering (two diffs same session → first visible, pop reveals second); `closeDiffs` with `tabName: null` clears the session's queue, with a name removes only that entry; other sessions' entries untouched.

```ts
import { describe, expect, test } from "vitest";
import { buildEditorContext, pushDiff, popDiff, closeDiffs, visibleDiff,
         type PendingDiff } from "./ideBridge";

const d = (sessionId: string, diffId: string, tabName = diffId): PendingDiff => ({
  sessionId, diffId, tabName, oldFilePath: "/a", newFilePath: "/a", newFileContents: "x",
});

describe("diff queue", () => {
  test("fifo per session", () => {
    let q: PendingDiff[] = [];
    q = pushDiff(q, d("s1", "d1"));
    q = pushDiff(q, d("s1", "d2"));
    q = pushDiff(q, d("s2", "d3"));
    expect(visibleDiff(q, "s1")?.diffId).toBe("d1");
    q = popDiff(q, "s1", "d1");
    expect(visibleDiff(q, "s1")?.diffId).toBe("d2");
    expect(visibleDiff(q, "s2")?.diffId).toBe("d3");
  });
  test("closeDiffs by tab name and wholesale", () => {
    let q = [d("s1", "d1", "T1"), d("s1", "d2", "T2"), d("s2", "d3", "T3")];
    expect(closeDiffs(q, "s1", "T1").map((x) => x.diffId)).toEqual(["d2", "d3"]);
    expect(closeDiffs(q, "s1", null).map((x) => x.diffId)).toEqual(["d3"]);
  });
});

test("buildEditorContext shapes tabs", () => {
  const c = buildEditorContext({
    openPaths: [{ path: "/w/src/a.ts", language: "typescript", active: true }],
    selection: null, markers: [],
  });
  expect(c.activeFile).toBe("/w/src/a.ts");
  expect(c.openFiles[0]).toEqual({
    path: "/w/src/a.ts", label: "a.ts", languageId: "typescript", active: true,
  });
});
```

- [ ] **Step 2: `pnpm test src/ideBridge.test.ts`** → fails (module missing). Implement `ideBridge.ts`. Re-run → pass.

- [ ] **Step 3: pref + toggle + spawn arg** — copy the `restoreSessionsOnOpen` pattern for `announceAsIde` (reader defaults true on absent), add the GeneralSettings row (copy JSX of the restore row, new label + description "Claude sessions connect to Conduit for diff review and selection context."), add `announceIde` to the Terminal.tsx invoke.

- [ ] **Step 4: `pnpm exec tsc --noEmit && pnpm test`** → green.

- [ ] **Step 5: Commit** — `git commit -am "feat(ide): announce pref, spawn arg, pure bridge helpers"`

---

### Task 6: DiffReviewOverlay + event wiring

**Files:**
- Create: `src/components/DiffReviewOverlay.tsx`
- Modify: `src/store.ts` (runtime `pendingDiffs: PendingDiff[]` + actions `ideDiffArrived`, `ideDiffResolved`, `ideDiffsClosed` delegating to the pure queue fns)
- Modify: `src/App.tsx` (listen `ide-open-diff`, `ide-open-file`, `ide-diff-closed`)
- Modify: `src/components/Terminal.tsx` (mount the overlay inside `.term-host`, exactly where `SessionChat` mounts — an absolutely positioned sibling; agent sessions only)

**Interfaces:**
- Consumes: `ideBridge.ts` queue fns + `PendingDiff` (Task 5); events from Task 4.
- Produces: overlay UI; `invoke("ide_diff_verdict", { sessionId, diffId, keep, contents })`.

**Overlay content:** header "Claude proposes changes — `<basename(newFilePath)>`" + the tabName small/dim; a Monaco **DiffEditor** (original = current file contents read via the existing file-read path CodeEditorPane uses — grep how it loads file bytes (`fsops` invoke) and reuse; if the file does not exist yet, original = empty string), modified = `newFileContents`, modified side EDITABLE; buttons **Keep** (primary; sends the modified editor's CURRENT value as `contents`, keep=true) and **Reject** (keep=false, contents null). Both then `ideDiffResolved`. Esc = Reject. While a diff is pending for the visible session, show it; queue drains FIFO via `visibleDiff`.

- [ ] **Step 1:** Store slice + App listeners (payload→`PendingDiff` mapping is 1:1 camelCase; `ide-open-file` handler: find the session's project id from store state, call `openFile(projectId, filePath)`).
- [ ] **Step 2:** Component. Reuse the Monaco setup in `src/monaco/setup.ts` (import pattern from `CodeEditorPane.tsx` — dynamic import if that is what the pane does; follow it exactly so the vitest node env never loads Monaco).
- [ ] **Step 3:** Mount in Terminal.tsx behind `!shellOnly`, `visibleDiff(pendingDiffs, sessionId)`.
- [ ] **Step 4:** `pnpm exec tsc --noEmit && pnpm test && pnpm build` → green. (No component test — repo convention.)
- [ ] **Step 5: Commit** — `git commit -am "feat(ide): Monaco diff review overlay wired to openDiff verdicts"`

---

### Task 7: editor context push + selection_changed + at-mention

**Files:**
- Modify: `src/components/CodeEditorPane.tsx`
- Modify: `src/App.tsx` or a new `src/hooks/useIdeContextPush.ts` (one debounced pusher)

**Interfaces:**
- Consumes: `buildEditorContext` (Task 5); `invoke("ide_editor_context", { projectId, context, selectionChanged })`; `invoke("ide_at_mention", { sessionId, filePath, lineStart, lineEnd })`.

- [ ] **Step 1:** In CodeEditorPane, on `onDidChangeCursorSelection` (debounce 150 ms via a `setTimeout` ref — no lodash) and on tab/model changes, build the `IdeSelection` (`fileUrl` = `"file://" + path`; Monaco positions are 1-based lines / 1-based columns → convert to 0-based `line`/`character`) and push `ide_editor_context` with `selectionChanged: true` for selection events, `false` for tab-only changes. Markers: `monaco.editor.getModelMarkers({})` filtered to open models, mapped to `{uri, diagnostics:[{message, severity, range}]}`.
- [ ] **Step 2:** Context menu / action: add a Monaco editor action ("Send selection to Claude", `contextMenuGroupId: "navigation"`) that invokes `ide_at_mention` with the ACTIVE session of the pane's project (store's selected session for that project; if none, no-op).
- [ ] **Step 3:** `pnpm exec tsc --noEmit && pnpm build` → green.
- [ ] **Step 4: Commit** — `git commit -am "feat(ide): editor context push, selection_changed, send-selection at-mention"`

---

### Task 8: gates + manual verification + version/changelog

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml` (line 3), `src-tauri/tauri.conf.json` → `0.38.0`
- Modify: `CHANGELOG.md` (new top entry)

- [ ] **Step 1: Full gates** — `cargo fmt --check`, `cargo clippy -D warnings` (as CI spells it), `cargo test`, `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`. All green before proceeding.
- [ ] **Step 2: Manual verification** — `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`; in a Claude session: `/ide` shows Conduit connected (or the status line shows the IDE indicator); shift+tab to manual mode; ask for a file edit → overlay appears; Keep → file written by claude, terminal shows accepted; Reject → "User rejected". Select text in the editor pane → claude's footer shows the selection. Kill the session → lock file gone.
- [ ] **Step 3: Version bump + changelog** — `0.38.0`, entry:

```markdown
## 0.38.0 — 2026-09-23

- **Added — Conduit is now a Claude Code IDE.** Claude sessions launched in Conduit
  connect back to the app: review and edit Claude's proposed file changes in a
  side-by-side diff with Keep/Reject, send editor selections to the session as
  context, and let Claude open files in Conduit's editor. Toggle under
  Settings → General → "Announce as IDE".
```

Then `cargo build --manifest-path src-tauri/Cargo.toml` once for `Cargo.lock`.
- [ ] **Step 4: Commit** — `git commit -am "chore(release): 0.38.0"`

---

## Self-review notes

- Spec coverage: lock/env (T1/T4), server+auth+subprotocol (T3), tools (T2/T3), openDiff two-item contract (T2/T3/T6), notifications (T3/T7), pref (T5), sweep + warm re-bind via persisted port + idempotent start (T1/T4), teardown rejects pending (T3/T4), version/changelog (T8).
- Deliberate deviations from spec text: token is NOT persisted (fresh per start; claude re-reads the lock on reconnect) — the spec's "persist token" line is superseded by the Secrets rule; the spec's `ide_token` field is dropped. Retire keeps the listener alive (cheap, and makes resume trivial); only destroy stops it.
- executeCode omitted (spec).
