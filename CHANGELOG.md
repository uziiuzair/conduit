# Changelog

All notable changes to Conduit are documented here. This project uses
[semantic versioning](https://semver.org/).

## 0.5.0 — 2026-07-03

- **Added — auto-updates (macOS).** Conduit now checks GitHub Releases in the
  background and via Settings → About, and installs signed + notarized updates on
  your consent. This is the first self-updating build — update to it once by hand;
  future versions update in place.

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
