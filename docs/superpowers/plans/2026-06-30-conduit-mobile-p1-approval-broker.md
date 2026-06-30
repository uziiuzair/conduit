# Conduit Mobile P1 — Approval Broker Implementation Plan

> **For agentic workers:** implement task-by-task with TDD. Steps use checkbox (`- [ ]`).

**Goal:** Let a paired phone (and a desktop card) answer Claude's tool-approval prompts, by turning the `PreToolUse` hook into a blocking broker that surfaces the request and waits for a decision.

**Architecture:** A new `broker.rs` holds pending approval requests (request-id → a one-shot decision channel). The hooks server gains a **concurrent** `/approve` endpoint (thread-per-request so a pending approval never stalls other hooks). The installed `PreToolUse` hook — scoped by matcher to mutating tools (`Bash|Write|Edit|MultiEdit|NotebookEdit`) — POSTs to `/approve` and outputs the returned decision to stdout. The bridge forwards `approval_request` to attached phones (+ a desktop card) and routes `approval_decision` back to the broker; first responder wins.

**Opt-in by presence (key safety property):** `/approve` only *waits* when a phone is attached to that session. **No phone → respond with no decision → Claude's normal flow runs (native desktop prompt unchanged).** So the desktop default is untouched until you pair; no global setting needed.

**Tech Stack:** Rust (std mpsc/condvar, tiny_http thread-per-request, serde_json), the existing bridge + hookbus, RN ApprovalCard.

---

## Interactive verification (the gate) — folded into integration, not a standalone spike

The one unverified risk is that a *blocking* `PreToolUse` hook in an **interactive** (non-`-p`) session (a) pauses cleanly, (b) `allow` suppresses Claude's native in-terminal prompt, (c) doesn't garble the TUI. Strong priors: Claude Code docs put hooks first in permission evaluation and state `allow` satisfies it; the 2026-06-30 headless spike confirmed fire/block/honor. **Verification step:** after Task 3 (hook wired, manual decision via a curl/file), trigger one `Bash` in a dev-app session and confirm pause + no native prompt + clean TUI **before** building the UI (Tasks 4-5). If it fails, stop and rethink the broker shape.

---

## File Structure

- **Create** `src-tauri/src/broker.rs` — `Broker` + `ApprovalRequest`/`Decision`: register/resolve/list pending, with a per-request one-shot channel. One responsibility: hold and resolve pending approvals.
- **Modify** `src-tauri/src/hooks.rs` — add the `/approve` endpoint (thread-per-request, blocking); add the broker `PreToolUse` matcher rows + the blocking hook command.
- **Modify** `src-tauri/src/bridge.rs` — forward `approval_request` to attached phones; accept `approval_decision` → broker.
- **Modify** `src-tauri/src/lib.rs` — manage `Arc<Broker>`; pass to hooks + bridge.
- **Modify** `mobile-app/src/bridge/{protocol,LiveProvider}.ts` + `ChatScreen.tsx` — receive `approval_request`, render the `ApprovalCard`, send `approval_decision`.

---

## Tasks (TDD; hardest-risk gated at Task 3.5)

### Task 1: `broker.rs` — pending-approval state
- [ ] Test: `register` returns an id + receiver; `resolve(id, decision)` delivers it; unknown id is a no-op; `pending()` lists open requests; resolving removes it.
- [ ] Impl: `Broker { pending: Mutex<HashMap<String, SyncSender<Decision>>>, seq: AtomicU64 }`; `register(session, tool, input) -> (id, Receiver<Decision>)`; `resolve(id, Decision)`; `pending_for(session) -> Vec<ApprovalRequest>`. `Decision = Allow | Deny{reason}`.
- [ ] Commit.

### Task 2: `/approve` endpoint (concurrent, blocking) in `hooks.rs`
- [ ] Test (pure helper): `approve_response(decision)` → the exact `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":...}}` JSON; allow vs deny shapes.
- [ ] Impl: in the request loop, route `POST /approve?session=&tool=` to a **spawned thread**: parse body (tool_input), ask the bridge "is a phone attached to this session?"; if not → respond `{}` (no decision) immediately; if yes → `broker.register(...)`, publish an `approval_request` to the hookbus/bridge, block on the receiver (timeout → deny "approval timed out"), respond with `approve_response(decision)`. Keep `/hook` inline + fire-and-forget as today.
- [ ] Commit.

### Task 3: blocking `PreToolUse` broker hook (settings)
- [ ] Test: the installed settings include a `PreToolUse` entry matched to `Bash|Write|Edit|MultiEdit|NotebookEdit` whose command POSTs to `/approve` (no `-m 2`, stdout NOT discarded) and carries `CONDUIT_SESSION_ID`.
- [ ] Impl: add broker rows to `claude_profile()` (or a parallel installer); a `approve_command(port)` that `curl`s the payload to `/approve?...` and prints the response. Existing `pretool` fire-and-forget stays for status.
- [ ] Commit.

### Task 3.5 — INTERACTIVE VERIFICATION (gate). Manual: dev-app session + a phone (or a curl that resolves the broker) → trigger one Bash → confirm pause, no native prompt on `allow`, clean TUI. Proceed only if green.

### Task 4: bridge approval routing
- [ ] Test: `approval_request_payload(req)` and parsing `approval_decision` client msg.
- [ ] Impl: bridge forwards pending `approval_request`s (from the hookbus/broker) to the attached phone; new client msg `approval_decision{request_id,allow,reason}` → `broker.resolve`. Wire `Arc<Broker>` via the AppHandle.
- [ ] Commit.

### Task 5: mobile ApprovalCard wiring
- [ ] LiveProvider: handle `approval_request` → insert an `ApprovalItem` into the feed (or a pending slot); `decide` → send `approval_decision` + mark resolved.
- [ ] ChatScreen: `onDecide` actually sends the decision (no longer a no-op).
- [ ] Bundle-check; commit.

---

## Risks / notes
- **Concurrency in tiny_http:** moving a blocking request to a thread while the main loop continues — the one structural change to the hooks server; keep `/hook` untouched.
- **Phone-attachment query:** the broker needs to know if a session has an attached bridge client — track attached session ids in shared state the bridge updates.
- **Timeout policy:** pending approval with no answer → deny with a reason Claude reads (or `ask` to fall back to the native prompt). Decide at Task 2.
- **Desktop card:** v1 may ship phone-only; the desktop card is a fast follow (same `approval_decision` path from a Tauri command).
