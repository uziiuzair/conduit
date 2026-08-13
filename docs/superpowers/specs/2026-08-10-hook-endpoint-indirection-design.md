# Hook endpoint indirection

**Date:** 2026-08-10
**Status:** Design
**Sub-project:** 2 of 6 — see `2026-08-10-nodeterm-lessons-overview.md`

## Problem

Conduit's hook listener binds the first free port in `8423..=8443` (`hooks.rs:52`). That port
is then written into two places, both of which fix it in time:

1. The hook command in the agent's `settings.json`, as the literal default in
   `${CONDUIT_HOOK_PORT:-<port>}` (`hooks.rs:729`).
2. The session's environment, as `CONDUIT_HOOK_PORT`, applied by `CommandBuilder` at spawn
   (`pty.rs`).

Both are correct at the moment they are written and can go stale afterwards. The port changes
whenever a lower port in the range frees up or a higher one is taken — most commonly when a
second Conduit (a dev build alongside the installed app) starts or stops, or when the app is
restarted while something transient holds 8423.

When it goes stale, the failure is silent and total: `curl` posts to a port nobody is
listening on, `|| true` swallows the error, and the session's status badge, To-dos panel, and
usage tally simply stop updating. Nothing is logged and nothing looks broken.

Today this is masked because a restart also respawns every session, so the fresh env carries
the fresh port. **It stops being masked the moment tmux persistence lands**, because a tmux
session survives the restart with its original environment. Sub-project 1 would write this
bug into the new spawn path if this lands after it. That is why this is sequenced first.

`is_conduit_entry` (`hooks.rs:749`) also matches any hook command containing the substring
`CONDUIT_SESSION_ID`, which would delete a foreign tool's hook if that tool ever referenced
Conduit's variable. This is a much smaller risk than nodeterm's was — their marker was a
directory name other apps genuinely use — but the fix is one line and is included here.

## What nodeterm does

The session env carries a *path*, not a port. The hook script sources that file at run time
to pick up the live port and token (`src/core/agents/hooks/managed-script.ts`). The endpoint
file is rewritten on every boot, so a session spawned under a previous port finds the current
one the first time it fires a hook.

They also added failover: if the POST fails, retry once against the freshest *other* endpoint
file on the machine, which heals a session whose owning app is gone but whose host runs
another Conduit-like process. That part is out of scope here — Conduit has no headless
sibling for a session to fail over to.

## Design

### The endpoint file

On boot, after the listener binds, write `<dataDir>/hook-endpoint.sh`:

```sh
CONDUIT_HOOK_PORT=8423
```

One assignment, no export, no shebang — it is sourced, never executed. It is rewritten on
every boot and on any rebind.

It lives in the data dir rather than a machine-stable path such as `~/.conduit/`. This is a
deliberate divergence from nodeterm. Conduit's data dir is overridable via
`CONDUIT_DATA_DIR_NAME`, which is precisely how a dev build is isolated from the installed
app (see CLAUDE.md). A machine-stable path would let the dev build's port overwrite the
installed app's, which is the exact class of bug nodeterm's field report describes — they
reached the same isolation by a different route, because their dev isolation works
differently.

### The hook command

`hooks.rs::command` gains a source step ahead of the existing `curl`, on the POSIX branch
only:

```sh
[ -n "$CONDUIT_HOOK_ENDPOINT" ] && [ -r "$CONDUIT_HOOK_ENDPOINT" ] && . "$CONDUIT_HOOK_ENDPOINT";
curl -s -m 2 -X POST -H "Content-Type: application/json" --data-binary @- \
  "http://127.0.0.1:${CONDUIT_HOOK_PORT:-<baked>}/hook?session=${CONDUIT_SESSION_ID:-unknown}&event=<event>" \
  >/dev/null 2>&1 || true
```

The resolution order that produces is, freshest first:

1. `CONDUIT_HOOK_PORT` from the sourced endpoint file — always current, because the file is
   rewritten every boot.
2. `CONDUIT_HOOK_PORT` from the session environment — correct at spawn, possibly stale.
3. The literal baked at install time — correct at install, most likely to be stale.

Each layer is a strictly better guess than the one under it, and every layer that fails falls
through to the next rather than erroring.

The `&&` chain is safe as the leading statement because it is followed by `;` and the `curl`
runs unconditionally afterwards. A missing or unreadable endpoint file leaves the sourced
step false and changes nothing — the command behaves exactly as it does today.

### The session environment

`pty.rs` keeps setting `CONDUIT_HOOK_PORT` (so layer 2 still exists for a session spawned
before the endpoint file was written) and adds `CONDUIT_HOOK_ENDPOINT` pointing at the
absolute path of the endpoint file.

### Windows

Untouched. `cmd.exe` cannot source a POSIX file, and the Windows branch already bakes the
port directly. The Windows path keeps today's behavior and today's staleness; tmux
persistence does not apply there either, so the failure stays masked by respawn exactly as
it is now.

### Marker tightening

`is_conduit_entry` changes from `command.contains("CONDUIT_SESSION_ID")` to a match on
`"/hook?session=${CONDUIT_SESSION_ID"` (POSIX) or `"/hook?session=%CONDUIT_SESSION_ID%"`
(Windows) — that is, the marker becomes the routing path, which is unmistakably ours, rather
than a bare variable name that another tool could legitimately reference.

This must keep matching entries written by *older* Conduit versions, or an upgrade would
duplicate every hook instead of replacing it. Both old and new commands contain the routing
substring, so the tightened matcher is strictly more specific and remains backward
compatible. A test asserts that an entry written by the current shipped format is still
recognized.

## Testing

Extending the existing `hooks.rs` test module:

- The endpoint file's contents parse as a single `KEY=value` line and round-trip through `sh`.
- The generated hook command sources `$CONDUIT_HOOK_ENDPOINT` before the `curl`.
- The generated hook command still ends in `|| true`, so it can never block a prompt.
- The port resolution order is correct — asserted by running the generated command under `sh`
  with a fake endpoint file and a fake `curl` on `PATH`, capturing the URL it was called with.
  This is the test that actually proves the feature, and it is worth the extra setup.
- A command with no endpoint file set behaves identically to the current one.
- `is_conduit_entry` matches the new format, matches the currently shipped format, and does
  *not* match a foreign hook that merely mentions `CONDUIT_SESSION_ID`.
- `install` remains idempotent and still preserves foreign hooks (existing tests, unchanged).

## Failure modes

| Failure | Behavior |
| --- | --- |
| Endpoint file missing | Falls through to session env, then to the baked literal |
| Endpoint file unreadable | Same |
| Endpoint file corrupt | `.` fails; `sh` continues; falls through to the next layer |
| Data dir not writable | No file written; behavior is exactly today's |
| Port changes while a session runs | Next hook sources the new port and recovers with no user action |

## Deferred

- **Cross-install failover.** nodeterm scans sibling endpoint files when its own is dead.
  Conduit has no headless sibling, so there is nothing to fail over to.
- **A token.** nodeterm's endpoint file carries a shared secret as well as a port. Conduit's
  listener is loopback-only and unauthenticated today; adding a token is a real hardening
  step but it is a separate change with its own compatibility story.
