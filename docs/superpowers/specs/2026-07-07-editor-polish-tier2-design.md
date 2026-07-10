# Editor Polish Tier 2 — Design

**Date:** 2026-07-07 · **Status:** implemented alongside this spec (single PR, stacked
on the markdown-preview PR)

Tier 2 of the VS Code feature-gap audit: cheap wiring, zero new dependencies. Eleven
features; the Settings "General" tab item was explicitly cut by the user, so the two
behavioral toggles introduced here (word wrap, whitespace-on-save) live in the native
View menu instead, persisted to localStorage like every other UI preference.

## 1. Quit guard + Save All (the data-loss items)

Today Cmd+Q runs `kill_all(); app.exit(0)` in Rust before the frontend can object, and
the red traffic-light close is equally unguarded — multiple dirty buffers are lost
silently. Rust knows nothing about dirty state, and asking the webview on *every* quit
would hold quit hostage to a hung webview.

- The store now pushes a **dirty count** (not paths) to Rust via `set_dirty_count`
  whenever the `dirty` map transitions (low frequency — `setDirty` only fires on
  clean↔dirty edges). Held in a `DirtyGuard(AtomicUsize)` managed state.
- Review-critical fix: the pane's dirty dispatch now compares `registry.dirtyOf`
  against **the store itself**, not a local edge-detector ref — `saveFile` clears
  `store.dirty` without a content event, and the stale ref meant a save-then-edit
  buffer never re-entered `store.dirty`, silently defeating this very guard (and
  Save All, and the tab dot).
- That store-truth dispatch needed a protocol around it (second review round):
  `registry.saving` now marks every **reconciliation window** — a save's trim edits
  and write, the watcher's silent reload, the banner Reload — during which the pane
  suppresses dirty dispatch (the content event fires while `dirtyOf` is transiently
  true; `setSaved` emits nothing to heal it). Each flow settles the store itself from
  `registry.dirtyOf`. `setSaved` takes the **pre-write version id** from `saveFile`
  (a keystroke landing inside the awaited write must leave the buffer dirty), the
  window is re-entrancy-guarded, async reconcilers re-check the guard after every
  await, and dirty is only force-cleared when the closing tab holds the model's
  last reference.
- menu.rs `quit` arm: count == 0 → exit immediately exactly as before (robust even if
  the webview is dead); count > 0 → forward `"quit"` through the existing `"menu"`
  event. New `on_window_event` CloseRequested handler does the same with
  `api.prevent_close()`.
- Frontend `"quit"` case: `ask("Quit with unsaved changes? …", okLabel "Quit Anyway")`
  — the same discard-confirm convention as `requestCloseTab`. Confirm → `quit_app`
  command (kill_all + exit, preserving the PTY-cleanup-before-exit ordering).
- **Save All**: store `saveAll()` iterates `Object.keys(dirty)` through the existing
  `saveFile` (which self-guards read-only/unloaded/saving paths). File ▸ Save All,
  ⌥⌘S macOS-gated like the Replace accelerator (Alt accelerators collide with AltGr
  on Windows).

Two-button dialog (not VS Code's three-way): plugin-dialog has no three-button ask;
Cancel + Save All (⌥⌘S) covers the save path in two keystrokes.

## 2. Tab & group navigation

- **⌃Tab / ⌃⇧Tab** cycle tabs in the active group (wrapping, array order = visual
  order). Implemented as a **capture-phase window keydown** handler, not a working
  menu accelerator: review found muda maps `Key::Tab` to the "⇥" display glyph as the
  NSMenuItem keyEquivalent, which AppKit never matches against a real Tab keypress —
  and xterm cancels Tab-family keydowns before they bubble out of a focused terminal,
  so capture phase is required. The Window-menu items keep the (display-only on
  macOS) accelerator; the two dispatch paths are mutually exclusive by construction.
- **⌘1..9** activate the Nth tab of the active group (⌘9 = last, browser convention;
  Conduit groups are shallow but tabs are many, so tabs beat VS Code's group-focus
  semantics here). **Meta only**: accepting ctrlKey would fight xterm, which maps
  Ctrl+3..8 to real control bytes (Ctrl+3 = ESC — an accidental agent interrupt).
- **⌘⇧T Reopen Closed Tab**: `closedTabs` stack (session-only state, capped at 20)
  pushed by `requestCloseTab` for *file* tabs only — `renamePath`/`deletePath` closes
  are not recorded (the old path is gone), session tabs are one click away in the
  sidebar. Reopen restores the tab at its old group/index when the group still
  exists (pure `reopenTabAt` reducer in layout.ts, unit-tested), else falls back to
  the active group; registry acquire/release stays balanced.

## 3. Preview (italic) tabs

Single-click in the file tree now opens a **preview tab** (italic label): the next
preview open in that group replaces it instead of accumulating tabs. Promotion to a
permanent tab: double-click the tree row, double-click the tab, or edit the buffer
(`setDirty(path, true)` pins — which guarantees a replaced preview is never dirty).

- Flag: `WsTab.preview?: boolean`. It survives the frontend JSON-clone/validateLayout
  paths untouched; the Rust `WsTab` struct gets a `#[serde(default)] preview: bool` so
  it also survives persistence rather than silently vanishing on restart.
- Replacement swaps the tab in place (same index) and releases the replaced model via
  the same release + disposeIfUnreferenced pair `requestCloseTab` uses.
- Only preview-mode opens replace; explicit opens still append (VS Code semantics).
- Dragging or splitting a tab **pins** it (review fix): moving a preview tab into
  another group would otherwise break the one-preview-per-group invariant and let the
  next single-click silently replace the tab the user just deliberately placed.

## 4. Reveal in tree / Reveal in Finder

- **Reveal in Finder**: new `reveal_path` command following `open_external`'s
  shell-out doctrine (`open -R` on macOS, `explorer /select,` on Windows, `xdg-open
  <parent>` fallback; `.no_window()`, no new plugins). Exposed in the tab context
  menu and the file-tree context menu.
- **Reveal active file in tree**: store `revealRequest {path, nonce}`; FileTree
  expands all ancestor dirs (its existing `setExpanded` precedent) and, because child
  rows appear only after each ancestor's async `list_dir` resolves, polls briefly for
  the row's new `data-path` attribute before `scrollIntoView({block:"center"})`
  (center dodges the sticky branch bar). Un-collapses the right panel first.
  Triggers: File ▸ Reveal Active File in Tree, tab context menu. No-ops when the file
  is outside the current tree root (worktree case).

## 5. Status chips (instead of a status bar) + LF/CRLF

A bottom status bar would steal a permanent ~22px row from terminals in an app whose
identity is terminal real estate, and "whose cursor?" is ambiguous with split groups.
The pane breadcrumb is already the per-editor chrome, so the status lives there,
right-aligned before the language selector, in the established chip recipe:

- **Ln X, Col Y** — `onDidChangeCursorPosition` wired in the create-once effect
  (editor-scoped, survives model swaps), re-seeded after view-state restore on swap.
- **Spaces/Tab: N** — from `model.getOptions()` (attach-time auto-detection means the
  create-time `tabSize: 2` is not the truth), updated via `onDidChangeModelOptions`.
- **LF/CRLF** — click toggles via `model.pushEOL` (undo-preserving; flips dirty
  naturally through the version-id mechanism). Disabled on read-only buffers.

## 6. Word wrap + font zoom

- **View ▸ Toggle Word Wrap** (⌥Z macOS-gated): global `wordWrap` store flag
  (localStorage `conduit.wordWrap`); each CodeEditorPane subscribes reactively and
  applies `updateOptions({wordWrap})` — no new registry needed.
- **View ▸ Zoom In/Out/Reset** (⌘= / ⌘− / ⌘0): integer `fontZoom` (−4..8, localStorage
  `conduit.fontZoom`, validate-else-default on read like the width prefs). Editors:
  `fontSize 12+z`, lineHeight scaled proportionally (it's an absolute px value, 18 at
  base). Terminals: `fontSize 13+z` — each TerminalView subscribes, sets
  `term.options.fontSize`, and re-runs its own fit + `pty_resize` path when visible
  (a font change never fires the ResizeObserver, and cols/rows must be renegotiated
  with the PTY). Hidden keep-alive terminals pick the size up through the existing
  reveal-refit path.

## 7. Maximize / restore group

`maximized: Record<projectId, groupId>` — **ephemeral store state**, deliberately not
in `ProjectLayout`: `validateLayout` rebuilds the layout as exactly
`{groups, activeGroupId, weights}` and the Rust serde struct would strip extra fields
on persist, so anything stored there dies within 400ms. WorkspaceCenter overrides the
`geometry()` output when a valid maximized id is set: that group gets 0/100%, other
groups keep their slots but their panes/strips are hidden via the same
visibility-only mechanism that already keeps terminals alive (nothing unmounts,
nothing reparents, no divider drags while maximized). Toggle: View ▸ Maximize Editor
Group (⇧⌘M), no-op with a single group.

Two review-driven rules make it safe:
- **Maximize follows the active group**: `applyLayout` clears it whenever a layout
  action activates a *different* group or prunes the maximized one — otherwise
  selecting a session / opening a file / ⌘⇧T into a hidden group produces an
  invisible-but-active pane (and stale ids can't linger).
- **Restore must not steal focus**: un-maximizing flips `visible` on every hidden
  keep-alive pane at once, and each pane's reveal effect used to grab focus. Both
  focus sites in CodeEditorPane and TerminalView's `focusOnReveal` are now gated on
  membership in the *active* group.

## 8. Image preview

`read_file` classifies images as binary and dead-ends in a banner. New
`read_file_base64` command (16 MB cap; `base64` crate already a dependency via pty.rs)
feeds an `ImagePreview` overlay rendered by CodeEditorPane — same overlay pattern as
the markdown preview (absolute, z-index 4) — when the active file is a raster image
(`png/jpg/jpeg/gif/webp/bmp/ico/avif`) that `read_file` flagged binary. Data lands as
a `data:image/*` URL (script-inert in an `<img>` context). SVG stays a text buffer
(it's editable source; previewing it safely is a different problem).

## 9. Whitespace on save

`View ▸ Clean Whitespace on Save` toggle — **default OFF** (VS Code's default too):
silently rewriting buffers would inject diff noise into exactly the agent-review
workflows Conduit exists for. When on, `saveFile` (the single choke point all three
save paths funnel through) applies, *before* `getValue()`, a `pushEditOperations`
batch (undo-preserving; the post-trim version becomes the saved point because
`setSaved` captures the version id after the write): trailing-whitespace deletion on
every line — **except in markdown**, where trailing double-space is a hard line
break — plus a final newline using the model's own EOL. Pure edit computation in
`src/trim.ts`, node-env unit tests.

## 10. Known limits (accepted)

- Reopen-closed-tab stack and maximize state don't survive an app restart.
- No MRU order for ⌃Tab (array order), no cross-group tab cycling.
- Zoom doesn't scale UI chrome or the markdown preview (13px fixed), only
  editors + terminals.
- Image preview: no zoom/pan, no SVG, 16 MB cap.
- The quit guard trusts the frontend's dirty count; if the webview is wedged *and*
  dirty, Cmd+Q needs a second confirm attempt (count>0 path emits to a dead listener).
  The clean-path exit remains instant and webview-independent.
