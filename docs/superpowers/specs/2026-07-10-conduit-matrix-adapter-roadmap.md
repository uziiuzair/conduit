# Conduit ⇄ BadgerClaw — Feature Roadmap

**Date:** 2026-07-10 · **Status:** living roadmap · companion to
`2026-07-10-conduit-matrix-adapter-design.md`

The adapter (`sidecars/matrix-adapter/`) already relays: list sessions, bind a room
to a session, forward prompts, stream replies + tool activity, typing indicator,
needs-input alerts. This roadmap turns it from "a chat pipe to a terminal" into "a
safe remote control for autonomous agents."

Effort key: **🟢 adapter-only** · **🟡 adapter + small bridge addition** ·
**🔴 deeper Conduit/backend work**.

## What's true today (constraints that shape everything)

- The Mac must stay awake — sessions live in Conduit's GUI process; the bridge only
  mirrors PTYs (`bridge.rs`).
- The bridge speaks `list / attach / input / resize` and emits
  `projects / size / history / output / status / chat / error`. **No `spawn`/`stop`.**
- Conduit's approval **broker exists but has no producer** — nothing registers
  approval requests through it yet (`broker.rs` is called only by its own tests). So
  "structured approvals" need a Conduit-side producer first.
- Claude Code's *own* permission prompts render in the PTY, so they already reach the
  phone as transcript and can be answered by texting `y`/`n` (see Phase 1).
- The app's "connected" chip stays red until the `/pairing/redeem` 500 is fixed
  (status is gated on a pairing row only `redeem` creates).

---

## Phase 1 — Reliable core + manual controls 🟢 ✅ SHIPPED

Everything adapter-side; no Conduit changes. Makes the loop trustworthy.

- **Submit fix** — send the prompt text and Enter as *separate* pty writes; a
  text-burst-ending-in-`\r` is treated as a paste by Claude Code's TUI and never
  submits. (Fixes the "typed but not executed" bug.)
- **`/conduit stop`** — interrupt a running agent (send Ctrl-C, `\x03`).
- **`/conduit key <name>`** — send a control key for interactive menus/prompts:
  `esc · enter · up · down · left · right · tab · ctrl-c · y · n`. Lets you drive
  Claude Code's y/n permission prompts and selection menus from the phone.
- **`/conduit send <text>`** — inject text WITHOUT auto-submitting (for when you want
  to edit on the desktop before running).

This already delivers *approvals by text*: Claude asks "allow Bash(rm …)? (y/n)" in
the terminal → it streams to your room → you reply `y`. Crude but real, today.

## Phase 2 — Awareness / mission control 🟢 ✅ SHIPPED

- **`/conduit sessions`** — one message, edited live via `m.replace`, showing every
  session with a status dot (running/idle/needs-input/done), its current activity
  label (from `pretool` events: "Editing store.ts"), and todo progress.
- **Proactive push on transitions** — a line to the room on the meaningful edges:
  `✅ finished` (`stop`), `⏸ needs input` (`notification`, already), `❌ error`.
  Debounced so a busy session doesn't spam.
- **Live todo mirror** — the `todos` hook event → a checklist message that edits in
  place as the agent checks items off.
- **Cost/usage meter** — the transcript already carries per-message `usage`
  (tokens + cache); surface a running total and alert at a spend cap.

## Phase 3 — Session lifecycle from the phone 🟡

Needs new bridge `ClientMsg`s (`spawn`, `stop`, `resume`) — the terminal-mirror
spec deferred these to its M5.

- **`/conduit new <project> <prompt>`** — spawn a fresh session with an initial task.
  Start work from the train, not just babysit it.
- **`/conduit kill <n>`** — terminate a session (vs Phase 1's soft interrupt).
- **`/conduit resume <n>`** — reattach/resume a closed session.
- Per-session rooms: binding creates/uses a dedicated room so each project is a
  persistent "channel."

## Phase 4 — Structured approvals 🔴 (the headliner, needs a producer)

- Conduit side: a PreToolUse gate that `broker.register`s risky tool calls and blocks
  the PTY until resolved; a new bridge `approval` emit + an `approve` ClientMsg.
- Adapter side: render each request as a message with 👍/👎 **reactions**
  (`m.annotation` → `Decision::Allow/Deny`); first responder wins, timeout = deny.
- Turns the agent into "autonomous but escalates the scary 5% to your pocket" — the
  real unlock for running agents while away.

## Phase 5 — Code review on the phone 🟡 (reuses Tier-3)

The desktop diff viewer already added `git_show_head` / `git_diff_hunks` / `changes`.
Expose them over the bridge:

- **`/conduit changes`** — changed files for the bound session's repo
- **`/conduit diff <file>`** — the diff as a formatted code block, or rendered to a
  **PNG** sent as `m.image` for readability
- **`/conduit commit "msg"` · `/conduit push`** — approve and ship from the phone

## Phase 6 — Orchestration 🔴 (fleet infra exists)

Conduit's Conductor can spawn/command a fleet (`fleet_*` MCP tools). A Conductor room
+ a room per worker:

- **`/conduit fleet`** — workers + status · **`/conduit spawn <task>`** — dispatch one
- `@mention` a worker's room to steer one; broadcast in the Conductor room to steer
  all. A swarm you conduct by text.

## Phase 7 — Multi-modal 🟡

- **Image in** — send a screenshot/mockup (`m.image`) attached to the prompt.
- **Voice in** — `m.audio` → transcribe → prompt.
- **Artifacts out** — agent returns a chart / app screenshot / preview as `m.image`.

## Phase 8 — Autonomy & safety 🟡/🔴

- **Watch mode** — "ping me when CI is green / the build finishes / this file changes."
- **Travel mode** — `/conduit pause` freezes all sessions; `/conduit resume` on landing.
- **Read-only leash** — agent reads/plans freely; every write/exec routes through
  Phase 4 approvals.

---

## Suggested order

Phase 1 (reliability) → Phase 2 (awareness) are pure adapter and ship now. Phase 3
(spawn) and Phase 5 (diff) are the next bridge additions. Phase 4 (approvals) is the
biggest leap and needs the Conduit-side producer — schedule it once the core loop is
proven. Fixing the `/pairing/redeem` 500 (so the app shows "connected") is worth
slotting in early since it makes every phase read nicer.
