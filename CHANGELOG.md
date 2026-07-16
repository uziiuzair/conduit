# Changelog

All notable changes to Conduit are documented here. This project uses
[semantic versioning](https://semver.org/).

## 0.15.0 — 2026-07-17

- **Added — stage-gate cards on the task board.** Any board card can now opt into a full
  delivery workflow — discovery → requirements → UX → architecture → plan → build → verify.
  The agent that claims a workflow card is handed that stage's role briefing inline (planner,
  UX, architect, or implementer), writes the stage's artifact into `.conduit/work-items/`, and
  reports the outcome to advance the card. An enforced state machine keeps the pipeline honest:
  an agent can't skip your sign-off — the card stops for you at requirements clarification and
  at final verification, where you Approve or send it back from the board. Each project also
  gets a shared knowledge bundle in `.conduit/knowledge/` (decisions, patterns, anti-patterns,
  domain, components) that the role agents read before proposing and promote to as work lands.

## 0.14.0 — 2026-07-16

- **Added — project task board.** Every project now has a Kanban board stored in its own
  repo under `.conduit/board/` (git-shared with your team, one file per card). Open it as a
  full-screen view with ⇧⌘B, then drag cards between columns and add cards inline — the
  terminals keep running underneath. Live agent sessions in the project claim, move, and
  comment on cards through new `task_*` MCP tools, so a fleet coordinates on shared work
  without stepping on each other: a claimed card can't be double-worked, and card ownership
  is shown right on the board. Off until you open a board in a project.

## 0.13.0 — 2026-07-14

- **Added — rename projects in the sidebar.** Give a project any display name you
  like: right-click its header (or open the ⋯ menu) and choose Rename, or just
  double-click the project name to edit it in place. Enter saves, Escape cancels.
  This renames the sidebar label only — the folder on disk is never touched.

## 0.12.2 — 2026-07-13

- **Changed — sidebar project headers highlight on hover only.** The faint
  background fill behind each project title no longer shows at rest; it now
  appears on hover, so the header list reads cleaner and unselected groups sit
  flat.
- **Fixed — security: patched vulnerable bundled dependencies.** Updated transitive
  dependencies flagged by security advisories. In the desktop app: the HTML
  sanitizer used by the code editor (DOMPurify 3.2.7 → 3.4.12) and the build
  toolchain (esbuild 0.27.7 → 0.28.1). In the mobile companion: the Markdown,
  link-detection, and UUID libraries (markdown-it 10 → 14.3.0, linkify-it 2.2.0 →
  5.0.2, uuid 7.0.3 → 11.1.1). No behavior changes; closes 20 Dependabot alerts.

## 0.12.0 — 2026-07-13

- **Added — auto-updates (macOS).** Conduit now checks GitHub Releases in the
  background and via Settings → About, and installs signed + notarized updates on
  your consent. This is the first self-updating build — update to it once by hand;
  future versions update in place.

## 0.11.0 — 2026-07-13

- **Added — sidebar drag-and-drop reordering.** Drag a project header to reorder
  projects, or drag a session row to reorder sessions within their project; an
  accent line previews the drop position and the order persists across launches.
  Project headers also got a clearer visual hierarchy: a header slab, bolder
  names, group separators, and an indent guide nesting sessions under their
  project.
- **Fixed — plan-usage connections self-heal.** "Connect plan usage" no longer
  reports a missing sign-in when the saved token is merely expired or the network
  blips: connecting now just verifies credentials exist, and the usage poll
  re-reads the on-disk token (never the macOS Keychain) and retries, so bars
  recover on their own after Claude Code refreshes a token. Transient failures no
  longer disconnect an account or block reconnection on the next launch.

## 0.10.3 — 2026-07-13

- **Changed — Settings control polish.** The glossy native macOS checkboxes, range
  sliders, and account/select dropdowns in Settings are replaced with
  theme-matched controls: custom-drawn checkmarks on accent fills, a themed slider
  track and thumb, and a hand-drawn select chevron. Scoped to the settings and
  dialog toggles so Markdown-preview task-list boxes and the agy accent toggle are
  untouched.

## 0.10.2 — 2026-07-13

- **Fixed — clipboard paste into the terminal.** WKWebView on macOS 26 gates
  `navigator.clipboard.readText()` behind a native consent popup that the
  canvas-rendered xterm can't satisfy, so browser-side paste silently failed
  (copy still worked). Conduit now reads the OS clipboard on the Rust side and
  hands the text to the terminal; a clipboard image is encoded to a temp PNG whose
  path is pasted, matching how Claude Code's TUI attaches image files.

## 0.10.1 — 2026-07-13

- **Fixed — usage meter fill direction and color.** Remaining-mode bars drew the
  remaining amount as a full bar, so "95% left" rendered as a 95%-full bar that
  read like consumption; the fill now tracks the used amount (label still shows
  "% left") so every bar fills in the same direction. The discrete amber/red
  health tiers are replaced by a smooth color-mix ramp from the agent's base color
  toward muted red as the bar approaches full, with onset derived from the
  Settings low-threshold preference.

## 0.10.0 — 2026-07-12

- **Added — session restore on startup.** Reopen where you left off: opening a
  project eagerly relaunches all of its sessions (gated by a new
  `restoreSessionsOnOpen` setting, default on; other projects stay lazy). Claude
  resumes via `--resume`; agy resumes via `agy --conversation=<uuid>`, with the
  conversation id captured from agy's own status-line payload (race-free per
  session) or an unambiguous spawn-time baseline, and persisted so stale ids
  self-clear and re-capture. Claude + agy today; Codex, OpenCode, and Gemini
  deferred.
- **Added — safe-shutdown guard.** Quitting the app or closing a single session
  now prompts for confirmation whenever an agent is still running, cross-checked
  against a live PTY so stale or deleted-session statuses can't false-prompt;
  confirming hard-kills the process while keeping history. agy activity reaches
  the guard through its status-line `agent_state`, since it fires no Claude-style
  lifecycle hooks.

## 0.9.0 — 2026-07-12

- **Added — multiple accounts, assignable per session and per project.** Accounts
  are now agent-aware (Claude + agy) and carry which agents they're signed in
  for. Set per-agent global defaults and per-project defaults; a resolver chain
  (session → project default → global default → env) picks the account at spawn.
  A `ProviderAdapter::account_env` seam centralizes the account→env redirect and
  is the single extension point a future multi-account agent implements.
- **Added — all-accounts usage bar.** A unified usage panel replaces the two
  agent-gated panels and shows every registered account's quota at once — Claude
  usage fetched per account (per-account token cache), agy snapshots keyed by the
  posting session's resolved account — driven by user-selectable view preferences
  (layout, window filters, sort, low-usage threshold). Polling runs at the app
  root so every account refreshes regardless of the selected agent or sidebar
  state.
- **Added — account assignment UI.** Settings → Agent accounts (agent tags plus
  per-agent and per-project defaults), a new-session account picker, a right-click
  "Account" submenu, and a per-session chip in the sidebar. Account discovery is
  generalized to any `<profile>/.claude` under home.

## 0.8.0 — 2026-07-12

- **Added — Antigravity (agy) usage bar.** A violet sidebar meter for agy
  sessions, sourcing quota from agy's own status-line command hook (its documented
  extension surface — avoiding the ToS-forbidden direct API access). Because agy
  execs status-line commands without a shell, Conduit ships a helper script
  (`conduit-usage.bat` / `.sh`) that posts agy's JSON to the local hook server and
  echoes the response back as agy's status line. The quota map is parsed into
  Gemini / Claude&GPT pools (Weekly + 5-hour remaining) plus plan tier and context
  window; config is synced into the session's resolved home and written
  atomically, and quota-less ticks are dropped so they can't clobber a good
  snapshot.
- **Fixed — Windows terminal and paths.** Path base/parent names now split on both
  `/` and `\` (Rust emits native backslash paths), fixing the agy worktree "not a
  valid branch name" bug and garbled editor tab names. Terminal copy/paste and
  click-to-open-path are now cross-platform (Ctrl+C / Ctrl+Shift+C / Ctrl+V and
  Ctrl+Click on Windows/Linux, Cmd on macOS).

## 0.7.0 — 2026-07-10

- **Added — markdown preview.** A "Preview" button in the editor breadcrumb (and
  ⇧⌘V) overlays the still-mounted editor with the active buffer rendered as HTML,
  re-rendered live from the shared model (150 ms debounce); ⇧⌘V returns to source
  and ⌘S saves from either. Rendering goes through `marked` (GFM) behind a strict
  DOM-whitelist sanitizer that is the security boundary since the webview ships
  `csp:null` — script/iframe and non-whitelisted attributes are stripped and URL
  schemes policed; anchor clicks route through the external opener rather than
  navigating the webview.
- **Added — editor tier-2 polish.** Eleven VS Code-parity features with zero new
  dependencies: a dirty-state quit/close guard (round-trips to a Rust `DirtyGuard`
  only when there are unsaved changes) plus Save All; tab navigation (⌃Tab /
  ⌃⇧Tab, ⌘1–9, ⌘⇧T to reopen closed tabs); italic **preview tabs** that replace
  each other until pinned; a tab context menu and Reveal in Finder/Tree;
  breadcrumb status chips (Ln/Col, indentation, clickable LF/CRLF); word wrap,
  synchronized editor+terminal font zoom, and Clean Whitespace on Save; maximize
  editor group (⇧⌘M) as a geometry-only override that never unmounts keep-alive
  panes; and image preview for binary raster files.
- **Added — editor tier-3.** Diff with HEAD (side-by-side overlay whose modified
  side is the live buffer, with gutter change stripes); Quick Open (⌘P) fuzzy file
  palette over `git ls-files`; Find in Files (⌘⇧F) via `rg --json` with git-grep /
  grep fallbacks; Format Document (⇧⌥F) piping the buffer through project-local
  prettier / rustfmt / gofmt as one undo-preserving edit; Discard to HEAD
  (confirm-guarded `git restore` / delete); and hot exit — dirty buffers are
  backed up to app-data and restored as dirty on relaunch, so ⌘Q backs up and
  quits silently. Shells out to git/rg/grep and the project's own formatter per
  the lean-dependencies doctrine.

## 0.6.1 — 2026-07-08

- **Fixed — full local Claude usage.** The local-consumption meter now reports the
  full local Claude usage instead of an undercounted figure.

## 0.6.0 — 2026-07-08

- **Added — terminal-to-editor navigation.** Cmd-click file paths in any terminal
  to open them in Conduit's editor, including absolute, home-relative, explicit
  relative, and workspace-relative paths with optional `:line` or `:line:col`
  suffixes. Matching paths reveal the target line in Monaco, and terminal
  Cmd+Left / Cmd+Right now jump to the start/end of the input line.
- **Added — orchestration v2.** The Conductor now coordinates a capability-aware,
  cost-conscious fleet across agent types with project-scoped missions, structured
  worker handback, reactive wakeups, per-session effort/model routing, worker
  mailbox notes, and usage tallying.
- **Added — local OpenCode models.** OpenCode sessions can run against local or
  self-hosted OpenAI-compatible endpoints such as Ollama, LM Studio, vLLM,
  llama.cpp, and OpenWebUI, with live server/model detection, context/output
  limits, API-key handling, local-only pinning, and tool-calling probes.
- **Added — one-click agent installs.** Missing agent CLIs can now be installed
  from Settings or onboarding, using each provider's known installer and
  re-detecting availability afterward.
- **Added — private mode trust boundaries.** Sensitive sessions can be marked as
  siloed so they remain visible on desktop but are withheld from remote streaming
  and other agents, with fleet read/send policy gates and a local sensitivity
  scanner.
- **Changed — editor polish.** Monaco editor behavior now explicitly pins the
  bundled editor contributions, adds themed bracket-pair guides, routes editor
  links through the native external opener, renders selected whitespace, and adds
  Find and Replace to the Edit menu.
- **Changed — Settings organization.** Settings now uses grouped navigation for
  coding agents, local models, MCP servers, accounts, privacy/security, and about
  content as the configuration surface has grown.
- **Fixed — OpenCode local model setup.** Hardened loopback endpoints, proxy
  bypassing, API-key attachment, stale probe state, limit schema generation,
  model picker stability, and theme variables for the Local Models panel.
- **Fixed — editor reveal edge cases.** Terminal path reveals clamp invalid
  columns, clear stale pending reveals when leaving a tab, and avoid opening a
  path after a terminal has been disposed.

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
