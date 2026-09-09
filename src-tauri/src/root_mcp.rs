//! In-app MCP server exposing ROOT-scoped tools to an HQ (root) chat.
//!
//! Deliberately a separate server from `fleet_mcp.rs`. Every fleet tool is project-scoped
//! by construction (`caller_project_root`, and SPEC-0's resolve-against-the-caller's-own-
//! project rule). A root chat is global: it names a project per call or none at all.
//! Teaching fleet's authorizer about a global caller is the shape that produced the
//! previous cross-project leak, so the surfaces are split at the transport: a different
//! endpoint, a different identity parameter, no shared `authorize()`.
//!
//! Transport mirrors fleet_mcp: hand-rolled MCP-over-HTTP (JSON-RPC 2.0, plain-JSON
//! replies) on its own `tiny_http` thread; the optional SSE GET is answered 405 so the
//! client falls back to POST, and `initialize` is idempotent (claude sends it twice).
//!
//! Task 3 lands the transport (`dispatch_tool`, `handle_request`, `start`) on top of
//! Task 2's declarative half, wired into `lib.rs`'s `setup` next to `fleet_mcp::start`.
//! `write_mcp_config`/`port` are called by `root_chat::root_chat_send`, which resolves the
//! generated config into root chat's own `claude -p` invocation on every spawn.
//!
//! `Ctx` and `handle_request` take an `EmitSink`, not an `AppHandle` -- same reasoning as
//! `cli_open::handle_open`'s sink parameter (see its module doc). `start` is the only
//! place a real `AppHandle` exists; it closes over one to build the sink and everything
//! downstream is plain data, which is what lets the tests below drive `dispatch_tool` and
//! `handle_request` directly (including over a real `tiny_http` socket) instead of only
//! the leaf helpers.
//!
//! Design: docs/superpowers/specs/2026-09-08-root-chat-orchestrator-design.md

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::fleet::FleetState;
use crate::proposals::{proposal_json, Outcome, Proposals};
use crate::pty::PtyManager;
use crate::store::{Session, Store};

/// How many bytes of recent output `session_peek` returns.
const PEEK_BYTES: usize = 8192;

/// The name the generated `--mcp-config` registers this server under. Claude Code
/// namespaces a server's tools as `mcp__<name>__<tool>`, so this string is also half of
/// the `--allowedTools` entry root chat needs; `TOOL_NAMESPACE` is the other half.
pub const SERVER_NAME: &str = "conduit-root";

/// What `root_chat::build_command` must add to `--allowedTools` whenever it passes
/// `--mcp-config`. Under Claude Code's default permission mode a `-p` run DENIES any MCP
/// tool that is not on the allow list -- the server is never reached at all and the
/// result carries `permission_denials`. Naming the SERVER (no `__<tool>` suffix) allows
/// all seven at once, so a new tool cannot ship unreachable.
pub const TOOL_NAMESPACE: &str = "mcp__conduit-root";

/// Forks one chat may create in the trailing minute. Every fork is itself a root chat, so
/// it is admitted by `known_chat` and handed its own `--mcp-config` -- including
/// `chat_fork`. Nothing else bounds that: `dispatch_work` has `MAX_PENDING_PER_CHAT` and
/// fleet has `under_cap` + `spawn_rate_ok`, but a seeded fork auto-sends, which spawns a
/// real `claude -p` child. Same mechanism and same reasoning as
/// `fleet::MAX_SPAWNS_PER_MINUTE_PER_CONDUCTOR`: bound the single-turn fan-out burst.
pub const MAX_FORKS_PER_MINUTE_PER_CHAT: usize = 2;

/// Rolling fork window per chat id. A module static rather than another `Ctx` field
/// because it is pure rate state with no owner: `start` would only be threading it
/// through to here. `fork_rate_ok_with` keeps the limit and window injectable so the test
/// does not sleep for a minute.
static FORK_TIMESTAMPS: LazyLock<Mutex<HashMap<String, VecDeque<Instant>>>> =
    LazyLock::new(Default::default);

fn fork_rate_ok(chat_id: &str) -> bool {
    fork_rate_ok_with(
        chat_id,
        MAX_FORKS_PER_MINUTE_PER_CHAT,
        Duration::from_secs(60),
    )
}

fn fork_rate_ok_with(chat_id: &str, max: usize, window: Duration) -> bool {
    crate::fleet::rate_limited(&FORK_TIMESTAMPS, chat_id, max, window)
}

/// The wire form of every routable task kind (`TaskKind` serializes lowercase). One list
/// feeds both `dispatch_work`'s schema enum and its validation, so the two cannot drift:
/// the schema is advisory to the model, and only the check refuses a bogus value.
fn task_kind_ids() -> Vec<String> {
    crate::routing::task_kinds()
        .into_iter()
        .filter_map(|k| {
            serde_json::to_value(k.id)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
        })
        .collect()
}

/// The wire form of every agent id Conduit can actually spawn.
fn agent_ids() -> Vec<String> {
    crate::agent::all_adapters()
        .iter()
        .filter_map(|a| {
            serde_json::to_value(a.id())
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
        })
        .collect()
}

/// The live port, published once the server binds. 0 = not up, which makes
/// `write_mcp_config` decline and root chat degrade to its Phase 2 tool set.
static PORT: AtomicU16 = AtomicU16::new(0);

/// The bound port, read by `root_chat::root_chat_send` to resolve the per-chat
/// `--mcp-config` before every spawn.
pub fn port() -> u16 {
    PORT.load(Ordering::SeqCst)
}

pub fn mcp_config_json(port: u16, chat_id: &str) -> String {
    json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp?rootchat={chat_id}")
            }
        }
    })
    .to_string()
}

/// Write the per-chat mcp-config into Conduit's data dir; return its path.
///
/// `root_chat::root_chat_send` calls this before every spawn; a port of 0 (server never
/// bound) means `None`, no `--mcp-config` flag, and the chat degrades to its Phase 2 tool
/// set rather than a half-state that promises tools it cannot reach.
pub fn write_mcp_config(port: u16, chat_id: &str) -> Option<String> {
    if port == 0 {
        return None;
    }
    let path = crate::store::data_dir().join(format!("rootchat-mcp-{chat_id}.json"));
    std::fs::write(&path, mcp_config_json(port, chat_id)).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// May root chat read this session's output? Root chat is a CLOUD agent with no clearance
/// of its own, so under private mode it is treated as `Clearance::Public`: a siloed or
/// above-public session is never readable. Off private mode the regime is inert, exactly
/// like every other trust consumer.
pub(crate) fn peek_allowed(store: &Store, session: &Session) -> bool {
    if !store.is_private_mode() {
        return true;
    }
    // A default `Session` IS the cloud caller root chat is: `Clearance::Public`, and an id
    // no real session shares so the self-read arm never fires. Delegating rather than
    // open-coding the two conditions means a third one added to the read policy applies
    // here automatically -- this is a security gate, so drift is the failure mode that
    // matters.
    crate::store::can_read(&Session::default(), session)
}

pub fn result_envelope(id: Option<Value>, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

pub fn error_envelope(id: Option<Value>, code: i64, msg: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } }).to_string()
}

/// The seven root tools, as MCP tool specs.
pub fn tool_specs() -> Vec<Value> {
    // Derived from the routing table so a sixth task kind cannot ship unreachable.
    // `TaskKindInfo.id` is the `TaskKind` enum; serde renders it lowercase.
    let kinds = task_kind_ids();
    vec![
        json!({
            "name": "sessions_list",
            "description": "Every agent session across all projects (or one project's): status, agent, branch, project. Use this to answer 'what is running' or 'what needs me'.",
            "inputSchema": { "type": "object", "properties": {
                "projectId": { "type": "string", "description": "Optional: limit to one project." }
            }}
        }),
        json!({
            "name": "session_peek",
            "description": "Recent terminal output from one session. Refused for sessions the user has marked sensitive.",
            "inputSchema": { "type": "object", "properties": {
                "sessionId": { "type": "string" }
            }, "required": ["sessionId"] }
        }),
        json!({
            "name": "chats_list",
            "description": "The other HQ (root) chats: id, title, created time. Use before chat_read to find the conversation you need.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "chat_read",
            "description": "Read another HQ chat's conversation, oldest first. This is how you pull context from a discussion that happened in a different chat.",
            "inputSchema": { "type": "object", "properties": {
                "chatId": { "type": "string" },
                "limit": { "type": "integer", "description": "Most recent N items (default 100)." }
            }, "required": ["chatId"] }
        }),
        json!({
            "name": "dispatch_work",
            "description": "Propose starting a real coding session in a project. This does NOT start it: the user sees a card and approves. Returns a proposal id; check it later with dispatch_status.",
            "inputSchema": { "type": "object", "properties": {
                "projectId": { "type": "string" },
                "task": { "type": "string", "description": "The brief the session opens with. Write it as you would for a competent engineer with no context." },
                "kind": { "type": "string", "enum": kinds, "description": "Task shape; picks the agent through the user's routing preferences. Omit if you name an agent." },
                "agent": { "type": "string", "description": "Optional exact agent id, overriding routing." },
                "model": { "type": "string", "description": "Optional exact model id." }
            }, "required": ["projectId", "task"] }
        }),
        json!({
            "name": "dispatch_status",
            "description": "The outcome of a proposal you made earlier: pending, approved (with the session id), denied, or expired.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" }
            }, "required": ["id"] }
        }),
        json!({
            "name": "chat_fork",
            "description": "Create a new HQ chat, optionally sending it a first message. Use to split a distinct topic out of this conversation. Fork sparingly -- each chat is its own context.",
            "inputSchema": { "type": "object", "properties": {
                "title": { "type": "string" },
                "seed": { "type": "string", "description": "Optional first message; the new chat starts working on it immediately." }
            }, "required": ["title"] }
        }),
    ]
}

/// What a tool handler uses to notify the frontend of an event, decoupled from
/// `AppHandle` so `dispatch_tool`/`handle_request` are callable from a unit test without
/// Tauri or a real window. `start` is the only place a real `AppHandle` is available; it
/// closes over one and calls `app.emit`.
type EmitSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Everything a tool handler needs, resolved per request.
struct Ctx {
    emit: EmitSink,
    store: Arc<Store>,
    pty: Arc<PtyManager>,
    fleet: Arc<FleetState>,
    proposals: Arc<Proposals>,
    chat_id: String,
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let (_, qs) = url.split_once('?')?;
    qs.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

/// The identity gate: the caller must name a root chat this app actually has. Same shape
/// and same strength as `fleet_mcp`'s `?conductor=<id>` -- a soft scoping check, not a
/// hard security boundary: the id lives in `state.json`, readable by any agent session
/// running as the user, same as a conductor id. What it actually stops is an accidental
/// or wrong-shaped caller (a browser, a stray client, a copy-pasted URL) from reaching
/// the tool surface at all, not a co-resident process deliberately impersonating a chat.
fn known_chat(store: &Store, chat_id: &str) -> Result<(), String> {
    if chat_id.is_empty() {
        return Err("missing rootchat id".into());
    }
    store
        .list_root_chats()
        .iter()
        .any(|c| c.id == chat_id)
        .then_some(())
        .ok_or_else(|| "not-a-root-chat".to_string())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Split out of `dispatch_tool` so the recording rules are testable without a server or
/// an AppHandle. Returns the JSON the tool answers with.
fn dispatch_work_inner(
    store: &Store,
    proposals: &Proposals,
    chat_id: &str,
    args: &Value,
    now: u64,
) -> Result<String, String> {
    let project_id = args
        .get("projectId")
        .and_then(|v| v.as_str())
        .ok_or("missing projectId")?;
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .filter(|t| !t.trim().is_empty())
        .ok_or("missing task")?;
    if !store.list().iter().any(|p| p.id == project_id) {
        return Err(format!("unknown project {project_id}"));
    }
    let str_arg = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    // The schema's `enum` is advisory -- a model may send anything. An unrecognized kind
    // leaves `routes.effective[kind]` undefined on the frontend, so the card renders
    // permanently disabled with a misleading "no agent available" and the chat is never
    // told why. Refusing here is the recoverable error §6 asks for.
    let kind = str_arg("kind");
    if let Some(k) = &kind {
        let known = task_kind_ids();
        if !known.contains(k) {
            return Err(format!(
                "unknown kind {k}; expected one of {}",
                known.join(", ")
            ));
        }
    }
    // Same reasoning, one step worse: an agent id this build does not know is rendered to
    // the USER as a promise ("as gpt5-turbo (chosen by the chat)"), and `AgentId`'s
    // lenient Deserialize would turn it into Claude at approve time -- the card asserting
    // one agent while a different one spawns.
    let agent = str_arg("agent");
    if let Some(a) = &agent {
        if <crate::agent::AgentId as crate::store::PersistedEnum>::from_wire(a).is_none() {
            return Err(format!(
                "unknown agent {a}; expected one of {}",
                agent_ids().join(", ")
            ));
        }
    }
    let p = proposals.register(
        chat_id,
        project_id,
        task,
        kind,
        agent,
        str_arg("model"),
        now,
    )?;
    Ok(json!({
        "status": "awaiting-approval",
        "id": p.id,
        "note": "The user must approve this before anything starts. Check dispatch_status later; do not assume it ran."
    })
    .to_string())
}

fn dispatch_status_inner(proposals: &Proposals, args: &Value, now: u64) -> Result<String, String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("missing id")?;
    // `get` alone never expires anything -- only `register`/`pending` sweep. Without this,
    // a proposal answered by nobody stays "pending" forever and (worse) stays approvable
    // past the window `EXPIRY_SECS` exists to close.
    proposals.sweep(now);
    let p = proposals.get(id).ok_or("unknown proposal id")?;
    let body = match p.outcome {
        Outcome::Pending => json!({ "status": "pending" }),
        Outcome::Approved { session_id } => {
            json!({ "status": "approved", "sessionId": session_id })
        }
        Outcome::Denied { reason } => json!({ "status": "denied", "reason": reason }),
        Outcome::Expired => json!({ "status": "expired" }),
    };
    Ok(body.to_string())
}

fn dispatch_tool(name: &str, args: &Value, ctx: &Ctx) -> Result<String, String> {
    match name {
        "sessions_list" => {
            let only = args.get("projectId").and_then(|v| v.as_str());
            // An id that matches nothing must not answer `[]`: to the model that reads as
            // "nothing is running there", which is a wrong answer rather than a failed
            // one. Spec §6 wants an error string the chat can recover from -- the same
            // shape `dispatch_work` already uses.
            if let Some(id) = only {
                if !ctx.store.list().iter().any(|p| p.id == id) {
                    return Err(format!("unknown project {id}"));
                }
            }
            let status = ctx.fleet.snapshot();
            let mut out: Vec<Value> = Vec::new();
            for p in ctx.store.list() {
                if only.is_some_and(|id| id != p.id) {
                    continue;
                }
                for s in &p.sessions {
                    let st = status.get(&s.id).cloned().unwrap_or_default();
                    out.push(json!({
                        "id": s.id,
                        "name": s.name,
                        "project": p.name,
                        "projectId": p.id,
                        "agent": s.agent,
                        "role": s.role,
                        "status": st.status,
                        "activity": st.activity,
                        "branch": s.branch,
                        "hibernated": s.stopped,
                        "sensitive": !peek_allowed(&ctx.store, s),
                    }));
                }
            }
            Ok(json!(out).to_string())
        }
        "session_peek" => {
            let id = args
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or("missing sessionId")?;
            let session = ctx
                .store
                .list()
                .into_iter()
                .flat_map(|p| p.sessions)
                .find(|s| s.id == id)
                .ok_or("unknown session")?;
            if !peek_allowed(&ctx.store, &session) {
                return Err("access-denied: the user marked this session sensitive".into());
            }
            ctx.pty
                .recent_output(id, PEEK_BYTES)
                .ok_or_else(|| "session is not running".to_string())
        }
        "chats_list" => {
            let me = ctx.chat_id.clone();
            let list: Vec<Value> = ctx
                .store
                .list_root_chats()
                .into_iter()
                .filter(|c| c.id != me)
                .map(|c| json!({ "id": c.id, "title": c.title, "createdAt": c.created_at }))
                .collect();
            Ok(json!(list).to_string())
        }
        "chat_read" => {
            let id = args
                .get("chatId")
                .and_then(|v| v.as_str())
                .ok_or("missing chatId")?;
            if !ctx.store.list_root_chats().iter().any(|c| c.id == id) {
                return Err("unknown chat id".into());
            }
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as usize;
            let items = crate::root_chat::history_items(&ctx.store, id);
            let start = items.len().saturating_sub(limit);
            Ok(json!(&items[start..]).to_string())
        }
        "dispatch_work" => {
            let out =
                dispatch_work_inner(&ctx.store, &ctx.proposals, &ctx.chat_id, args, now_secs())?;
            // Tell the UI a card is waiting. Payload is self-contained so the card can
            // render without re-reading the chat.
            let parsed: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
            if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
                if let Some(p) = ctx.proposals.get(id) {
                    // ONE builder with `lib.rs`'s catch-up fetch (`list_pending_decisions`).
                    // Hand-built twice, the two drifted silently: a live card missing `kind`
                    // routes as "implementation" and one missing `agent` loses the chat's
                    // explicit choice, while the same card after a reload carries both.
                    (ctx.emit)("pending-decision", proposal_json(&ctx.store, &p));
                }
            }
            Ok(out)
        }
        "dispatch_status" => dispatch_status_inner(&ctx.proposals, args, now_secs()),
        "chat_fork" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|t| !t.trim().is_empty())
                .ok_or("missing title")?;
            // A fork is self-replicating: the new chat is a root chat, so it gets the same
            // tool surface including `chat_fork`, and a seeded one auto-sends -- a real
            // `claude -p` child per fork. The charter's "fork sparingly" is advice, not a
            // bound.
            if !fork_rate_ok(&ctx.chat_id) {
                return Err(format!(
                    "fork rate limit: at most {MAX_FORKS_PER_MINUTE_PER_CHAT} new chats per minute from one chat. Continue in this chat, or wait and try again."
                ));
            }
            let chat = ctx.store.add_root_chat();
            ctx.store.rename_root_chat(&chat.id, title);
            let seed = args.get("seed").and_then(|v| v.as_str()).unwrap_or("");
            // The desktop reconciles its sidebar from this event; without it the new chat
            // only appears on the next reload.
            (ctx.emit)(
                "root-chat-created",
                json!({ "id": chat.id, "title": title, "seed": seed }),
            );
            Ok(json!({ "id": chat.id, "title": title, "seeded": !seed.is_empty() }).to_string())
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn json_response(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header: Header = "Content-Type: application/json".parse().unwrap();
    Response::from_string(body).with_header(header)
}

/// Boot the root MCP server on the first free port in 8496..=8516 (clear of the hook
/// server's 8423..=8443, the mobile bridge's 8455..=8475 and the fleet server's
/// 8475..=8495).
pub fn start(
    app: AppHandle,
    store: Arc<Store>,
    pty: Arc<PtyManager>,
    fleet: Arc<FleetState>,
    proposals: Arc<Proposals>,
) {
    // The one place a real `AppHandle` exists; everything downstream gets a sink instead
    // (see the module doc and `EmitSink`).
    let emit: EmitSink = Arc::new(move |event, payload| {
        let _ = app.emit(event, payload);
    });
    thread::spawn(move || {
        let mut server: Option<Server> = None;
        for candidate in 8496u16..=8516 {
            if let Ok(s) = Server::http(("127.0.0.1", candidate)) {
                PORT.store(candidate, Ordering::SeqCst);
                server = Some(s);
                break;
            }
        }
        let Some(server) = server else {
            eprintln!("conduit: no free root MCP port in 8496..=8516");
            return;
        };
        for request in server.incoming_requests() {
            let emit = emit.clone();
            let store = store.clone();
            let pty = pty.clone();
            let fleet = fleet.clone();
            let proposals = proposals.clone();
            thread::spawn(move || handle_request(request, emit, store, pty, fleet, proposals));
        }
    });
}

fn handle_request(
    mut request: Request,
    emit: EmitSink,
    store: Arc<Store>,
    pty: Arc<PtyManager>,
    fleet: Arc<FleetState>,
    proposals: Arc<Proposals>,
) {
    // claude opens an optional SSE stream via GET; we never push, so 405 makes it fall
    // back to POST (same as fleet_mcp).
    if request.method() != &Method::Post {
        let allow: Header = "Allow: POST".parse().unwrap();
        let _ = request.respond(
            Response::from_string("")
                .with_status_code(405u16)
                .with_header(allow),
        );
        return;
    }

    let url = request.url().to_string();
    let chat_id = query_param(&url, "rootchat").unwrap_or_default();

    let mut body = String::new();
    let _ = request
        .as_reader()
        .take(1024 * 1024)
        .read_to_string(&mut body);
    let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");

    if method.starts_with("notifications/") {
        let _ = request.respond(Response::from_string("").with_status_code(202u16));
        return;
    }

    // The identity gate runs before anything but the handshake, so a stranger learns
    // nothing about what tools exist.
    if method != "initialize" {
        if let Err(e) = known_chat(&store, &chat_id) {
            let _ = request.respond(json_response(error_envelope(id, -32001, &e)));
            return;
        }
    }

    let reply = match method {
        "initialize" => {
            let ver = msg
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("2024-11-05");
            result_envelope(
                id,
                json!({
                    "protocolVersion": ver,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "conduit-root", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
        }
        "tools/list" => result_envelope(id, json!({ "tools": tool_specs() })),
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let ctx = Ctx {
                emit,
                store,
                pty,
                fleet,
                proposals,
                chat_id,
            };
            match dispatch_tool(name, &args, &ctx) {
                Ok(text) => result_envelope(
                    id,
                    json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
                ),
                Err(e) => result_envelope(
                    id,
                    json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                ),
            }
        }
        "" => error_envelope(id, -32600, "invalid request"),
        other => error_envelope(id, -32601, &format!("method not found: {other}")),
    };

    let _ = request.respond(json_response(reply));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Clearance, SessionTrust, Store};
    use std::sync::Mutex;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("conduit_rootmcp_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_points_at_the_root_endpoint_with_the_chat_id() {
        let cfg = mcp_config_json(8496, "chat-1");
        let v: Value = serde_json::from_str(&cfg).unwrap();
        let url = v["mcpServers"]["conduit-root"]["url"].as_str().unwrap();
        assert_eq!(url, "http://127.0.0.1:8496/mcp?rootchat=chat-1");
        assert_eq!(v["mcpServers"]["conduit-root"]["type"], "http");
    }

    /// `build_command` puts `TOOL_NAMESPACE` on `--allowedTools` while `mcp_config_json`
    /// registers the server under `SERVER_NAME`, and Claude derives one from the other
    /// (`mcp__<server>__<tool>`). Renaming the server without the namespace would allow a
    /// name nothing serves -- every call denied, with a config that still looks right.
    #[test]
    fn the_allowed_tools_namespace_is_the_registered_server_name() {
        assert_eq!(TOOL_NAMESPACE, format!("mcp__{SERVER_NAME}"));
        let v: Value = serde_json::from_str(&mcp_config_json(8496, "chat-1")).unwrap();
        assert!(
            v["mcpServers"].get(SERVER_NAME).is_some(),
            "the config must register the server the allow list names: {v}"
        );
    }

    #[test]
    fn tool_specs_are_exactly_the_seven_and_carry_schemas() {
        let names: Vec<String> = tool_specs()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            vec![
                "chat_fork",
                "chat_read",
                "chats_list",
                "dispatch_status",
                "dispatch_work",
                "session_peek",
                "sessions_list",
            ]
        );
        // No fleet tool may ever appear on the root surface.
        assert!(!names.iter().any(|n| n.starts_with("fleet_")));
        for t in tool_specs() {
            assert!(t["description"].is_string(), "{t} needs a description");
            assert_eq!(t["inputSchema"]["type"], "object", "{t} needs a schema");
        }
    }

    #[test]
    fn dispatch_work_schema_offers_the_five_task_kinds() {
        let spec = tool_specs()
            .into_iter()
            .find(|t| t["name"] == "dispatch_work")
            .unwrap();
        let kinds: Vec<&str> = spec["inputSchema"]["properties"]["kind"]["enum"]
            .as_array()
            .expect("kind is an enum")
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        // `TaskKindInfo.id` is the `TaskKind` ENUM, not a string — it serializes
        // lowercase, which is the wire form the schema must offer.
        for k in crate::routing::task_kinds() {
            let wire = serde_json::to_value(k.id).unwrap();
            let wire = wire.as_str().unwrap();
            assert!(
                kinds.contains(&wire),
                "{wire} is a routable kind but dispatch_work will not accept it"
            );
        }
    }

    #[test]
    fn peek_is_refused_for_a_siloed_session_only_under_private_mode() {
        let dir = temp_dir("peek");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Worker".into(),
                false,
                crate::agent::AgentId::Claude,
                crate::store::SessionRole::Worker,
            )
            .unwrap();
        store.set_session_trust(
            &s.id,
            SessionTrust {
                clearance: Clearance::Confidential,
                silo: true,
                ..Default::default()
            },
        );
        let siloed = store
            .list()
            .into_iter()
            .flat_map(|p| p.sessions)
            .find(|x| x.id == s.id)
            .unwrap();
        // Private mode off: the whole regime is inert, so peeking is allowed.
        assert!(peek_allowed(&store, &siloed));
        store.set_trust_settings(crate::store::TrustSettings { private_mode: true });
        // Private mode on: root chat is a cloud agent and must never receive silo output.
        assert!(!peek_allowed(&store, &siloed));
    }

    #[test]
    fn a_public_session_stays_peekable_under_private_mode() {
        let dir = temp_dir("peek_public");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Worker".into(),
                false,
                crate::agent::AgentId::Claude,
                crate::store::SessionRole::Worker,
            )
            .unwrap();
        store.set_trust_settings(crate::store::TrustSettings { private_mode: true });
        assert!(peek_allowed(&store, &s));
    }

    // The two tests below pin the `&&`, not just the two extremes: marking a session
    // sensitive sets `silo` without necessarily raising `clearance` (and vice versa), so
    // each half of the guard must independently block under private mode. A `||` in place
    // of the `&&` would pass both `peek_is_refused_for_a_siloed_session_only_under_private_mode`
    // and `a_public_session_stays_peekable_under_private_mode` above -- neither exercises a
    // session where exactly one of the two conditions is true.

    #[test]
    fn a_siloed_public_session_is_still_refused_under_private_mode() {
        let dir = temp_dir("peek_siloed_public");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Worker".into(),
                false,
                crate::agent::AgentId::Claude,
                crate::store::SessionRole::Worker,
            )
            .unwrap();
        // Silo set, clearance left at its default (Public) -- exactly what "mark sensitive"
        // does when the user doesn't also raise the clearance.
        store.set_session_trust(
            &s.id,
            SessionTrust {
                clearance: Clearance::Public,
                silo: true,
                ..Default::default()
            },
        );
        let siloed = store
            .list()
            .into_iter()
            .flat_map(|p| p.sessions)
            .find(|x| x.id == s.id)
            .unwrap();
        store.set_trust_settings(crate::store::TrustSettings { private_mode: true });
        assert!(!peek_allowed(&store, &siloed));
    }

    #[test]
    fn a_non_siloed_confidential_session_is_still_refused_under_private_mode() {
        let dir = temp_dir("peek_confidential_unsiloed");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Worker".into(),
                false,
                crate::agent::AgentId::Claude,
                crate::store::SessionRole::Worker,
            )
            .unwrap();
        // Clearance raised, silo left false -- not the asymmetric-silo case at all, but
        // still above Public and so still not root chat's to read.
        store.set_session_trust(
            &s.id,
            SessionTrust {
                clearance: Clearance::Confidential,
                silo: false,
                ..Default::default()
            },
        );
        let confidential = store
            .list()
            .into_iter()
            .flat_map(|p| p.sessions)
            .find(|x| x.id == s.id)
            .unwrap();
        store.set_trust_settings(crate::store::TrustSettings { private_mode: true });
        assert!(!peek_allowed(&store, &confidential));
    }

    #[test]
    fn query_param_extracts_the_chat_id() {
        assert_eq!(
            query_param("/mcp?rootchat=abc-123", "rootchat").as_deref(),
            Some("abc-123")
        );
        assert_eq!(query_param("/mcp", "rootchat"), None);
        assert_eq!(query_param("/mcp?other=1", "rootchat"), None);
    }

    #[test]
    fn an_unknown_chat_id_is_refused_before_any_tool_runs() {
        let dir = temp_dir("identity");
        let store = Store::for_test(&dir);
        // No root chats exist, so any caller id is a stranger.
        assert!(known_chat(&store, "nope").is_err());
        let chat = store.add_root_chat();
        assert!(known_chat(&store, &chat.id).is_ok());
    }

    #[test]
    fn dispatch_work_records_a_proposal_and_reports_its_status() {
        let dir = temp_dir("dispatch");
        let store = Arc::new(Store::for_test(&dir));
        let project = store.add_project("/repo".into());
        let chat = store.add_root_chat();
        let proposals = Arc::new(Proposals::default());

        let out = dispatch_work_inner(
            &store,
            &proposals,
            &chat.id,
            &json!({ "projectId": project.id, "task": "add rate limiting", "kind": "implementation" }),
            1_700_000_000,
        )
        .expect("records");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["status"], "awaiting-approval");
        let id = v["id"].as_str().unwrap().to_string();

        let status: Value = serde_json::from_str(
            &dispatch_status_inner(&proposals, &json!({ "id": id }), 1_700_000_000).unwrap(),
        )
        .unwrap();
        assert_eq!(status["status"], "pending");

        proposals.resolve(
            &id,
            Outcome::Approved {
                session_id: "s-1".into(),
            },
        );
        let status: Value = serde_json::from_str(
            &dispatch_status_inner(&proposals, &json!({ "id": id }), 1_700_000_000).unwrap(),
        )
        .unwrap();
        assert_eq!(status["status"], "approved");
        assert_eq!(status["sessionId"], "s-1");
    }

    /// `Proposals::get` alone never expires anything -- only `register`/`pending` sweep.
    /// Before this fix, `dispatch_status_inner` read straight off `get`, so a proposal
    /// nobody ever answered stayed "pending" forever, `Outcome::Expired` was unreachable
    /// from this path, and (worse) `resolve` still accepted an approval on a card whose
    /// window had long closed.
    #[test]
    fn dispatch_status_reports_expired_past_the_window_and_refuses_a_late_approval() {
        let dir = temp_dir("dispatch_expired");
        let store = Arc::new(Store::for_test(&dir));
        let project = store.add_project("/repo".into());
        let chat = store.add_root_chat();
        let proposals = Arc::new(Proposals::default());

        let out = dispatch_work_inner(
            &store,
            &proposals,
            &chat.id,
            &json!({ "projectId": project.id, "task": "x" }),
            1_700_000_000,
        )
        .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let later = 1_700_000_000 + crate::proposals::EXPIRY_SECS + 1;
        let status: Value = serde_json::from_str(
            &dispatch_status_inner(&proposals, &json!({ "id": id }), later).unwrap(),
        )
        .unwrap();
        assert_eq!(status["status"], "expired");

        // The read above is what marks it -- a resolve attempted after must still fail.
        assert!(!proposals.resolve(
            &id,
            Outcome::Approved {
                session_id: "too-late".into()
            }
        ));
    }

    /// The schema's `enum` is advisory -- nothing stops a model sending another string.
    /// A bogus kind used to be recorded verbatim, leaving `routes.effective[kind]`
    /// undefined so the card rendered permanently disabled ("no agent available") while
    /// the chat was told the proposal was awaiting approval.
    #[test]
    fn dispatch_work_refuses_a_kind_outside_the_routing_table() {
        let dir = temp_dir("dispatch_bad_kind");
        let store = Arc::new(Store::for_test(&dir));
        let project = store.add_project("/repo".into());
        let chat = store.add_root_chat();
        let proposals = Arc::new(Proposals::default());
        let err = dispatch_work_inner(
            &store,
            &proposals,
            &chat.id,
            &json!({ "projectId": project.id, "task": "x", "kind": "refactoring" }),
            1_700_000_000,
        )
        .unwrap_err();
        assert!(err.contains("unknown kind refactoring"), "{err}");
        // …and the error names the kinds that DO work, so the model can retry.
        assert!(err.contains("implementation"), "{err}");
        // Every real kind still records.
        for k in task_kind_ids() {
            assert!(
                dispatch_work_inner(
                    &store,
                    &proposals,
                    &chat.id,
                    &json!({ "projectId": project.id, "task": "x", "kind": k }),
                    1_700_000_000,
                )
                .is_ok(),
                "{k} is routable and must be accepted"
            );
        }
    }

    /// An agent id the chat invented reached the card as an enabled "Start it" button
    /// labelled "as gpt5-turbo (chosen by the chat)", and `AgentId`'s lenient Deserialize
    /// turned it into Claude at approve time -- the card asserting one agent while a
    /// different one spawned. Refuse it at the door so the model gets a recoverable error.
    #[test]
    fn dispatch_work_refuses_an_agent_this_build_cannot_spawn() {
        let dir = temp_dir("dispatch_bad_agent");
        let store = Arc::new(Store::for_test(&dir));
        let project = store.add_project("/repo".into());
        let chat = store.add_root_chat();
        let proposals = Arc::new(Proposals::default());
        let err = dispatch_work_inner(
            &store,
            &proposals,
            &chat.id,
            &json!({ "projectId": project.id, "task": "x", "agent": "gpt5-turbo" }),
            1_700_000_000,
        )
        .unwrap_err();
        assert!(err.contains("unknown agent gpt5-turbo"), "{err}");
        assert!(
            err.contains("claude"),
            "the error must list what works: {err}"
        );
        for a in agent_ids() {
            assert!(
                dispatch_work_inner(
                    &store,
                    &proposals,
                    &chat.id,
                    &json!({ "projectId": project.id, "task": "x", "agent": a }),
                    1_700_000_000,
                )
                .is_ok(),
                "{a} is a real agent and must be accepted"
            );
        }
    }

    #[test]
    fn dispatch_work_refuses_an_unknown_project() {
        let dir = temp_dir("dispatch_bad");
        let store = Arc::new(Store::for_test(&dir));
        let chat = store.add_root_chat();
        let proposals = Arc::new(Proposals::default());
        let err = dispatch_work_inner(
            &store,
            &proposals,
            &chat.id,
            &json!({ "projectId": "ghost", "task": "x" }),
            1_700_000_000,
        )
        .unwrap_err();
        assert!(err.contains("unknown project"), "{err}");
    }

    // ---- dispatch_tool / handle_request: previously untested (Ctx held an AppHandle,
    // unreachable from a unit test). An EmitSink makes both reachable directly.

    type EmitLog = Arc<Mutex<Vec<(String, Value)>>>;

    /// A sink that records every event it was asked to emit, so a test can assert on the
    /// payload instead of just "it didn't error".
    fn capturing_sink() -> (EmitSink, EmitLog) {
        let log: EmitLog = Arc::new(Mutex::new(Vec::new()));
        let log2 = log.clone();
        let emit: EmitSink = Arc::new(move |event: &str, payload: Value| {
            log2.lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((event.to_string(), payload));
        });
        (emit, log)
    }

    #[test]
    fn dispatch_tool_session_peek_refuses_a_siloed_session_under_private_mode() {
        let dir = temp_dir("dispatch_peek_denied");
        let store = Arc::new(Store::for_test(&dir));
        let p = store.add_project("/repo".into());
        let s = store
            .add_session(
                &p.id,
                "Worker".into(),
                false,
                crate::agent::AgentId::Claude,
                crate::store::SessionRole::Worker,
            )
            .unwrap();
        store.set_session_trust(
            &s.id,
            SessionTrust {
                silo: true,
                ..Default::default()
            },
        );
        store.set_trust_settings(crate::store::TrustSettings { private_mode: true });

        let (emit, _log) = capturing_sink();
        let ctx = Ctx {
            emit,
            store: store.clone(),
            pty: Arc::new(PtyManager::new()),
            fleet: Arc::new(FleetState::default()),
            proposals: Arc::new(Proposals::default()),
            chat_id: "chat-1".into(),
        };
        let err = dispatch_tool("session_peek", &json!({ "sessionId": s.id }), &ctx).unwrap_err();
        assert!(err.contains("access-denied"), "{err}");
    }

    #[test]
    fn dispatch_work_emits_a_pending_decision_the_frontend_can_render() {
        let dir = temp_dir("dispatch_emits");
        let store = Arc::new(Store::for_test(&dir));
        let project = store.add_project("/repo".into());
        let chat = store.add_root_chat();
        let (emit, log) = capturing_sink();
        let ctx = Ctx {
            emit,
            store: store.clone(),
            pty: Arc::new(PtyManager::new()),
            fleet: Arc::new(FleetState::default()),
            proposals: Arc::new(Proposals::default()),
            chat_id: chat.id.clone(),
        };

        let out = dispatch_tool(
            "dispatch_work",
            &json!({
                "projectId": project.id,
                "task": "add rate limiting",
                "kind": "review",
                "agent": "codex",
                "model": "o3",
            }),
            &ctx,
        )
        .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let events = log.lock().unwrap();
        assert_eq!(events.len(), 1, "{events:?}");
        let (name, payload) = &events[0];
        assert_eq!(name, "pending-decision");
        // ALL NINE keys, not the five this used to check. The routing fields were the
        // unpinned ones and they are the load-bearing ones: deleting `kind` silently
        // routes the card as "implementation" and deleting `agent` drops the chat's
        // explicit choice, while `list_pending_decisions` still carries both -- so the
        // live card and the same card after a reload would disagree.
        assert_eq!(payload["id"], id);
        assert_eq!(payload["chatId"], chat.id);
        assert_eq!(payload["projectId"], project.id);
        assert_eq!(payload["projectName"], project.name);
        assert_eq!(payload["task"], "add rate limiting");
        assert_eq!(payload["kind"], "review");
        assert_eq!(payload["agent"], "codex");
        assert_eq!(payload["model"], "o3");
        assert_eq!(
            payload["createdAt"],
            json!(ctx.proposals.get(&id).unwrap().created_at)
        );
        // Pins the COUNT too, so dropping one key while adding another cannot pass.
        assert_eq!(payload.as_object().map(|o| o.len()), Some(9), "{payload}");
    }

    /// The live emit and `lib.rs`'s catch-up fetch must be the same object: a card that
    /// renders one way live and another way after a reload is the drift this shares one
    /// builder to prevent.
    #[test]
    fn the_live_emit_is_byte_for_byte_the_catch_up_payload() {
        let dir = temp_dir("dispatch_same_payload");
        let store = Arc::new(Store::for_test(&dir));
        let project = store.add_project("/repo".into());
        let chat = store.add_root_chat();
        let (emit, log) = capturing_sink();
        let proposals = Arc::new(Proposals::default());
        let ctx = Ctx {
            emit,
            store: store.clone(),
            pty: Arc::new(PtyManager::new()),
            fleet: Arc::new(FleetState::default()),
            proposals: proposals.clone(),
            chat_id: chat.id.clone(),
        };
        dispatch_tool(
            "dispatch_work",
            &json!({ "projectId": project.id, "task": "t", "kind": "planning", "agent": "gemini" }),
            &ctx,
        )
        .unwrap();
        let live = log.lock().unwrap()[0].1.clone();
        let catch_up = proposal_json(&store, &proposals.pending(1_700_000_000)[0]);
        assert_eq!(live, catch_up);
    }

    #[test]
    fn sessions_list_refuses_an_unknown_project_instead_of_answering_empty() {
        let dir = temp_dir("sessions_list_bad_project");
        let store = Arc::new(Store::for_test(&dir));
        store.add_project("/repo".into());
        let (emit, _log) = capturing_sink();
        let ctx = Ctx {
            emit,
            store: store.clone(),
            pty: Arc::new(PtyManager::new()),
            fleet: Arc::new(FleetState::default()),
            proposals: Arc::new(Proposals::default()),
            chat_id: "chat-1".into(),
        };
        // `[]` would read to the model as "nothing is running in that project" — a wrong
        // answer rather than a failed one.
        let err =
            dispatch_tool("sessions_list", &json!({ "projectId": "ghost" }), &ctx).unwrap_err();
        assert!(err.contains("unknown project ghost"), "{err}");
        // No filter still lists everything, and a real id still works.
        assert!(dispatch_tool("sessions_list", &json!({}), &ctx).is_ok());
        let real = store.list()[0].id.clone();
        assert!(dispatch_tool("sessions_list", &json!({ "projectId": real }), &ctx).is_ok());
    }

    /// Every fork is itself a root chat with the full tool surface (including
    /// `chat_fork`), and a seeded one is auto-sent — a real `claude -p` child per fork.
    /// `dispatch_work` has `MAX_PENDING_PER_CHAT` and fleet has `spawn_rate_ok`; this had
    /// only the charter's "fork sparingly", which is advice, not a bound.
    #[test]
    fn chat_fork_is_capped_per_chat_per_minute() {
        let dir = temp_dir("chat_fork_cap");
        let store = Arc::new(Store::for_test(&dir));
        let chat = store.add_root_chat();
        let (emit, log) = capturing_sink();
        let ctx = Ctx {
            emit,
            store: store.clone(),
            pty: Arc::new(PtyManager::new()),
            fleet: Arc::new(FleetState::default()),
            proposals: Arc::new(Proposals::default()),
            chat_id: chat.id.clone(),
        };
        for i in 0..MAX_FORKS_PER_MINUTE_PER_CHAT {
            assert!(
                dispatch_tool("chat_fork", &json!({ "title": format!("t{i}") }), &ctx).is_ok(),
                "fork {i} is within the cap"
            );
        }
        let err =
            dispatch_tool("chat_fork", &json!({ "title": "one too many" }), &ctx).unwrap_err();
        assert!(err.contains("fork rate limit"), "{err}");
        // A refused fork must not half-happen: no chat created, no event emitted.
        assert_eq!(
            store.list_root_chats().len(),
            1 + MAX_FORKS_PER_MINUTE_PER_CHAT
        );
        assert_eq!(log.lock().unwrap().len(), MAX_FORKS_PER_MINUTE_PER_CHAT);
    }

    #[test]
    fn the_fork_budget_is_per_chat_and_rolls_off() {
        // Distinct keys from every other test's chat ids: the window is a module static.
        assert!(fork_rate_ok_with("fork-a", 1, Duration::from_millis(40)));
        assert!(!fork_rate_ok_with("fork-a", 1, Duration::from_millis(40)));
        // A different chat has its own budget…
        assert!(fork_rate_ok_with("fork-b", 1, Duration::from_millis(40)));
        // …and the window rolls off rather than latching.
        std::thread::sleep(Duration::from_millis(60));
        assert!(fork_rate_ok_with("fork-a", 1, Duration::from_millis(40)));
    }

    /// Serve `handle_request` on a real socket -- the only way to exercise the identity
    /// gate's ordering (it must run before dispatch but not before the handshake) rather
    /// than testing `known_chat` in isolation, which cannot see where in the request path
    /// it is actually called.
    fn serve_for_test(
        store: Arc<Store>,
        pty: Arc<PtyManager>,
        fleet: Arc<FleetState>,
        proposals: Arc<Proposals>,
        emit: EmitSink,
    ) -> u16 {
        let server = Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        thread::spawn(move || {
            for request in server.incoming_requests() {
                handle_request(
                    request,
                    emit.clone(),
                    store.clone(),
                    pty.clone(),
                    fleet.clone(),
                    proposals.clone(),
                );
            }
        });
        port
    }

    fn post(port: u16, query: &str, body: &str) -> Value {
        let url = format!("http://127.0.0.1:{port}/mcp{query}");
        let out = std::process::Command::new("curl")
            .args(["-s", "-X", "POST", "--data", body, &url])
            .output()
            .unwrap();
        serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
    }

    #[test]
    fn handle_request_lets_initialize_through_but_refuses_the_rest_for_an_unknown_chat() {
        let dir = temp_dir("handle_request_gate");
        let store = Arc::new(Store::for_test(&dir));
        // Deliberately no root chat registered -- "unknown-chat" is a stranger.
        let (emit, _log) = capturing_sink();
        let port = serve_for_test(
            store,
            Arc::new(PtyManager::new()),
            Arc::new(FleetState::default()),
            Arc::new(Proposals::default()),
            emit,
        );
        let q = "?rootchat=unknown-chat";

        let init = post(
            port,
            q,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        );
        assert!(init.get("error").is_none(), "{init}");
        assert_eq!(init["result"]["serverInfo"]["name"], "conduit-root");

        let list = post(
            port,
            q,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        );
        assert_eq!(list["error"]["code"], -32001, "{list}");

        let call = post(
            port,
            q,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sessions_list","arguments":{}}}"#,
        );
        assert_eq!(call["error"]["code"], -32001, "{call}");
    }
}
