# Changelog

All notable changes to Conduit are documented here. This project uses
[semantic versioning](https://semver.org/).

## 0.5.0 — 2026-07-03

- **Added — in-app code editor (Monaco).** Open any file from the tree into a full
  Monaco editor and edit it in place: Cmd+S save-to-disk, per-tab unsaved-changes dots
  with a close-guard, theme-synced syntax highlighting, a VS Code-style language
  selector, and read-only banners for binary/oversized files. Editors live in the same
  keep-alive split-pane system as the terminals.
- **Added — smart reload.** When a `claude` agent (or anything else) edits a file you
  have open on disk, a clean buffer silently refreshes with your undo history intact,
  while a buffer with unsaved edits shows a non-blocking "changed on disk — reload /
  keep mine" banner; deletions get their own banner. Your own saves never trigger it.
- **Added — file management in the tree.** Right-click to create files/folders (inline
  name rows), rename, or delete (with a confirm), and **drag-and-drop to move** files and
  folders between directories. Only the touched folders re-list, so expansion state is
  preserved.
- **Added — VS Code-style tabs and splits.** Drag a tab sideways to reorder it, or drag
  it onto a pane's left/right edge to split into a new column (drop on the center to move
  it into that group). The old split button is gone.
- **Added — native Conduit menu bar.** A real macOS menu wired to app actions — New
  Session (⌘T), Open Project (⌘O), Save (⌘S), Close Tab (⌘W), Find (⌘F), toggle the
  sidebar/right panel, switch theme, open Settings/About — plus standard Edit clipboard
  items and a Quit that shuts sessions down cleanly.
- **Changed — native app feel.** Text selection is now disabled across the app chrome
  (kept where it's useful — the editor, the terminal, and inputs). The old read-only file
  preview was replaced by the Monaco editor and its `react-syntax-highlighter` dependency
  dropped.
- **Fixed — in-app drag and drop.** Disabled the webview's native drag-drop handler,
  which had been swallowing HTML5 drop events, so tab and file-tree drag-and-drop work.

## 0.4.0 — 2026-06-30

- **Added — mobile companion (read + prompt).** A React Native (Expo) app that shows
  each agent as a **chat feed** rather than a raw terminal mirror: a live project list
  with per-session running status, full transcript history with live tailing, hook
  status surfaced inline, Markdown-formatted messages, and a prompt box to talk to a
  session from your phone. The desktop stays the source of truth — the phone is a thin
  live view over a WebSocket bridge.
- **Added — dev LAN access for the companion.** Set `CONDUIT_BRIDGE_TOKEN` and the
  bridge binds your LAN (reachable from a phone on the same Wi-Fi) **and** requires a
  matching token on every connection, so transport and auth flip together — the LAN is
  never open unauthenticated. Left unset, the bridge stays loopback-only (unchanged). A
  trusted-network dev shortcut ahead of the full QR/X25519 pairing.

## 0.3.0 — 2026-06-30

- **Added — the Conductor.** Each project can now have one **Conductor**: a Claude
  session you talk to in plain language that knows what your whole fleet is doing and
  orchestrates it for you. It sees every session's live status, to-dos, and branch, can
  peek at a worker's recent output on demand, and can act — **spawn** a new worker,
  **send** it input, or **stop** it. Workers the Conductor spawns are always isolated in
  their own git worktree and branch, so parallel agents never share a working tree.
  Stopping a worker asks you to confirm first. The Conductor shows a ◆ badge in the
  sidebar and runs from the New Session dialog's "Conductor" toggle.

## 0.2.0 — 2026-06-30

- **Added — multiple agent CLIs.** Beyond Claude Code, Conduit now runs **OpenAI
  Codex**, **Google Gemini**, and **OpenCode** in their own keep-alive terminals. Pick
  a global default agent and override it per session from the New Session dialog; a
  first-run onboarding wizard and a Settings panel detect which agent binaries are on
  your `PATH`. Live per-session status (running · tool activity · done) lights up for
  every agent.
- **Added — OpenCode support.** OpenCode joins as a first-class agent. Because it has
  no shell-hook config like the others, Conduit installs a small status plugin into the
  project so its tool activity and idle/done status surface in the sidebar just like
  Claude, Codex, and Gemini. (Managing OpenCode's MCP servers from the matrix is coming
  in a later release.)
- **Added — shared MCP server matrix.** Define an MCP server once and toggle it per
  agent (Claude, Codex, Gemini) from Settings; Conduit registers it through each
  agent's own `mcp` CLI at user scope.
- **Added — collapsible projects.** Click a project header in the sidebar to
  collapse it (a disclosure chevron shows the state). Collapsed projects still keep
  active work in view — the selected session and any session that's running, needs
  you, compacting, or done stays visible; idle sessions fold away. Collapse state
  persists across launches.
- **Fixed — tab focus lands on the agent.** Switching between Claude sessions now
  focuses the agent terminal instead of the side-panel shell, so you no longer start
  typing in the wrong terminal.

## 0.1.0

- Initial Tauri v2 release (rebuilt from the original native macOS SwiftUI app).
