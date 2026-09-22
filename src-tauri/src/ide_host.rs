//! Conduit-as-IDE host: per-session WebSocket/MCP servers the `claude` CLI connects
//! back to, making Conduit a recognized Claude Code IDE (diff review, selection
//! context, at-mentions, openFile).
//!
//! Topology: ONE server per running Claude session (ephemeral port). The protocol
//! carries no client identity on the wire, and under tmux Conduit is never the
//! claude process's ancestor, so the port itself is the identity: a connection on a
//! session's port IS that session. That is what lets `openDiff` land on the right
//! pane with no pid forensics.
//!
//! Wire details (auth header, `mcp` subprotocol, the two-item FILE_SAVED contract)
//! are EMPIRICAL against claude 2.1.267 — see
//! `docs/superpowers/specs/2026-09-23-ide-integration-design.md` before "fixing"
//! anything that looks odd here.

use std::path::{Path, PathBuf};

/// 128-bit auth token as 32 lowercase hex chars — the shape claude's own IDE
/// extensions mint. Never logged, never persisted to state.json (Secrets rule);
/// it lives in memory and in the 0600 lock file, nowhere else.
pub fn mint_token() -> String {
    // No `rand` dep (lean-deps rule): /dev/urandom on unix; a time+pid FNV fold as
    // the fallback for the effectively-unheard-of read failure. Localhost-only,
    // per-spawn token — this is belt-and-braces, not a KDF.
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

/// The lock file body, exactly the fields claude 2.1.267 parses. `runningInWindows`
/// only on Windows builds (it exists for WSL bridging: it tells a WSL claude to dial
/// the Windows host instead of localhost).
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
/// `agent::claude_profile_env`: a `.claude`-rooted account redirects HOME to the
/// profile root (claude then reads `<root>/.claude/ide` — which IS `<dir>/ide`);
/// any other explicit dir becomes CLAUDE_CONFIG_DIR (claude reads `<dir>/ide`);
/// ambient is `~/.claude/ide`. Both explicit routes collapse to `<dir>/ide`, which
/// is why there is no `.claude`-suffix branch here — the test documents both.
/// Writing to the real home for a redirected session would announce to a claude
/// that can never see it.
pub fn lock_dir(account_config_dir: Option<&str>, home: &Path) -> PathBuf {
    match account_config_dir {
        Some(d) => PathBuf::from(d).join("ide"),
        None => home.join(".claude").join("ide"),
    }
}

/// Sweep guard: only files WE wrote are ever candidates. Unparseable contents are
/// not ours (claude itself tolerates a legacy newline-list format — leave those to
/// their owner).
pub fn is_conduit_lock(contents: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(contents)
        .ok()
        .is_some_and(|v| v["ideName"] == "Conduit")
}

/// Startup hygiene: remove OUR stale lock files (ideName == "Conduit") whose port no
/// longer answers. The probe is injected so tests need no sockets; production passes
/// a TCP connect. Deliberately keyed on "is anything listening" rather than pid
/// liveness — that is the actual question, and it needs no platform-split syscall.
pub fn sweep_lock_dir(dir: &Path, probe: &dyn Fn(u16) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(port) = name
            .to_str()
            .and_then(|n| n.strip_suffix(".lock"))
            .and_then(|p| p.parse::<u16>().ok())
        else {
            continue;
        };
        let Ok(contents) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        if is_conduit_lock(&contents) && !probe(port) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// ---------------------------------------------------------------------------
// MCP dispatcher (pure): one wire message in, a list of actions out. The
// connection loop owns sockets and side effects; keeping this pure is what
// makes the wire contract unit-testable without a socket.
// ---------------------------------------------------------------------------

/// Editor state the frontend pushes down (project-scoped, fanned to that
/// project's sessions). Everything optional: an empty context is a session whose
/// project has no editor pane open, and every read tool degrades gracefully.
#[derive(Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorContext {
    pub active_file: Option<String>,
    /// `{text, filePath, fileUrl, selection: {start, end, isEmpty}}` — built by
    /// the frontend in claude's own shape so this side never remaps it.
    pub selection: Option<serde_json::Value>,
    /// `[{path, label, languageId, active}]`
    pub open_files: Vec<serde_json::Value>,
    /// `[{uri, diagnostics: […]}]` per open model.
    pub diagnostics: Vec<serde_json::Value>,
}

/// What the connection loop should do for one inbound message, in order.
pub enum Action {
    /// Send this JSON-RPC payload back.
    Reply(serde_json::Value),
    /// `openDiff`: park the request (no reply yet), surface it to the human.
    /// The reply is minted later by `IdeHost::resolve_diff`.
    DeferDiff {
        diff_id: String,
        rpc_id: serde_json::Value,
        args: serde_json::Value,
    },
    /// `openFile`: ask the frontend to open the file in the project's editor.
    OpenFile { path: String },
    /// `close_tab` (Some) / `closeAllDiffTabs` (None): drop pending reviews.
    CloseDiff { tab_name: Option<String> },
}

/// JSON-RPC result whose `content` is a list of text items — the MCP tool-result
/// shape. `openDiff`'s accept path REQUIRES two items (FILE_SAVED + the final
/// contents); everything else uses one.
pub fn tool_result(id: &serde_json::Value, texts: &[&str]) -> serde_json::Value {
    let content: Vec<serde_json::Value> = texts
        .iter()
        .map(|t| serde_json::json!({"type": "text", "text": t}))
        .collect();
    serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {"content": content}})
}

fn rpc_result(id: &serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// The advertised tool surface. Ten tools; `executeCode` is deliberately absent
/// (Jupyter-only — Conduit has no kernel).
fn tool_defs() -> serde_json::Value {
    let empty = serde_json::json!({"type":"object","properties":{},"additionalProperties":false});
    serde_json::json!([
        {"name": "getWorkspaceFolders", "description": "Get the workspace folders for this session", "inputSchema": empty},
        {"name": "getCurrentSelection", "description": "Get the current editor selection", "inputSchema": empty},
        {"name": "getLatestSelection", "description": "Get the most recent editor selection", "inputSchema": empty},
        {"name": "getOpenEditors", "description": "List open editor tabs", "inputSchema": empty},
        {"name": "getDiagnostics", "description": "Get language diagnostics", "inputSchema":
            {"type":"object","properties":{"uri":{"type":"string"}}}},
        {"name": "checkDocumentDirty", "description": "Whether a document has unsaved changes", "inputSchema":
            {"type":"object","properties":{"filePath":{"type":"string"}},"required":["filePath"]}},
        {"name": "saveDocument", "description": "Save a document", "inputSchema":
            {"type":"object","properties":{"filePath":{"type":"string"}},"required":["filePath"]}},
        {"name": "openFile", "description": "Open a file in Conduit's editor", "inputSchema":
            {"type":"object","properties":{
                "filePath":{"type":"string"},
                "preview":{"type":"boolean"},
                "startText":{"type":"string"},
                "endText":{"type":"string"}},
             "required":["filePath"]}},
        {"name": "openDiff", "description": "Show a diff of a proposed change and wait for the user's verdict", "inputSchema":
            {"type":"object","properties":{
                "old_file_path":{"type":"string"},
                "new_file_path":{"type":"string"},
                "new_file_contents":{"type":"string"},
                "tab_name":{"type":"string"}}}},
        {"name": "close_tab", "description": "Close a diff tab by name", "inputSchema":
            {"type":"object","properties":{"tab_name":{"type":"string"}},"required":["tab_name"]}},
        {"name": "closeAllDiffTabs", "description": "Close all diff tabs", "inputSchema": empty},
    ])
}

fn call_tool(
    id: &serde_json::Value,
    name: &str,
    args: &serde_json::Value,
    workspace_dir: &str,
    ctx: &EditorContext,
    next_diff_id: &mut u64,
) -> Vec<Action> {
    match name {
        "getWorkspaceFolders" => {
            let body = serde_json::json!({
                "success": true,
                "folders": [workspace_dir],
                "rootPath": workspace_dir,
            });
            vec![Action::Reply(tool_result(id, &[&body.to_string()]))]
        }
        "getCurrentSelection" | "getLatestSelection" => {
            let body = match &ctx.selection {
                Some(sel) => sel.clone(),
                None => serde_json::json!({"success": false, "message": "No selection"}),
            };
            vec![Action::Reply(tool_result(id, &[&body.to_string()]))]
        }
        "getOpenEditors" => {
            let body = serde_json::json!({"tabs": ctx.open_files});
            vec![Action::Reply(tool_result(id, &[&body.to_string()]))]
        }
        "getDiagnostics" => {
            let uri = args["uri"].as_str();
            let list: Vec<&serde_json::Value> = ctx
                .diagnostics
                .iter()
                .filter(|d| uri.is_none_or(|u| d["uri"] == u))
                .collect();
            let body = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
            vec![Action::Reply(tool_result(id, &[&body]))]
        }
        "checkDocumentDirty" => {
            // Conduit's editor autosaves; dirty is a state it does not keep.
            let body = serde_json::json!({"success": true, "isDirty": false});
            vec![Action::Reply(tool_result(id, &[&body.to_string()]))]
        }
        "saveDocument" => {
            let body = serde_json::json!({"success": true, "saved": true});
            vec![Action::Reply(tool_result(id, &[&body.to_string()]))]
        }
        "openFile" => {
            let path = args["filePath"].as_str().unwrap_or_default().to_string();
            vec![
                Action::OpenFile { path },
                Action::Reply(tool_result(id, &["FILE_OPENED"])),
            ]
        }
        "openDiff" => {
            let diff_id = format!("d{}", *next_diff_id);
            *next_diff_id += 1;
            vec![Action::DeferDiff {
                diff_id,
                rpc_id: id.clone(),
                args: args.clone(),
            }]
        }
        "close_tab" => {
            let tab = args["tab_name"].as_str().map(str::to_string);
            vec![
                Action::CloseDiff { tab_name: tab },
                Action::Reply(tool_result(id, &["TAB_CLOSED"])),
            ]
        }
        "closeAllDiffTabs" => vec![
            Action::CloseDiff { tab_name: None },
            Action::Reply(tool_result(id, &["TAB_CLOSED"])),
        ],
        _ => vec![Action::Reply(serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "error": {"code": -32602, "message": "unknown tool"},
        }))],
    }
}

/// One inbound wire message → ordered actions. Requests ALWAYS get a reply
/// (unknown methods get `{}` — claude tolerates that, and silence would hang its
/// request); notifications never do. `openDiff` is the one deliberate exception:
/// its reply is deferred to the human verdict.
pub fn dispatch(
    msg: &serde_json::Value,
    workspace_dir: &str,
    ctx: &EditorContext,
    next_diff_id: &mut u64,
) -> Vec<Action> {
    let method = msg["method"].as_str().unwrap_or_default();
    let id = &msg["id"];
    let has_id = !id.is_null();
    match method {
        "initialize" => {
            let proto = msg["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2025-11-25");
            vec![Action::Reply(rpc_result(
                id,
                serde_json::json!({
                    "protocolVersion": proto,
                    "capabilities": {"tools": {"listChanged": true}},
                    "serverInfo": {"name": "Conduit", "version": env!("CARGO_PKG_VERSION")},
                }),
            ))]
        }
        "tools/list" => vec![Action::Reply(rpc_result(
            id,
            serde_json::json!({"tools": tool_defs()}),
        ))],
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or_default();
            let args = &msg["params"]["arguments"];
            call_tool(id, name, args, workspace_dir, ctx, next_diff_id)
        }
        "ping" => vec![Action::Reply(rpc_result(id, serde_json::json!({})))],
        // Known no-reply notifications, and any unknown notification.
        _ if !has_id => Vec::new(),
        // Unknown REQUEST: answer `{}` rather than hanging the client.
        _ => vec![Action::Reply(rpc_result(id, serde_json::json!({})))],
    }
}

// ---------------------------------------------------------------------------
// The host: per-session listeners, lock files, connections, pending diffs.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// Side effects the connection loop needs from the app. A trait, not an
/// `AppHandle`, so `tests/ide_host.rs` can drive the real loop over a real
/// socket (the `cli_open.rs` lesson).
pub trait IdeEvents: Send + Sync + 'static {
    fn open_diff(&self, session_id: &str, diff_id: &str, args: &serde_json::Value);
    fn open_file(&self, session_id: &str, path: &str);
    fn diff_closed(&self, session_id: &str, tab_name: Option<&str>);
}

struct PendingDiff {
    diff_id: String,
    rpc_id: serde_json::Value,
    tab_name: String,
}

struct IdeSessionState {
    token: String,
    port: u16,
    lock_path: PathBuf,
    workspace_dir: Mutex<String>,
    context: Mutex<EditorContext>,
    /// The live connection's outbound queue; None between connections.
    /// Notifications sent while disconnected are dropped on purpose — claude
    /// re-reads context through the tools after it reconnects.
    outbound: Mutex<Option<mpsc::Sender<String>>>,
    pending: Mutex<Vec<PendingDiff>>,
    shutdown: AtomicBool,
    connected: AtomicBool,
}

impl IdeSessionState {
    fn send(&self, payload: String) {
        if let Ok(guard) = self.outbound.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(payload);
            }
        }
    }
}

#[derive(Default)]
pub struct IdeHost {
    sessions: Mutex<HashMap<String, Arc<IdeSessionState>>>,
}

impl IdeHost {
    pub fn new() -> Arc<IdeHost> {
        Arc::new(IdeHost::default())
    }

    /// Bind a listener for this session, write its lock file, start the accept
    /// thread, and return the port for the spawn env. Idempotent: a session with
    /// a live server keeps its port (the lock is rewritten — the workspace dir
    /// may have changed across a resume). `preferred_port` re-binds a persisted
    /// port after an app restart so a still-running claude's env stays valid;
    /// a failed preferred bind falls back to an ephemeral port.
    pub fn start_for_session(
        &self,
        session_id: &str,
        workspace_dir: &str,
        lock_dir: &Path,
        preferred_port: Option<u16>,
        events: Arc<dyn IdeEvents>,
    ) -> Option<u16> {
        if let Ok(map) = self.sessions.lock() {
            if let Some(existing) = map.get(session_id) {
                if let Ok(mut dir) = existing.workspace_dir.lock() {
                    *dir = workspace_dir.to_string();
                }
                write_lock_file(
                    &existing.lock_path,
                    existing.port,
                    workspace_dir,
                    &existing.token,
                );
                return Some(existing.port);
            }
        }
        let listener = preferred_port
            .and_then(|p| std::net::TcpListener::bind(("127.0.0.1", p)).ok())
            .or_else(|| std::net::TcpListener::bind(("127.0.0.1", 0)).ok())?;
        let port = listener.local_addr().ok()?.port();
        // Nonblocking accept + sleep polls: shutdown is observed within ~100 ms
        // without needing a wake-up connection.
        if listener.set_nonblocking(true).is_err() {
            return None;
        }
        if std::fs::create_dir_all(lock_dir).is_err() {
            eprintln!("conduit: ide lock dir {lock_dir:?} not writable; session runs without IDE");
            return None;
        }
        let token = mint_token();
        let lock_path = lock_dir.join(format!("{port}.lock"));
        write_lock_file(&lock_path, port, workspace_dir, &token);
        let state = Arc::new(IdeSessionState {
            token,
            port,
            lock_path,
            workspace_dir: Mutex::new(workspace_dir.to_string()),
            context: Mutex::new(EditorContext::default()),
            outbound: Mutex::new(None),
            pending: Mutex::new(Vec::new()),
            shutdown: AtomicBool::new(false),
            connected: AtomicBool::new(false),
        });
        if let Ok(mut map) = self.sessions.lock() {
            map.insert(session_id.to_string(), state.clone());
        }
        let sid = session_id.to_string();
        std::thread::spawn(move || accept_loop(listener, state, sid, events));
        Some(port)
    }

    /// Destroy path: stop the listener, drop the lock file, forget the session.
    /// Pending diffs should be rejected FIRST (`reject_all`) so claude's blocked
    /// request resolves rather than dangling until its own timeout.
    pub fn stop_for_session(&self, session_id: &str) {
        let state = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut m| m.remove(session_id));
        if let Some(s) = state {
            s.shutdown.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(&s.lock_path);
        }
    }

    /// Frontend context push, fanned to the named sessions. `selection_changed`
    /// additionally queues the `selection_changed` notification claude uses for
    /// its live footer.
    pub fn update_context(
        &self,
        session_ids: &[String],
        ctx: &EditorContext,
        selection_changed: bool,
    ) {
        let Ok(map) = self.sessions.lock() else {
            return;
        };
        for sid in session_ids {
            let Some(s) = map.get(sid) else { continue };
            if let Ok(mut c) = s.context.lock() {
                *c = ctx.clone();
            }
            if selection_changed {
                if let Some(sel) = &ctx.selection {
                    let note = serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "selection_changed",
                        "params": sel,
                    });
                    s.send(note.to_string());
                }
            }
        }
    }

    /// Explicit "send this to claude" — lands in the session's prompt as an
    /// at-mention.
    pub fn at_mention(&self, session_id: &str, file_path: &str, line_start: u64, line_end: u64) {
        let Ok(map) = self.sessions.lock() else {
            return;
        };
        if let Some(s) = map.get(session_id) {
            let note = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "at_mentioned",
                "params": {"filePath": file_path, "lineStart": line_start, "lineEnd": line_end},
            });
            s.send(note.to_string());
        }
    }

    /// The human's verdict on one parked openDiff. Keep ⇒ the two-item
    /// `[FILE_SAVED, contents]` reply (claude then writes the file itself —
    /// Conduit NEVER touches the file); reject ⇒ `[DIFF_REJECTED]`.
    pub fn resolve_diff(
        &self,
        session_id: &str,
        diff_id: &str,
        keep: bool,
        contents: Option<&str>,
    ) -> bool {
        let Ok(map) = self.sessions.lock() else {
            return false;
        };
        let Some(s) = map.get(session_id) else {
            return false;
        };
        let Ok(mut pending) = s.pending.lock() else {
            return false;
        };
        let Some(idx) = pending.iter().position(|p| p.diff_id == diff_id) else {
            return false;
        };
        let p = pending.remove(idx);
        let reply = if keep {
            tool_result(&p.rpc_id, &["FILE_SAVED", contents.unwrap_or_default()])
        } else {
            tool_result(&p.rpc_id, &["DIFF_REJECTED"])
        };
        s.send(reply.to_string());
        true
    }

    /// Teardown half of `stop_for_session`; also used alone when a session dies
    /// with reviews still open.
    pub fn reject_all(&self, session_id: &str) {
        let Ok(map) = self.sessions.lock() else {
            return;
        };
        let Some(s) = map.get(session_id) else {
            return;
        };
        let Ok(mut pending) = s.pending.lock() else {
            return;
        };
        for p in pending.drain(..) {
            s.send(tool_result(&p.rpc_id, &["DIFF_REJECTED"]).to_string());
        }
    }

    /// App-exit tidiness: leave no lock files pointing at listeners that are
    /// about to die with the process. The startup sweep would catch them next
    /// boot; this just keeps other tools' `/ide` menus clean in between.
    pub fn remove_all_locks(&self) {
        if let Ok(map) = self.sessions.lock() {
            for s in map.values() {
                let _ = std::fs::remove_file(&s.lock_path);
            }
        }
    }
}

fn write_lock_file(path: &Path, _port: u16, workspace_dir: &str, token: &str) {
    let body = lock_json(std::process::id(), workspace_dir, token);
    if std::fs::write(path, body).is_err() {
        eprintln!("conduit: could not write ide lock file {path:?}");
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

fn accept_loop(
    listener: std::net::TcpListener,
    state: Arc<IdeSessionState>,
    session_id: String,
    events: Arc<dyn IdeEvents>,
) {
    loop {
        if state.shutdown.load(Ordering::SeqCst) {
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                // One live connection at a time: claude reconnects rarely, and
                // last-wins juggling buys nothing but races. A second dial while
                // one is live is dropped; claude retries after the old one dies.
                if state.connected.load(Ordering::SeqCst) {
                    drop(stream);
                    continue;
                }
                let st = state.clone();
                let sid = session_id.clone();
                let ev = events.clone();
                std::thread::spawn(move || {
                    st.connected.store(true, Ordering::SeqCst);
                    connection_loop(stream, &st, &sid, ev.as_ref());
                    st.connected.store(false, Ordering::SeqCst);
                    if let Ok(mut out) = st.outbound.lock() {
                        *out = None;
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return,
        }
    }
}

/// Auth + subprotocol live in the HTTP upgrade. Reject BEFORE speaking any
/// protocol: a bad token gets a bare 401, never a token oracle.
///
/// `result_large_err`: the Err type is tungstenite's `ErrorResponse`, fixed by
/// its `Callback` trait — nothing to box here.
#[allow(clippy::result_large_err)]
fn upgrade_callback(
    token: &str,
    req: &tungstenite::handshake::server::Request,
    mut resp: tungstenite::handshake::server::Response,
) -> Result<tungstenite::handshake::server::Response, tungstenite::handshake::server::ErrorResponse>
{
    let presented = req
        .headers()
        .get("x-claude-code-ide-authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    // Constant-time-ish compare: fold over all bytes, no early exit.
    let a = presented.as_bytes();
    let b = token.as_bytes();
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().min(b.len()) {
        diff |= (a[i] ^ b[i]) as usize;
    }
    if diff != 0 {
        let mut deny = tungstenite::handshake::server::ErrorResponse::new(None);
        *deny.status_mut() = tungstenite::http::StatusCode::UNAUTHORIZED;
        return Err(deny);
    }
    // claude requests the `mcp` subprotocol; echo it or the client refuses the
    // connection.
    if let Some(proto) = req.headers().get("sec-websocket-protocol") {
        if proto
            .to_str()
            .unwrap_or_default()
            .split(',')
            .any(|p| p.trim() == "mcp")
        {
            resp.headers_mut().insert(
                "sec-websocket-protocol",
                tungstenite::http::HeaderValue::from_static("mcp"),
            );
        }
    }
    Ok(resp)
}

// `result_large_err` fires on the thin adapter closure handed to `accept_hdr`
// too — same fixed `ErrorResponse` type, same reason as `upgrade_callback`.
#[allow(clippy::result_large_err)]
fn connection_loop(
    stream: std::net::TcpStream,
    state: &IdeSessionState,
    session_id: &str,
    events: &dyn IdeEvents,
) {
    // The accept socket is nonblocking (inherited); the handshake and the poll
    // loop both want timed blocking reads instead.
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));

    let token = state.token.clone();
    let mut ws = match tungstenite::accept_hdr(stream, |req: &_, resp| {
        upgrade_callback(&token, req, resp)
    }) {
        Ok(ws) => ws,
        Err(_) => return, // bad token or malformed upgrade — nothing to say
    };

    let (tx, rx) = mpsc::channel::<String>();
    if let Ok(mut out) = state.outbound.lock() {
        *out = Some(tx);
    }

    let mut next_diff_id: u64 = 0;
    loop {
        if state.shutdown.load(Ordering::SeqCst) {
            let _ = ws.close(None);
            return;
        }
        // Drain queued outbound (notifications, deferred diff replies) first.
        while let Ok(payload) = rx.try_recv() {
            if ws.send(tungstenite::Message::Text(payload)).is_err() {
                return;
            }
        }
        match ws.read() {
            Ok(tungstenite::Message::Text(text)) => {
                let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                let workspace = state
                    .workspace_dir
                    .lock()
                    .map(|d| d.clone())
                    .unwrap_or_default();
                let ctx = state.context.lock().map(|c| c.clone()).unwrap_or_default();
                for action in dispatch(&msg, &workspace, &ctx, &mut next_diff_id) {
                    match action {
                        Action::Reply(payload) => {
                            if ws
                                .send(tungstenite::Message::Text(payload.to_string()))
                                .is_err()
                            {
                                return;
                            }
                        }
                        Action::DeferDiff {
                            diff_id,
                            rpc_id,
                            args,
                        } => {
                            let tab_name =
                                args["tab_name"].as_str().unwrap_or_default().to_string();
                            if let Ok(mut pending) = state.pending.lock() {
                                pending.push(PendingDiff {
                                    diff_id: diff_id.clone(),
                                    rpc_id,
                                    tab_name,
                                });
                            }
                            events.open_diff(session_id, &diff_id, &args);
                        }
                        Action::OpenFile { path } => events.open_file(session_id, &path),
                        Action::CloseDiff { tab_name } => {
                            // The user may have answered the TERMINAL prompt instead of
                            // the overlay — claude resolves its side and closes the tab,
                            // and the parked entry would otherwise wait forever for a
                            // verdict nobody is going to give. Drop it WITHOUT replying:
                            // that rpc id is already answered on claude's side.
                            if let Ok(mut pending) = state.pending.lock() {
                                pending.retain(|p| {
                                    tab_name.as_deref().is_some_and(|t| p.tab_name != t)
                                });
                            }
                            events.diff_closed(session_id, tab_name.as_deref());
                        }
                    }
                }
            }
            Ok(tungstenite::Message::Ping(p)) => {
                let _ = ws.send(tungstenite::Message::Pong(p));
            }
            Ok(tungstenite::Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_32_lowercase_hex() {
        let t = mint_token();
        assert_eq!(t.len(), 32);
        assert!(t
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(mint_token(), t); // not constant
    }

    #[test]
    fn lock_json_has_exact_field_names() {
        let j: serde_json::Value = serde_json::from_str(&lock_json(42, "/w", "abc")).unwrap();
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

    fn req(method: &str, id: u64, params: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
    }

    #[test]
    fn initialize_echoes_protocol_version() {
        let mut n = 0;
        let a = dispatch(
            &req(
                "initialize",
                0,
                serde_json::json!({"protocolVersion":"2025-11-25"}),
            ),
            "/w",
            &EditorContext::default(),
            &mut n,
        );
        let Action::Reply(r) = &a[0] else {
            panic!("expected reply")
        };
        assert_eq!(r["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(r["result"]["serverInfo"]["name"], "Conduit");
        assert_eq!(r["id"], 0);
    }

    #[test]
    fn tools_list_has_eleven_tools_and_no_execute_code() {
        let mut n = 0;
        let a = dispatch(
            &req("tools/list", 1, serde_json::json!({})),
            "/w",
            &EditorContext::default(),
            &mut n,
        );
        let Action::Reply(r) = &a[0] else { panic!() };
        let tools = r["result"]["tools"].as_array().unwrap();
        // getCurrentSelection and getLatestSelection are distinct tools (the spec
        // table shares a row); executeCode is deliberately absent.
        assert_eq!(tools.len(), 11);
        assert!(tools.iter().all(|t| t["name"] != "executeCode"));
        assert!(tools.iter().any(|t| t["name"] == "openDiff"));
    }

    #[test]
    fn open_diff_defers_instead_of_replying() {
        let mut n = 0;
        let args = serde_json::json!({"name":"openDiff","arguments":
            {"old_file_path":"/w/a.txt","new_file_path":"/w/a.txt",
             "new_file_contents":"hi","tab_name":"t1"}});
        let a = dispatch(
            &req("tools/call", 3, args),
            "/w",
            &EditorContext::default(),
            &mut n,
        );
        assert!(matches!(&a[0], Action::DeferDiff { diff_id, .. } if diff_id == "d0"));
        assert_eq!(a.len(), 1, "no reply until the human answers");
        assert_eq!(n, 1, "counter advanced");
    }

    #[test]
    fn unknown_request_gets_empty_result_never_silence() {
        let mut n = 0;
        let a = dispatch(
            &req("some/future_method", 9, serde_json::json!({})),
            "/w",
            &EditorContext::default(),
            &mut n,
        );
        let Action::Reply(r) = &a[0] else { panic!() };
        assert_eq!(r["result"], serde_json::json!({}));
    }

    #[test]
    fn notifications_get_no_reply() {
        let mut n = 0;
        let msg = serde_json::json!({"jsonrpc":"2.0","method":"ide_connected","params":{"pid":1}});
        assert!(dispatch(&msg, "/w", &EditorContext::default(), &mut n).is_empty());
    }

    #[test]
    fn selection_answers_from_pushed_context() {
        let mut n = 0;
        let ctx = EditorContext {
            selection: Some(serde_json::json!({"text":"x","filePath":"/w/a.ts"})),
            ..Default::default()
        };
        let a = dispatch(
            &req(
                "tools/call",
                4,
                serde_json::json!({"name":"getCurrentSelection","arguments":{}}),
            ),
            "/w",
            &ctx,
            &mut n,
        );
        let Action::Reply(r) = &a[0] else { panic!() };
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("/w/a.ts"));
    }

    #[test]
    fn open_file_produces_event_and_reply() {
        let mut n = 0;
        let a = dispatch(
            &req(
                "tools/call",
                5,
                serde_json::json!({"name":"openFile","arguments":{"filePath":"/w/b.rs"}}),
            ),
            "/w",
            &EditorContext::default(),
            &mut n,
        );
        assert!(matches!(&a[0], Action::OpenFile { path } if path == "/w/b.rs"));
        let Action::Reply(r) = &a[1] else { panic!() };
        assert_eq!(r["result"]["content"][0]["text"], "FILE_OPENED");
    }

    #[test]
    fn close_tab_closes_and_replies_tab_closed() {
        let mut n = 0;
        let a = dispatch(
            &req(
                "tools/call",
                6,
                serde_json::json!({"name":"close_tab","arguments":{"tab_name":"T"}}),
            ),
            "/w",
            &EditorContext::default(),
            &mut n,
        );
        assert!(matches!(&a[0], Action::CloseDiff { tab_name: Some(t) } if t == "T"));
        let Action::Reply(r) = &a[1] else { panic!() };
        assert_eq!(r["result"]["content"][0]["text"], "TAB_CLOSED");
        let a2 = dispatch(
            &req(
                "tools/call",
                7,
                serde_json::json!({"name":"closeAllDiffTabs","arguments":{}}),
            ),
            "/w",
            &EditorContext::default(),
            &mut n,
        );
        assert!(matches!(&a2[0], Action::CloseDiff { tab_name: None }));
    }

    #[test]
    fn workspace_folders_report_the_session_dir() {
        let mut n = 0;
        let a = dispatch(
            &req(
                "tools/call",
                8,
                serde_json::json!({"name":"getWorkspaceFolders","arguments":{}}),
            ),
            "/w/tree",
            &EditorContext::default(),
            &mut n,
        );
        let Action::Reply(r) = &a[0] else { panic!() };
        let body: serde_json::Value =
            serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(body["folders"], serde_json::json!(["/w/tree"]));
        assert_eq!(body["success"], true);
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
        assert!(
            dir.join("1003.lock").exists(),
            "other IDE's lock never touched"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
