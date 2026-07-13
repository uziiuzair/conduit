# Session restore + safe shutdown — design

**Status:** proposed (2026-07-12)
**Scope:** On launch, bring a project's agent sessions back **where the user left off** —
Claude and agy resume their real conversation; other agents deferred. On shutdown, **never
lose history**, and **confirm before killing a session whose agent is actively working**.

## Problem

Today Conduit persists the session tree + editor layout, and a **Claude** session already
resumes its conversation (`claude --resume <uuid>`) — but only lazily, when you click its tab.
agy and the others relaunch fresh with no visible history, and there is no scrollback
persistence. On quit, all PTYs are hard-killed with **no check for a running agent** (the only
close guard is unsaved *editor* files via `DirtyGuard`). The user wants the VSCode experience:
reopen and land back in the conversations, and a safe shutdown that asks before interrupting
work.

## Goals

1. **Startup restore.** Opening a project **eagerly launches all its sessions**; each resumes
   its conversation where the agent supports it. Other projects stay lazy (VSCode-style).
2. **Real resume for Claude + agy.** Claude via `--resume` (works today); agy via
   `--conversation=<uuid>` (new). Codex / OpenCode / Gemini deferred (fresh launch).
3. **Safe shutdown.** If **any one** session's agent is actively `running`, confirm before
   quitting the app **and** before closing that single session. On confirm, **hard-kill** —
   history is already durable (Claude flushes its transcript continuously; agy keeps its own
   per-conversation SQLite store), so a hard kill loses no conversation.
4. **Never destroy history.** No close path deletes transcripts; `state.json` stays atomic.
5. **All platforms** (Windows/macOS/Linux). Off-by-default only where it changes today's
   behavior (the eager-spawn is the one visible change; gate it behind a setting, default on).

## Non-goals

- Codex / OpenCode / Gemini conversation resume (no Conduit-addressable id today; deferred).
- Terminal scrollback serialization. With real resume for Claude + agy, the agent itself
  redraws its history, so a separate Conduit-side buffer restore is unnecessary for the two
  in-scope agents. (It's the fallback for the deferred agents, later.)
- Graceful "drain" on quit. Hard-kill after confirm is acceptable given durable history.

## Current architecture (ground truth)

- **Persistence:** `state.json` holds projects, full `Session` structs, and per-project
  `layout` (open tabs). Written atomically on every mutation (`store.rs` `save`). Reloaded by
  `store.ts` `load()` on mount.
- **Spawn is lazy:** a restored tab spawns its PTY only when it first becomes **visible**
  (`Terminal.tsx`, guarded by `spawnedRef`). Fresh app start ⇒ always a **cold spawn** (the
  Rust `PtyManager` is empty; PTYs are killed on quit).
- **Claude resume already works:** `ClaudeAdapter::build_invocation` emits
  `claude --resume <id>` when `transcript_exists(session_id, projects_dir)`, else
  `claude --session-id <id>` to pin a new conversation to Conduit's UUID (`agent.rs`,
  `pty.rs`). Transcripts: `<account>/projects/<slug>/<id>.jsonl`.
- **agy resume exists but un-pinnable:** `agy --conversation=<uuid>` resumes a specific
  conversation; agy has **no** caller-supplied-id flag (issue #7). It prints
  `Resume: agy --conversation=<uuid>` to its PTY; conversations live at
  `~/.gemini/antigravity-cli/conversations/<uuid>.db`.
- **Running signal already exists**, per session, in two places fed by the same Claude-Code
  hook events: the frontend `live` map (`store.ts`, `status: "running"`) and the Rust
  `FleetState.status` mirror (`fleet.rs`, populated for every hooked session). `prompt`/
  `pretool` → running; `stop`/`sessionend` → not.
- **Shutdown guard is editor-only:** `WindowEvent::CloseRequested` (`lib.rs`) calls
  `prevent_close()` only when `DirtyGuard > 0`; agent activity is never consulted. Quit kills
  all PTYs (`kill_all`, `taskkill /T /F` on Windows). `remove_session` leaves transcripts.

## Design

### A. Startup restore — per-project eager spawn

- Add a per-session **"should spawn"** trigger: a session spawns when it is visible **or** when
  it belongs to the **active project** and eager-restore is on. Concretely, `Terminal.tsx`'s
  spawn gate changes from `visible` to `visible || eagerRestoreForActiveProject`. All open
  session tabs in the active project are already mounted (keep-alive), so this just fires their
  spawn without waiting for a click.
- Switching projects spawns *that* project's sessions (same trigger keyed on
  `selectedProjectId`); previously-spawned sessions stay alive.
- **Setting:** `restoreSessionsOnOpen` (default **on**), Settings → a General/Startup section.
  Off = today's click-to-spawn behavior.
- The last-active session (the visible tab) spawns first/immediately; the rest of the project
  spawn in the background. No new processes for non-active projects.

### B. Claude resume — validate, no code change

Already correct: an eager cold-spawn of a Claude session whose transcript exists becomes
`claude --resume <id>`. Phase A simply makes it fire for the whole project, not just the
clicked tab. Add a test asserting the resume branch under the eager path.

### C. agy resume — capture the conversation id, relaunch with `--conversation`

agy can't pin our id, so Conduit **captures** the UUID agy chose and persists it:

- **Data model:** add `Session.agent_conversation_id: Option<String>` (Rust + TS,
  `#[serde(default)]`). Generic name (agy today; a future agent could reuse it). Claude does
  NOT use it — Claude keys off `Session.id`.
- **Capture (spike — resolve the cleanest of these on the real machine):**
  1. **Status-line payload (preferred if present).** Conduit already receives agy's status-line
     JSON per session (keyed by `CONDUIT_SESSION_ID`) for the usage bar. If that payload carries
     a conversation/project id, store it there (`hooks.rs` agy branch → a new
     `set_session_agent_conversation_id` command). Race-free, hard-kill-proof, no scraping.
  2. **PTY-scrape (fallback).** The reader already keeps a per-session output ring (`pty.rs`).
     Scan agy output for `--conversation=<uuid>` and persist the first UUID seen. Per-session,
     so no cross-session race; capture it *live* (not only at exit) since a hard kill skips the
     exit banner.
  3. **Newest `.db` (last resort).** mtime of `~/.gemini/antigravity-cli/conversations/*.db`
     after spawn — racy across same-home sessions; only if 1 and 2 fail.
- **Resume:** thread the stored id into the Antigravity adapter's `build_invocation`
  (a new `resume_token: Option<&str>` spawn param, resolved from the Session like
  `account_config_dir` is). With a token: `agy --conversation=<id> || agy`; without:
  `agy || agy` (fresh), then capture. Never use `-c`/`--continue` (global, cross-contaminates).
- agy home is the account-redirected home (existing `resolve_agy_home`), so the conversation
  store is read from the same place the session writes it.

### D. Safe shutdown — running-agent confirmation + hard kill

- **App quit.** Extend `WindowEvent::CloseRequested` (`lib.rs`) to also prevent-close when any
  agent is running: `DirtyGuard > 0 || fleet.any_running()` (new `FleetState::any_running()` =
  any snapshot value `status == "running"`). On prevent, emit `"quit"` to the frontend as today.
  - Frontend `"quit"` handler: if any session's `live.status == "running"`, show a **confirm**
    dialog — "N session(s) still working (list names). Quit and stop them?" → [Quit] / [Cancel].
    Cancel aborts; Quit runs the existing teardown (`flushHotExit()` → `quit_app` → `kill_all`).
    If nothing is running (only dirty editors), keep today's silent hot-exit save.
- **Single-session close/delete.** In `removeSession` (`store.ts`): if that session's
  `live.status == "running"`, confirm first — "Agent is working in this session. Close and stop
  it?" → proceed to `remove_session` (which hard-kills) only on confirm.
- **Hard kill unchanged.** `kill`/`kill_all` (taskkill tree on Windows) stay. History is
  durable, so no drain needed. `remove_session` continues to leave transcripts on disk.
- **Cross-platform:** the guard is pure Rust `FleetState` + a frontend dialog; no OS-specific
  code beyond the existing kill path.

## Data model changes

| Field | Where | Notes |
| --- | --- | --- |
| `agent_conversation_id: Option<String>` | `Session` (store.rs + store.ts) | agy's captured UUID; `#[serde(default)]`, back-compat |
| `restoreSessionsOnOpen: boolean` | settings (localStorage, like `defaultAgent`) | default on |

No change to transcripts or the account model. agy id is a pointer, not a secret.

## Security / correctness

- The agy conversation id is a UUID pointer (not credentials); persisting it in `state.json`
  is fine. Never log conversation contents.
- Eager spawn respects existing account/worktree resolution — each session spawns under its
  own resolved account home, exactly as a click-spawn would.
- The shutdown guard is fail-safe: if the running signal is somehow missing, worst case is
  today's behavior (no prompt) — never a hang. Confirm dialog can always be cancelled.
- Back-compat: sessions from old `state.json` have no `agent_conversation_id` → agy starts
  fresh and captures one on first run. Zero behavior change for non-agy users.

## Phasing

1. **Safe shutdown** — `FleetState::any_running()`, extend `CloseRequested`, frontend quit +
   per-session-close confirm. Self-contained, high value, no restore dependency.
2. **Per-project eager restore** — the `restoreSessionsOnOpen` trigger + setting; validates
   Claude resume across the whole project. Pure frontend + a small setting.
3. **agy resume** — the id-capture spike (payload vs PTY-scrape), `agent_conversation_id`
   persistence, the Antigravity adapter `--conversation` wiring.

Each phase is independently shippable; 1 and 2 need no agy work.

## Open questions

- **agy id capture (the phase-3 spike):** does agy's status-line payload carry a
  conversation/project id (clean capture), or must we PTY-scrape the `--conversation=<uuid>`
  banner? Resolve on the user's machine before wiring — determines the capture code.
- **Eager-spawn fleet size:** if a project has many sessions, launching all at once is heavy.
  Start with "all sessions of the active project"; if it's too aggressive, cap concurrency or
  stagger. Revisit after real use.
