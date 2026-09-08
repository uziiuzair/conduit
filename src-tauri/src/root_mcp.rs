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
//! **Not wired to a caller yet, deliberately.** This is Task 2 of the root-chat
//! orchestrator plan: `dispatch_tool` and `start` (the server loop) are Task 3, so several
//! of the imports below (transport + fleet/pty/proposals plumbing) have no caller in this
//! file yet. `#[allow(dead_code, unused_imports)]` is scoped to this file rather than left
//! as bare warnings, so it reads as an explicit "not yet" rather than an oversight (same
//! convention as `usage_tally.rs` and Task 1's `proposals.rs`).
//!
//! Design: docs/superpowers/specs/2026-09-08-root-chat-orchestrator-design.md
#![allow(dead_code, unused_imports)]

use std::io::Read;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::fleet::FleetState;
use crate::proposals::{Outcome, Proposals};
use crate::pty::PtyManager;
use crate::store::{Session, Store};

/// How many bytes of recent output `session_peek` returns.
const PEEK_BYTES: usize = 8192;

/// The live port, published once the server binds. 0 = not up, which makes
/// `write_mcp_config` decline and root chat degrade to its Phase 2 tool set.
static PORT: AtomicU16 = AtomicU16::new(0);

pub fn port() -> u16 {
    PORT.load(Ordering::SeqCst)
}

pub fn mcp_config_json(port: u16, chat_id: &str) -> String {
    json!({
        "mcpServers": {
            "conduit-root": {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/mcp?rootchat={chat_id}")
            }
        }
    })
    .to_string()
}

/// Write the per-chat mcp-config into Conduit's data dir; return its path.
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
    !session.silo && session.clearance == crate::store::Clearance::Public
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
    let kinds: Vec<String> = crate::routing::task_kinds()
        .into_iter()
        .filter_map(|k| {
            serde_json::to_value(k.id)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
        })
        .collect();
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
            "description": "The other HQ (root) chats: id, title, last activity. Use before chat_read to find the conversation you need.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "chat_read",
            "description": "Read another HQ chat's conversation, oldest first. This is how you pull context from a discussion that happened in a different chat.",
            "inputSchema": { "type": "object", "properties": {
                "chatId": { "type": "string" },
                "limit": { "type": "number", "description": "Most recent N items (default 100)." }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Clearance, SessionTrust, Store};

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
}
