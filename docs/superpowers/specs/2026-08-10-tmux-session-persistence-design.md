# tmux-backed session persistence

**Date:** 2026-08-10
**Status:** Design
**Sub-project:** 1 of 6 — see `2026-08-10-nodeterm-lessons-overview.md`

## Problem

Conduit spawns each session as a `portable_pty` child of the app process. When Conduit
quits, every agent dies with it. "Session restore" today means re-spawning the CLI and
asking it to replay the conversation — `claude --resume <id>`, `agy --conversation=<uuid>`.

That reconstructs the *conversation* but not the *session*. Specifically it loses:

- **Work in flight.** An agent mid-turn is killed. A ten-minute build, a long test run, a
  half-finished edit — gone, with no record that they were running.
- **Scrollback.** The pane comes back empty; everything printed before the quit is gone.
- **Non-agent state.** A `shellOnly` companion shell loses its cwd, its history, its
  environment, and any process it was running.
- **Anything without a resume token.** Codex, opencode, and plain shells have no `--resume`
  equivalent, so for them restore is not partial — it is nothing.

It also produces a class of bug that looks like a data problem and is not: the known
"resume fails" report is an alt-screen replay that is never repainted on cold spawn. The
data was always fine. Attaching to a live session instead of replaying a transcript makes
that whole class disappear, because there is no replay.

## What nodeterm does

Every node attaches to a tmux session named after the node id, on a private socket, using a
generated config so the user's `~/.tmux.conf` cannot interfere
(`src/core/pty-manager.ts:116`, `src/core/tmux-naming.ts:4`):

```
tmux -L node-terminal -f <generated.conf> new-session -A -D -s nt-<nodeId> -c <dir> <cmd>
```

`-A` means attach-or-create: if the session exists, attach and ignore the command; if not,
create it and run the command. `-D` detaches any other client, which cleans up a client
stranded by a crashed app. The result is exactly one tmux client per session, so tmux's own
multi-client resize negotiation never applies.

Closing a node detaches. The tmux server outlives the app, so relaunching reattaches to
processes that never stopped.

nodeterm also snapshots scrollback to disk periodically, so a machine reboot (which does
kill the tmux server) can still replay recent output. That part is explicitly out of scope
here — see Deferred.

## Design

### Shape

A new Rust module `src-tauri/src/tmux.rs` holds every tmux-specific decision as pure,
testable functions. `pty.rs` gains a thin wrapping layer and nothing else. The split matters
because `pty.rs` is already 1261 lines and is the most load-bearing file in the backend;
everything that can be decided without a live PTY is decided in `tmux.rs` and unit-tested.

`tmux.rs` owns:

- `fn socket_name() -> &'static str` — `"conduit"`. A private socket, so Conduit's sessions
  never appear in the user's own `tmux ls` and the user's sessions never appear in ours.
- `fn session_name(session_id: &str) -> String` — `cdt-<sanitized>`, where sanitization
  replaces every character outside `[A-Za-z0-9_-]` with `_`. This is the persistence key and
  must never change once shipped.
- `fn find_tmux() -> Option<PathBuf>` — probes `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`,
  `/usr/bin/tmux`, `/bin/tmux`, then scans `$PATH`. Deliberately subprocess-free: resolving
  tmux by spawning a login shell costs 100–800 ms on a machine with nvm or conda, on the main
  thread, and nodeterm's comment records that as a real regression they had to undo.
- `fn conf_body(scrollback: u32) -> String` — the generated config.
- `fn wrap_command(...) -> String` — builds the `tmux … new-session …` line from the existing
  inner script.

### The generated config

Written once per boot to `<dataDir>/conduit.tmux.conf`. The tmux server outlives the app and
will not re-read `-f` on relaunch, so boot also runs `tmux -L conduit source-file <path>`
best-effort to push changes into an already-running server.

```
set -g status off
set -g history-limit <scrollback>
set -g escape-time 0
set -g mouse on
set -g focus-events on
set -g set-clipboard on
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g destroy-unattached off
```

`status off` matters: a tmux status bar would eat a row and appear inside Conduit's pane,
which is not what the user asked for.

`mouse on` is a deliberate reversal of what might seem right. The instinct is to take
scrolling away from tmux so xterm.js keeps its own scrollback. nodeterm tried exactly that
and recorded why it fails structurally (`pty-manager.ts:101`): tmux is a screen painter, not
a stream. Every redraw repaints the visible region only, so xterm.js's scrollback fills with
fragments of repainted frames rather than a coherent history. With `mouse on`, the wheel
scrolls tmux's own history, which is the only copy that is actually correct.

`set-clipboard on` gives OSC 52 copy out of tmux's copy-mode. On tmux 3.2+ this is the
supported route; the older `terminal-overrides ',xterm*:Ms=\E]52;...'` form does not work.

### Spawn

The POSIX branch of `PtyManager::spawn` currently builds:

```
export CONDUIT_SESSION_ID=<id> CONDUIT_HOOK_PORT=<port>; cd <dir> && <invocation>; exec <shell> -i -l
```

With tmux available and persistence enabled, that string becomes the *inner* command and the
outer becomes:

```
export CONDUIT_SESSION_ID=<id> CONDUIT_HOOK_ENDPOINT=<path>; exec <tmux> -L conduit -f <conf> \
  new-session -A -D -s cdt-<id> -c <dir> sh -c <quoted inner>
```

Three details carry weight:

1. **The `export` stays outside.** tmux copies the creating client's environment into a new
   session, so the exported variables land in the session and persist for its lifetime. On
   attach they are not re-applied, which is correct: the existing session already has its own
   correct id.
2. **`-A` makes resume conditional for free.** On create, the inner command runs, and the
   inner command is the existing `build_script` output including any `--resume` flag. On
   attach, tmux ignores the command entirely, so a live agent is never resumed out from under
   itself. No new branch is needed in the resume logic; the existing logic simply stops being
   reached in the attach case.
3. **`exec`** replaces the login shell with tmux, so there is no extra process between the PTY
   and the tmux client.

Windows takes no part in this. tmux is Unix-only; the `#[cfg(windows)]` branch of `spawn` is
untouched and the feature reports itself unavailable there.

### Kill semantics

This is the part that is easy to get wrong, and Conduit's existing call sites already encode
the right distinction — every current caller of `kill()` means destroy, and every current
caller of `kill_all()` means quit:

| Call site | Intent | tmux behavior |
| --- | --- | --- |
| `lib.rs::remove_session` | destroy | `kill-session` |
| `lib.rs::remove_project` | destroy | `kill-session` per session |
| `Sidebar.tsx` worktree removal | destroy | `kill-session` (git needs the lock released) |
| `Terminal.tsx` shell-only dir change | destroy | `kill-session` (respawn follows) |
| `fleet_mcp.rs` `fleet_stop` | destroy | `kill-session` |
| `lib.rs` / `menu.rs` app quit | detach | nothing — drop the PTY only |

So `PtyManager::kill(session_id)` gains a `tmux kill-session -t cdt-<id>` after dropping the
PTY, and `kill_all()` deliberately does not. The asymmetry is the whole feature and needs a
comment saying so, because the natural instinct when reading `kill_all` is to make it
consistent with `kill`.

`bridge.rs:438` also calls `kill()`; it is the mobile channel's session-stop path, which is
a destroy intent, so it inherits `kill-session` correctly.

### Orphan sweep

A tmux session whose Conduit session no longer exists is a leak: it holds a process forever
and nothing will ever attach to it. On boot, after the store loads, list `tmux -L conduit
list-sessions -F '#{session_name}'`, and kill any `cdt-*` name whose decoded id is absent
from the store. Best-effort and silent; a tmux that is not installed or not running yields no
sessions and no error.

### Settings

One new boolean, `persistSessions`, following the existing `restoreSessionsOnOpen` pattern
exactly: a `localStorage` key read at store construction, a field on the store, a setter, and
a toggle in `GeneralSettings.tsx` under General.

- Default **on** when tmux is present, **off** and disabled with an explanatory hint when it
  is not.
- Turning it off does not kill existing tmux sessions; it only stops new spawns from using
  tmux. Existing sessions keep working until they are destroyed. This avoids a setting toggle
  that silently destroys running work.
- The frontend learns tmux availability from a new `tmux_available` command returning
  `{ available: bool, version: Option<String> }`.

### Interaction with existing features

- **`restoreSessionsOnOpen`** is unchanged and still governs whether opening a project eagerly
  spawns its sessions. With tmux on, that eager spawn becomes an eager *attach*, which is
  faster and lossless. The two settings compose rather than conflict.
- **The quit guard** (`live_running_agent` in `lib.rs`) stays. With tmux, quitting no longer
  kills the agent, so the guard's copy should change from a warning about losing work to a
  statement that the agent will keep running in the background. The guard itself is still
  wanted: a user quitting with an agent mid-turn should know.
- **The unified session directory** (`effectiveDirOf`, `useSessionDirs`) is untouched. tmux
  receives the already-resolved directory via `-c`, so a pending worktree still keeps the
  shell's `dirReady` gate closed exactly as before.
- **Keep-alive terminals** are untouched. This is a backend change; no component mounts,
  unmounts, or reparents differently.

## Testing

Pure functions in `tmux.rs` carry the test weight, following the pattern already established
in `hooks.rs`:

- `session_name` sanitizes, is stable, and is idempotent.
- `session_name` never produces a name that could collide across two distinct session ids.
- `conf_body` contains `status off` and the requested history limit.
- `wrap_command` produces a correctly quoted command line for an inner script containing
  single quotes, double quotes, `$`, and backticks.
- `wrap_command` includes `-A` and `-D` and targets the private socket.
- `find_tmux` returns `None` when no candidate path exists and `$PATH` is empty.
- The orphan sweep's pure half — given a list of tmux session names and a list of live
  session ids, return the names to kill — is a function, and is tested directly.

Integration behavior (attach-vs-create, survival across quit) is verified by hand in the dev
app, per the repo's testing rules. The verification script is in the plan document.

## Failure modes and how each degrades

| Failure | Behavior |
| --- | --- |
| tmux not installed | Feature reports unavailable; spawn takes today's exact path |
| tmux present but `new-session` fails | Spawn falls back to the direct path; a warning is logged once |
| tmux server killed externally | Next spawn creates a fresh session; the agent cold-starts with `--resume` as today |
| Machine reboot | tmux server is gone; sessions cold-start with `--resume` as today |
| Stale client from a crashed app | `-D` detaches it on attach |
| A session id containing shell metacharacters | Sanitized by `session_name`; the quoted `-s` argument is never interpolated raw |

Every row degrades to current behavior. There is no failure mode that is worse than today.

## Deferred

- **Scrollback snapshots across reboot.** nodeterm periodically captures pane contents to disk
  so a reboot can replay recent output. Real value, but it is a separate feature with its own
  storage and expiry concerns, and it is only reachable once tmux is in place.
- **Co-attach.** nodeterm supports N viewers of one session with a single tmux client.
  Conduit has one viewer per session today, so this is not yet needed.
- **Windows.** No tmux equivalent worth the complexity. Conduit on Windows keeps today's
  behavior.

## Open question for review

The `mouse on` decision changes scrolling from xterm.js's scrollback to tmux's. This is the
right call per nodeterm's recorded experience, but it is a visible behavioral change: the
scrollback limit becomes tmux's `history-limit` rather than xterm.js's, and selection goes
through tmux copy-mode. If that trade is unwanted, the alternative is `mouse off` plus
accepting that scrollback in a persisted session is fragmentary — which is worse, but it is a
choice worth making explicitly rather than by default.
