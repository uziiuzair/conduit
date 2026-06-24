# Conduit Mobile Bridge (M0 + M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one extra consumer (a future phone) watch a live `claude` session's PTY and type into it, proven via a loopback WebSocket and a browser tab — with the desktop terminal's behavior byte-for-byte unchanged.

**Architecture:** M0 evolves `pty.rs` from a single webview sink to a *primary webview sink + a fan-out list of bounded subscribers*; the reader thread broadcasts each base64 frame to all subscribers, dropping frames for a slow subscriber rather than blocking the desktop. M1 adds `bridge.rs`, a loopback WebSocket server that `subscribe()`s to a session for output and calls existing `pty.write/resize` for input. No pairing, tunnel, or mobile code yet — this de-risks live streaming first.

**Tech Stack:** Rust, `portable-pty`, `tungstenite` (sync WebSocket, thread-per-connection — matches the existing `tiny_http` style in `hooks.rs`), `serde`/`serde_json`, Tauri v2 managed state.

**Scope note:** This is the first of several plans for the mobile companion spec (`docs/superpowers/specs/2026-06-25-conduit-mobile-companion-design.md`). Follow-on plans cover M2 (frontend transport abstraction), M3 (Tauri mobile app), M4 (pairing/E2E), M5 (spawn-on-demand), M6 (APNs push).

---

## File Structure

- `src-tauri/src/pty.rs` *(modify)* — add a bounded-subscriber fan-out alongside the existing webview sink; add `broadcast`, `subscribe`, `unsubscribe`, `session_ids`.
- `src-tauri/src/bridge.rs` *(create)* — loopback WebSocket server: control-message parsing + per-connection attach/input/resize/list loop.
- `src-tauri/src/lib.rs` *(modify)* — manage `PtyManager` as `Arc<PtyManager>`, start the bridge in `setup`, update PTY command signatures.
- `src-tauri/Cargo.toml` *(modify)* — add `tungstenite`.

---

## Task 1: Fan-out broadcast helper (M0, pure)

**Files:**
- Modify: `src-tauri/src/pty.rs` (imports near `:16-25`; helper near the other free functions `:236+`; tests in the `#[cfg(test)] mod tests` block `:275+`)

- [ ] **Step 1: Add imports**

At the top of `pty.rs`, extend the std imports:

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
```

(The existing `use std::sync::{Arc, Mutex};` line is replaced by the three lines above.)

- [ ] **Step 2: Write the failing tests**

Add to the `mod tests` block in `pty.rs`:

```rust
#[test]
fn broadcast_delivers_same_frame_to_all() {
    let (tx1, rx1) = sync_channel(8);
    let (tx2, rx2) = sync_channel(8);
    let mut subs = vec![(1u64, tx1), (2u64, tx2)];
    broadcast(&mut subs, "QUJD"); // base64("ABC")
    assert_eq!(rx1.recv().unwrap(), "QUJD");
    assert_eq!(rx2.recv().unwrap(), "QUJD");
    assert_eq!(subs.len(), 2);
}

#[test]
fn broadcast_prunes_disconnected() {
    let (tx1, rx1) = sync_channel(8);
    let (tx2, rx2) = sync_channel(8);
    drop(rx2);
    let mut subs = vec![(1u64, tx1), (2u64, tx2)];
    broadcast(&mut subs, "Zg=="); // base64("f")
    assert_eq!(rx1.recv().unwrap(), "Zg==");
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].0, 1);
}

#[test]
fn broadcast_slow_subscriber_drops_frame_not_others() {
    let (tx_slow, _rx_slow) = sync_channel(1);
    tx_slow.try_send("queued".into()).unwrap(); // now full
    let (tx_fast, rx_fast) = sync_channel(8);
    let mut subs = vec![(1u64, tx_slow), (2u64, tx_fast)];
    broadcast(&mut subs, "next");
    assert_eq!(rx_fast.recv().unwrap(), "next"); // fast unaffected
    assert_eq!(subs.len(), 2); // full != disconnected → kept
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test broadcast`
Expected: FAIL — `cannot find function broadcast in this scope`.

- [ ] **Step 4: Implement `broadcast`**

Add as a free function in `pty.rs` (near `shell_quote`):

```rust
/// Per-subscriber buffered fan-out. Sends one base64 frame to every subscriber.
/// A subscriber whose bounded buffer is full has the frame DROPPED (slow consumer —
/// must never block the desktop webview); a subscriber whose receiver hung up is
/// pruned from the list. Mutates `subs` in place.
fn broadcast(subs: &mut Vec<(u64, SyncSender<String>)>, frame: &str) {
    subs.retain(|(_, tx)| match tx.try_send(frame.to_string()) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => true,
        Err(TrySendError::Disconnected(_)) => false,
    });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test broadcast`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "feat(pty): bounded-subscriber broadcast helper for session fan-out"
```

---

## Task 2: Wire subscribers into PtySession + the reader thread (M0)

**Files:**
- Modify: `src-tauri/src/pty.rs` (`Sink` typedef `:27`; `PtySession` struct `:29-34`; `spawn` insert block `:136-146`; reader thread `:151-183`; new methods after `resize` `:217`)

- [ ] **Step 1: Add the `Subscribers` type alias**

Below `type Sink = Arc<Mutex<Channel<String>>>;` add:

```rust
type Subscribers = Arc<Mutex<Vec<(u64, SyncSender<String>)>>>;

/// Bounded buffer (frames) per remote subscriber before frames start dropping.
const SUBSCRIBER_BUFFER: usize = 1024;
```

- [ ] **Step 2: Extend `PtySession`**

Replace the struct with:

```rust
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    sink: Sink,
    subscribers: Subscribers,
    next_sub_id: Arc<AtomicU64>,
}
```

- [ ] **Step 3: Create the subscriber list in `spawn` and hand a clone to the reader**

In `spawn`, just before `let sink: Sink = Arc::new(Mutex::new(on_event));`, add:

```rust
let subscribers: Subscribers = Arc::new(Mutex::new(Vec::new()));
let subs_for_reader = subscribers.clone();
```

Update the `self.sessions.insert(...)` `PtySession { ... }` to include the new fields:

```rust
self.sessions.insert(
    session_id.clone(),
    Mutex::new(PtySession {
        writer,
        master: pair.master,
        child,
        sink: sink.clone(),
        subscribers: subscribers.clone(),
        next_sub_id: Arc::new(AtomicU64::new(0)),
    }),
);
```

- [ ] **Step 4: Broadcast each frame (and the exit notice) to subscribers in the reader thread**

In the `thread::spawn(move || { ... })` reader loop, in the `Ok(n) => { ... }` arm, change the body so the subscribers get the frame before the webview send consumes `encoded`:

```rust
Ok(n) => {
    let encoded = engine.encode(&buf[..n]);
    if let Ok(mut subs) = subs_for_reader.lock() {
        broadcast(&mut subs, &encoded);
    }
    let ok = sink
        .lock()
        .map(|s| s.send(encoded).is_ok())
        .unwrap_or(false);
    if ok {
        consecutive_fails = 0;
    } else {
        consecutive_fails += 1;
        if consecutive_fails > 2000 {
            break;
        }
    }
}
```

And after the loop, broadcast the exit notice too:

```rust
let notice = "\r\n\u{1b}[90m[process exited]\u{1b}[0m\r\n";
let enc_notice = engine.encode(notice);
if let Ok(mut subs) = subs_for_reader.lock() {
    broadcast(&mut subs, &enc_notice);
}
if let Ok(s) = sink.lock() {
    let _ = s.send(enc_notice);
}
```

- [ ] **Step 5: Add `subscribe` / `unsubscribe` / `session_ids` methods**

Add inside `impl PtyManager`, after `resize`:

```rust
/// Attach an extra output consumer (a bridge connection) to a live session.
/// Returns a receiver of base64 frames plus an id to detach with, or None if the
/// session isn't running. Buffer is bounded — see `broadcast` for drop semantics.
pub fn subscribe(&self, session_id: &str) -> Option<(u64, Receiver<String>)> {
    let entry = self.sessions.get(session_id)?;
    let session = entry.lock().ok()?;
    let id = session.next_sub_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = sync_channel(SUBSCRIBER_BUFFER);
    session.subscribers.lock().ok()?.push((id, tx));
    Some((id, rx))
}

/// Detach a previously-subscribed consumer. No-op if the session or id is gone.
pub fn unsubscribe(&self, session_id: &str, sub_id: u64) {
    if let Some(entry) = self.sessions.get(session_id) {
        if let Ok(session) = entry.lock() {
            if let Ok(mut subs) = session.subscribers.lock() {
                subs.retain(|(id, _)| *id != sub_id);
            }
        }
    }
}

/// Ids of all currently-running sessions (for the bridge `list` message).
pub fn session_ids(&self) -> Vec<String> {
    self.sessions.iter().map(|e| e.key().clone()).collect()
}
```

- [ ] **Step 6: Verify it builds and existing tests still pass**

Run: `cd src-tauri && cargo test`
Expected: PASS (all prior `pty`/`hooks` tests plus the 3 broadcast tests). No warnings about unused `subscribe`/`unsubscribe`/`session_ids` are acceptable at this step (the bridge in Task 4 consumes them); if `-D warnings` is set, add `#[allow(dead_code)]` on the three methods and remove it in Task 4.

- [ ] **Step 7: Manual regression — desktop unchanged**

Run: `pnpm tauri dev`, open a session, confirm `claude` runs and renders exactly as before (the fan-out path is additive; with zero subscribers `broadcast` is a no-op over an empty Vec).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "feat(pty): fan-out live PTY output to bounded subscribers"
```

---

## Task 3: Bridge control-message parsing (M1, pure)

**Files:**
- Create: `src-tauri/src/bridge.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the `tungstenite` dependency**

In `src-tauri/Cargo.toml` under `[dependencies]` add:

```toml
tungstenite = "0.23"
```

Ensure `serde` has the derive feature (it is already used by `store.rs`); if the `serde` line lacks it, set `serde = { version = "1", features = ["derive"] }`.

- [ ] **Step 2: Create `bridge.rs` with the message type and parser, and write failing tests**

Create `src-tauri/src/bridge.rs`:

```rust
//! Mobile bridge — a loopback WebSocket server that mirrors a session's PTY to a
//! remote client and forwards its keystrokes back. M1 binds to 127.0.0.1 only (no
//! pairing, no tunnel) to de-risk live streaming before any mobile/pairing code.
//!
//! WebSocket (not tiny_http like hooks.rs) because terminal I/O is bidirectional and
//! latency-sensitive. Thread-per-connection, matching the hooks server's style.

use std::net::TcpStream;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tungstenite::{accept, Message};

use crate::pty::PtyManager;

/// Messages the client (browser/phone) sends. `input.data` is a RAW keystroke
/// string (same contract as the `pty_write` command), NOT base64 — only PTY *output*
/// is base64 because it is arbitrary bytes.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMsg {
    List,
    Attach { session_id: String },
    Input { session_id: String, data: String },
    Resize { session_id: String, cols: u16, rows: u16 },
}

/// Parse one client text frame. None on malformed JSON or an unknown `type`.
pub fn parse_client_msg(text: &str) -> Option<ClientMsg> {
    serde_json::from_str(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list() {
        assert_eq!(parse_client_msg(r#"{"type":"list"}"#), Some(ClientMsg::List));
    }

    #[test]
    fn parses_attach() {
        assert_eq!(
            parse_client_msg(r#"{"type":"attach","session_id":"s1"}"#),
            Some(ClientMsg::Attach { session_id: "s1".into() })
        );
    }

    #[test]
    fn parses_input_raw_string() {
        assert_eq!(
            parse_client_msg(r#"{"type":"input","session_id":"s1","data":"ls\r"}"#),
            Some(ClientMsg::Input { session_id: "s1".into(), data: "ls\r".into() })
        );
    }

    #[test]
    fn parses_resize() {
        assert_eq!(
            parse_client_msg(r#"{"type":"resize","session_id":"s1","cols":80,"rows":24}"#),
            Some(ClientMsg::Resize { session_id: "s1".into(), cols: 80, rows: 24 })
        );
    }

    #[test]
    fn rejects_garbage_and_unknown_type() {
        assert!(parse_client_msg("not json").is_none());
        assert!(parse_client_msg(r#"{"type":"explode"}"#).is_none());
    }
}
```

- [ ] **Step 3: Register the module so tests compile**

In `src-tauri/src/lib.rs`, add to the module list near `:7-12`:

```rust
mod bridge;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test parses`
Expected: PASS (4 `parses_*` tests + the reject test). This also confirms `tungstenite` resolves.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bridge.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(bridge): control-message protocol + parser for mobile bridge"
```

---

## Task 4: Bridge WebSocket server (M1)

**Files:**
- Modify: `src-tauri/src/bridge.rs`

- [ ] **Step 1: Add the server and per-connection handler**

Append to `bridge.rs` (above the `#[cfg(test)]` block):

```rust
/// How many buffered output frames to flush to the socket per poll iteration.
const DRAIN_PER_TICK: usize = 256;
/// Read timeout so the poll loop can interleave control reads with output draining.
const READ_POLL: Duration = Duration::from_millis(20);

/// Start the loopback bridge on the first free port in 8455..=8475 (distinct from the
/// hook server's 8423..=8443). Stores the chosen port and logs the ws:// URL.
pub fn start(pty: Arc<PtyManager>, port_out: Arc<AtomicU16>) {
    thread::spawn(move || {
        let mut listener = None;
        for candidate in 8455u16..=8475 {
            if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", candidate)) {
                port_out.store(candidate, Ordering::SeqCst);
                eprintln!("conduit: mobile bridge on ws://127.0.0.1:{candidate}");
                listener = Some(l);
                break;
            }
        }
        let Some(listener) = listener else {
            eprintln!("conduit: no free bridge port in 8455..=8475");
            return;
        };
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let pty = pty.clone();
            thread::spawn(move || handle_conn(stream, pty));
        }
    });
}

fn handle_conn(stream: TcpStream, pty: Arc<PtyManager>) {
    // Handshake blocking, THEN switch to a short read timeout for the poll loop.
    let Ok(mut ws) = accept(stream) else { return };
    if ws.get_ref().set_read_timeout(Some(READ_POLL)).is_err() {
        return;
    }

    // (session_id, subscription id, frame receiver) once attached.
    let mut attached: Option<(String, u64, std::sync::mpsc::Receiver<String>)> = None;

    loop {
        // 1. Read a control message if one is ready (times out quickly otherwise).
        match ws.read() {
            Ok(Message::Text(text)) => match parse_client_msg(&text) {
                Some(ClientMsg::List) => {
                    let ids = pty.session_ids();
                    let _ = ws.send(Message::Text(
                        json!({ "type": "sessions", "sessions": ids }).to_string(),
                    ));
                }
                Some(ClientMsg::Attach { session_id }) => {
                    if let Some((sub_id, rx)) = pty.subscribe(&session_id) {
                        attached = Some((session_id, sub_id, rx));
                    } else {
                        let _ = ws.send(Message::Text(
                            json!({ "type": "error", "message": "no such session" }).to_string(),
                        ));
                    }
                }
                Some(ClientMsg::Input { session_id, data }) => {
                    let _ = pty.write(&session_id, &data);
                }
                Some(ClientMsg::Resize { session_id, cols, rows }) => {
                    let _ = pty.resize(&session_id, cols, rows);
                }
                None => {}
            },
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }

        // 2. Flush any buffered PTY output for the attached session.
        if let Some((_, _, rx)) = attached.as_ref() {
            for _ in 0..DRAIN_PER_TICK {
                match rx.try_recv() {
                    Ok(frame) => {
                        if ws
                            .send(Message::Text(
                                json!({ "type": "output", "data": frame }).to_string(),
                            ))
                            .is_err()
                        {
                            detach(&pty, &attached);
                            return;
                        }
                    }
                    Err(_) => break, // Empty or Disconnected → nothing to flush this tick
                }
            }
        }
    }

    detach(&pty, &attached);
}

fn detach(
    pty: &Arc<PtyManager>,
    attached: &Option<(String, u64, std::sync::mpsc::Receiver<String>)>,
) {
    if let Some((session_id, sub_id, _)) = attached {
        pty.unsubscribe(session_id, *sub_id);
    }
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd src-tauri && cargo build`
Expected: builds clean. (If Task 2 Step 6 added `#[allow(dead_code)]` to `subscribe`/`unsubscribe`/`session_ids`, remove those attributes now — the bridge uses all three — and rebuild.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/bridge.rs
git commit -m "feat(bridge): loopback WebSocket server mirroring PTY output + input"
```

---

## Task 5: Start the bridge from the app (M1 wiring)

**Files:**
- Modify: `src-tauri/src/lib.rs` (`pty_spawn` `:28-37`; `pty_write` `:55`; `pty_resize` `:60`; `pty_kill` `:65`; `pty_is_running` `:70`; `remove_project` `:87`; `remove_session` `:113-118`; `run` manage + setup + ExitRequested `:293-330`)

- [ ] **Step 1: Manage `PtyManager` as `Arc<PtyManager>`**

In `run()`, change:

```rust
.manage(PtyManager::new())
```

to:

```rust
.manage(Arc::new(PtyManager::new()))
```

- [ ] **Step 2: Update every PTY command signature to `State<Arc<PtyManager>>`**

In each of these commands, change the parameter `pty: State<PtyManager>` to `pty: State<Arc<PtyManager>>` (method bodies are unchanged — `Arc` derefs to `PtyManager`):

- `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`, `pty_is_running`, `remove_project`, `remove_session`

Example (`pty_write`):

```rust
#[tauri::command]
fn pty_write(session_id: String, data: String, pty: State<Arc<PtyManager>>) -> Result<(), String> {
    pty.write(&session_id, &data)
}
```

- [ ] **Step 3: Start the bridge in `setup` and fix the exit handler**

In `.setup(|app| { ... })`, after the `hooks::start(...)` line, add:

```rust
let pty = app.state::<Arc<PtyManager>>().inner().clone();
bridge::start(pty, Arc::new(std::sync::atomic::AtomicU16::new(0)));
```

In the `.run(|app_handle, event| { ... })` closure, change:

```rust
app_handle.state::<PtyManager>().kill_all();
```

to:

```rust
app_handle.state::<Arc<PtyManager>>().kill_all();
```

- [ ] **Step 4: Verify it builds and all tests pass**

Run: `cd src-tauri && cargo build && cargo test`
Expected: builds clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(bridge): manage PtyManager as Arc and start loopback bridge"
```

---

## Task 6: End-to-end manual verification (M1 acceptance)

**Files:** none (manual).

- [ ] **Step 1: Launch and find the bridge port**

Run: `pnpm tauri dev`. In the terminal output, find the line:
`conduit: mobile bridge on ws://127.0.0.1:<PORT>`

- [ ] **Step 2: Open a real session**

In Conduit, open a project and start a `claude` session so a PTY is running. Send it a message so it produces output.

- [ ] **Step 3: Connect a browser tab as the "phone"**

Open any page in a browser, open DevTools console, and paste (replace `<PORT>`):

```js
const ws = new WebSocket("ws://127.0.0.1:<PORT>");
window._ws = ws;
ws.onopen = () => ws.send(JSON.stringify({ type: "list" }));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "output") console.log("OUT:", atob(m.data));
  else console.log(m);
};
```

Expected: a `{type:"sessions", sessions:[...]}` message listing the running session id(s).

- [ ] **Step 4: Attach and confirm mirroring**

```js
const SID = "<paste a session id from the list>";
window._ws.send(JSON.stringify({ type: "attach", session_id: SID }));
```

Now type in the **desktop** Conduit terminal for that session. Expected: the same bytes appear as `OUT:` logs in the browser console (the phone sees the live terminal).

- [ ] **Step 5: Confirm reverse input**

```js
window._ws.send(JSON.stringify({ type: "input", session_id: SID, data: "echo hi-from-phone\r" }));
```

Expected: the command runs **in the desktop terminal** and its output streams back to the console — bidirectional mirror proven.

- [ ] **Step 6: Confirm desktop isolation**

With the browser tab still attached, confirm the desktop terminal is fully responsive and unchanged. Close the browser tab; confirm the desktop session keeps running (the bridge `detach`es the subscriber; no impact on the PTY).

- [ ] **Step 7: Record the result**

If all steps pass, M1's de-risking goal is met: a live PTY streams to a remote client with usable latency and accepts input, desktop behavior intact. Note any latency/repaint concerns for the M2 frontend transport work.

---

## Self-review notes (for the implementer)

- **Spec coverage:** This plan delivers the spec's *fan-out sink* (the one change to existing behavior) and the *bridge WS server* `list`/`attach`/`input`/`resize`. Deliberately deferred to later plans: `spawn`-on-demand (M5), pairing/tunnel binding (M4), push (M6), frontend `WebSocketTransport` (M2). The bridge binds to **127.0.0.1** here by design — do NOT expose it beyond loopback until M4 adds pairing + tunnel-interface binding.
- **Isolation invariant:** the slow-subscriber test (Task 1 Step 2) is the guard that a bad phone connection can't stall the desktop. Keep it.
- **Input encoding:** client `input.data` is a raw string (matches `pty_write`); only output is base64. Don't "fix" one to match the other.
