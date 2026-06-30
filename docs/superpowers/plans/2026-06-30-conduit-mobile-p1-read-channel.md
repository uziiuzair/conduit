# Conduit Mobile P1 — Read Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream a session's real projects/sessions, live hook status, and chat-transcript content over the existing loopback bridge, so the React Native app's Projects + Chat screens show live desktop data instead of mock data.

**Architecture:** Add a `HookBus` (in-process fan-out) that `hooks.rs` publishes every hook event to. `bridge.rs` takes the `AppHandle` (like `hooks.rs`), so each connection reaches managed `PtyManager` + `Store` + `HookBus` on demand. New server→client messages: `projects` (real tree + running flags), `status` (forwarded hook verb+body), and later `history`/`chat` (parsed transcript). This is **purely additive** — no change to the PTY, the permission flow, or desktop behavior.

**Tech Stack:** Rust (std mpsc, serde_json, tungstenite, tiny_http, dashmap), Tauri managed state.

**Scope:** This plan is the **read channel** only. The **approval broker** (blocking `PreToolUse`, concurrent hook server, desktop approval card) is a separate plan — `2026-06-30-conduit-mobile-p1-approval-broker.md` — gated by an interactive-mode verification spike (see Appendix). Build the read channel first; it de-risks the structured bridge protocol without touching the permission path.

---

## File Structure

- **Create** `src-tauri/src/hookbus.rs` — `HookBus` + `HookEvent`: subscribe/unsubscribe/publish with drop-oldest backpressure (mirrors `pty::broadcast`). One responsibility: fan hook events out to bridge subscribers.
- **Create** `src-tauri/src/transcript.rs` — locate `<id>.jsonl`, parse Claude transcript lines into `ChatItem`s, tail for appends. One responsibility: transcript → structured chat.
- **Modify** `src-tauri/src/hooks.rs` — publish each event to the `HookBus` (alongside the existing `app.emit`).
- **Modify** `src-tauri/src/bridge.rs` — take `AppHandle`; add `projects`, `status`, `history`, `chat` messages; subscribe to `HookBus`; stream transcript on attach.
- **Modify** `src-tauri/src/lib.rs` — `.manage(Arc::new(HookBus::default()))`; pass the bus to `hooks::start`; pass the `AppHandle` to `bridge::start`; declare `mod hookbus; mod transcript;`.
- **Modify** `mobile-app/src/data/*` + screens (P1c, after the Rust lands) — a `BridgeClient` replacing the mock; out of scope for the Rust tasks below but tracked at the end.

---

## Phase A — Hook event bus + forwarding + named projects

### Task 1: HookBus fan-out

**Files:**
- Create: `src-tauri/src/hookbus.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod hookbus;` near the other `mod` lines)

- [ ] **Step 1: Write the failing tests** (`src-tauri/src/hookbus.rs`, `#[cfg(test)]` module)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(session: &str) -> HookEvent {
        HookEvent { session: session.into(), event: "pretool".into(), body: json!({"tool_name":"Bash"}) }
    }

    #[test]
    fn subscriber_receives_published_event() {
        let bus = HookBus::default();
        let (_id, rx) = bus.subscribe();
        bus.publish(ev("s1"));
        let got = rx.recv().unwrap();
        assert_eq!(got.session, "s1");
        assert_eq!(got.event, "pretool");
    }

    #[test]
    fn unsubscribe_stops_delivery() {
        let bus = HookBus::default();
        let (id, rx) = bus.subscribe();
        bus.unsubscribe(id);
        bus.publish(ev("s1"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn disconnected_subscriber_is_pruned() {
        let bus = HookBus::default();
        let (_id, rx) = bus.subscribe();
        drop(rx);
        bus.publish(ev("s1")); // prunes
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn full_subscriber_drops_not_blocks() {
        let bus = HookBus::default();
        let (_id, rx) = bus.subscribe();
        for _ in 0..(BUS_BUFFER + 5) {
            bus.publish(ev("s1")); // must not block or panic
        }
        // buffer holds at most BUS_BUFFER; excess dropped
        let mut n = 0;
        while rx.try_recv().is_ok() { n += 1; }
        assert!(n <= BUS_BUFFER, "got {n}");
        drop(rx);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hookbus`
Expected: FAIL — `cannot find type HookBus` / module not declared.

- [ ] **Step 3: Write the implementation** (top of `src-tauri/src/hookbus.rs`)

```rust
//! In-process fan-out of Claude hook events to the mobile bridge. `hooks.rs`
//! publishes each event here; bridge connections subscribe to receive the live
//! status stream. Drop-oldest backpressure (a slow phone never stalls the hook
//! server), pruning disconnected receivers — mirrors `pty::broadcast`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Mutex;

/// Buffered hook events per subscriber before events start dropping.
const BUS_BUFFER: usize = 256;

/// One forwarded hook event: routed session, Conduit verb, and the raw body JSON.
#[derive(Clone, Debug)]
pub struct HookEvent {
    pub session: String,
    pub event: String,
    pub body: serde_json::Value,
}

#[derive(Default)]
pub struct HookBus {
    subscribers: Mutex<Vec<(u64, SyncSender<HookEvent>)>>,
    next_id: AtomicU64,
}

impl HookBus {
    /// Attach a subscriber. Returns its id (for `unsubscribe`) and the receiver.
    pub fn subscribe(&self) -> (u64, Receiver<HookEvent>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = sync_channel(BUS_BUFFER);
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.push((id, tx));
        }
        (id, rx)
    }

    pub fn unsubscribe(&self, id: u64) {
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.retain(|(i, _)| *i != id);
        }
    }

    /// Fan one event to every subscriber. A full buffer drops the event (never
    /// blocks the hook server); a hung-up receiver is pruned.
    pub fn publish(&self, ev: HookEvent) {
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.retain(|(_, tx)| match tx.try_send(ev.clone()) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => true,
                Err(TrySendError::Disconnected(_)) => false,
            });
        }
    }

    #[cfg(test)]
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.lock().map(|s| s.len()).unwrap_or(0)
    }
}
```

Then add to `src-tauri/src/lib.rs` (with the other `mod` declarations near the top):

```rust
mod hookbus;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hookbus`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hookbus.rs src-tauri/src/lib.rs
git commit -m "feat(bridge): HookBus fan-out for hook events"
```

---

### Task 2: hooks.rs publishes to the bus

**Files:**
- Modify: `src-tauri/src/hooks.rs` — `start` signature + publish in the request loop
- Modify: `src-tauri/src/lib.rs:427` — pass the bus to `hooks::start`

- [ ] **Step 1: Write the failing test** (append to `hooks.rs` test module)

```rust
#[test]
fn publishes_event_to_bus() {
    use crate::hookbus::HookBus;
    let bus = HookBus::default();
    let (_id, rx) = bus.subscribe();
    // forward_to_bus is the pure helper start() calls per request
    forward_to_bus(&bus, Some("s1".to_string()), "pretool".to_string(), serde_json::json!({"tool_name":"Bash"}));
    let got = rx.recv().unwrap();
    assert_eq!(got.session, "s1");
    assert_eq!(got.event, "pretool");
    assert_eq!(got.body["tool_name"], "Bash");
}

#[test]
fn forward_skips_when_no_session() {
    use crate::hookbus::HookBus;
    let bus = HookBus::default();
    let (_id, rx) = bus.subscribe();
    forward_to_bus(&bus, None, "stop".to_string(), serde_json::Value::Null);
    assert!(rx.try_recv().is_err());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks::`
Expected: FAIL — `cannot find function forward_to_bus`.

- [ ] **Step 3: Implement** — add the helper and call it in `start`, and thread the bus through.

In `src-tauri/src/hooks.rs`, add the import at the top:

```rust
use crate::hookbus::{HookBus, HookEvent};
```

Add the pure helper (above `start`):

```rust
/// Publish a parsed hook event onto the bus (no-op when unrouted).
fn forward_to_bus(bus: &HookBus, session: Option<String>, event: String, body: Value) {
    if let Some(session) = session {
        bus.publish(HookEvent { session, event, body });
    }
}
```

Change `start`'s signature and body. Replace the `pub fn start(app: AppHandle, state: Arc<HookState>) {` line with:

```rust
pub fn start(app: AppHandle, state: Arc<HookState>, bus: Arc<HookBus>) {
```

Inside the request loop, replace the existing emit block (the `let _ = app.emit("hook", json!({...}));`) with one that publishes to the bus too (note `parsed` is cloned for the emit, owned by the bus):

```rust
            forward_to_bus(&bus, session.clone(), event.clone(), parsed.clone());

            let _ = app.emit(
                "hook",
                json!({
                    "session": session,
                    "event": event,
                    "body": parsed,
                }),
            );
```

(Move the `let Some(session) = session else { continue };` guard to AFTER the `forward_to_bus`/emit? No — keep it: `forward_to_bus` already takes `Option`. Remove the early `let Some(session) = session else { continue };` and let `forward_to_bus` + emit handle `Option<String>`; the emit's `"session": session` accepts `Option`.) Concretely the block becomes:

```rust
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

            if std::env::var("CONDUIT_HOOK_LOG").as_deref() == Ok("1") {
                eprintln!("[hook] session={session:?} event={event} body={body}");
            }

            forward_to_bus(&bus, session.clone(), event.clone(), parsed.clone());

            let _ = app.emit(
                "hook",
                json!({ "session": session, "event": event, "body": parsed }),
            );
```

In `src-tauri/src/lib.rs` setup, change the `hooks::start(...)` call:

```rust
            let bus = app.state::<Arc<crate::hookbus::HookBus>>().inner().clone();
            hooks::start(app.handle().clone(), hook_state, bus);
```

and add (with the other `.manage(...)` lines):

```rust
        .manage(Arc::new(crate::hookbus::HookBus::default()))
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks::`
Expected: PASS (existing hooks tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hooks.rs src-tauri/src/lib.rs
git commit -m "feat(bridge): publish hook events to the HookBus"
```

---

### Task 3: bridge forwards status + real named projects

**Files:**
- Modify: `src-tauri/src/bridge.rs` — `start(AppHandle)`, `projects` + `status` messages, bus subscription
- Modify: `src-tauri/src/lib.rs:429` — `bridge::start(app.handle().clone())`

- [ ] **Step 1: Write the failing test** (append to `bridge.rs` test module) — pure builders, no socket needed.

```rust
#[test]
fn projects_message_marks_running_sessions() {
    use serde_json::json;
    // (project tree, set of running ids) -> the "projects" payload
    let projects = vec![json!({
        "id": "p1", "name": "Conduit", "path": "/repo",
        "sessions": [ {"id":"s1","name":"auth","branch":"feat/x","agent":"claude"} ]
    })];
    let running: std::collections::HashSet<String> = ["s1".to_string()].into_iter().collect();
    let msg = projects_payload(&projects, &running);
    assert_eq!(msg["type"], "projects");
    assert_eq!(msg["projects"][0]["sessions"][0]["running"], true);
}

#[test]
fn status_message_shape() {
    use serde_json::json;
    let msg = status_payload("pretool", &json!({"tool_name":"Bash"}));
    assert_eq!(msg["type"], "status");
    assert_eq!(msg["event"], "pretool");
    assert_eq!(msg["body"]["tool_name"], "Bash");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml bridge::`
Expected: FAIL — `cannot find function projects_payload`.

- [ ] **Step 3: Implement** the pure builders + wire them.

Add to `src-tauri/src/bridge.rs` (pure helpers, near `parse_client_msg`):

```rust
use std::collections::HashSet;

/// Build the `projects` payload: the persisted tree with a `running` flag per session.
fn projects_payload(projects: &[serde_json::Value], running: &HashSet<String>) -> serde_json::Value {
    let with_flags: Vec<serde_json::Value> = projects
        .iter()
        .map(|p| {
            let sessions: Vec<serde_json::Value> = p
                .get("sessions").and_then(|s| s.as_array()).cloned().unwrap_or_default()
                .into_iter()
                .map(|mut s| {
                    let id = s.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                    if let Some(obj) = s.as_object_mut() {
                        obj.insert("running".into(), serde_json::Value::Bool(running.contains(&id)));
                    }
                    s
                })
                .collect();
            let mut p = p.clone();
            if let Some(obj) = p.as_object_mut() {
                obj.insert("sessions".into(), serde_json::Value::Array(sessions));
            }
            p
        })
        .collect();
    json!({ "type": "projects", "projects": with_flags })
}

/// Build a forwarded hook-status frame.
fn status_payload(event: &str, body: &serde_json::Value) -> serde_json::Value {
    json!({ "type": "status", "event": event, "body": body })
}
```

Change `start` and `handle_conn` to take the `AppHandle`. Replace the `use crate::pty::PtyManager;` import with:

```rust
use tauri::{AppHandle, Manager};

use crate::hookbus::HookBus;
use crate::pty::PtyManager;
use crate::store::Store;
```

Replace `pub fn start(pty: Arc<PtyManager>, port_out: Arc<AtomicU16>) {` with:

```rust
pub fn start(app: AppHandle) {
    let port_out = Arc::new(AtomicU16::new(0));
    thread::spawn(move || {
```

Keep the bind loop, but in the accept loop replace `let pty = pty.clone();` / `handle_conn(stream, pty)` with `let app = app.clone();` / `handle_conn(stream, app)`.

In `handle_conn`, derive `pty` and subscribe to the bus at the top:

```rust
fn handle_conn(stream: TcpStream, app: AppHandle) {
    let Ok(mut ws) = accept(stream) else { return };
    if ws.get_ref().set_read_timeout(Some(READ_POLL)).is_err() {
        return;
    }
    let pty = app.state::<Arc<PtyManager>>().inner().clone();
    let bus = app.state::<Arc<HookBus>>().inner().clone();
    let (bus_id, bus_rx) = bus.subscribe();

    let mut attached: Option<(String, u64, std::sync::mpsc::Receiver<String>)> = None;
    // ... existing loop ...
```

Replace the `ClientMsg::List` arm to send the real tree (note: `serde_json::to_value(store.list())` serializes `Vec<Project>` via its camelCase Serialize):

```rust
                Some(ClientMsg::List) => {
                    let running: HashSet<String> = pty.session_ids().into_iter().collect();
                    let projects = serde_json::to_value(app.state::<Store>().list())
                        .ok()
                        .and_then(|v| v.as_array().cloned())
                        .unwrap_or_default();
                    let _ = ws.send(Message::Text(projects_payload(&projects, &running).to_string()));
                }
```

After the PTY-output drain block (step 2 in the loop), add a hook-status drain that forwards events for the attached session:

```rust
        // 3. Forward hook status events (filtered to the attached session).
        if let Some((sid, _, _)) = attached.as_ref() {
            for _ in 0..DRAIN_PER_TICK {
                match bus_rx.try_recv() {
                    Ok(ev) if &ev.session == sid => {
                        if ws.send(Message::Text(status_payload(&ev.event, &ev.body).to_string())).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {} // event for another session; ignore
                    Err(_) => break,
                }
            }
        } else {
            // not attached: drain-and-discard so the bus buffer can't back up
            while bus_rx.try_recv().is_ok() {}
        }
```

At the end of `handle_conn`, before/after `detach`, unsubscribe from the bus:

```rust
    bus.unsubscribe(bus_id);
    detach(&pty, &attached);
```

In `src-tauri/src/lib.rs` setup, replace the `bridge::start(...)` call with:

```rust
            bridge::start(app.handle().clone());
```

(remove the now-unused `let pty = app.state::<Arc<PtyManager>>()...` line that fed bridge, if it's only used there.)

- [ ] **Step 4: Run to verify it passes + full build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml bridge::`
Expected: PASS (existing parse tests + 2 new).
Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds clean (the `AppHandle` wiring compiles).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bridge.rs src-tauri/src/lib.rs
git commit -m "feat(bridge): forward hook status + real named projects to clients"
```

---

## Phase B — Transcript → chat content

### Task 4: transcript locate + parse

**Files:**
- Create: `src-tauri/src/transcript.rs`
- Modify: `src-tauri/src/pty.rs` — expose `transcript_path` (refactor of `transcript_exists`)
- Modify: `src-tauri/src/lib.rs` — `mod transcript;`

- [ ] **Step 1: Write failing tests** (`transcript.rs` test module). Claude transcript lines are objects like `{"type":"user","message":{"role":"user","content":"hi"}}` and `{"type":"assistant","message":{"content":[{"type":"text","text":"..."},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}` and `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}`. Parser maps each to zero or more `ChatItem`s.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_user_text_bubble() {
        let items = parse_line(&json!({"type":"user","message":{"role":"user","content":"add rate limiting"}}).to_string());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["text"], "add rate limiting");
    }

    #[test]
    fn parses_assistant_text_and_tool_use() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"On it."},
            {"type":"tool_use","name":"Bash","input":{"command":"npm test"}}
        ]}}).to_string();
        let items = parse_line(&line);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["role"], "assistant");
        assert_eq!(items[1]["kind"], "event");
        assert_eq!(items[1]["event"], "bash");
        assert_eq!(items[1]["mono"], "npm test");
    }

    #[test]
    fn skips_tool_result_and_meta_lines() {
        assert!(parse_line(&json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}).to_string()).is_empty());
        assert!(parse_line("not json").is_empty());
        assert!(parse_line(&json!({"type":"summary"}).to_string()).is_empty());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcript`
Expected: FAIL — module/`parse_line` missing.

- [ ] **Step 3: Implement** `src-tauri/src/transcript.rs`:

```rust
//! Parse Claude transcript JSONL (`<id>.jsonl`) into the bridge's chat items.
//! One line → zero or more items: user/assistant text → "bubble"; tool_use →
//! "event" (mapped to the same kinds the RN app renders); everything else skipped.

use serde_json::{json, Value};

/// Map a Claude tool name to the RN timeline event kind + verb (mirror of
/// mobile-app/src/logic/status.ts `eventKindFor`/labels).
fn tool_event(name: &str, input: &Value) -> Value {
    let (kind, label, mono) = match name {
        "Read" => ("read", "read", input.get("file_path").and_then(|v| v.as_str())),
        "Bash" => ("bash", "ran", input.get("command").and_then(|v| v.as_str())),
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => ("edit", "edited", input.get("file_path").and_then(|v| v.as_str())),
        "Grep" | "Glob" => ("search", "searched", input.get("pattern").and_then(|v| v.as_str())),
        "WebFetch" | "WebSearch" => ("web", "browsed", input.get("url").and_then(|v| v.as_str())),
        "Task" => ("subagent", "ran a subagent", None),
        _ => ("generic", "used a tool", None),
    };
    json!({ "kind": "event", "event": kind, "label": label, "mono": mono })
}

/// Parse one transcript line into chat items (possibly empty).
pub fn parse_line(line: &str) -> Vec<Value> {
    let Ok(v): Result<Value, _> = serde_json::from_str(line) else { return vec![] };
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let content = v.pointer("/message/content");
    let mut out = Vec::new();
    match kind {
        "user" => {
            // user content is either a plain string or an array (tool_result we skip)
            if let Some(text) = content.and_then(|c| c.as_str()) {
                out.push(json!({ "kind":"bubble", "role":"user", "text": text }));
            }
        }
        "assistant" => {
            if let Some(arr) = content.and_then(|c| c.as_array()) {
                for block in arr {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                if !t.trim().is_empty() {
                                    out.push(json!({ "kind":"bubble", "role":"assistant", "text": t }));
                                }
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let empty = json!({});
                            let input = block.get("input").unwrap_or(&empty);
                            out.push(tool_event(name, input));
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
    out
}
```

In `src-tauri/src/pty.rs`, add a path resolver next to `transcript_exists` (and make `claude_projects_dir` `pub(crate)`):

```rust
/// Path to `<session_id>.jsonl` under whichever project-slug dir holds it. None if absent.
pub(crate) fn transcript_path(session_id: &str, projects_dir: &Path) -> Option<PathBuf> {
    let file = format!("{session_id}.jsonl");
    fs::read_dir(projects_dir).ok()?.flatten().find_map(|entry| {
        let p = entry.path().join(&file);
        p.exists().then_some(p)
    })
}
```

Change `fn claude_projects_dir()` to `pub(crate) fn claude_projects_dir()`.

Add `mod transcript;` to `lib.rs`.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcript`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript.rs src-tauri/src/pty.rs src-tauri/src/lib.rs
git commit -m "feat(bridge): parse Claude transcript jsonl into chat items"
```

---

### Task 5: bridge streams history + tails chat

**Files:**
- Modify: `src-tauri/src/bridge.rs` — on attach, send `history`; poll the transcript for appends → `chat`

- [ ] **Step 1: Write the failing test** (bridge test module) — pure helper that turns a slice of parsed lines into a `history` payload.

```rust
#[test]
fn history_payload_flattens_items() {
    use serde_json::json;
    let lines = vec![
        json!({"type":"user","message":{"role":"user","content":"hi"}}).to_string(),
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"yo"}]}}).to_string(),
    ];
    let msg = history_payload(&lines);
    assert_eq!(msg["type"], "history");
    assert_eq!(msg["items"].as_array().unwrap().len(), 2);
    assert_eq!(msg["items"][0]["role"], "user");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml bridge::`
Expected: FAIL — `history_payload` missing.

- [ ] **Step 3: Implement** the helper + the attach/tail wiring.

Add to `bridge.rs`:

```rust
/// Build the transcript backfill payload from raw jsonl lines.
fn history_payload(lines: &[String]) -> serde_json::Value {
    let items: Vec<serde_json::Value> = lines.iter().flat_map(|l| crate::transcript::parse_line(l)).collect();
    json!({ "type": "history", "items": items })
}

/// Read a transcript file fully into trimmed non-empty lines. Empty on any error.
fn read_lines(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).map(|l| l.to_string()).collect())
        .unwrap_or_default()
}
```

In the `ClientMsg::Attach` arm, after the existing subscribe + size send, resolve and send history, and remember the transcript path + line count for tailing. Extend the `attached` tuple to carry an optional `(PathBuf, usize)` cursor, or add a parallel `let mut transcript: Option<(PathBuf, usize)> = None;` near `attached`:

```rust
                Some(ClientMsg::Attach { session_id }) => {
                    if let Some((sub_id, rx)) = pty.subscribe(&session_id) {
                        if let Some((cols, rows)) = pty.session_size(&session_id) {
                            let _ = ws.send(Message::Text(json!({ "type":"size", "cols":cols, "rows":rows }).to_string()));
                        }
                        // transcript backfill + start tailing
                        if let Some(dir) = crate::pty::claude_projects_dir() {
                            if let Some(path) = crate::pty::transcript_path(&session_id, &dir) {
                                let lines = read_lines(&path);
                                let _ = ws.send(Message::Text(history_payload(&lines).to_string()));
                                transcript = Some((path, lines.len()));
                            }
                        }
                        attached = Some((session_id, sub_id, rx));
                    } else {
                        let _ = ws.send(Message::Text(json!({ "type":"error", "message":"no such session" }).to_string()));
                    }
                }
```

Add a 4th drain step in the loop (after hook-status), tailing the transcript for new lines and sending `chat` items:

```rust
        // 4. Tail the transcript for appended lines -> chat items.
        if let Some((path, cursor)) = transcript.as_mut() {
            let lines = read_lines(path);
            if lines.len() > *cursor {
                for line in &lines[*cursor..] {
                    for item in crate::transcript::parse_line(line) {
                        let _ = ws.send(Message::Text(json!({ "type":"chat", "item": item }).to_string()));
                    }
                }
                *cursor = lines.len();
            }
        }
```

(Re-reading the whole file each tick is fine for a single attached transcript; optimize to byte-offset reads only if profiling shows it matters — YAGNI for now.)

- [ ] **Step 4: Run to verify it passes + build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml bridge::`
Expected: PASS.
Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bridge.rs
git commit -m "feat(bridge): stream transcript history + tail chat on attach"
```

---

## Phase C — RN BridgeClient (after the Rust lands)

Replace `mobile-app/src/data/mock.ts` consumers with a `BridgeClient` (WebSocket) that: sends `list`/`attach`, maps `projects`→Projects screen, `history`/`chat`→Chat feed, and runs the verb→status reducer (port of `src/App.tsx`) over `status` frames. Tracked as a follow-on; detail when the Rust read channel is verified over LAN.

---

## Appendix — Approval broker (separate plan, GATED)

The blocking `PreToolUse` broker is **not** in this plan. Before it can be designed task-by-task, run the **interactive-mode verification spike**: a real (non-`-p`) `claude` in a PTY with a blocking `PreToolUse` hook, confirming (a) the session pauses without garbling the TUI, (b) a returned `allow` suppresses the native prompt, (c) `deny` blocks with the reason shown. The headless prototype (2026-06-30 spec) proved fire/block/honor; this confirms the interactive specifics. Its result determines the broker design (always-broker vs opt-in, and whether the hook returns `ask` as a desktop fallback). Capture findings, then write `2026-06-30-conduit-mobile-p1-approval-broker.md`.

---

## Self-Review

- **Spec coverage:** read channel = spec §"Read channel" (transcript content + forwarded hook verbs) ✓; session list with names+status = Task 3 (names) + forwarded status (Task 2/3) ✓. Approval broker + desktop card = explicitly deferred to the gated plan ✓.
- **Placeholders:** none — every code step is complete.
- **Type consistency:** `HookEvent{session,event,body}` used identically in hookbus/hooks/bridge; `projects_payload`/`status_payload`/`history_payload` names consistent; `parse_line` returns `Vec<Value>` used by both `history_payload` and the tail loop.
- **Risk:** purely additive; desktop `app.emit("hook")` path unchanged; PTY untouched; no permission-flow changes.
