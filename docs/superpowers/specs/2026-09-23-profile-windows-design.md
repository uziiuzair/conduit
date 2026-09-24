# Profile windows (Obsidian-style) — design

**Date:** 2026-09-23 · **Status:** approved, pre-implementation

## Why

Profiles today are a visibility filter: switching one re-filters the single window.
The user wants an opt-in second mode, matching Obsidian's vaults: picking a profile
opens (or focuses) a **separate window pinned to that profile**, so two profiles can
be on screen at once — e.g. a "Streaming" window on camera while client work stays
in another window off-screen.

Approved shape (all four confirmed by the user):

1. **Partitioned windows** — each window mounts ONLY its profile's projects and
   sessions. Not a mirror.
2. **Closing a profile window keeps its sessions running** — detach, never stop.
   Same philosophy as hidden profiles today.
3. **Canvas board stays main-window-only** for this increment.
4. **The setting is restart-gated** — it changes behavior at next launch.

## Rejected approaches (for the record)

- **Full mirror** (every window mounts everything): needs PTY output fan-out, and
  two differently-sized xterms fight over one `pty_resize` winsize. The mobile
  bridge's read-only subscriber list does not solve the write/resize side.
- **Second OS process**: the startup orphan sweep would kill the other instance's
  tmux sessions, the hook/bridge/MCP ports collide, and two writers clobber
  `state.json`. Dead end.

## Core invariant

**A session's terminal is mounted in exactly one webview: the window whose profile
owns its project.** Profiles partition projects (`Project.profile_id`, dangling ids
normalize to Default), so this is well-defined. The PTY sink stays single-consumer
— no fan-out, no resize fights. Everything below serves this invariant.

## The setting

`profileWindowMode: "switch" | "window"`, default `"switch"`. Per-machine, stored in
localStorage (`conduit.profileWindowMode`), surfaced in **Settings → General** with
"takes effect after restart" copy, rendered with `Dropdown.tsx` (or a toggle row
matching existing rows). Restart-gated because a live flip would unmount other
profiles' terminals from main (orphaned sinks) or double-mount them (mirror
conflict); no runtime migration path is attempted.

While the pref is `"switch"` (default), NOTHING below activates: one window,
current behavior byte-for-byte.

## Window model

- **Labels.** Main keeps label `"main"` — `tauri-plugin-window-state` keys geometry
  by label, so existing geometry survives. Secondary windows are `profile-<id>`
  (each gets independent geometry for free).
- **Registry.** A Rust-managed `WindowRegistry: label → Option<profile_id>` is the
  single source of truth for "which profile is this window". `"main"` maps to the
  boot-time `active_profile_id` (`None` = Default). The frontend never parses
  labels: at boot it calls a new `window_profile` command with its own label
  (`getCurrentWebviewWindow().label`) and pins the answer in Zustand
  (`windowProfileId`), alongside `isMainWindow`.
- **Opening.** New command `open_profile_window(profile_id)`: if a window for that
  profile exists (registry lookup), `show + unminimize + set_focus`; else create
  `WebviewWindowBuilder` with label `profile-<id>`, same URL/config as main, and
  record it in the registry. Picking the profile a window already shows focuses it.
  Windows are removed from the registry on `Destroyed`.
- **Capabilities.** `capabilities/default.json` `"windows"` widens to
  `["main", "profile-*"]`.
- **ProfileBar in window mode.** The dropdown still lists Default + profiles.
  Picking one calls `open_profile_window` instead of `set_active_profile`. The
  current window's own profile is the selected value and is inert. The `+` add-
  profile flow is unchanged (creating a profile does not open a window).
- **`set_active_profile` is refused from secondary windows** (Rust checks the
  calling window's label) — it would silently change which profile main pins at
  next boot. Main in window mode does not call it on pick either; it remains the
  persisted "what main opens as" memory, unchanged by this feature.
- **`remove_profile`** first closes that profile's window if open (registry
  lookup), then proceeds with today's fallback-to-Default behavior. The close goes
  through the normal detach path below.

## Boot (per window)

`load()` already computes visible projects from the active profile. Changes:

- Each window resolves `windowProfileId` first, then filters what it MOUNTS —
  `WorkspaceCenter`'s `allSessions` flat-map and `Terminal.tsx`'s eager-spawn
  effect include only projects with `inProfile(project, windowProfileId)`. In
  `"switch"` mode `windowProfileId` is simply the active profile and the mount set
  stays ALL projects exactly as today (the filter applies only in window mode).
- Sidebar/HQ filtering reuses the existing `inProfile` machinery against
  `windowProfileId` instead of `activeProfileId` when in window mode.
- `conduit.lastProject` / `openBehavior` remain main-window concepts: a secondary
  window always opens on its profile's first visible project (the existing
  `initialProjectSelection` null-safety applies). Secondaries do not write
  `conduit.lastProject`.
- The plugin Web Worker host (`initPlugins`) runs in **main only** this increment
  — otherwise every hook event is processed once per window.
- Canvas mode is unavailable in secondaries (board is one global localStorage
  blob; two writers clobber). The mode toggle is hidden there.

## PTY detach on window close (load-bearing)

Today `pty.rs`'s reader breaks after ~2000 consecutive failed sink sends with
`child_exited = false`, leaving a zombie: the session stays in the DashMap with no
reader thread, and the next `pty_spawn` takes the re-attach fast path into
permanent silence. With window close becoming a routine action, that latent bug
becomes the common path. Fix it as part of this feature:

- New `PtyManager::detach_window(profile_sessions)` (called from `on_window_event`
  `Destroyed` for a secondary, resolving the profile's sessions via the registry +
  store): swaps each session's sink to a **detached** state (an explicit
  `Option`/null-object, not a dead channel). The reader thread, on a detached
  sink, discards output (tmux history is the coherent copy; scrollback snapshots
  continue on their existing cadence) and **never breaks** on send failure while
  detached. The PTY child, tmux session, and session record are untouched —
  sessions keep running.
- Reopening the window calls `pty_spawn` per session as usual; the existing
  re-attach fast path swaps the live channel back in and nudges winsize for a
  repaint. Warm reattach, like a tab switch today.
- The same detached-sink state also fixes the orphan break for main-window quit
  races. The `consecutive_fails` break is replaced by "flip to detached", making
  sink death survivable everywhere.

## Event routing

Rust keeps `AppHandle::emit` broadcast; the FRONTEND guards. Every listener whose
payload carries a session/project/chat id applies it only when that id's project
is in this window's profile (`fleet-spawn`, `hook`, `bridge-open-session`,
`conductor-confirm` + broker approve UI, `root-chat-*`, `pending-decision`,
`session-stale` where it mutates UI state). A shared pure helper
`eventInWindow(projectId, windowProfileId, projects)` lives beside `inProfile` in
`src/profiles.ts` (testable without `store.ts`).

Root chats are profile-tagged already (`RootChat.profile_id`); the HQ layer and
its events follow the same guard.

Only two events need Rust-side targeting because their payloads carry no project:

- **`menu`** — `menu.rs` resolves the focused window (`webview_windows()` +
  `is_focused()`, falling back to main) and uses `emit_to`. ⌘T / palette / quit
  land in one window. The `quit` item stays app-wide (see quit semantics).
- **`cli-open`** — `hooks.rs`'s sink matches the request path against the
  store's projects (same containment rule as `matchProjectByPath`; a Rust test
  pins the two against each other so the logic cannot fork), resolves that
  project's profile to a window via the registry, and `emit_to`s only it —
  falling back to the focused window, then main, for an unmatched path. Only the
  targeted window runs `add_project`, killing the duplicate-project hazard.
- **`clone-progress`** gains a `request_id` echoed from the dialog that started
  the clone; other windows' dialogs ignore foreign ids.

`add_project` / `add_root_chat` stop reading the global `active_profile_id` and
take an explicit `profile_id` parameter (the caller passes its
`windowProfileId`). In `"switch"` mode callers pass the active profile — same
result as today.

## State sync between windows

Frontend keeps the write path (invoke → local `set`). Cross-window convergence is
one coarse choke point, not per-command plumbing:

- `Store::save()` (verified: every mutator funnels through it) reports through a
  sink (same Tauri-free pattern as `cli_open`) that emits `store-saved` with a
  monotonically increasing generation. No originating-window label is threaded —
  the originator refetching its own write is harmless because the merge is
  idempotent.
- Every window receiving `store-saved` refetches the read slices
  (`load_projects`, `list_profiles`, `list_accounts`,
  `get_default_accounts`) debounced (~300 ms), and merges into Zustand. Merge
  preserves object identity where content is equal and NEVER changes the mount
  set's React keys (session ids — already the case) so no terminal remounts.
  Sessions in this window's profile keep their live entries untouched.
- localStorage prefs stay boot-read; no `storage`-event sync this increment
  (documented limitation: toggling a pref in one window doesn't restyle the other
  until its restart).

## Dirty counts, hot exit, quit

- **`DirtyGuard`** becomes a `DashMap<label, usize>`; `set_dirty_count` records
  under the calling window's label. A secondary's `CloseRequested` consults its
  OWN count (confirm if >0) and its own profile's running agents
  (`live_running_agent` filtered by profile) — but per the approved close
  semantics, running agents do NOT block a secondary close (sessions keep
  running); only dirty buffers prompt. App quit (menu quit, or last window
  closing) sums all labels and keeps today's dirty + running-agent guard.
- **`on_window_event`**: `CloseRequested` on a secondary = optional dirty confirm
  then close (detach path); on the LAST live window = today's quit flow.
  `hooks.rs:110`'s hard-coded `get_webview_window("main")` gains a fallback to
  any live window for the focus nudge.
- **Hot exit** (`hot-exit.json` is replaced wholesale per flush — two windows
  would clobber): `hotexit_save` gains the window label; Rust keeps
  `label → Vec<HotExitEntry>` and writes the union. `hotexit_load` returns the
  union (a dirty buffer restores wherever its file is opened next). Stale labels
  are dropped when their window's set is next flushed empty or at quit.

## Cross-profile borrowed tabs

A pane whose borrowed session's project lives in ANOTHER window's profile renders
a placeholder card — "Session lives in profile X — open that window" with an
open/focus button — never a blank pane. `repairLayout` keeps validating the tab
against its own project (unchanged); only the RENDER is gated. In `"switch"` mode
nothing changes.

## Testing

- Pure TS: `eventInWindow` guard, ProfileBar pick routing (open vs focus vs
  inert), placeholder decision, mount-set filter — colocated vitest beside
  `profiles.ts`/`layout.ts` helpers, no `store.ts` import.
- Rust: `WindowRegistry` unit tests (register/lookup/remove, main fallback);
  detached-sink reader behavior (send failure while detached does not break, live
  reattach resumes); `hotexit` label-union round trip; `DirtyGuard` map sum;
  `add_project` explicit-profile stamping. Both CI legs compile the window code
  (no `cfg` gating).
- Manual gate (CLAUDE.md rule): launch the app, two-profile smoke — open second
  window, run an agent in each, close secondary, confirm sessions still running,
  reopen warm, quit guard sums.

## Deferred (explicit non-goals)

- Reopening secondary windows on boot (Obsidian does; we start main-only).
- Per-profile settings/accounts/layout state.
- Canvas board in secondaries; live pref sync across windows; plugin host in
  secondaries.
- Moving projects between profiles; profile rename/delete UI (unchanged from MVP).
