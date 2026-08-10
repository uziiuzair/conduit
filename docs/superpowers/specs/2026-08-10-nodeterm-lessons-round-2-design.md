# nodeterm lessons, round 2 — eleven adoptions

**Date:** 2026-08-10
**Status:** Design, approved for implementation
**Predecessor:** `2026-08-10-nodeterm-lessons-overview.md` (sub-projects 1–6)

The first round took six lessons from nodeterm. A second read of the same codebase — this
time through the subsystems the first pass skipped (`core/context-tail.ts`,
`shared/agents/stale.ts`, `core/session-budget.ts`, `core/scrollback-store.ts`,
`core/subagent-tail.ts`, the command palette, the approval docs) — found eleven more. This
document is the record of what each one is, why Conduit needs it, and the decision taken.

They are grouped by the machinery they touch, not by value, because that is the order they
should be built in: each group is one increment that can ship on its own.

---

## Group A — the status mirror learns about time

Conduit's per-session status is a pure event→state switch, written twice: `fleet.rs`'s
`apply_event` (what the Conductor reads through `fleet_list`) and the `switch` in
`App.tsx`'s hook listener (what the sidebar dot renders). Neither has any notion of *when*
an event arrived, and three separate defects follow from that.

### A1 — a `working` session must be able to time out

**The defect.** A session leaves `running` only when something says so, and several exits
say nothing at all: Esc during a tool call (Claude aborts the tool and never runs `Stop`),
a killed CLI, a slept machine. The session then reads `running` forever.

This is not cosmetic. `fleet::conductor_wakeable` is `status != "running"`, so a Conductor
that dies mid-turn can never again be woken by a worker event — the orchestration silently
stops. The shutdown guard is protected (it cross-checks against a live PTY) but the sidebar
and `fleet_list` are not.

**The decision.** Copy nodeterm's structure, not just its constant. One module owns the
number and one place decides; every existing consumer already knows how to handle the
resulting state. `WORKING_STALE_MS = 20 minutes` — well past Claude's ~10-minute Bash cap,
so a genuinely long turn is never swept, and self-healing because one later event puts the
session straight back to `running`.

The sweep runs where the mirror is written (`FleetState`), on the same background thread as
the tmux orphan sweep, and the frontend applies the identical rule to its own `live` map so
the sidebar can't disagree with `fleet_list`.

### A2 — `done` must survive a late `working`

**The defect.** Claude runs hooks in parallel. A `PostToolUse` POST can land *after* the
`Stop` POST for the same turn; Conduit's `pretool` arm then sets `running` and nothing ever
clears it, so a finished session shows as busy until the next turn.

**The decision.** nodeterm's `DONE_HOLDOFF_MS = 3000`: for three seconds after entering
`done`, a `working` signal that is not a new turn is ignored. `prompt` (a real new turn) is
never held off — only the tool-level chatter is. This needs the `updated_at` that
`FleetStatus` already carries, plus the same field in `LiveState`.

### A3 — a notification is four different things

**The defect.** Both reducers map every `notification` event to `needsInput`. Claude's
payload carries a `notification_type` that distinguishes:

| `notification_type` | Meaning | Conduit today | Correct |
| --- | --- | --- | --- |
| `permission_prompt` | blocked on an approval | needsInput | needsInput |
| `elicitation_dialog`, `agent_needs_input` | genuinely asking you something | needsInput | needsInput |
| `idle_prompt` | the CLI is sitting at its prompt | **needsInput** | see below |
| anything else (`auth_success`, `elicitation_complete`, `agent_completed`, future types) | informational | **needsInput** | no-op |

`idle_prompt` is the interesting one, and it cuts both ways:

- It fires after a **normally finished** turn, so today every completed session bounces from
  `done` straight back to `needsInput` — a permanent false alarm on the sidebar.
- It cannot be true while a turn is running, which makes it the one signal that **rescues a
  session stuck on `running`** when no turn-end hook ever fired. It is the direct cure for
  the Esc-during-a-tool-call case that A1's watchdog only backstops twenty minutes later.

**The decision.** Switch on `notification_type`. `idle_prompt` applies a narrow rule — it may
only move a session that is still `running`, and it moves it to `idle`, never to `done`
(nothing was accomplished, so there is nothing to go and read). Unknown types are a no-op, so
a future Claude release adds a badge only when we decide it should.

---

## Group B — per-session context-window meter

**The gap.** Conduit shows a context meter for agy sessions only, because agy volunteers it
in its status line. Claude sessions show nothing, even though Conduit already knows the
transcript path and already parses transcript lines (`transcript.rs`).

**The mechanism.** Tail the session's transcript `.jsonl` and read the LATEST assistant
message's `usage`: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`,
over the model's window.

Three implementation rules are taken verbatim from `context-tail.ts` because each one is a
measured performance decision, not a preference:

1. **Scan backwards and stop early.** A forward scan `JSON.parse`s every line of the chunk,
   and a single tool-result line can be 100 KB+ of JSON. Pre-filter each line with a
   substring test for both `"usage"` and `"assistant"` before parsing it at all.
2. **Cap the initial read at 1 MB.** A resumed transcript is routinely many megabytes; only
   the tail matters. The partial first line is dropped by the parse guard.
3. **Resolve the window by model FAMILY, never by id.** Claude Code runs opus/sonnet sessions
   in a 1M window while the transcript's model id stays bare (`claude-opus-4-8`), so the
   window is not derivable from the id. opus/sonnet/fable/mythos → 1M, haiku → 200k, unknown
   → 200k.

**Persistence.** The value is cached per session id so the meter survives an app restart:
after a restart the session exists but is idle, so no hook fires and nothing re-feeds the
tailer until the next prompt. Without the cache the meter would vanish on every launch.

---

## Group C — command palette

Conduit has no palette at all. Actions are reachable only through menus, the sidebar context
menu, and a handful of accelerators.

A ⌘K palette over the actions Conduit already exposes: new session, switch session, open
project, toggle board/canvas, settings pages, account switching, formatting, git actions.
Matching is case-insensitive subsequence (`ntr` matches "New TeRminal").

One design detail is worth stealing exactly: **searchable `hint` and non-searchable `note`
are different fields.** nodeterm put a disabled row's reason in `hint`, which fed it to the
matcher, and the row started answering unrelated queries. A reason is not a key.

This is also the surface that Group I (transcript search) plugs into later.

---

## Group D — tmux banner

Session persistence shipped in 0.19.0 with a silent fallback: no tmux, no persistence, no
explanation. Users do not discover this on their own.

A dismissible banner when persistence is enabled but tmux is missing, with a one-click
install that runs in a terminal. The macOS-without-Homebrew case carries a real trap worth
copying: chain the official Homebrew installer, then call the new `brew` by **absolute path**
(`/opt/homebrew/bin/brew`, `/usr/local/bin/brew`), because the freshly installed brew is not
on the launching shell's `PATH` and a bare `brew install tmux` fails immediately after the
install succeeds.

---

## Group E — session reaper

**The gap this closes is one 0.19.0 opened.** Conduit's `sweep_orphans` kills only tmux
sessions with no matching session id in the store. A session that still exists but has been
abandoned for days keeps its `claude` process, and its memory, forever. nodeterm's field
report on the same design: 95 sessions and 34 GB of idle agent processes on one host.

The policy is deliberately a *budget*, not an expiry — the same shape as a cache eviction:

- Trigger on a **memory watermark**, not the calendar. Nothing is reaped on a healthy host.
- A backstop count cap catches the pathological case with memory to spare.
- **Never reap an attached session** — someone is looking at it.
- A **grace window** protects anything recently active.
- Reap in **small batches**; the next sweep re-evaluates rather than one sweep mass-killing
  toward a target.

The safety contract is what makes it acceptable: kill **only** the tmux session, never the
scrollback snapshot and never any session record. To the app, a reap is indistinguishable
from a machine reboot — the next open finds no tmux session, replays the snapshot (Group F)
and resumes the agent with `claude --resume`.

---

## Group F — cold-restore scrollback

The other half of 0.19.0. tmux survives an app restart, so a warm reattach redraws and
everything looks right. It does **not** survive a machine reboot (or a Group E reap), and
then the terminal comes back completely empty.

Persist a byte-capped snapshot of each terminal's recent output while it runs — 256 KB of
trailing bytes, cut on a UTF-8 code-point boundary so a multi-byte character is never torn —
and replay it into xterm **only on a cold start**. A warm reattach ignores the snapshot
entirely, because tmux is about to redraw the same content and replaying would double it.

---

## Group G — hook-reply approvals

Conduit's approval broker (built, dormant) answers a permission prompt by typing digits into
the TUI. That depends on the prompt being on screen, focused, and numbered the way we assume.

nodeterm's answer is deterministic and strictly better: the permission hook itself holds the
decision. The hook writes its request to a pending file, polls for an answer file for up to
N seconds, and prints a decision JSON to stdout — Claude applies it **before ever painting
the prompt**. On timeout the hook prints nothing and exits 0, so Claude shows its normal
interactive prompt: fail-open, bit-for-bit identical to today.

Two properties make it the right choice here. It is **file-based**, so any answerer that can
write to the host — including Conduit's mobile companion over its existing channel — can
answer without a route to the desktop's loopback server. And the wait branch is **env-gated**:
with the variable absent the hook behaves exactly as it does now, which keeps a user's own
terminals and older sessions untouched.

---

## Group H — subagent visibility

When a Conduit session fans out into subagents, the UI shows nothing — one busy dot for
what may be five parallel agents.

Claude writes each subagent's transcript to `<transcript dir>/<sessionId>/subagents/agent-<id>.jsonl`
alongside an `agent-<id>.meta.json` carrying the spawning `tool_use_id`. Resolve the file by
matching that id, tail it, and render it as an activity log rather than raw JSON: assistant
prose verbatim, tool calls as `$ Read store.ts`, tool results collapsed to
`↳ <first line> … (+12 lines)`.

One companion detail from the same file: a completed **async** subagent is announced back to
the parent as a queued `<task-notification>` transcript line carrying the spawning
`tool_use_id`. That is the end signal an async launch's `PostToolUse` never is.

Everything here is read-only. If Claude changes the format we stream less; nothing breaks.

---

## Group I — transcript search

Conduit cannot search past conversations at all.

An index over the transcripts Conduit already knows about: extract searchable text per
session (capped at 200 KB per file), rank by query, return a snippet. Results are appended to
the Group C palette as pre-filtered rows, so there is no second search UI to build.

---

## Sequencing

A → B → C → D are independent and cheap; A first because it fixes live defects rather than
adding surface. E and F are one pair (F's snapshot is what makes E's reap safe) and should
land together. G, H, I are each a feature in their own right and are sequenced last.

Every increment carries unit tests for its pure logic on the side of the boundary it lives on
— Rust `#[cfg(test)]` for the reducers, tailers, and reaper policy; vitest for the palette
matcher and the frontend status rules.
