# Session restore + safe shutdown — implementation plan

Companion to `docs/superpowers/specs/2026-07-12-session-restore-and-safe-shutdown-design.md`.
Three independently-shippable phases. Verify each with `cargo test` / `cargo clippy` /
`cargo fmt` / `pnpm exec tsc --noEmit` / `pnpm build` **and by launching the app** (UI +
lifecycle changes can't be trusted from a typecheck).

Legend: **R** = Rust (`src-tauri/src`), **T** = TypeScript (`src`).

---

## Phase 1 — Safe shutdown (running-agent guard)

Goal: confirm before quitting or closing a session whose agent is actively `running`; hard-kill
on confirm; never touch history.

### 1.1 Rust running signal
- `fleet.rs`: add `FleetState::any_running(&self) -> bool` (any snapshot value
  `status == "running"`) and `running_session_names`/count if handy for the message. Unit-test
  it by recording a `prompt` event then asserting true, a `stop` then false.

### 1.2 Extend the close guard (R)
- `lib.rs` `WindowEvent::CloseRequested`: prevent-close when `DirtyGuard > 0 ||
  fleet.any_running()` (get `FleetState` from `window.app_handle().state()`), then emit `"quit"`
  as today. (Menu quit path in `menu.rs` gets the same `any_running()` check before its
  immediate `kill_all()` + `exit`.)

### 1.3 Frontend quit confirm (T)
- `App.tsx` `"menu"="quit"` handler: compute running sessions from the store `live` map
  (`status === "running"`). If any, show a confirm dialog (reuse the app's dialog style) listing
  their names → [Quit anyway] / [Cancel]. Quit → existing `flushHotExit()` → `quit_app`. Cancel
  → abort (window stays open; `prevent_close` already kept it). No running → today's silent
  hot-exit path.

### 1.4 Per-session close confirm (T)
- `store.ts` `removeSession` (and the Sidebar "Delete" menu item / Cmd-W-on-session if any):
  if `liveState(get().live, sessionId).status === "running"`, `confirm(...)` first; proceed to
  `invoke("remove_session")` only if confirmed. Keep hard-kill semantics.

### 1.5 Verify
- `cargo test` (any_running), tsc. Live: start a Claude task (status→running), try to quit →
  prompt appears; cancel keeps it; quit kills it. Close a running session tab → prompt. Idle
  session/app → no prompt (unchanged).

---

## Phase 2 — Per-project eager restore

Goal: opening a project launches all its sessions (each resumes where the agent can); other
projects stay lazy. Setting-gated, default on.

### 2.1 Setting (T)
- `store.ts`: `restoreSessionsOnOpen: boolean` (localStorage, default true) + setter, mirroring
  `defaultAgent`. Surface a toggle in Settings (a "Startup" line in an existing section, e.g.
  Privacy/General or a new small section).

### 2.2 Eager spawn trigger (T)
- `Terminal.tsx`: change the spawn gate from `visible` to
  `visible || (restoreOnOpen && sessionProjectId === selectedProjectId)`. The `spawnedRef` guard
  keeps it one-shot. Confirm all open session tabs of a project are mounted when it's the active
  project (keep-alive design) — if a tab must be "opened" in the layout to mount, that's already
  restored from `state.json`, so no extra mounting is needed; if not, add a lightweight
  offscreen mount for the active project's session tabs.
- Ensure the visible/last-active session still spawns first (it already does); the rest follow.
- Switching `selectedProjectId` fires the trigger for the newly-active project only.

### 2.3 Validate Claude resume across the project (R test)
- Add/confirm a test that an eager cold-spawn with an existing transcript takes the
  `--resume` branch (extends the existing `agent.rs` resume tests; no new resume code).

### 2.4 Verify
- Live: with 3+ Claude/agy sessions in a project, relaunch → all spawn; each Claude session
  redraws its resumed conversation. Switch to a second project → its sessions spawn then. Toggle
  the setting off → back to click-to-spawn. Watch CPU with many sessions (see spec open Q).

---

## Phase 3 — agy conversation resume

Goal: agy sessions reopen their exact prior conversation via `agy --conversation=<uuid>`.

### 3.0 Spike — how to capture agy's conversation id (do FIRST, on the real machine)
- Instrument the agy status-line payload: log its **keys** (not values) once in `hooks.rs`
  (`CONDUIT_HOOK_LOG` branch) and run an agy session — does it include a conversation/project id?
  - **If yes** → capture path = payload (3.1a). Clean, race-free, survives hard-kill.
  - **If no** → capture path = PTY-scrape the `Resume: agy --conversation=<uuid>` /
    `--conversation=<uuid>` pattern from the session's output (3.1b).

### 3.1 Capture + persist the id (R)
- `store.rs`: add `Session.agent_conversation_id: Option<String>` (`#[serde(default)]`); TS
  mirror in `store.ts`. Command `set_session_agent_conversation_id(session_id, id)`.
- 3.1a (payload): in the `hooks.rs` agy branch, parse the id from the payload and call the store
  setter when it changes.
- 3.1b (scrape): in `pty.rs`, for `agent == Antigravity`, run a cheap regex over streamed output
  (or the existing output ring) for `--conversation=([0-9a-f-]{36})`; on first match, persist via
  the store (emit an internal event or call the store directly). Capture live, not only at exit.

### 3.2 Resume wiring (R)
- Thread `resume_token: Option<String>` into `PtyManager::spawn` → `build_script[_win]` →
  `adapter.build_invocation`, resolved from `Session.agent_conversation_id` in `lib.rs`
  `pty_spawn` (next to `account_config_dir`). Claude ignores it (keys off `session_id`).
- `AntigravityAdapter::build_invocation`: with a token →
  `agy --conversation={quote(token)} || agy`; without → `agy || agy` (unchanged). Add
  `initial_prompt` support via `-i`/`--prompt-interactive` if we later want seeded resume.
- Tests: adapter emits `--conversation=<id>` with a token, bare `agy || agy` without.

### 3.3 Verify
- Live: run an agy session, chat, quit (confirm prompt), relaunch → the agy session reopens the
  same conversation (agy redraws it). A brand-new agy session (no stored id) starts fresh and
  captures its id for next time. Two concurrent agy sessions resume their *own* conversations
  (no cross-contamination — that's why we avoid `--continue`).

---

## Cross-cutting

- **Version bump** on release (three files + `Cargo.lock`), per the CLAUDE.md SemVer policy —
  a feature set ⇒ MINOR (`0.8.0`).
- **Back-compat:** `agent_conversation_id` and the setting default to "unset / today's
  behavior"; old `state.json` loads unchanged.
- **No AI-attribution trailer**; one `feat/<topic>` branch; fork → PR to uzair (current flow).
- **Platforms:** guard is pure Rust + a JS dialog; agy scrape/`--conversation` and Claude
  `--resume` are separator-agnostic. Re-run the mac/linux reasoning for any `#[cfg]` added.
