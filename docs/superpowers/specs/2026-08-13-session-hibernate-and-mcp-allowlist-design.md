# Session hibernate + per-session MCP allowlist — design

**Date:** 2026-08-13
**Status:** approved, not yet implemented
**Ships as:** 0.19.0

## Problem

Running several sessions exhausts memory, and the only way to get it back is to
**delete** the session. Closing its tab does nothing.

Measured by the user on macOS: each live `claude` session is roughly 400 MB, and the MCP
servers it loads add roughly 200 MB on top — about 600 MB per session. Five sessions is
~3 GB before the editor, the webview, or anything else.

Two independent causes:

### 1. PTY lifetime is bound to session lifetime, not to the tab

`WorkspaceCenter.tsx` builds `allSessions` from **every session of every project** and
mounts a `TerminalView` for each one. Those components never unmount — that is the
keep-alive rule, and it is correct for its purpose (reparenting an `xterm` kills the
underlying PTY).

But the rule got applied one level too broadly. `pty.rs` states it outright: a PTY is
"never torn down on a tab switch — only on explicit `pty_kill`". The only callers of
`pty_kill` for an agent terminal are:

| Caller | Trigger |
| --- | --- |
| `remove_session` (`lib.rs`) | user deletes the session |
| `remove_project` (`lib.rs`) | user removes the project |
| `fleet_stop` (`fleet_mcp.rs`) | the Conductor stops a worker |
| `kill_all` (quit path) | app exits |

`closeTab` (`store.ts`) only filters the tab out of the layout array. So a session
spawned once stays resident until it is deleted or the app quits — across project
switches, across days.

`restoreSessionsOnOpen` (default on) multiplies this: opening a project eagerly spawns
*every* session in it, whether or not the user touches them.

### 2. Every session loads every MCP server

The MCP matrix registers servers with `claude mcp add -s user` (`agent.rs`) — **user
scope**, so every Claude process on the machine loads all of them. Conduit passes
`--mcp-config` only for the Conductor and fleet workers (`lib.rs`); an ordinary session
passes nothing and inherits the full user-scope set. The MCP cost is therefore
`sessions × servers`, and a session that needs no MCP tools at all still pays for them.

## Goals

- Stop a session's processes without destroying the session, its history, or its
  scrollback — and bring it back with the conversation intact.
- Make closing a tab the gesture that frees the memory, because that is what users
  already try.
- Let a session declare which MCP servers it actually needs, so a lean session costs
  what a lean session should.
- Change nothing for users who touch neither feature.

## Relationship to `session_budget`

This design was written before tmux session persistence landed on `main`, which brought
`session_budget.rs` — a reaper that retires long-idle **detached** tmux sessions when the
host is genuinely short of memory. The two are complements, not rivals:

| | `session_budget` | this feature |
| --- | --- | --- |
| Trigger | memory pressure, automatic | a user gesture, immediate |
| Targets | detached, long-idle sessions | whatever the user points at, attached included |
| Reversible | yes — reopens like a reboot | yes, by the same mechanism |

The reaper never touches an attached session and never fires on a healthy machine, so it
cannot answer "I am done with this session, take its 600 MB back now." Both end in the same
state, and deliberately so: one teardown verb (`retire`), one restore path (cold spawn +
snapshot replay).

## Non-goals

- **Auto-hibernate on an idle timer.** Deferred, and now largely unnecessary: the pressure
  case is `session_budget`'s. What remains is the deliberate stop, which is this feature.
- **Reducing a single `claude` process's own footprint.** Out of Conduit's control.
- **MCP allowlists for non-Claude agents.** `--strict-mcp-config` is verified present in
  the installed Claude CLI. The equivalent for gemini/codex/opencode is not verified, and
  guessing at another CLI's flags breaks its invocation outright.

## Feature A — Session hibernate

### State

One new field on `Session` (`store.rs`), `#[serde(default)]` so existing `state.json`
files load unchanged:

```rust
/// User stopped this session's processes without deleting it. The session, its
/// transcript, and its worktree are untouched; only the PTYs are gone. Persisted so
/// hibernation survives a restart — otherwise the eager restore-on-open path would
/// relaunch on the next project open, undoing the user's decision.
#[serde(default)]
pub stopped: bool,
```

`stopped` records **intent**, not liveness. Whether a PTY exists is `PtyManager::has`.
The two can disagree briefly (during a stop, or if a process dies on its own) and that is
fine — intent is what must survive a restart.

### Commands

Three new Tauri commands. Each is a single call so the kill and the persisted flag cannot
drift apart:

- **`stop_session(session_id)`** — `pty.retire(id)`, `pty.retire("{id}::term")`,
  `store.set_session_stopped(id, true)`, `fleet.set_running(id, false)`. Idempotent.
  Session ids are globally unique, so no project id is needed (same shape as
  `set_session_account`).

  **`retire`, never `kill`.** Under tmux, `PtyManager::kill` means DESTROY: it kills the
  tmux session *and deletes the scrollback snapshot* ("Destroy means destroy"). Hibernation
  is the opposite — the session is coming back, and the snapshot is the only record of its
  screen once tmux is gone. `retire` is the same teardown with the snapshot kept (and
  freshened first), which makes a stopped session indistinguishable from one
  `session_budget` reaped or one that lost its tmux server to a reboot. That equivalence is
  a contract the reaper already depends on; hibernation joins it rather than inventing a
  third state. The two verbs differ only in `Teardown::keeps_snapshot()`, which is a tested
  table rather than a comment.
- **`start_session(session_id)`** — clears the flag only. The frontend's `TerminalView`
  owns spawning; a command that spawned directly would need cols/rows it does not have.
- **`stop_idle_sessions(project_id) -> Vec<String>`** — stops every session in the
  project that has a live PTY and is **not** in `FleetState::running_sessions()`. Returns
  the ids it stopped, for the toast.

The selection rule in `stop_idle_sessions` is extracted as a pure function so it can be
unit-tested without a PTY:

```rust
fn idle_stop_targets(session_ids: &[String], alive: &HashSet<String>, running: &HashSet<String>) -> Vec<String>
```

A session with no live PTY is skipped rather than marked stopped: it was never running,
and marking it would silently opt it out of restore-on-open.

### Terminal behavior

`TerminalView` gains a `stopped: boolean` prop, threaded from the session by
`WorkspaceCenter`. An effect watches it:

**false → true:** bump `spawnGenRef` (so the doomed PTY's late frames, including
`[process exited]`, cannot paint), clear `spawnedRef`, write a dim separator line into the
buffer, then `pty_kill` both PTYs.

**true → false, while visible:** spawn. The cold-spawn path already resumes —
`claude --resume <id> || claude` (`agent.rs`) for Claude, `agy --conversation=<uuid>` for
agy — so the conversation comes back.

A stopped tab keeps showing where its session got to — the xterm instance stays mounted, so
the buffer is still there under a stop marker. The **clear happens at the next spawn**, not
at the stop, because a resumed session is a COLD spawn and Rust's first frame is the
scrollback snapshot (`take_cold_scrollback`). Without the clear, the user would see the same
screen twice — precisely the duplication `warm_spawns` exists to prevent on the reattach
path. The snapshot is the better copy anyway: unlike the live buffer, it survives quitting
the app.

This is the same kill-and-respawn-in-place mechanism the unified-session-directory work
already shipped for the companion shell (`Terminal.tsx`), including its generation guard.
That path is `shellOnly`-gated because a *directory change* must never silently restart an
agent. A user explicitly choosing to stop is a different event, and gets the same
machinery under a different gate. **The keep-alive rule stands unchanged for tab switches,
reparenting, and layout changes** — those must still never touch an agent PTY.

The eager restore-on-open effect gains `if (stopped) return`.

#### Resume repaint

`pty_spawn`'s re-attach fast path nudges the winsize (`resize(cols, rows+1)` then
`resize(cols, rows)`) to force a repaint. The cold-spawn path does not — which is the
known "resume looks broken" symptom: `claude --resume` replays into the alternate screen
and nothing repaints it. Resuming a stopped session takes the cold path, so it needs the
same nudge, issued from the frontend shortly after the resume spawn. Scoped to the resume
path; the ordinary first-spawn path is untouched.

### Triggers

| Gesture | Behavior |
| --- | --- |
| Tab close (X or ⌘W) on a session tab | Stop the session, then close the tab. Confirm first **only** when `live[id].status === "running"`. |
| Sidebar right-click → **Stop session** | Stop. Shown as **Start session** when already stopped. |
| Project right-click → **Stop idle sessions** | Bulk stop; toast reports the count. |

A stopped session renders dimmed with a hollow status dot in the sidebar, and stays fully
interactive — clicking it opens its tab and resumes it.

Stopping from the tab X shows a toast ("Session stopped — click it to resume") because
the gesture is now destructive-ish and the tab that would have explained it is gone.

Killing an idle-but-mid-conversation agent without a prompt is acceptable precisely
because resume is real: the next spawn reopens the conversation. The confirm exists for
`running`, where killing loses in-flight work.

### What is unaffected

- The quit guard (`live_running_agent`) cross-checks fleet state against a live PTY, so a
  stopped session simply stops counting. No change needed.
- Deleting a session is unchanged and still the way to destroy history.
- Worktrees are untouched by a stop.

## Feature C — Per-session MCP allowlist (Claude only)

### State

```rust
/// MCP servers this session may load, by registry name. None = inherit whatever the
/// agent would load on its own (user scope, project `.mcp.json`, plugins) — today's
/// behavior exactly. Some(list) = load exactly these and nothing else.
#[serde(default)]
pub mcp_servers: Option<Vec<String>>,
```

`None` and `Some(<everything>)` are **deliberately different**. `--strict-mcp-config`
ignores *all* other MCP configuration, including a repo's own `.mcp.json`. An allowlist
containing every registered server would still be a behavior change for such a repo, so
"the user left every box checked" must serialize to `None`, not to a full list.
`Some(vec![])` is meaningful: no MCP servers at all.

### Where the server definitions come from

The MCP registry lives in the **frontend's localStorage** (`persistMcp` in `store.ts`),
not in the Rust store. Rust therefore cannot resolve a name to a command/URL on its own.

Rather than mirroring the whole registry into Rust, `pty_spawn` takes the already-resolved
definitions as a parameter:

```rust
mcp_allowlist: Option<Vec<crate::agent::McpServer>>,
```

`TerminalView` resolves `session.mcpServers` (names) against `state.mcpServers`
(definitions) at spawn time. Names are the durable, store-owned fact; definitions are
looked up fresh on every spawn, so editing a server in the matrix takes effect on the next
start without touching any session record.

### Config generation

A new pure function in `agent.rs`:

```rust
pub fn session_mcp_config_json(servers: &[McpServer], fleet_block: Option<&str>) -> String
```

It emits the standard shape — `{"mcpServers": {...}}` — mapping `stdio` servers to
`{command, args, env}` and `http` servers to `{"type": "http", "url": ...}`, and merges
the Conductor/worker fleet block when one applies so a Conductor with an allowlist keeps
its fleet tools. One file, one flag: `lib.rs` writes `session-mcp-<id>.json` into the data
dir and passes it as `mcp_config_path`, exactly the seam
`fleet::write_mcp_config` already uses.

`build_script` and `build_script_win` gain a `strict_mcp: bool` that appends
`--strict-mcp-config`. It is set only when an allowlist is present, so the flag never
appears for a `None` session.

### UI

`NewSessionDialog` gains an "MCP servers" section, rendered only when the effective agent
is Claude and at least one server is enabled for Claude. Every box starts checked. On
create: all checked → send `null`; otherwise send the checked names.

Editing the allowlist of an existing session is out of scope for this increment — the
choice is made where it matters, before the process exists. (Delete-and-recreate, or a
later increment, covers changing one's mind.)

### Open risk — continuity's plugin MCP

Continuity's tools reach a board-enabled Claude session through `--plugin-dir`, not
through `--mcp-config`. `--strict-mcp-config` is documented as ignoring "all other MCP
configurations", and whether that includes plugin-provided servers is **not known**.

This must be settled empirically before the feature ships: launch a board-enabled Claude
session with an allowlist, run `/mcp`, and record whether continuity's tools are present.
If they are suppressed, the dialog warns when the project has the board enabled, and the
behavior is documented in `CLAUDE.md`. The feature is not gated on the answer — the answer
is gated on being written down rather than assumed.

## Testing

**Rust unit tests (pure logic only, matching the repo's existing test posture):**

- `session_mcp_config_json`: stdio server with args and env; http server; several servers;
  empty list; merged with the fleet block.
- `build_script` / `build_script_win`: `--strict-mcp-config` appears with the flag set and
  is absent without it.
- `idle_stop_targets`: stops a session that is alive and not running; skips a running one;
  skips one with no PTY; empty project yields nothing.

**Frontend:** no test runner exists, so `pnpm exec tsc --noEmit` plus `pnpm build`, and
then the app is actually launched under `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev` to
verify by hand:

1. Stop a session from the tab X → memory drops in Activity Monitor; sidebar dims.
2. Click it → it resumes with its conversation, and the screen repaints (the nudge).
3. Scrollback from before the stop is still there.
4. Quit and relaunch with restore-on-open enabled → the stopped session stays stopped.
5. Stop a *running* session → confirm prompt appears first.
6. "Stop idle sessions" leaves a running session alive.
7. New session with two of four MCP servers checked → `/mcp` lists exactly those two.
8. New session with all boxes checked → `/mcp` lists what it lists today.
9. The continuity check above.

## Migration and compatibility

Both fields are `#[serde(default)]` additions, so an existing `state.json` loads with
`stopped: false` and `mcp_servers: None` — i.e. current behavior. No migration step, and a
downgrade drops the two fields harmlessly.

## Version

MINOR — a shipped, user-facing capability. `0.19.0` across `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, with a matching `CHANGELOG.md`
entry.
