//! In-app MCP server exposing fleet tools to the Conductor session.
//!
//! Transport: hand-rolled MCP-over-HTTP (JSON-RPC 2.0, plain-JSON responses) on its
//! own `tiny_http` server/thread, sibling to the hook server. Validated against
//! `claude` 2.1.186 (see the Task 0 spike): the client opens an optional SSE `GET`
//! that we answer 405 (it falls back to POST), and sends `initialize` twice
//! (handled idempotently). Each request is handled on its own thread so a slow tool
//! call (e.g. a 60s stop-confirm) never blocks the accept loop.
//!
//! Scoping: the Conductor's `--mcp-config` URL carries `?conductor=<id>`; every tool
//! call resolves the owning project from that id, so a Conductor only ever sees and
//! commands its own project's sessions.

use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::fleet::{self, FleetState};
use crate::pty::PtyManager;
use crate::store::{SessionRole, Store};

/// How many bytes of recent output `fleet_peek` returns.
const PEEK_BYTES: usize = 8192;

/// Everything a tool handler needs, resolved per request.
struct Ctx {
    app: AppHandle,
    store: Arc<Store>,
    pty: Arc<PtyManager>,
    fleet: Arc<FleetState>,
    conductor_id: String,
}

pub fn result_envelope(id: Option<Value>, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

pub fn error_envelope(id: Option<Value>, code: i64, msg: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } }).to_string()
}

/// The five fleet tools, as MCP tool specs (name/description/inputSchema).
pub fn tool_specs() -> Vec<Value> {
    vec![
        json!({
            "name": "fleet_list",
            "description": "List every session in this project with status, todos, and branch.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "fleet_peek",
            "description": "Return a worker's recent terminal output (ANSI-stripped).",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }),
        json!({
            "name": "fleet_spawn",
            "description": "Create a new worktree-isolated worker on its own branch and start it on `task`.",
            "inputSchema": { "type": "object",
                "properties": { "task": { "type": "string" }, "name": { "type": "string" } },
                "required": ["task"] }
        }),
        json!({
            "name": "fleet_send",
            "description": "Type text into a worker session (submitted with Enter).",
            "inputSchema": { "type": "object",
                "properties": { "id": { "type": "string" }, "text": { "type": "string" } },
                "required": ["id", "text"] }
        }),
        json!({
            "name": "fleet_stop",
            "description": "Stop a worker's running process. The human is asked to confirm first.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }),
    ]
}

fn role_str(r: SessionRole) -> &'static str {
    match r {
        SessionRole::Conductor => "conductor",
        SessionRole::Worker => "worker",
    }
}

/// Run one tool. Ok(text) becomes MCP text content; Err(text) becomes an isError result.
fn dispatch_tool(name: &str, args: &Value, ctx: &Ctx) -> Result<String, String> {
    match name {
        "fleet_list" => {
            let snap = ctx
                .store
                .fleet_snapshot(&ctx.conductor_id)
                .ok_or("conductor-not-found")?;
            let status = ctx.fleet.snapshot();
            let list: Vec<Value> = snap
                .sessions
                .iter()
                .map(|s| {
                    let st = status.get(&s.id).cloned().unwrap_or_default();
                    json!({
                        "id": s.id,
                        "name": s.name,
                        "role": role_str(s.role),
                        "branch": s.branch,
                        "worktree": s.worktree_path.is_some(),
                        "status": st.status,
                        "activity": st.activity,
                        "todosTotal": st.todos_total,
                        "todosDone": st.todos_done,
                        "updatedAt": st.updated_at,
                    })
                })
                .collect();
            Ok(json!(list).to_string())
        }
        "fleet_peek" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("missing id")?;
            ctx.pty
                .recent_output(id, PEEK_BYTES)
                .ok_or_else(|| "worker-not-running".to_string())
        }
        "fleet_spawn" => {
            let task = args
                .get("task")
                .and_then(|v| v.as_str())
                .ok_or("missing task")?;
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Worker")
                .to_string();
            let snap = ctx
                .store
                .fleet_snapshot(&ctx.conductor_id)
                .ok_or("conductor-not-found")?;
            if crate::git::current_branch(&snap.project_path).is_none() {
                return Err("not-a-git-repo".into());
            }
            if !fleet::under_cap(fleet::worker_count(&snap.sessions)) {
                return Err("worker-cap-reached".into());
            }
            let session = ctx
                .store
                .add_session(
                    &snap.project_id,
                    name,
                    true, // always worktree-isolated
                    crate::agent::AgentId::Claude,
                    SessionRole::Worker,
                )
                .ok_or("spawn-failed")?;
            // The frontend opens the tab (which spawns the PTY) and injects `task`
            // as the worker's initial prompt — Rust can't mint a terminal Channel.
            let _ = ctx.app.emit(
                "fleet-spawn",
                json!({ "projectId": snap.project_id, "session": session, "task": task }),
            );
            Ok(json!({
                "id": session.id,
                "name": session.name,
                "branch": session.branch,
                "worktreePath": session.worktree_path,
            })
            .to_string())
        }
        "fleet_send" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("missing id")?;
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or("missing text")?;
            if id == ctx.conductor_id {
                return Err("cannot-target-self".into());
            }
            // Trailing CR submits the prompt, as if typed by a human.
            ctx.pty
                .write(id, &format!("{text}\r"))
                .map_err(|_| "worker-not-running".to_string())?;
            Ok("sent".into())
        }
        "fleet_stop" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("missing id")?;
            if id == ctx.conductor_id {
                return Err("cannot-target-self".into());
            }
            let snap = ctx
                .store
                .fleet_snapshot(&ctx.conductor_id)
                .ok_or("conductor-not-found")?;
            let sess = snap
                .sessions
                .iter()
                .find(|s| s.id == id)
                .ok_or("session-not-found")?;
            let branch = sess.branch.clone().unwrap_or_default();
            let dirty = sess
                .worktree_path
                .as_deref()
                .map(crate::worktree::is_dirty)
                .unwrap_or(false);
            let approved = fleet::request_stop_confirmation(
                &ctx.app, &ctx.fleet, id, &sess.name, &branch, dirty,
            );
            if !approved {
                return Ok("cancelled".into());
            }
            ctx.pty.kill(id);
            ctx.pty.kill(&format!("{id}::term"));
            Ok("stopped".into())
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

fn query_param(url: &str, key: &str) -> Option<String> {
    url.split('?').nth(1)?.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        match (it.next(), it.next()) {
            (Some(k), Some(v)) if k == key => Some(v.to_string()),
            _ => None,
        }
    })
}

fn json_response(body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header: Header = "Content-Type: application/json".parse().unwrap();
    Response::from_string(body).with_header(header)
}

/// Boot the fleet MCP server on the first free port in 8475..=8495 (clear of the
/// hook server's 8423..=8443 and Conduit's other in-use port 8455).
pub fn start(app: AppHandle, store: Arc<Store>, pty: Arc<PtyManager>, fleet: Arc<FleetState>) {
    thread::spawn(move || {
        let mut server: Option<Server> = None;
        for candidate in 8475u16..=8495 {
            if let Ok(s) = Server::http(("127.0.0.1", candidate)) {
                fleet.mcp_port.store(candidate, Ordering::SeqCst);
                server = Some(s);
                break;
            }
        }
        let Some(server) = server else {
            eprintln!("conduit: no free fleet MCP port in 8475..=8495");
            return;
        };

        for request in server.incoming_requests() {
            let app = app.clone();
            let store = store.clone();
            let pty = pty.clone();
            let fleet = fleet.clone();
            thread::spawn(move || handle_request(request, app, store, pty, fleet));
        }
    });
}

fn handle_request(
    mut request: Request,
    app: AppHandle,
    store: Arc<Store>,
    pty: Arc<PtyManager>,
    fleet: Arc<FleetState>,
) {
    // claude opens an optional SSE stream via GET; we don't push server->client, so
    // 405 makes it fall back to POST (validated in the Task 0 spike).
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
    let conductor_id = query_param(&url, "conductor").unwrap_or_default();

    let mut body = String::new();
    let _ = request
        .as_reader()
        .take(1024 * 1024)
        .read_to_string(&mut body);
    let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");

    // Notifications carry no id and expect no JSON-RPC body.
    if method.starts_with("notifications/") {
        let _ = request.respond(Response::from_string("").with_status_code(202u16));
        return;
    }

    let reply = match method {
        // Idempotent: claude sends initialize twice (probe + connect).
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
                    "serverInfo": { "name": "conduit-fleet", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
        }
        "tools/list" => result_envelope(id, json!({ "tools": tool_specs() })),
        "tools/call" => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let ctx = Ctx {
                app,
                store,
                pty,
                fleet,
                conductor_id,
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

    #[test]
    fn jsonrpc_result_envelope_shape() {
        let v: Value =
            serde_json::from_str(&result_envelope(Some(json!(7)), json!({"ok": true}))).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["ok"], true);
    }

    #[test]
    fn tools_list_includes_all_five() {
        let names: Vec<String> = tool_specs()
            .into_iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        for n in [
            "fleet_list",
            "fleet_peek",
            "fleet_spawn",
            "fleet_send",
            "fleet_stop",
        ] {
            assert!(names.contains(&n.to_string()), "missing {n}");
        }
    }

    #[test]
    fn query_param_extracts_conductor() {
        assert_eq!(
            query_param("/mcp?conductor=abc-123", "conductor").as_deref(),
            Some("abc-123")
        );
        assert_eq!(query_param("/mcp", "conductor"), None);
    }
}
