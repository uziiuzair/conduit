# Antigravity (agy) usage bar — design

**Status:** implemented (2026-07-12)
**Scope:** a sidebar usage meter for `agy` (Antigravity) sessions, mirroring the Claude
usage panel but sourced entirely from agy's own extension surface.

## Problem

Conduit shows a bottom-left usage meter for Claude sessions (plan/local token usage), but
`agy` sessions show nothing. We want the equivalent for agy: its subscription **quota**
(and, later, credits), in a visually distinct panel.

## Why this approach (and what we rejected)

Antigravity exposes usage in exactly one place a third party can read safely:

- **agy's status-line command hook** (`~/.gemini/antigravity-cli/settings.json` →
  `statusLine.command`). agy pipes a JSON payload to a user-configured command on each
  agent-state change; the command's stdout becomes agy's status line. This is agy's own
  **documented extension mechanism** — reading the payload it hands us is inside the
  product, not "third-party software accessing Antigravity" (which Google's FAQ forbids,
  naming Claude Code/OpenCode; account suspension is the stated penalty).

Rejected alternatives:
- **Local language-server RPC** (`127.0.0.1/.../RetrieveUserQuotaSummary`). Returns the
  same data with no auth, and works — but Conduit calling agy's private server *is* the
  "third-party access" the ToS forbids. Not worth the user's account.
- **Cloud Code Assist API** (`cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`).
  Needs the user's OAuth token from the OS keyring; undocumented and ToS-adjacent.
- **Reading local files.** agy stores no token/quota counts on disk (conversation DB has
  no token columns; transcripts record only step/status).

## The two gotchas that make this non-obvious

1. **agy execs the status-line command WITHOUT a shell.** It tokenizes the command string
   into program + args and runs it directly — so `&`, `>`, `%VAR%`/`$VAR`, `if`, `||` are
   all inert (an inline `if defined … (curl …)` fails with exit 3 and does nothing). Fix:
   ship a helper **script** (`conduit-usage.bat` / `conduit-usage.sh`) beside settings.json
   and set the command to `cmd /c <path>` (Windows) / `sh <path>` (Unix). `cmd`/`sh` *is*
   the program agy execs; it then runs the script with a real shell (env expansion,
   stdin = the payload, stdout = the status line). Guard: `if not defined CONDUIT_HOOK_PORT
   exit /b 0` so a standalone agy (outside Conduit) is a clean no-op.

2. **The home agy reads is not always Conduit's `~`.** A session with a `.claude` account
   runs with `HOME`/`USERPROFILE` redirected to the account root (see `pty.rs`). So the
   config must be written to the home *that session's* agy will actually read.
   `resolve_agy_home(account_config_dir)` mirrors that redirect; the config is (re)synced
   into the resolved home on every agy spawn.

## Data flow

```
agy (per state change) ──JSON payload on stdin──▶ conduit-usage.{bat,sh}
      ▲                                                    │ curl POST (localhost)
      └──────── status-line string (HTTP response) ────────┤
                                                            ▼
   hook server  /hook?session=…&event=agyusage  (hooks.rs)
      │ parse_statusline_payload → AgyUsage
      │ store (in-memory) + emit "agyusage"           (agy_usage.rs)
      ▼
   AgyUsagePanel (violet meters, gated on agent==="antigravity")
```

Same pattern Conduit already uses for Codex result reporting (a helper that curls the
local hook server).

## Data model

The payload's `quota` map is `{ "<bucketId>": { remaining_fraction, reset_time, disabled? } }`.
Bucket ids observed: `gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`. We group by prefix
into two pools ("Gemini Models", "Claude & GPT Models"), each with a Weekly + 5-hour meter
showing `remaining_fraction`. Also surfaced: `plan_tier`, `context_window`. The bucket-id
set is under-documented and drifts, so parsing enumerates the map dynamically and
degrades gracefully (unknown prefix → title-cased group) rather than hard-keying.

## Security / correctness notes

- The `event=agyusage` endpoint is **untrusted, unauthenticated, localhost display-data**
  — same trust model as every other hook event. Nothing keys a security decision off it;
  a spoofed post at worst shows wrong numbers.
- The usage snapshot lives in memory only (never persisted); the status-line string
  returned to agy carries no email/token. `CONDUIT_HOOK_LOG` logs a redacted summary, not
  the raw body (which contains the account email).
- Quota-less ticks (startup/idle) are dropped (`has_data()`) so they can't clobber a good
  snapshot. settings.json is written atomically (temp + rename) and the per-spawn sync
  short-circuits when already current, so agy's live config is never half-written or
  needlessly churned. We never overwrite a user's own custom `statusLine`.

## Known limitations

- The helper path is unquoted, so a home directory containing spaces is unsupported (agy's
  shell-less tokenizer constrains the command form).
- Credits (`/credits`) are not yet surfaced — only subscription quota (`/usage`).
- Data refreshes on agy activity (the status line only fires while agy runs).
