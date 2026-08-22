# Command Code as a Conduit agent

Date: 2026-08-23
Status: design, being implemented on `feat/commandcode-agent`

## What Command Code is

A terminal coding agent (`npm i -g command-code`, v1.32.1 at time of writing) that
fronts ~58 models from Anthropic, OpenAI, Google, xAI, Meta and a large open-source
set behind one subscription. Its shape is close enough to Claude Code that most of
Conduit's existing seams take it without modification -- and the places where it is
NOT close are the interesting part of this document.

Everything below was verified against the installed CLI (`cmdc --help`,
`cmdc --list-models`, `cmdc status --json`) and the shipped bundle, not from the docs
alone; where the docs and the binary disagree, the binary wins and the disagreement is
called out.

## The binary is called `cmd`, and that is a problem

The package installs four aliases -- `cmd`, `cmdc`, `command-code`, `commandcode` --
all pointing at `dist/index.mjs`.

On Windows `cmd` is unusable, and not merely ambiguous:

- `C:\Windows\System32\cmd.exe` is ahead of the npm prefix on PATH, so `cmd` resolves
  to the system shell.
- Conduit spawns Windows sessions as `cmd.exe /K "cd /d <dir> && <agent> ..."`. An
  agent literally named `cmd` would spawn a nested command interpreter inside its own
  shell, forever.

Command Code's own code agrees -- the bundle contains:

```js
function getBinaryCommand(){return"win32"===process.platform?"cmdc":"cmd"}
```

So `CommandCodeAdapter::binary()` returns `cmdc` on Windows and `cmd` elsewhere,
matching the vendor exactly. `cmdc` exists on every platform, so if this ever causes
trouble the safe move is to use `cmdc` everywhere rather than to reach back for `cmd`.

## What maps onto existing seams unchanged

| Conduit seam | Command Code |
| --- | --- |
| `install_command()` | `npm install -g command-code` |
| `account_env()` | resolves home via `HOME`/`USERPROFILE`, so the existing profile-root redirect works |
| `hooks_profile()` | `settings.json`/`settings.local.json` with Claude Code's exact `hooks` schema |
| `mcp_add_command()` | `cmd mcp add` / `add-json` / `remove` |
| initial prompt | positional argument, same as Claude |

The hooks match is the valuable one. Command Code emits **four** events --
`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart` -- with Claude-shaped stdin
(`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, plus
`tool_name`/`tool_input`/`tool_response`). Conduit's `HooksProfile` is already generic
over `config_rel_path` and a list of `(event, matcher, verb)` rows, and `command()`
already emits a cmd.exe-native form on Windows. So Command Code gets real session
status -- idle/running/needsInput -- on day one, which `agy` still does not have.

It gets the four events it supports and nothing else. Claude's profile also installs
`UserPromptSubmit`, `Notification` and `PreCompact`; writing those into Command Code's
settings would be inert at best and rejected at worst.

Hooks are written to `.commandcode/settings.local.json`, not `settings.json`, for the
same reason Claude's go to `.claude/settings.local.json`: the non-local file is the one
a team commits.

## Resume: the one place it is better than Claude

Claude lets Conduit PIN a session id (`--session-id <uuid>`), so resume is
`--resume <our own id>`. Command Code has no such flag. `--session <path|id>` RESUMES
by an id that Command Code chose; `-r`/`-c` are interactive or directory-scoped.

That is the same shape as `agy`, which Conduit solves with an unpleasant heuristic:
watch for a conversation db that did not exist at spawn time, disambiguated by a
spawn-time baseline so two sessions sharing a home cannot cross-capture.

Command Code needs none of that. Its `SessionStart` hook carries `session_id`, and
Conduit's hook URL already carries `?session=<conduit session id>`. So the mapping
arrives **keyed on both sides in one payload**, race-free, with no filesystem
archaeology and no baseline. Capture it once into the existing
`Session.agent_conversation_id` and the next spawn resumes with
`--session <captured id>`.

This is worth stating plainly because it is a trap: the obvious move is to copy the
`agy` capture path since the constraint looks identical. It is not identical -- `agy`
fires no lifecycle hooks, which is the ONLY reason that heuristic exists.

## Usage detection

`/usage` is an interactive slash command; there is no headless usage subcommand, and
`cmd status --json` returns only `{"authenticated":bool,"version":string}`.

The bundle shows where the TUI actually gets its numbers -- `https://api.commandcode.ai`
with a bearer token from `~/.commandcode/auth.json`:

- `/alpha/usage/summary` -- the rolling-window meters
- `/alpha/billing/credits` -- credit balance
- `/alpha/billing/subscriptions` -- plan identity
- `/alpha/whoami` -- account identity

The limit model is two rolling windows (5-hour and weekly) over monthly credits, both
opening on first request rather than on a calendar boundary, with per-plan caps
(`Go`, `GOAT`, `Pro`, `Provider`, `Max`, `Ultra`, `Teams Pro`). Extra pay-as-you-go
credits are never capped and are spent first once a window is exhausted.

Conduit reads these the way `claude_usage.rs` already reads Claude's: shell out to
`curl` (the Rust side deliberately has no HTTP client -- see CLAUDE.md), on explicit
poll, holding the token in memory and never logging or persisting it.

**These endpoints are `/alpha/`.** They are an internal surface of a CLI at v1.32.1 and
will move. Every field is therefore optional on the way in, and a shape Conduit does
not recognize degrades to "usage unavailable" rather than to a wrong number or a panic.
A usage meter that lies is worse than one that admits it does not know.

## Model routing already exists inside Command Code

`config.json` carries a `featureModels` map that routes Command Code's own internal
tasks to cheap models:

```
titleGeneration: deepseek-v4-flash    compaction: deepseek-v4-pro
toolDescription: deepseek-v4-flash    branchSummarization: deepseek-v4-pro
tasteOnboarding: deepseek-v4-flash    vision: xiaomi/mimo-v2.5
```

This is the same idea as the cross-agent routing preferences designed in
`2026-08-23-agent-preferences-design.md`, one level down. The two must not fight:
Conduit's preferences decide **which agent and which top-level model** a session
starts with (`--model`, `--effort`); `featureModels` stays Command Code's business and
Conduit only surfaces it read-mostly in the config GUI.

## Not doing yet, and why

- **Conduit-managed worktrees** (`supports_worktree()` stays false). Command Code has
  its own `-w/--worktree`, so there are two worktree managers in the room and no way to
  tell which owns the directory. Picking a winner deserves its own change.
- **Approvals.** Conduit's hook transport discards the hook's stdout, so the
  `permissionDecision` channel is not reachable without changing that transport.
  Sessions run with Command Code's own prompting, exactly as they do standalone.
- **Trust/private mode.** OpenCode's provider-pinning has no Command Code analogue that
  has been verified, so nothing is claimed.
