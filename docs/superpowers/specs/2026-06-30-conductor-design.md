# Conductor — a master AI session that observes and orchestrates the fleet — design

- **Date:** 2026-06-30
- **Status:** Approved (design); pending implementation plan
- **Topic:** A per-project "Conductor" agent session you converse with, that sees every worker session's structured status (with on-demand transcript peeks) and can act on the fleet — spawn worktree-isolated workers, send input, stop workers — via a Conduit-hosted MCP server.

## Context

Conduit runs multiple real `claude` CLI sessions side by side, one PTY per session, grouped by project (`pty.rs`, `store.rs`). Sessions are deliberately **peers** — there is no master, and there is **no inter-session communication** today (confirmed: the only fan-out is the mobile bridge, which is client↔session, never session↔session).

This design intentionally cuts against that peer ethos: it introduces **one** privileged session per project — the Conductor — that knows the state of the whole fleet and can orchestrate it. The user's primary goal is **fleet observability** (a session you can talk to that reports what every other session is doing), with **acting** (spawn / send / stop) included from day one.

The building blocks already exist and are repurposed rather than rebuilt:

- **Status is already plumbed.** Every agent session reports lifecycle status via hooks → a local HTTP server in `hooks.rs` → a `"hook"` Tauri event → the frontend `live` map (`status`, `todos`, `activity`). Crucially, **the Rust hooks server already sees every status event before forwarding it** — it just doesn't retain anything.
- **Acting primitives exist.** `add_session` + `pty_spawn(--worktree)` create an isolated worker; `PtyManager::write` injects raw input into any session by id; `pty_kill` stops one. Nothing wires these together for session→session yet.
- **Branch isolation exists.** A worktree session gets its own branch (`worktree-<slug>`) and dir (`<repo>/.claude/worktrees/<slug>`) via Claude Code's native `--worktree` (see `2026-06-24-worktree-isolation-design.md`). This is the mechanism that makes the user's "never two agents on one branch" rule free.
- **MCP plumbing exists.** Conduit already applies MCP config to sessions (`mcp_apply`), and Claude Code natively supports MCP servers.

## Goals

- A per-project Conductor session, created explicitly, that is the only session able to see/command the fleet.
- The Conductor sees compact structured status for every session in its project (state, todos, activity, branch) and can pull a specific worker's recent terminal output on demand (`peek`).
- The Conductor can **spawn** workers (always worktree-isolated), **send** input to a worker, and **stop** a worker.
- The "never two agents share a branch" invariant is structural: Conductor-spawned workers are always worktree-isolated.
- Guardrails prevent runaway fan-out and protect uncommitted work.

## Non-goals (v1 scope cuts)

- **No dedicated chat-panel UI** (Approach B). The Conductor is a normal keep-alive terminal; its "interface" is its own terminal. No bespoke fleet dashboard, no clickable worker cards.
- **No continuous ingestion of worker output** (full live content). Observation is structured-status-by-default + on-demand `peek` only.
- **No deterministic-orchestrator layer** (Approach C). Orchestration intelligence lives in the Conductor agent, gated by guardrails — not in hand-written routing logic.
- **No cross-project Conductor.** A Conductor sees only its own project's sessions.
- **No non-Claude workers via `fleet_spawn`** in v1: worktree support is Claude-only today (`agent.rs` — Codex/Gemini return `supports_worktree() == false`), and spawned workers are always isolated, so `fleet_spawn` is Claude-only. (The Conductor can still *observe* non-Claude sessions, which report status via hooks.)
- **No branch deletion on stop.** `fleet_stop` removes the checkout but keeps `worktree-<slug>` (matches existing `worktree_remove` convention; preserves commits).

## Key decisions

These were settled during brainstorming with the user:

1. **Primary goal = fleet observability**, with acting included from day one (observe + act).
2. **Observation depth = structured status + on-demand peek.** Compact per-session state by default; the Conductor pulls recent transcript for a specific worker only when it needs detail.
3. **Approach A — Conductor-as-terminal + a Conduit-hosted fleet interface.** The Conductor is a flagged `claude` terminal session (a **Claude** agent in v1, since it relies on MCP attach + persona injection); Conduit exposes fleet tools to it. (Rejected B = dedicated chat panel: large build + outbound API dependency against the lean-deps ethos. Rejected C = deterministic orchestrator: AI not central enough.)
4. **Bridge = MCP server.** Fleet capabilities are exposed as first-class MCP tools, hosted by Conduit alongside the existing hooks server / mobile bridge, and auto-attached to Conductor sessions via the existing `mcp_apply` path. (Rejected: a local CLI shim called via Bash — leaner, but less ergonomic than structured tools.)
5. **Destructive-action policy = spawn/send autonomous, stop confirms.** `fleet_spawn` (isolated) and `fleet_send` (just input) run without confirmation; `fleet_stop` pops an in-app confirmation naming the worker, its branch, and dirty state, because killing a worker can discard uncommitted work.
6. **The Conductor runs in the project root, no worktree of its own.** It is the controller, not a coder; it should not be editing files on a branch.
7. **At most one Conductor per project**, enforced at creation time.

## Architecture

### Data model (`store.rs`, `store.ts`)

Add `role: "worker" | "conductor"` to `Session`, defaulting to `"worker"` with `#[serde(default)]` in Rust — the same back-compat pattern used when `use_worktree`/`branch`/`agent` were added, so all persisted sessions deserialize as workers with zero migration.

`add_session` (Tauri command + `store.add_session`) gains the ability to create a session with `role: "conductor"`; creation **rejects** a second Conductor in a project that already has one.

### Fleet status map (`hooks.rs`)

The hooks HTTP server already receives every `?session=<id>&event=<verb>` POST and re-emits it as a `"hook"` Tauri event. Extend it to also retain the latest status per session in an `Arc<Mutex<HashMap<SessionId, FleetStatus>>>`, updated on each inbound event **before** the event is forwarded (so the frontend `live` map behaviour is unchanged).

```
FleetStatus = { status, todos, activity, branch, updatedAt }
```

`status` mirrors the frontend `SessionStatus` (`idle | running | needsInput | done`). This map is the authoritative source for `fleet_list`, read entirely Rust-side — no round-trip to the frontend.

### Output ring buffer (`pty.rs`)

`fleet_peek` needs recent worker output, but xterm keeps scrollback in the frontend, not Rust. Add a **bounded per-session ring buffer** (last ~N KB; N a small constant, e.g. 64 KB) filled by the existing PTY reader thread alongside the current sink/subscriber fan-out. Expose `PtyManager::recent_output(id, max_bytes) -> String`. This is the only genuinely new low-level plumbing.

### Fleet MCP server (new module, in-app)

A new module hosts an MCP server inside the Tauri app (sibling to the hooks server and mobile bridge), scoped so only Conductor sessions connect to it. It exposes five tools:

| Tool | Behaviour | Backed by |
| --- | --- | --- |
| `fleet_list()` | All sessions in the Conductor's project: `{ id, name, role, branch, worktree, status, todos, activity, updatedAt }` | fleet status map + store |
| `fleet_peek(id, lines?)` | Recent terminal output for one worker | `recent_output` ring buffer |
| `fleet_spawn({ task, name? })` | Create a worktree-isolated worker (`add_session(use_worktree=true)` + `pty_spawn(--worktree)`); optionally inject `task` as first input; returns `{ id, name, branch, worktreePath }` | `add_session` + `pty_spawn` |
| `fleet_send({ id, text })` | Inject input into a worker | `PtyManager::write` |
| `fleet_stop({ id })` | Stop a worker after in-app confirmation; removes checkout, keeps branch | confirmation gate → `pty_kill` (+ `worktree_remove`) |

**Conductor provisioning.** When a session has `role: "conductor"`, its spawn auto-attaches the fleet MCP server (via `mcp_apply` / a generated MCP config) and injects a short persona/system-prompt describing: its role, the available tools, the branch-isolation rule, and the untrusted-input rule. Worker sessions never get the MCP server attached, so they physically cannot see or command the fleet — the "one knows all" property is structural, not convention.

### Data flow (spawn example)

```
You → type to Conductor terminal
Conductor → decides to spawn → calls fleet_spawn{task}
  → fleet MCP server (Rust)
    → store.add_session(use_worktree=true) + pty_spawn(--worktree)
    → (optional) PtyManager::write(new_id, task)
  → new worker appears in sidebar/layout via the existing add_session path
  → returns { id, branch, worktreePath } to the Conductor
Conductor → reports the new worker to you
New worker's status → flows back through hooks → fleet status map → next fleet_list
```

### UI (minimal)

- **Create:** the New Session dialog gains a Conductor option (role toggle or a "New Conductor" action), hidden/disabled when the project already has a Conductor.
- **Distinction:** the Conductor shows a distinct badge/icon in the sidebar so it reads as the master.
- **Stop confirmation:** when the Conductor calls `fleet_stop`, an in-app modal names the worker, its branch, and dirty state, then asks to confirm — the single human gate in the flow.
- **Spawned workers** appear through the existing `add_session` UI path; no new surface.

## Guardrails & safety

- **Worker cap** per project (configurable, default e.g. 8). `fleet_spawn` refuses past the cap with a clear error the Conductor relays.
- **Spawn rate limit** so the Conductor cannot fan out a swarm in a single turn.
- **No self-targeting:** `fleet_send` / `fleet_stop` reject the Conductor's own id, preventing self-interference loops.
- **Untrusted input:** `fleet_peek` returns another agent's text — treated as data, never auto-executed. The Conductor persona states this explicitly (the "output of A becomes instruction to B" risk).
- **Stop confirmation:** per decision 5, `fleet_stop` is the only action gated by the user; it never silently discards uncommitted work.

## Error handling

Structured tool errors, never silent:

- **session-not-found** — bad id passed to peek/send/stop.
- **worker-cap-reached** — spawn refused at the cap.
- **not-a-git-repo** — `fleet_spawn` requires git (worktree). Detected via `git::current_branch`.
- **agent-without-worktree-support** — `fleet_spawn` is Claude-only in v1.
- **second-conductor-rejected** — creating a Conductor when one exists.
- **dirty-stop** — surfaced to the confirmation modal; force is explicit, mirroring `worktree_remove`'s dirty handling, which defaults to *dirty* on git/IPC error so a destructive remove is never gated by a falsely-clean reading.

## Testing

Per CLAUDE.md reality (Rust has `#[cfg(test)]` unit tests; the frontend has no test runner), TDD the pure Rust pieces:

- **Fleet status map:** a hook event updates the retained status; `fleet_list` reflects it.
- **Ring buffer:** bounded size honoured; `recent_output` returns the tail.
- **Spawn invariant:** `fleet_spawn` always sets `use_worktree = true`; slug/branch uniqueness across spawns.
- **Guardrails:** worker cap, spawn rate limit, self-target rejection.
- **Error cases:** not-a-git-repo, agent-without-worktree-support, second-conductor-rejected.
- **MCP tool handlers:** tested against mocked `PtyManager` / store where feasible; favour pure functions.

Regression: existing `hooks.rs` install/status tests stay green (worker status path unchanged).

Frontend: `pnpm exec tsc --noEmit` + `pnpm build`, then **launch-and-verify in an isolated dev data dir** (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`): create a Conductor, confirm it lists workers, spawns an isolated worker, sends input, and that `fleet_stop` triggers the confirmation modal.

## Risks / to verify during implementation

- **In-app MCP server transport.** Confirm the cleanest way for a Conduit-spawned `claude` to reach a Conduit-hosted MCP server — stdio (a small helper process proxying to the app) vs. a local HTTP/SSE endpoint (consistent with the existing hooks server / bridge). Settle in the implementation plan; the tool *contract* above is transport-independent.
- **`fleet_send` framing.** Injecting text into a live interactive `claude` REPL is "typing as a human." Verify input is delivered cleanly (newline/submit semantics) and that the Conductor can tell when a worker has finished responding (watch status transitioning to `idle`/`done` via the status map, rather than parsing output).
- **Status freshness.** The fleet status map is only as current as the last hook event; a worker between events shows its last known state. Acceptable for v1 (the `peek` escape hatch covers detail).
- **Persona injection mechanism.** Decide how the Conductor's system-prompt/persona is delivered (e.g. a generated `--settings`/instruction file, reusing the worktree `--settings` delivery pattern), since the Conductor runs in the project root.

## References

- Worktree isolation design: `docs/superpowers/specs/2026-06-24-worktree-isolation-design.md`
- Mobile companion (the existing in-app local-server + per-session fan-out pattern): `docs/superpowers/specs/2026-06-25-conduit-mobile-companion-design.md`
- MCP: https://modelcontextprotocol.io / Claude Code MCP docs: https://code.claude.com/docs/en/mcp
