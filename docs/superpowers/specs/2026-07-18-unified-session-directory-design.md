# Unified Session Directory ("Effective Dir") — Design

**Date:** 2026-07-18
**Status:** Approved, pending implementation
**Problem owner:** Panel unity — Files, Changes, Git, and the right-panel shell terminal must all
operate on the same directory as the agent session, and re-sync when that directory changes.

## Problem

Each session resolves its working directory as `worktreePath ?? project.path`
(`workingDirOf`, `src/store.ts:2345`). The Files, Changes, and Git panels already read this
value, so they agree with each other. Two things break the unity:

1. **The shell terminal spawn race (the "`~/` bug").** The right-panel shell terminal
   (`RightColumn.tsx` → `TerminalView` with `shellOnly`) passes the correct
   `workingDirOf` value, but the PTY spawns exactly once, lazily, on first reveal
   (`Terminal.tsx` `spawnedRef` guard). For a worktree session, `session.worktreePath` is
   computed at session creation (`store.rs`), but the directory itself is created *later* by
   the agent (`claude --worktree <slug>`, see `worktree::spawn_target`,
   `src-tauri/src/worktree.rs:55-66`). If the shell PTY spawns before the directory exists,
   `cmd.cwd()` (`pty.rs:280`) points at a nonexistent path and the shell falls back to the
   home directory — and never recovers, because nothing re-syncs a live PTY. The agent
   terminal is immune: `pty_spawn` computes its real cwd via `worktree::spawn_target`. The
   shell terminal has no equivalent handling.

2. **No observed state.** Nothing tracks whether the resolved directory actually exists.
   Before a worktree materializes, panels query a nonexistent path (silently empty); if a
   worktree is later deleted, panels break the same way. Spawn order matters when it
   should not.

## Decision summary (from brainstorming)

- **Sync model: static resolution, races fixed.** The single truth is the session's
  resolved directory (`worktreePath ?? project.path`), confirmed against the filesystem.
  No live tracking of the agent process's actual cwd (hooks/OSC/lsof) — rejected as a
  larger, per-agent-adapter effort with little user-visible gain over static + confirmation.
- **Shell fix: defer spawn** until the resolved directory exists on disk. No injected
  `cd` keystrokes.
- **Live re-sync: respawn the shell PTY** when a session's effective directory changes
  after spawn (worktree materializes late, or worktree deleted → fall back to project
  root). Shell scrollback for that pane is lost — accepted. Agent terminals are never
  killed or respawned (keep-alive rule intact).
- **Mechanism: store-centralized resolve + targeted polling** (Approach A). Rejected:
  backend fs-watch events (new dependency, no user-visible gain over a 1 s poll that lives
  for seconds) and Claude-hook-driven confirmation (agent-specific; agy/OpenCode would
  need the polling fallback anyway, leaving two code paths).

## Design

The pattern is desired state vs. observed state. `session.worktreePath` is *desired*;
the new `sessionDirs` map is *observed-confirmed*. All panels and the shell terminal bind
to observed state, which makes spawn order irrelevant.

### 1. Single source of truth — store

`src/store.ts`:

- New state: `sessionDirs: Record<string, string>` (session id → confirmed effective
  directory). Not persisted — rebuilt at runtime by the resolver hook.
- New action: `setSessionDir(sessionId: string, dir: string)`.
- New selector: `effectiveDirOf(project, session, sessionDirs): string` — returns
  `sessionDirs[session.id] ?? project.path`.
- `workingDirOf` remains as the statement of *intent* (`worktreePath ?? project.path`),
  used only by the agent-terminal spawn path (the resolver reads `session.worktreePath`
  directly).

Resolution rule per session:

| Session state | Effective dir |
| --- | --- |
| No `worktreePath` | `project.path`, immediately; never polled |
| `worktreePath` set, dir not yet confirmed on disk | `project.path` |
| `worktreePath` set, dir confirmed on disk | `worktreePath` |
| `worktreePath` confirmed, then dir disappears | falls back to `project.path` |

### 2. Resolver hook — one poller, app level

New `src/hooks/useSessionDirs.ts`, mounted once in `App.tsx` (same pattern as
`useClaudeAmbient`). For every session of every open project:

- No `worktreePath` → `setSessionDir(id, project.path)` once; no polling.
- `worktreePath` set, unconfirmed → check `invoke("dir_exists", { path: worktreePath })`
  every **1 s**; on true, `setSessionDir(id, worktreePath)`. While pending, **no map
  entry is written** — panels get `project.path` via the `effectiveDirOf` fallback, and
  the absence of an entry is what keeps the shell's `dirReady` false (see section 4).
- **Deletion sweep:** every **~5 s**, re-check each *confirmed* worktree directory; if it
  no longer exists, `setSessionDir(id, project.path)` (and the 1 s confirmation poll
  resumes, in case the worktree is recreated).

Polling cost: one `stat` per second per *unconfirmed* worktree session — a state that
normally lasts a few seconds after session creation. No cap needed. If a worktree never
materializes (agent spawn failed), panels stay usable on `project.path` and the poll
continues while the project is open — one stat/second is negligible.

Rust: new `dir_exists(path: String) -> bool` Tauri command in `src-tauri/src/fsops.rs`,
registered in `lib.rs`. Returns true only for an existing *directory* (not a file). Pure
function, unit-tested.

### 3. Consumers — everything reads the effective dir

| Call site | Today | Change |
| --- | --- | --- |
| `RightColumn.tsx:76` — Files root, `git_changes`, `git_graph`, `git_branch` | `workingDirOf` | effective dir |
| `RightColumn.tsx:262` — shell `TerminalView` `workingDirectory` | `workingDirOf` | effective dir + `dirReady` prop |
| `WorkspaceCenter.tsx:409` — file-tab working dir | `workingDirOf` | effective dir |
| `Sidebar.tsx:770` — "Open in VSCode" | `workingDirOf` | effective dir |
| `WorkspaceCenter.tsx:245` — agent terminal spawn | `useWorktree ? project.path : workingDirOf` + `worktreeName` | **untouched** — backend `worktree::spawn_target` already resolves the race |

Panels re-render from the store when the confirmed dir flips, so Files/Changes/Git move
from project root to worktree automatically the moment it materializes (`refreshGit`'s
dependency on the directory already triggers the reload).

### 4. Shell terminal — deferred spawn + respawn on change

`src/components/Terminal.tsx`, scoped strictly to `shellOnly`:

- **New prop `dirReady: boolean`** (default `true`, so agent terminals are unaffected).
  The spawn effect waits for `visible && dirReady` before calling `pty_spawn`. RightColumn
  computes `dirReady = !session.worktreePath || sessionDirs[session.id] !== undefined` —
  i.e. non-worktree sessions are ready immediately; a worktree session is ready once the
  resolver has written *any* entry for it: the worktree path on confirmation, or the
  project root after a confirmed worktree was deleted. A *pending* worktree session (no
  entry yet — the worktree has never been seen on disk) keeps a blank, unspawned shell
  pane rather than spawning at the project root and respawning seconds later. Panels are
  unaffected while pending: `effectiveDirOf` falls back to `project.path`. Only the
  reveal spawn path needs the gate — the eager restore-on-open path already skips
  `shellOnly` terminals.
- **Respawn on dir change:** an effect watching `workingDirectory` after spawn. When it
  changes for an already-spawned `shellOnly` terminal: `invoke("pty_kill", { sessionId })`
  (`lib.rs:422`), `term.reset()`, then `spawnPty` again with the new directory. In
  practice this fires when a confirmed worktree is deleted (worktree → project root) or
  later recreated (project root → worktree).
- Agent terminals (`shellOnly = false`): zero changes. The keep-alive rule
  (never unmount, never reparent, never kill on layout change) is untouched.

### 5. Edge cases

- **Session without worktree:** identical behavior to today; zero polls, `dirReady` true
  from the start.
- **Restored session, worktree already on disk:** first `dir_exists` check confirms
  immediately; no visible delay.
- **Worktree never materializes** (agent spawn failed): panels operate on `project.path`
  so the session stays usable; the shell pane stays blank until the directory appears.
  The 1 s poll idles harmlessly until the project closes.
- **Two sessions in one project with different worktrees:** the per-session map keys by
  session id; each resolves independently.
- **Worktree deleted while shell is mid-command:** the respawn kills the foreground
  command. Accepted for v1 (the alternative — idle detection via process-group inspection —
  was considered and deferred; the deleted-worktree case is rare and the shell was pointed
  at a dead directory anyway).
- **Legacy `~/` shells from before this change:** shipping this feature requires an app
  update and restart, which tears down every PTY; on next launch the deferred-spawn gate
  puts every shell in the right directory. No special mid-flight healing path is needed.

### 6. Testing

- **Rust:** unit tests for `dir_exists` — existing directory → true; missing path → false;
  existing *file* → false.
- **Frontend:** `pnpm exec tsc --noEmit` and `pnpm build` must pass. No JS test runner
  exists; behavior is verified by launching the dev app
  (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`) and checking:
  1. New worktree session → shell terminal lands inside the worktree (not `~`, not repo
     root) once the worktree materializes.
  2. Files/Changes/Git show the worktree contents, matching the agent.
  3. Delete the worktree from another terminal → panels and shell fall back to the
     project root within ~5 s.
  4. Non-worktree session → no behavior change; shell spawns immediately in
     `project.path`.

## Out of scope

- Live tracking of the agent process's actual `cwd` (agent `cd`s somewhere unrelated
  mid-session). The static resolved directory is the anchor by design.
- Changing agent-terminal spawn behavior or `worktree::spawn_target`.
- Idle-detection before shell respawn.
