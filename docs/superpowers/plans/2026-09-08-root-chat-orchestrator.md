# Root Chat Orchestrator (Phase 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give root chat a project-less MCP tool surface so it can see every session, read other HQ chats, fork chats, and propose real work into projects that the human approves with one tap.

**Architecture:** A second in-app MCP-over-HTTP server (`root_mcp.rs`) modelled on `fleet_mcp.rs` but keyed by `?rootchat=<chat-id>` instead of `?conductor=`, with its own tool list and no shared authorizer. Dispatch is non-blocking: `dispatch_work` records a proposal in a new `proposals.rs` registry and returns immediately; the human approves on a desktop card, the frontend resolves the agent via the existing TypeScript `pickTarget`, and a Tauri command performs `add_session` + emits `fleet-spawn` — the same path `bridge.rs`'s `spawn_reply` already uses.

**Tech Stack:** Rust (`tiny_http`, `serde_json`, Tauri v2 commands/events), React 19 + TypeScript + Zustand.

**Spec:** `docs/superpowers/specs/2026-09-08-root-chat-orchestrator-design.md`

## Global Constraints

- Conventional Commits, scoped (`feat(rootchat): …`); **never** add a `Co-Authored-By: Claude` or any AI-attribution trailer.
- Never push or merge to `main` without explicit human approval; work stays on `feat/root-orchestrator`.
- `cargo clippy -D warnings` is CI-enforced (macOS **and** Windows legs) — fix the lint, never weaken the gate.
- Rust tests colocated `#[cfg(test)]`; frontend tests colocated `src/foo.test.ts` (vitest, node env — never import `store.ts` or anything touching `localStorage`/xterm at module scope).
- Root chat's writable paths stay exactly scratchpad + shared memory. This feature adds **no** file-write capability.
- Dispatched sessions are always `SessionRole::Worker`. Never Conductor.
- Root MCP port range is **8496..=8516** (hooks 8423–8443, bridge 8455–8475, fleet 8475–8495 are taken).
- Time is always passed into `proposals.rs` as a `now: u64` parameter (unix seconds) — never read the clock inside it, so tests are deterministic.
- Dev-run only as `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`; if port 1420 is taken by another Tauri app, add `CONDUIT_DEV_PORT=1430` and `--config '{"build":{"devUrl":"http://localhost:1430"}}'`.
- Pre-PR checks: `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`, and with `--manifest-path src-tauri/Cargo.toml`: `cargo fmt --check`, `cargo clippy`, `cargo test`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/src/proposals.rs` (create) | The dispatch-proposal registry: register, get, pending, resolve, expire. Pure logic + a `Mutex`; no Tauri, no clock. |
| `src-tauri/src/root_mcp.rs` (create) | The root MCP server: transport, tool specs, tool dispatch, config-file writer. |
| `src-tauri/src/root_chat.rs` (modify) | Write the per-chat MCP config, pass `--mcp-config`, teach the charter about the tools. |
| `src-tauri/src/lib.rs` (modify) | `mod` declarations, `.manage(Proposals)`, start the server, and the approve/deny/list Tauri commands. |
| `src/rootProposals.ts` (create) | Pure frontend logic: the pending-decision list shape and its reducer. |
| `src/store.ts` (modify) | `pendingDecisions` state + actions calling the new commands. |
| `src/components/PendingDecisions.tsx` (create) | The approval card UI. |
| `src/App.tsx` (modify) | Listen for `pending-decision`; mount the card stack. |
| `src/theme.css` (modify) | Card styles. |

---

### Task 1: The proposal registry

**Files:**
- Create: `src-tauri/src/proposals.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod proposals;` in the alphabetical `mod` block near `mod pty;`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub const MAX_PENDING_PER_CHAT: usize = 10;`
  - `pub const EXPIRY_SECS: u64 = 86_400;`
  - `pub enum Outcome { Pending, Approved { session_id: String }, Denied { reason: Option<String> }, Expired }`
  - `pub struct Proposal { pub id: String, pub chat_id: String, pub project_id: String, pub task: String, pub kind: Option<String>, pub agent: Option<String>, pub model: Option<String>, pub created_at: u64, pub outcome: Outcome }`
  - `pub struct Proposals` (Default) with:
    - `pub fn register(&self, chat_id: &str, project_id: &str, task: &str, kind: Option<String>, agent: Option<String>, model: Option<String>, now: u64) -> Result<Proposal, String>`
    - `pub fn get(&self, id: &str) -> Option<Proposal>`
    - `pub fn pending(&self, now: u64) -> Vec<Proposal>`
    - `pub fn resolve(&self, id: &str, outcome: Outcome) -> bool`
    - `pub fn sweep(&self, now: u64)`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/proposals.rs` containing ONLY this test module for now (the code above it comes in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_700_000_000;

    fn reg(p: &Proposals, chat: &str, now: u64) -> Proposal {
        p.register(chat, "proj-1", "ship the thing", None, None, None, now)
            .expect("registers")
    }

    #[test]
    fn register_starts_pending_and_ids_are_unique() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        let b = reg(&p, "chat-1", T0);
        assert!(matches!(a.outcome, Outcome::Pending));
        assert_ne!(a.id, b.id);
        assert_eq!(p.get(&a.id).unwrap().task, "ship the thing");
        assert_eq!(p.pending(T0).len(), 2);
    }

    #[test]
    fn approve_records_the_session_and_first_responder_wins() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        assert!(p.resolve(
            &a.id,
            Outcome::Approved { session_id: "s-9".into() }
        ));
        match p.get(&a.id).unwrap().outcome {
            Outcome::Approved { session_id } => assert_eq!(session_id, "s-9"),
            other => panic!("expected approved, got {other:?}"),
        }
        // A second resolve must not overwrite the first answer.
        assert!(!p.resolve(&a.id, Outcome::Denied { reason: None }));
        assert!(matches!(
            p.get(&a.id).unwrap().outcome,
            Outcome::Approved { .. }
        ));
        // Resolved proposals leave the pending queue but stay readable.
        assert!(p.pending(T0).is_empty());
    }

    #[test]
    fn deny_keeps_the_reason() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        p.resolve(
            &a.id,
            Outcome::Denied { reason: Some("not now".into()) },
        );
        match p.get(&a.id).unwrap().outcome {
            Outcome::Denied { reason } => assert_eq!(reason.as_deref(), Some("not now")),
            other => panic!("expected denied, got {other:?}"),
        }
    }

    #[test]
    fn pending_expires_past_the_window_and_cannot_be_approved_after() {
        let p = Proposals::default();
        let a = reg(&p, "chat-1", T0);
        assert_eq!(p.pending(T0 + EXPIRY_SECS - 1).len(), 1);
        assert!(p.pending(T0 + EXPIRY_SECS + 1).is_empty());
        // Reading pending past the window is what marks it — the outcome sticks.
        assert!(matches!(p.get(&a.id).unwrap().outcome, Outcome::Expired));
        assert!(!p.resolve(
            &a.id,
            Outcome::Approved { session_id: "s-1".into() }
        ));
    }

    #[test]
    fn the_cap_is_per_chat_and_freed_by_resolving() {
        let p = Proposals::default();
        let mut ids = Vec::new();
        for _ in 0..MAX_PENDING_PER_CHAT {
            ids.push(reg(&p, "chat-1", T0).id);
        }
        // Chat 1 is full…
        let err = p
            .register("chat-1", "proj-1", "one more", None, None, None, T0)
            .unwrap_err();
        assert!(err.contains("too many"), "{err}");
        // …but another chat is unaffected, and resolving frees a slot.
        assert!(p
            .register("chat-2", "proj-1", "fine", None, None, None, T0)
            .is_ok());
        p.resolve(&ids[0], Outcome::Denied { reason: None });
        assert!(p
            .register("chat-1", "proj-1", "now ok", None, None, None, T0)
            .is_ok());
    }

    #[test]
    fn expired_proposals_free_cap_slots_too() {
        let p = Proposals::default();
        for _ in 0..MAX_PENDING_PER_CHAT {
            reg(&p, "chat-1", T0);
        }
        let later = T0 + EXPIRY_SECS + 1;
        assert!(
            p.register("chat-1", "proj-1", "after expiry", None, None, None, later)
                .is_ok(),
            "a full queue of expired proposals must not block forever"
        );
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml proposals::`
Expected: FAIL to compile — `Proposals`, `Outcome`, `Proposal` not found. (Add `mod proposals;` to `lib.rs` in this step so the failure is about the types, not a missing module.)

- [ ] **Step 3: Implement**

Put this ABOVE the test module in `src-tauri/src/proposals.rs`:

```rust
//! Dispatch proposals: work root chat wants to start, waiting on a human decision.
//!
//! Deliberately NOT `broker.rs`. That registry hands its caller a receiver to block on
//! and forgets the entry the moment it is answered -- right for a 45s tool-approval hook.
//! A dispatch proposal is the opposite shape: the MCP call returns immediately, the human
//! may answer an hour later from a phone, and the outcome must still be readable
//! afterwards so a later chat turn can ask `dispatch_status`. One struct serving both
//! lifetimes would have to lie to one of them; the UI merges the two queues instead.
//!
//! `now` is always a parameter -- never a clock read -- so expiry is testable.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Pending proposals one chat may hold at once. A confused loop queues ten cards, not
/// five hundred.
pub const MAX_PENDING_PER_CHAT: usize = 10;

/// How long an unanswered proposal stays actionable. An approval you never got to must
/// not spawn work next week.
pub const EXPIRY_SECS: u64 = 86_400;

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Pending,
    Approved { session_id: String },
    Denied { reason: Option<String> },
    Expired,
}

#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: String,
    pub chat_id: String,
    pub project_id: String,
    pub task: String,
    /// Task kind for routing (planning|implementation|review|research|bulk). The concrete
    /// agent is resolved at APPROVE time by the frontend's `pickTarget`, which is the only
    /// place that knows which accounts still have quota.
    pub kind: Option<String>,
    /// An explicit agent the chat named, overriding routing.
    pub agent: Option<String>,
    pub model: Option<String>,
    pub created_at: u64,
    pub outcome: Outcome,
}

#[derive(Default)]
pub struct Proposals {
    inner: Mutex<Vec<Proposal>>,
    seq: AtomicU64,
}

impl Proposals {
    pub fn register(
        &self,
        chat_id: &str,
        project_id: &str,
        task: &str,
        kind: Option<String>,
        agent: Option<String>,
        model: Option<String>,
        now: u64,
    ) -> Result<Proposal, String> {
        self.sweep(now);
        let mut list = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let open = list
            .iter()
            .filter(|p| p.chat_id == chat_id && p.outcome == Outcome::Pending)
            .count();
        if open >= MAX_PENDING_PER_CHAT {
            return Err(format!(
                "too many pending proposals for this chat ({open}); resolve some first"
            ));
        }
        let proposal = Proposal {
            id: format!("dp-{}", self.seq.fetch_add(1, Ordering::SeqCst)),
            chat_id: chat_id.to_string(),
            project_id: project_id.to_string(),
            task: task.to_string(),
            kind,
            agent,
            model,
            created_at: now,
            outcome: Outcome::Pending,
        };
        list.push(proposal.clone());
        Ok(proposal)
    }

    pub fn get(&self, id: &str) -> Option<Proposal> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// Still-actionable proposals. Sweeps first, so reading the queue is also what
    /// retires anything past the window.
    pub fn pending(&self, now: u64) -> Vec<Proposal> {
        self.sweep(now);
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|p| p.outcome == Outcome::Pending)
            .cloned()
            .collect()
    }

    /// Record an answer. Returns false if the proposal is unknown or already answered --
    /// first responder wins, so a desktop card and a phone racing cannot double-spawn.
    pub fn resolve(&self, id: &str, outcome: Outcome) -> bool {
        let mut list = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match list.iter_mut().find(|p| p.id == id) {
            Some(p) if p.outcome == Outcome::Pending => {
                p.outcome = outcome;
                true
            }
            _ => false,
        }
    }

    pub fn sweep(&self, now: u64) {
        let mut list = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for p in list.iter_mut() {
            if p.outcome == Outcome::Pending && now.saturating_sub(p.created_at) > EXPIRY_SECS {
                p.outcome = Outcome::Expired;
            }
        }
    }
}
```

Note: `register` and `pending` both call `sweep`, which takes the same lock — so `sweep` must return before the lock is taken again. Written as above it does (each function's guard is dropped at the end of its statement/scope); do not inline `sweep`'s body while holding the outer guard.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml proposals::`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/proposals.rs src-tauri/src/lib.rs
git commit -m "feat(rootchat): dispatch-proposal registry with expiry and a per-chat cap"
```

---

### Task 2: Root MCP server — transport, identity, and the context tools

**Files:**
- Create: `src-tauri/src/root_mcp.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod root_mcp;`)

**Interfaces:**
- Consumes: `crate::store::Store` (`list_root_chats`, `list`, `root_chat_config_dir`, `is_private_mode`, `can_read`), `crate::fleet::FleetState::snapshot`, `crate::pty::PtyManager::recent_output`, `crate::transcript::parse_line`, `crate::proposals::Proposals`.
- Produces:
  - `pub fn tool_specs() -> Vec<serde_json::Value>`
  - `pub fn mcp_config_json(port: u16, chat_id: &str) -> String`
  - `pub fn write_mcp_config(port: u16, chat_id: &str) -> Option<String>`
  - `pub fn port() -> u16` (0 when the server has not booted)
  - `pub fn start(app: tauri::AppHandle, store: Arc<Store>, pty: Arc<PtyManager>, fleet: Arc<FleetState>, proposals: Arc<Proposals>)`
  - `pub(crate) fn peek_allowed(store: &Store, session: &crate::store::Session) -> bool`
  - internal `struct Ctx { app, store, pty, fleet, proposals, chat_id }` and `fn dispatch_tool(name: &str, args: &Value, ctx: &Ctx) -> Result<String, String>`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/root_mcp.rs` with ONLY this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Clearance, SessionTrust, Store};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("conduit_rootmcp_{tag}_{}", std::process::id()));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml root_mcp::`
Expected: FAIL to compile — `mcp_config_json`, `tool_specs`, `peek_allowed` not found. (Add `mod root_mcp;` to `lib.rs` in this step.)

If `Store::for_test`, `set_session_trust`, `set_trust_settings`, or `routing::task_kinds()` have different signatures than used above, adapt the test calls to the real ones — the assertions stay as written.

- [ ] **Step 3: Implement the module head, specs, config writer, and trust gate**

Put this ABOVE the test module:

```rust
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
//! Design: docs/superpowers/specs/2026-09-08-root-chat-orchestrator-design.md

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml root_mcp::`
Expected: PASS, 5 tests. (`dispatch_tool` and `start` do not exist yet — that is Task 3.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/root_mcp.rs src-tauri/src/lib.rs
git commit -m "feat(rootchat): root MCP tool specs, config writer, and the peek trust gate"
```

---

### Task 3: Root MCP tool dispatch and the server loop

**Files:**
- Modify: `src-tauri/src/root_mcp.rs` (add `Ctx`, `dispatch_tool`, `handle_request`, `start`, `query_param`)
- Modify: `src-tauri/src/lib.rs` (`.manage(Arc::new(proposals::Proposals::default()))`; call `root_mcp::start(...)` in `setup` next to `fleet_mcp::start`)

**Interfaces:**
- Consumes: everything from Task 1 and Task 2.
- Produces: a running server; `dispatch_tool` handling all seven names; `pending-decision` Tauri event with payload `{ id, chatId, projectId, projectName, task, kind, agent, model, createdAt }`.

- [ ] **Step 1: Write the failing tests**

Add to the test module in `src-tauri/src/root_mcp.rs`:

```rust
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

        let status: Value =
            serde_json::from_str(&dispatch_status_inner(&proposals, &json!({ "id": id })).unwrap())
                .unwrap();
        assert_eq!(status["status"], "pending");

        proposals.resolve(&id, Outcome::Approved { session_id: "s-1".into() });
        let status: Value =
            serde_json::from_str(&dispatch_status_inner(&proposals, &json!({ "id": id })).unwrap())
                .unwrap();
        assert_eq!(status["status"], "approved");
        assert_eq!(status["sessionId"], "s-1");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml root_mcp::`
Expected: FAIL — `query_param`, `known_chat`, `dispatch_work_inner`, `dispatch_status_inner` not found.

- [ ] **Step 3: Implement dispatch and the server**

Append to `src-tauri/src/root_mcp.rs` (above the tests):

```rust
/// Everything a tool handler needs, resolved per request.
struct Ctx {
    app: AppHandle,
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

/// The identity gate: the caller must name a root chat this app actually has. A project
/// session cannot reach these tools even if it learns the port.
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
    let str_arg = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    let p = proposals.register(
        chat_id,
        project_id,
        task,
        str_arg("kind"),
        str_arg("agent"),
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

fn dispatch_status_inner(proposals: &Proposals, args: &Value) -> Result<String, String> {
    let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
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
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(100) as usize;
            let items = crate::root_chat::history_items(&ctx.store, id);
            let start = items.len().saturating_sub(limit);
            Ok(json!(&items[start..]).to_string())
        }
        "dispatch_work" => {
            let out = dispatch_work_inner(
                &ctx.store,
                &ctx.proposals,
                &ctx.chat_id,
                args,
                now_secs(),
            )?;
            // Tell the UI a card is waiting. Payload is self-contained so the card can
            // render without re-reading the chat.
            let parsed: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
            if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
                if let Some(p) = ctx.proposals.get(id) {
                    let project_name = ctx
                        .store
                        .list()
                        .into_iter()
                        .find(|x| x.id == p.project_id)
                        .map(|x| x.name)
                        .unwrap_or_default();
                    let _ = ctx.app.emit(
                        "pending-decision",
                        json!({
                            "id": p.id,
                            "chatId": p.chat_id,
                            "projectId": p.project_id,
                            "projectName": project_name,
                            "task": p.task,
                            "kind": p.kind,
                            "agent": p.agent,
                            "model": p.model,
                            "createdAt": p.created_at,
                        }),
                    );
                }
            }
            Ok(out)
        }
        "dispatch_status" => dispatch_status_inner(&ctx.proposals, args),
        "chat_fork" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|t| !t.trim().is_empty())
                .ok_or("missing title")?;
            let chat = ctx.store.add_root_chat();
            ctx.store.rename_root_chat(&chat.id, title);
            let seed = args.get("seed").and_then(|v| v.as_str()).unwrap_or("");
            // The desktop reconciles its sidebar from this event; without it the new chat
            // only appears on the next reload.
            let _ = ctx.app.emit(
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
            let app = app.clone();
            let store = store.clone();
            let pty = pty.clone();
            let fleet = fleet.clone();
            let proposals = proposals.clone();
            thread::spawn(move || handle_request(request, app, store, pty, fleet, proposals));
        }
    });
}

fn handle_request(
    mut request: Request,
    app: AppHandle,
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
    let _ = request.as_reader().take(1024 * 1024).read_to_string(&mut body);
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
                app,
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
```

`chat_read` calls `crate::root_chat::history_items(&Store, chat_id) -> Vec<Value>`. That helper does not exist yet — extract it now from the existing `root_chat_history` Tauri command in `src-tauri/src/root_chat.rs` so both callers share one implementation:

```rust
/// Parse a chat's transcript into renderable items. Shared by the `root_chat_history`
/// command and root_mcp's `chat_read`, so the two can never drift.
pub fn history_items(store: &crate::store::Store, chat_id: &str) -> Vec<Value> {
    let projects = match store.root_chat_config_dir(chat_id) {
        Some(cfg) if !cfg.is_empty() => PathBuf::from(cfg).join("projects"),
        _ => match crate::pty::claude_projects_dir() {
            Some(d) => d,
            None => return Vec::new(),
        },
    };
    let Some(path) = crate::pty::transcript_path(chat_id, &projects) else {
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
```

and reduce the command to:

```rust
#[tauri::command]
pub fn root_chat_history(chat_id: String, store: State<Arc<crate::store::Store>>) -> Vec<Value> {
    history_items(&store, &chat_id)
}
```

- [ ] **Step 4: Wire it into `lib.rs`**

In `run()`, alongside the other `.manage(...)` calls:

```rust
.manage(Arc::new(proposals::Proposals::default()))
```

In `setup`, next to the existing `fleet_mcp::start(...)` call, take the proposals handle the same way the others are taken and start the server:

```rust
let proposals = app.state::<Arc<proposals::Proposals>>().inner().clone();
root_mcp::start(
    app.handle().clone(),
    store.clone(),
    pty.clone(),
    fleet.clone(),
    proposals.clone(),
);
```

- [ ] **Step 5: Run the tests and the lint**

Run: `cargo test --manifest-path src-tauri/Cargo.toml root_mcp::` → PASS (9 tests)
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml` → no warnings
Run: `cargo test --manifest-path src-tauri/Cargo.toml` → whole suite green

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/root_mcp.rs src-tauri/src/root_chat.rs src-tauri/src/lib.rs
git commit -m "feat(rootchat): root MCP tool dispatch and server loop"
```

---

### Task 4: Approve and deny — the Tauri commands that spawn

**Files:**
- Modify: `src-tauri/src/lib.rs` (three commands + registration in `generate_handler![]`)

**Interfaces:**
- Consumes: `proposals::{Proposals, Outcome}`, `Store::add_session`, the `fleet-spawn` event contract `{ projectId, session, task }` already consumed by `src/App.tsx`.
- Produces (frontend calls these):
  - `list_pending_decisions() -> Vec<serde_json::Value>` — same field set as the `pending-decision` event.
  - `approve_root_proposal(id: String, agent: String, model: Option<String>) -> Result<String, String>` — returns the new session id.
  - `deny_root_proposal(id: String, reason: Option<String>)`

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` at the bottom of `src-tauri/src/lib.rs`:

```rust
    /// The invariant that keeps root chat from escalating: a dispatched session is a
    /// WORKER. A Conductor would hold fleet's whole orchestration surface, which root
    /// chat is deliberately not given.
    #[test]
    fn dispatched_sessions_are_always_workers() {
        assert_eq!(DISPATCH_ROLE, store::SessionRole::Worker);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml dispatched_sessions`
Expected: FAIL — `DISPATCH_ROLE` not found.

- [ ] **Step 3: Implement the commands**

Add near the other root-chat commands in `src-tauri/src/lib.rs`:

```rust
// ---- Root chat dispatch proposals ----------------------------------------------

/// Root chat dispatches WORKERS, never Conductors: a Conductor would carry fleet's full
/// orchestration surface, which is exactly the boundary root chat is held to.
const DISPATCH_ROLE: store::SessionRole = store::SessionRole::Worker;

fn proposal_json(store: &Store, p: &proposals::Proposal) -> serde_json::Value {
    let project_name = store
        .list()
        .into_iter()
        .find(|x| x.id == p.project_id)
        .map(|x| x.name)
        .unwrap_or_default();
    serde_json::json!({
        "id": p.id,
        "chatId": p.chat_id,
        "projectId": p.project_id,
        "projectName": project_name,
        "task": p.task,
        "kind": p.kind,
        "agent": p.agent,
        "model": p.model,
        "createdAt": p.created_at,
    })
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
fn list_pending_decisions(
    store: State<Arc<Store>>,
    proposals: State<Arc<proposals::Proposals>>,
) -> Vec<serde_json::Value> {
    proposals
        .pending(unix_now())
        .iter()
        .map(|p| proposal_json(&store, p))
        .collect()
}

/// Approve a proposal: create the session and hand it to the frontend to mount.
///
/// `agent` is resolved by the CALLER (src/routing.ts `pickTarget`), because only the
/// frontend holds the live usage snapshot that says which account still has quota --
/// the same split CLAUDE.md pins between routing.rs and routing.ts.
#[tauri::command]
fn approve_root_proposal(
    app: tauri::AppHandle,
    id: String,
    agent: String,
    model: Option<String>,
    store: State<Arc<Store>>,
    proposals: State<Arc<proposals::Proposals>>,
) -> Result<String, String> {
    use tauri::Emitter;
    let p = proposals.get(&id).ok_or("unknown proposal")?;
    if p.outcome != proposals::Outcome::Pending {
        return Err("this proposal was already answered".into());
    }
    let agent_id: crate::agent::AgentId = serde_json::from_value(serde_json::json!(agent))
        .map_err(|_| format!("unknown agent {agent}"))?;
    let project = store
        .list()
        .into_iter()
        .find(|x| x.id == p.project_id)
        .ok_or("unknown project")?;
    let session = store
        .add_session(
            &project.id,
            "Dispatched".to_string(),
            true,
            agent_id,
            DISPATCH_ROLE,
        )
        .ok_or("could not create session")?;
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        store.set_session_model(&session.id, Some(m));
    }
    // Claim the proposal BEFORE emitting, so a phone answering at the same moment loses
    // the race cleanly instead of spawning a second session.
    if !proposals.resolve(
        &id,
        proposals::Outcome::Approved {
            session_id: session.id.clone(),
        },
    ) {
        return Err("this proposal was already answered".into());
    }
    // Rust cannot mint a terminal Channel, so the frontend completes the spawn -- the
    // same path bridge.rs's `spawn` verb uses.
    let _ = app.emit(
        "fleet-spawn",
        serde_json::json!({ "projectId": project.id, "session": session, "task": p.task }),
    );
    Ok(session.id)
}

#[tauri::command]
fn deny_root_proposal(
    id: String,
    reason: Option<String>,
    proposals: State<Arc<proposals::Proposals>>,
) {
    proposals.resolve(&id, proposals::Outcome::Denied { reason });
}
```

If `store.set_session_model` does not exist with that signature, use whatever the store exposes for pinning a session's model (the Command Code work added one — see CLAUDE.md's note that `fleet_spawn`'s exact model is applied via `store.set_session_model`, not `set_session_trust`).

Register all three in `generate_handler![]` next to the existing root-chat commands:

```rust
            list_pending_decisions,
            approve_root_proposal,
            deny_root_proposal,
```

- [ ] **Step 4: Run the test and the suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → PASS
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml` → clean

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(rootchat): approve/deny commands that spawn a dispatched worker"
```

---

### Task 5: Give root chat the tools — config file, flag, charter

**Files:**
- Modify: `src-tauri/src/root_chat.rs` (`root_chat_send` body; `build_command`; `build_charter`; tests)

**Interfaces:**
- Consumes: `root_mcp::{port, write_mcp_config}`.
- Produces: `build_command(chat_id, resume, charter, dirs, mcp_config: Option<&str>)` — one new parameter appended.

- [ ] **Step 1: Update the failing tests**

In `src-tauri/src/root_chat.rs`'s test module, update the two `build_command` tests to pass the new argument and assert the flag, and extend the charter test:

```rust
    #[test]
    fn command_includes_the_mcp_config_when_the_root_server_is_up() {
        let d = tdirs();
        let with = build_command("abc-123", false, "charter", &d, Some("/tmp/App Support/rootchat-mcp-abc.json"));
        assert!(with.contains("--mcp-config"), "{with}");
        assert!(with.contains("rootchat-mcp-abc.json"));
        assert!(with.contains("--strict-mcp-config"), "strict mode must survive");
        // No server: no flag, and the chat degrades to its Phase 2 tool set.
        let without = build_command("abc-123", false, "charter", &d, None);
        assert!(!without.contains("--mcp-config"));
        assert!(without.contains("--strict-mcp-config"));
    }

    #[test]
    fn charter_explains_the_orchestration_tools_only_when_they_exist() {
        let d = tdirs();
        let with = build_charter("/w", &[], &d, "", true);
        assert!(with.contains("dispatch_work"));
        assert!(with.contains("approve"), "the charter must say the user approves: {with}");
        let without = build_charter("/w", &[], &d, "", false);
        assert!(!without.contains("dispatch_work"));
    }
```

Also update every existing call of `build_command`/`build_charter` in the tests to the new arities.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml root_chat::`
Expected: FAIL — arity mismatch on `build_command` / `build_charter`.

- [ ] **Step 3: Implement**

In `build_command`, add the parameter and the flag:

```rust
pub fn build_command(
    chat_id: &str,
    resume: bool,
    charter: &str,
    dirs: &Dirs,
    mcp_config: Option<&str>,
) -> String {
    // …existing allow/deny/add/mode construction unchanged…
    // Orchestration tools ride a --mcp-config file naming the root MCP server. When the
    // server did not boot there is no flag at all, so --strict-mcp-config leaves the chat
    // with exactly its Phase 2 surface rather than a half-state that believes it can
    // dispatch.
    let mcp = mcp_config
        .map(|p| format!(" --mcp-config {}", crate::pty::quote_arg(p)))
        .unwrap_or_default();
    format!(
        "claude -p --output-format stream-json --verbose \
         --allowedTools {allow} \
         --disallowedTools {deny} \
         --add-dir {add}{mcp} \
         --strict-mcp-config \
         --append-system-prompt {sys} {mode}"
    )
}
```

In `build_charter`, add a trailing `has_tools: bool` parameter and this block, inserted before the `Workspace root:` line:

```rust
    let orchestration = if has_tools {
        "\n\nOrchestration: you can see and act across the whole workspace. \
         `sessions_list` and `session_peek` show what every agent session is doing; \
         `chats_list` and `chat_read` let you pull context out of your other HQ chats; \
         `chat_fork` starts a new HQ chat for a distinct topic. To get work built, call \
         `dispatch_work` with the project and a brief written for an engineer with no \
         context — this does NOT start anything: the user sees a card and approves it, \
         and you learn the outcome later from `dispatch_status`. Never claim work has \
         started until dispatch_status says approved.\n"
    } else {
        ""
    };
```

and interpolate `{orchestration}` into the format string.

In `root_chat_send`, resolve the config before building:

```rust
    let mcp_config = crate::root_mcp::write_mcp_config(crate::root_mcp::port(), &chat_id);
    let charter = build_charter(
        &cwd.to_string_lossy(),
        &roster,
        &dirs,
        &memory_index,
        mcp_config.is_some(),
    );
    let cmd = build_command(&chat_id, resume, &charter, &dirs, mcp_config.as_deref());
```

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml root_chat::` → PASS
Run: `cargo test --manifest-path src-tauri/Cargo.toml` → whole suite green

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/root_chat.rs
git commit -m "feat(rootchat): hand the chat its MCP config and teach the charter the tools"
```

---

### Task 6: Frontend pending-decision logic

**Files:**
- Create: `src/rootProposals.ts`
- Test: `src/rootProposals.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PendingDecision {
  id: string;
  chatId: string;
  projectId: string;
  projectName: string;
  task: string;
  kind?: string | null;
  agent?: string | null;
  model?: string | null;
  createdAt: number;
}
export function addDecision(list: PendingDecision[], d: PendingDecision): PendingDecision[];
export function removeDecision(list: PendingDecision[], id: string): PendingDecision[];
export function summarize(task: string, max?: number): string;
```

- [ ] **Step 1: Write the failing test**

Create `src/rootProposals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  addDecision,
  removeDecision,
  summarize,
  type PendingDecision,
} from "./rootProposals";

const d = (id: string, createdAt = 100): PendingDecision => ({
  id,
  chatId: "c1",
  projectId: "p1",
  projectName: "conduit",
  task: "add rate limiting",
  createdAt,
});

describe("addDecision", () => {
  it("appends, dedupes by id, and keeps newest first", () => {
    const one = addDecision([], d("a", 100));
    const two = addDecision(one, d("b", 200));
    expect(two.map((x) => x.id)).toEqual(["b", "a"]);
    // The same proposal arriving twice (event plus a catch-up list) must not double.
    expect(addDecision(two, d("b", 200)).map((x) => x.id)).toEqual(["b", "a"]);
    expect(one).toHaveLength(1); // no mutation
  });
});

describe("removeDecision", () => {
  it("drops one and leaves the rest", () => {
    const list = addDecision(addDecision([], d("a")), d("b"));
    expect(removeDecision(list, "a").map((x) => x.id)).toEqual(["b"]);
    expect(removeDecision(list, "ghost")).toHaveLength(2);
  });
});

describe("summarize", () => {
  it("keeps short tasks whole and clips long ones on a word", () => {
    expect(summarize("ship it")).toBe("ship it");
    const long = "word ".repeat(40).trim();
    const s = summarize(long, 40);
    expect(s.length).toBeLessThanOrEqual(41);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toContain("  ");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot find module `./rootProposals`.

- [ ] **Step 3: Implement**

Create `src/rootProposals.ts`:

```ts
// Pending decisions: work root chat proposed, waiting on the human. Shapes mirror the
// Rust `pending-decision` event and `list_pending_decisions` exactly — one payload,
// whether it arrived live or as a catch-up on mount.

export interface PendingDecision {
  id: string;
  chatId: string;
  projectId: string;
  projectName: string;
  task: string;
  kind?: string | null;
  agent?: string | null;
  model?: string | null;
  createdAt: number;
}

/** Newest first, deduped by id — the live event and the mount-time list overlap. */
export function addDecision(
  list: PendingDecision[],
  d: PendingDecision,
): PendingDecision[] {
  return [d, ...list.filter((x) => x.id !== d.id)];
}

export function removeDecision(list: PendingDecision[], id: string): PendingDecision[] {
  return list.filter((x) => x.id !== id);
}

/** One-line card title: the brief, clipped on a word boundary. */
export function summarize(task: string, max = 80): string {
  const flat = task.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/rootProposals.ts src/rootProposals.test.ts
git commit -m "feat(rootchat): pending-decision list logic"
```

---

### Task 7: Store slice, card UI, and app wiring

**Files:**
- Modify: `src/store.ts` (state + actions)
- Create: `src/components/PendingDecisions.tsx`
- Modify: `src/App.tsx` (event listeners + mount)
- Modify: `src/theme.css` (card styles)

**Interfaces:**
- Consumes: Task 6's `PendingDecision`/`addDecision`/`removeDecision`/`summarize`; Task 4's three commands; `pickTarget` from `src/routing.ts`.
- Produces: store fields `pendingDecisions: PendingDecision[]`, actions `loadPendingDecisions()`, `decisionArrived(d)`, `approveDecision(id, agent, model?)`, `denyDecision(id)`.

- [ ] **Step 1: Add the store slice**

In `src/store.ts`, import the helpers:

```ts
import {
  addDecision,
  removeDecision,
  type PendingDecision,
} from "./rootProposals";
```

Add to the state interface (next to the other root-chat fields):

```ts
  /** Work root chat proposed, waiting on your approval. Runtime-only; Rust owns it. */
  pendingDecisions: PendingDecision[];
  loadPendingDecisions: () => Promise<void>;
  decisionArrived: (d: PendingDecision) => void;
  approveDecision: (id: string, agent: string, model?: string) => Promise<void>;
  denyDecision: (id: string) => Promise<void>;
```

Initial state: `pendingDecisions: [],`

Actions:

```ts
    loadPendingDecisions: async () => {
      const list = await invoke<PendingDecision[]>("list_pending_decisions").catch(
        () => [] as PendingDecision[],
      );
      set({ pendingDecisions: list });
    },

    decisionArrived: (d) =>
      set((st) => ({ pendingDecisions: addDecision(st.pendingDecisions, d) })),

    approveDecision: async (id, agent, model) => {
      // Optimistic: the card goes as soon as you answer. A failure re-adds it below.
      const before = get().pendingDecisions.find((x) => x.id === id);
      set((st) => ({ pendingDecisions: removeDecision(st.pendingDecisions, id) }));
      try {
        await invoke("approve_root_proposal", { id, agent, model: model ?? null });
      } catch (e) {
        if (before) set((st) => ({ pendingDecisions: addDecision(st.pendingDecisions, before) }));
        get().pushToast?.(`Could not start that work: ${e}`);
      }
    },

    denyDecision: async (id) => {
      set((st) => ({ pendingDecisions: removeDecision(st.pendingDecisions, id) }));
      await invoke("deny_root_proposal", { id, reason: null }).catch(() => {});
    },
```

If the store's toast action is not named `pushToast`, use whatever the file already uses for surfacing an error toast.

- [ ] **Step 2: Build the card component**

Create `src/components/PendingDecisions.tsx`:

```tsx
import { useMemo } from "react";
import { useStore } from "../store";
import { summarize } from "../rootProposals";
import { pickTarget, type TaskKind } from "../routing";
import { agyRow, availabilityFrom, claudeRow, commandCodeRow } from "../usageRows";

/** Cards for work root chat wants to start. Rendered at the app root so an approval is
 *  reachable from anywhere, not only from the chat that asked. */
export function PendingDecisions() {
  const decisions = useStore((s) => s.pendingDecisions);
  const approve = useStore((s) => s.approveDecision);
  const deny = useStore((s) => s.denyDecision);
  const routes = useStore((s) => s.routes);
  const detected = useStore((s) => s.agents);
  const claudeUsage = useStore((s) => s.claudeUsage);
  const agyMap = useStore((s) => s.agyUsageByAccount);
  const commandCodeUsage = useStore((s) => s.commandCodeUsage);
  const lowThresholdPct = useStore((s) => s.usagePrefs.lowThresholdPct);

  // The exact account-health collapse NewSessionDialog uses, so a card can never decide
  // an agent is spent while its meter still reads green.
  const availability = useMemo(
    () =>
      availabilityFrom(detected, [
        ...claudeUsage.map(claudeRow),
        ...Object.values(agyMap).map(agyRow),
        ...commandCodeUsage.filter((u) => u.usage.windows?.length).map(commandCodeRow),
      ]),
    [detected, claudeUsage, agyMap, commandCodeUsage],
  );

  if (decisions.length === 0) return null;

  return (
    <div className="decision-stack">
      {decisions.map((d) => {
        // The chat may have named an agent; otherwise routing picks one HERE, because
        // only the frontend knows which accounts still have quota.
        const kind = (d.kind ?? "implementation") as TaskKind;
        const decision = routes
          ? pickTarget(
              routes.effective[kind],
              availability,
              Math.max(0, Math.min(1, lowThresholdPct / 100)),
            )
          : null;
        const routed = d.agent
          ? { agent: d.agent, model: d.model ?? undefined }
          : decision?.target
            ? { agent: decision.target.agent, model: decision.target.model }
            : null;
        const agent = routed?.agent ?? null;
        return (
          <div className="decision-card" key={d.id}>
            <div className="decision-head">
              Start work in <strong>{d.projectName}</strong>
            </div>
            <div className="decision-task">{summarize(d.task, 220)}</div>
            <div className="decision-meta">
              {agent ? (
                <>
                  as <strong>{agent}</strong>
                  {d.agent ? " (chosen by the chat)" : " (by your routing)"}
                </>
              ) : (
                <span className="decision-warn">
                  No agent available for this kind of work — install one or free up quota.
                </span>
              )}
            </div>
            <div className="decision-actions">
              <button onClick={() => void deny(d.id)}>Not now</button>
              <button
                className="primary"
                disabled={!agent}
                onClick={() => void approve(d.id, agent!, routed?.model)}
              >
                Start it
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

Two things to verify against the real files as you write this, because the card must not diverge from the dialog: `pickTarget(chain, availability, threshold)` returns a `RouteDecision` — confirm whether its chosen target is `.target` or another field name (`src/routing.ts:65,109`) and use the real one. And confirm the store field names for the usage inputs (`claudeUsage`, `agyUsageByAccount`, `commandCodeUsage`, `usagePrefs.lowThresholdPct`, `routes`, `agents`) against `src/components/NewSessionDialog.tsx:80-102`, which is the reference call site. Also ensure `loadRouting(null)` (global routes) has run — the dialog loads routes per project on mount; the card stack is app-level, so load the global table once in the same effect that loads pending decisions.

- [ ] **Step 3: Wire App.tsx**

Import and mount next to the other app-root overlays (`<Toasts />`, `<UpdateNotice />`):

```tsx
      <PendingDecisions />
```

Add a listener effect beside the root-chat ones:

```tsx
  // Work root chat proposed. Also loaded once on mount so a proposal made while the
  // window was closed is not lost.
  useEffect(() => {
    void useStore.getState().loadPendingDecisions();
    // Global routing table, so a card can name the agent it would use. The new-session
    // dialog loads this per project; the card stack is app-level, so it needs the
    // global one.
    void useStore.getState().loadRouting(null);
    const unPending = listen<PendingDecision>("pending-decision", ({ payload }) => {
      useStore.getState().decisionArrived(payload);
    });
    const unCreated = listen<{ id: string; title: string }>("root-chat-created", () => {
      void useStore.getState().loadRootChats();
    });
    return () => {
      void unPending.then((f) => f());
      void unCreated.then((f) => f());
    };
  }, []);
```

- [ ] **Step 4: Styles**

Append to `src/theme.css`, using the existing variables (`--panel-bg`, `--border`, `--accent`, `--text-bright`, `--text-mid`):

```css
/* Pending decisions — work root chat proposed, waiting on the human. */
.decision-stack {
  position: fixed; right: 16px; bottom: 16px; z-index: 60;
  display: flex; flex-direction: column; gap: 10px; max-width: 380px;
}
.decision-card {
  background: var(--panel-bg); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px 14px;
  box-shadow: 0 6px 24px -8px rgba(0, 0, 0, 0.5);
}
.decision-head { font-size: 13px; color: var(--text-bright); margin-bottom: 6px; }
.decision-task {
  font-size: 12.5px; line-height: 1.5; color: var(--text-mid);
  max-height: 8em; overflow-y: auto; margin-bottom: 8px;
}
.decision-meta { font-size: 11.5px; color: var(--text-mid); margin-bottom: 10px; }
.decision-warn { color: var(--amber); }
.decision-actions { display: flex; gap: 8px; justify-content: flex-end; }
.decision-actions button { padding: 5px 12px; border-radius: 7px; font-size: 12px; }
.decision-actions .primary { background: var(--accent); color: var(--panel-bg); }
.decision-actions .primary:disabled { opacity: 0.45; }
```

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc --noEmit && pnpm test && pnpm build`
Expected: all clean; `store.seam.test.ts` still passes untouched.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/components/PendingDecisions.tsx src/App.tsx src/theme.css
git commit -m "feat(rootchat): approval cards for dispatched work"
```

---

### Task 8: Docs, full gates, and manual verification

**Files:**
- Modify: `CLAUDE.md` (a new section after "Where the `conduit` CLI lives")

- [ ] **Step 1: Document the seam**

Add to `CLAUDE.md`:

```markdown
## Where root chat's orchestration lives

Root chat (HQ) reaches Conduit through a SECOND in-app MCP server, `root_mcp.rs`, on
`/mcp?rootchat=<chat-id>` (ports 8496..=8516). It is deliberately not part of
`fleet_mcp.rs`: every fleet tool is project-scoped by construction, root chat is global,
and teaching one authorizer both shapes is what produced the earlier cross-project leak.
The two surfaces share no `authorize()` — only the spawn path underneath.

- **Dispatch never spawns.** `dispatch_work` records a `proposals.rs` entry and returns;
  the human approves a card, and `approve_root_proposal` creates the session and emits
  `fleet-spawn` for the frontend to mount (Rust cannot mint a terminal Channel — the same
  wall `bridge.rs` hit). Dispatched sessions are ALWAYS `SessionRole::Worker`; a Conductor
  would hand root chat fleet's whole orchestration surface.
- **`proposals.rs` is not `broker.rs`.** The broker hands its caller a receiver to block
  on and forgets an answered entry (right for a 45 s approval hook). A proposal is
  non-blocking, lives 24 h, and must stay readable after the answer so `dispatch_status`
  can report it. The UI merges the two queues; the registries stay separate.
- **The agent is resolved at APPROVE time, in TypeScript.** `routing.rs` owns the
  preferences, `routing.ts`'s `pickTarget` owns which target has quota left. The proposal
  therefore stores the task KIND, never a resolved agent.
- **No root MCP server means no tools, not a half-state.** `write_mcp_config` returns
  `None` when the port is 0, `build_command` omits `--mcp-config`, and
  `--strict-mcp-config` leaves the chat with exactly its Phase 2 surface.
- Design: `docs/superpowers/specs/2026-09-08-root-chat-orchestrator-design.md`.
```

- [ ] **Step 2: Run every gate**

```bash
pnpm exec tsc --noEmit && pnpm test && pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all pass, zero clippy warnings.

- [ ] **Step 3: Manual verification**

Launch: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev` (add `CONDUIT_DEV_PORT=1430` and `--config '{"build":{"devUrl":"http://localhost:1430"}}'` if 1420 is taken).

- Ask an HQ chat "what's running across my projects?" → it calls `sessions_list` and answers with real sessions.
- Ask "what is <session> doing?" → `session_peek` returns output.
- In chat A, discuss something; in chat B ask "what did I decide in the <title> chat?" → `chats_list` + `chat_read` pull it.
- Ask "fork a chat for the pricing question and start it off" → a new HQ chat appears in the sidebar and begins working.
- Ask "get X built in conduit" → a card appears bottom-right naming the project, the brief, and the routed agent → **Start it** → the session appears and opens with the brief. Ask the chat again next turn → `dispatch_status` says approved.
- Repeat and press **Not now** → next turn `dispatch_status` says denied.
- Mark a session sensitive (Settings → Security private mode + right-click → mark sensitive) → ask root to peek it → refused.
- Quit and relaunch with a proposal outstanding → the card is back (loaded on mount).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(rootchat): record the orchestration seam"
```

---

### Task 9: Release (only when shipping)

**Files:** `package.json`, `src-tauri/Cargo.toml` (line 3), `src-tauri/tauri.conf.json`, `CHANGELOG.md`

A user-facing feature → MINOR bump. Current version is `0.35.0`, so this is **0.36.0** unless another release lands first — check the three files before writing.

- [ ] **Step 1:** Set `0.36.0` in all three files, then `cargo build --manifest-path src-tauri/Cargo.toml` once so `Cargo.lock` follows.
- [ ] **Step 2:** Add the changelog entry (newest first, no contributor names):

```markdown
## 0.36.0 — YYYY-MM-DD

- **Added — Root chat can run the workspace.** HQ chats can now see every session across
  every project, read your other HQ chats for context, fork a new chat for a topic, and
  propose real work into a project. Dispatch is never silent: you get a card naming the
  project, the brief and the agent it would use, and nothing starts until you approve it.
  Ask "what's running?" or "get this built in conduit" and it answers for the whole
  workspace instead of handing you a brief to carry yourself.
```

- [ ] **Step 3:** Sanity check and commit:

```bash
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore(release): 0.36.0"
```
