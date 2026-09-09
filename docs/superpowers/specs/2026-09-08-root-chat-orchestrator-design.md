# Root Chat Phase 3a — Orchestrator

**Date:** 2026-09-08
**Status:** Approved (brainstormed section-by-section)
**Predecessors:** `2026-08-26-root-chat-design.md` (Phase 1, v0.23.0 — read-only analyst),
Phase 2 shipped in v0.34.0 (gh CLI, scratchpad, shared memory).
**Successor:** Phase 3b — the mobile companion talks only to root chat. Its own spec,
written once 3a is real.

## 1. What this is

Root chat stops being an advisor that hands you briefs and becomes the place work is
*directed from*: it can see every session across every project, read your other HQ
chats, fork a focused chat, and propose real work into a project — which you approve
with one tap.

This is Option C from the Phase 1 spec's scope ladder (§8, "rail to Option C"), widened:
that spec anticipated MCP tools into Conduit; this adds cross-chat context and the
propose/approve loop that makes dispatch safe from a phone.

Three roles in one surface, and they are the same surface deliberately:

- **Brainstorm companion** — unchanged from Phase 1/2. Thinking partner, reads
  everything, writes nothing but its scratchpad and memory.
- **Project lead** — knows what is running, what needs you, what each chat has been
  chewing on, and can say so without you assembling it.
- **Orchestrator** — turns a decision into a dispatched session, gated on your approval.

## 2. Architecture

### 2.1 A separate MCP server: `src-tauri/src/root_mcp.rs`

Same hand-rolled MCP-over-HTTP transport as `fleet_mcp.rs` (JSON-RPC 2.0, plain-JSON
replies), on the first free port in **8496–8516** — clear of the hook server
(8423–8443), the mobile bridge (8455–8475) and the fleet server (8475–8495).

Identity rides the URL: `/mcp?rootchat=<chat-id>`. A request whose id is not in
`Store::list_root_chats()` is refused. Root chat spawns with `--mcp-config` naming that
URL and **keeps `--strict-mcp-config`**, so exactly one server is reachable and the
user's global MCP fleet stays excluded (unchanged from Phase 1's rule).

**Why not extend `fleet_mcp.rs`.** Every fleet tool is project-scoped by construction —
`caller_project_root`, and the SPEC-0 resolution that pins caller and target to the
*caller's own* project. Root chat is global: each tool takes an explicit project or none
at all. Mixing a global caller into an authorizer built for project-scoped callers is the
shape that produced the previous cross-project leak. Separate endpoint, separate identity
parameter, no shared `authorize()` — fleet tools are unreachable from root and root tools
unreachable from a project session.

**What IS shared: the implementation underneath.** Dispatch does not re-implement
spawning; approval drives the same `fleet-spawn` path `fleet_spawn` uses.

### 2.2 Proposals are non-blocking

`dispatch_work` does not hold the chat's turn open waiting for a human. It records a
proposal and returns `{status: "awaiting-approval", id}` immediately.

This differs from fleet's `request_stop_confirmation`, which blocks its MCP request
thread until the frontend answers — correct there, because a Conductor is a live
interactive session and the human is at the keyboard. A root chat turn is a short-lived
`claude -p` child and the human may be on a phone an hour away; holding a child process
open for that is wrong.

### 2.3 Two registries, one queue

| | tool approvals (`broker.rs`, Phase 3b) | dispatch proposals (`proposals.rs`, this phase) |
| --- | --- | --- |
| caller | blocks on a receiver | returns immediately |
| lifetime | ephemeral, 45 s, gone once answered | durable, 24 h, outcome retained |
| payload | tool + input | project, task, kind, agent override |
| resolved by | first responder wins | first responder wins |

They are not one struct. A single type pretending two lifetimes are the same is how a
registry starts lying to one of its consumers. `broker.rs` is left exactly as it is for
its own phase; `proposals.rs` is new, small and testable.

**The UI merges them.** One pending-decision list on the desktop, one approvals inbox on
mobile in 3b. What the human sees is a single queue; what the backend keeps is two
correctly-shaped registries.

## 3. Tool surface

Seven tools. Each returns structured JSON; none writes to a project.

### Context

- **`sessions_list(project_id?)`** — sessions across all projects, or one project's:
  id, name, project, agent, role, status (`running` / `needsInput` / `idle` / `done`),
  branch, hibernated. The fleet-wide view.
- **`session_peek(session_id, lines?)`** — recent transcript tail for one session.
- **`chats_list()`** — the other HQ chats: id, title, created, last activity.
- **`chat_read(chat_id, limit?)`** — another chat's items, through the same parser
  `root_chat_history` uses (`transcript::parse_line`). This is "get context from the
  existing chats".

### Act

- **`dispatch_work(project_id, task, kind?, agent?, model?)`** — records a proposal;
  returns `awaiting-approval` + id.
- **`dispatch_status(id)`** — `pending` / `approved` (+ session id) / `denied` /
  `expired`. Spawn-per-message gives no callback, so a later turn asks.
- **`chat_fork(title, seed?)`** — creates an HQ chat immediately and, with a seed, sends
  it as that chat's first message. No approval gate: cheap and reversible (delete the
  chat), and gating it would turn "spin up a chat for the pricing question" into a chore.
  The charter tells it to fork sparingly.

### Deliberate omissions

- **No `projects_list`.** The charter already injects the project roster every spawn; a
  tool for data the model already holds is a wasted round trip.
- **No `usage_snapshot`.** The "how full is this account" arithmetic lives in
  `usageRows.ts`; a Rust reimplementation is exactly the fork CLAUDE.md warns about.
  Quota-awareness arrives instead through routing (§4.2).
- **No board tools.** Dispatch covers the same need directly.

### Trust gate

When private mode is on, root chat is treated as `Clearance::Public` and can never
`session_peek` a siloed session. Root chat is a cloud agent; a silo exists precisely so
its output never reaches one.

## 4. Dispatch lifecycle

### 4.1 Steps

1. Chat calls `dispatch_work(project_id, task, kind?, agent?, model?)`.
2. `root_mcp` validates the project, enforces the per-chat pending cap, and records a
   proposal: `{ id, chat_id, project_id, task, kind, agent_override, model, created_at }`.
3. A `pending-decision` event goes to the frontend; the desktop renders a card (mobile
   inbox in 3b).
4. The tool returns `{status: "awaiting-approval", id}`. The turn ends normally.
5. On approve, **the frontend spawns** — resolving the agent (§4.2), calling
   `add_session`, and driving the existing `fleet-spawn` → `mergeSpawnedSession` path
   with `task` as the session's initial prompt.
6. The proposal's outcome is recorded; `dispatch_status(id)` reports it later.
7. Unanswered proposals expire after 24 h, so an approval you never got to cannot spawn
   work next week.

**Why the frontend spawns.** Rust cannot mint a terminal Channel — `bridge.rs` hit this
same wall, which is why its `spawn` verb emits `fleet-spawn` for the frontend to
complete. Approval reuses that path rather than inventing a second spawn mechanism.

### 4.2 Agent resolution happens at approve time, in TypeScript

`routing.rs` owns *what* the preferences are; `src/routing.ts`'s `pickTarget` owns *which
target is usable right now*, because that needs the live usage snapshot held in the
store. Rust cannot know which account is spent.

So the proposal stores the **task kind**, not a resolved agent. When the card renders,
the frontend runs `pickTarget` and displays the agent it would use; approving spawns that
agent. An explicit `agent`/`model` in the tool call overrides routing and is shown as
chosen by the chat. Neither language re-implements the other — the existing split holds.

## 5. Invariants

- **Root chat can never spawn a Conductor.** Dispatched sessions are always
  `role: Worker`. Otherwise root chat could mint a second orchestrator holding fleet's
  full tool surface and escalate past its own boundary.
- **No chat turn reaches a live agent without a human decision.** The MCP handler
  records; it never spawns.
- **Approval acts on the recorded proposal**, never on anything re-read from the chat at
  approve time. The card is exactly what runs.
- **Phase 2's write rule is untouched.** Root chat's only writable paths remain its
  scratchpad and the shared memory. Dispatch issues work orders, not file access.
- **Cap: 10 pending proposals per chat.** A confused loop queues ten cards, not five
  hundred.
- **The root endpoint refuses non-root callers**, and no root tool appears on the fleet
  endpoint.

## 6. Failure and degradation

- **Root MCP server did not start.** `--strict-mcp-config` means the tools simply are not
  present and the chat behaves exactly like Phase 2. There is no half-state where it
  believes it can dispatch and silently cannot.
- **Unknown project or session id** → a tool error string the chat can recover from and
  explain.
- **`pickTarget` finds nothing usable at approve time** (agent not installed, every
  account spent) → the card says so and the proposal stays pending rather than spawning
  something nobody chose.
- **A siloed or missing session in `session_peek`** → an explicit refusal, not empty
  output that reads like "nothing happening".

## 7. Testing

**Rust (`#[cfg(test)]`, colocated):**
- `proposals.rs`: register → approve → outcome; deny; expiry past 24 h; the per-chat cap;
  first-responder-wins on double resolve.
- `root_mcp.rs`: the endpoint refuses a chat id absent from the store; the tool list
  matches its schema; `session_peek` refuses a siloed session under private mode;
  `chat_read` of an unknown chat degrades rather than erroring the transport.

**Frontend (vitest, colocated):**
- The pending-decision reducer (add, resolve, expire) and the merge of proposals with
  broker approvals into one ordered queue.
- The approve → spawn payload: role is always `worker`, task becomes the initial prompt,
  agent comes from `pickTarget` unless overridden.

**Manual gate (UI changes require launching the app):** ask "what's running?" across
projects; "read my pricing chat" from a different chat; "fork a chat for X"; "get X built
in conduit" → card appears with the resolved agent → approve → the session appears with
the brief as its opening prompt; deny → `dispatch_status` reports denied on the next
turn.

## 8. Out of scope (Phase 3b and later)

- The mobile companion talking only to root chat, and waking the dormant approval broker
  (`Presence::attach` is called by nobody today, and no client message can answer an
  approval). Both breaks are documented; 3b fixes them.
- Board tools, a usage snapshot tool, per-chat context meters, token-level streaming.
- Converging fleet's blocking stop-confirm into the shared queue.
