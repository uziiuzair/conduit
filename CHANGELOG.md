# Changelog

All notable changes to Conduit are documented here. This project uses
[semantic versioning](https://semver.org/).

## 0.30.0 — 2026-08-25

- **Fixed — Starting a session with a task no longer fails on Windows.** Any agent handed an
  opening instruction — every worker the Conductor spawns, and any session launched from a
  worktree whose path contains a space — died at launch with "too many arguments. Expected 1
  argument but got 16." Windows was splitting the instruction into one argument per word
  before the agent ever saw it. The command now travels in a generated script file instead of
  on the command line, so the whole instruction arrives intact no matter how long it is or
  what it contains.
- **Fixed — Continuity's presence and coordination work again on Windows.** In the installed
  Windows app, none of continuity's hooks or its MCP tools ever ran: every session ended with
  a "Stop hook error … EISDIR … lstat 'C:'" and the rest failed silently, so no session
  reported its presence, file activity or handoffs. The plugin was being located through a
  path shape Node refuses to load from. Sessions started from a development build were never
  affected.
- **Added — Command Code can be orchestrated.** The Conductor could not spawn a Command Code
  worker at all: it was missing from the list of agents `fleet_spawn` accepts. It is now a
  first-class choice, which matters because Command Code reaches its ~58 models through a
  separate subscription — so it keeps working when your Claude window closes.
- **Added — Pick the model a spawned worker runs on.** Workers used to be limited to a coarse
  cheap/standard/hard tier, which for Command Code could not name most of its catalogue. A
  spawn can now pin one exact model (`claude-opus-5`, `google/gemini-3.7-flash`,
  `deepseek/deepseek-v4-flash`, `gpt-5.5`, `xai/grok-4.5`, …), and the three tiers now map to
  real Command Code models instead of being ignored — cheap deliberately lands on an
  open-source model so mechanical work stops spending a frontier budget.
- **Added — Command Code workers hand their results back.** A Command Code session could only
  be watched through its terminal output; it had no way to report what it did or to exchange
  notes with its peers. It now gets the same structured hand-back and project mailbox a Claude
  worker has, so the Conductor learns whether a worker succeeded instead of guessing from
  scraped text.

## 0.29.0 — 2026-08-23

- **Added — Drag a session straight into a pane.** Drag any session from the sidebar onto the
  workspace: drop it on the left or right third of a pane to split beside it, or in the
  middle (or on a tab strip) to add it to that pane. Sessions from other projects work the
  same way, which is what the previous release's cross-project panes were missing — until
  now the only way in was the right-click menu.

## 0.28.1 — 2026-08-23

- **Fixed — Usage meters no longer disagree with each other.** The collapsed summary reported
  an account's worst window while the expanded view showed every window, so one view said
  "79%" and the other showed 18%, 3% and 79% with no hint of the connection. The summary now
  names the window it is reporting, and the low-alert list, the sort order and the health dot
  all read the same windows the meters draw — so hiding a window no longer leaves the
  headline number describing one you cannot see.
- **Fixed — A rate-limited check no longer blanks your usage.** Claude's usage endpoint
  throttles, and Conduit was polling it once a minute for every account (plus your real
  `claude` sessions doing the same). A throttled check wiped that account's meters and, worse,
  drew it as a healthy green dot — so the panel changed its mind minute to minute. Conduit
  now keeps the last good reading, marks it "last known", and checks every five minutes
  instead of every minute. An account whose quota genuinely could not be read shows a hollow
  dot and "not read" rather than a clean bill of health.
- **Fixed — The single-account view no longer shows another account's numbers.** With two
  Claude accounts signed in, a session that didn't name one would display whichever account
  happened to sort first — different figures from the stacked view for the same session. It
  now asks you to pick one instead of guessing.

## 0.28.0 — 2026-08-23

- **Added — Split panes across projects.** Sessions from different projects can now sit
  side by side. Right-click any session in the sidebar and choose **Open beside <project>**
  to borrow it into the panes you are already looking at. The session stays where it lives:
  it keeps its own project, its own sidebar row and its own working directory, and closing
  the borrowed tab leaves it running.
- **Added — Tabs say which project they belong to.** As soon as a set of panes holds more
  than one project, every tab gains its project's name and colour, and a pane whose tabs are
  all one project wears that colour along its top edge. Panes holding a single project look
  exactly as they did. Each project's colour is derived from the project itself, so it is
  the same in every window and on every machine — and the sidebar's folder icon now carries
  it too, so the colour on a tab always has something to point back to.
- **Changed — Clicking a borrowed session focuses it where it is.** Selecting a session in
  the sidebar that is already visible in the panes on screen now focuses that tab instead of
  switching projects and tearing down the split.

## 0.27.0 — 2026-08-23

- **Changed — Usage meters read one way, everywhere.** The number and the bar used to point
  in opposite directions: a meter that said "62% left" drew a bar filled to 38%. Every meter
  now shows how much you have **used** — the number, the bar and the collapsed summary all
  agreeing — which is what `claude /usage` and the agents' own usage views show. Reset times
  read "resets 3:50pm" instead of a bare timestamp.
- **Added — "Meters show" preference (Settings → Usage display).** Prefer a fuel gauge? Switch
  the whole panel to "Amount left" and the number, the bar and the summary all flip together.
  Colour still warns on consumption either way, so a meter reading "8% left" is red whichever
  direction you read.
- **Changed — The same window is named the same thing across agents.** Claude reported
  "Current session" / "Current week (all)", Command Code "5-hour window" / "Weekly", and
  Antigravity its own variants, so a stacked panel read as unrelated kinds of limit. They are
  now all "5-hour", "Weekly" and "Weekly · Opus"; Antigravity keeps its pool prefix
  ("Gemini · Weekly") because those genuinely are separate quotas.
- **Changed — Sessions show their agent's real logo.** The coloured monogram tiles (C, x, G,
  o, A, c) are gone, replaced by each agent's actual brand mark — Claude, Codex, Gemini,
  opencode, Antigravity and Command Code — tinted to stay legible in both the dark and the
  light themes.
- **Added — A ring around the agent logo shows what the session is doing.** No ring means it
  has not started; a faint ring means it is loaded and waiting; a slow pulse means it is
  working; a faster amber pulse means it needs you; a green ring means it just finished. The
  animation respects your system's reduce-motion setting, and every state is spelled out in
  the tooltip rather than left to colour.

## 0.26.3 — 2026-08-23

- **Fixed — Command Code usage appears for accounts, not just the default profile.** An
  account tagged for Command Code stores one Claude-shaped config directory, and the usage
  meter was looking for Command Code's credentials inside it. It never found them, so the
  account was reported as signed out and left out of the panel entirely — while its
  sessions ran perfectly well on the signed-in profile. The meter and the session now
  resolve the profile through one shared function, so they cannot describe different
  accounts.

## 0.26.2 — 2026-08-23

- **Fixed — Command Code usage now actually appears in the usage bar.** The meter read
  Command Code's quota from an endpoint that reports billing-period *spend* rather than
  *limits* — it answered normally, just with no caps in it, so every poll parsed to nothing
  and the account was left out of the panel entirely. It now reads the real limits endpoint
  and draws the 5-hour and weekly windows like every other agent.

## 0.26.1 — 2026-08-23

- **Fixed — launch no longer opens whichever project is at the top.** Conduit used to
  select the first project in the sidebar every time it started, open its tabs and (with
  restore-on-open) spawn all of its sessions — so reordering the sidebar changed which
  project launched, and coming back to a specific session meant clicking away from one you
  never asked for. It now reopens the project you were actually last in.
- **Added — a launch preference.** Settings → General — *Reopen the last project on
  launch*, on by default. Turn it off to start with nothing selected and nothing spawned.
  A stale memory (the project was deleted) also starts empty rather than falling back to
  someone else's project.

## 0.26.0 — 2026-08-23

- **Added — Read a session as a conversation.** A new Chat button on each session tab
  swaps the terminal for a rendered view of what the agent is doing: your prompts and its
  replies as messages, tool calls as one-line rows, and a proper input box instead of a
  terminal prompt. The terminal keeps running underneath the whole time and is one click
  away — nothing is paused, restarted, or lost. Turn it on in Settings → General.
  Claude sessions only for now.

---

## 0.25.0 — 2026-08-23

- **Added — Tell Conduit which agent should do which kind of work.** Settings →
  Routing lets you say that planning goes to Opus, implementation to Sonnet, checks to
  Haiku, research to Antigravity, and bulk edits to a local model — globally or for one
  project. The new-session dialog then asks what the session is for and picks the agent and
  model for you.
- **Added — Fall back automatically when an agent runs out.** Each kind of work has an
  ordered list, so if your first choice isn't installed or its quota is spent, the next one
  takes the job and the dialog tells you why it switched. The defaults come from what each
  agent is actually good at, and always fall back to a *different* agent — a second
  model on the same subscription runs out at the same moment as the first.

---

## 0.24.0 — 2026-08-23

- **Added — Command Code is now a Conduit agent.** Install it in one click from Settings
  → Agents and run it in sessions like any other agent, with live session status, resume
  across restarts, MCP server management, and multi-account support.
- **Added — Command Code usage in the usage bar.** Its five-hour and weekly rolling
  windows sit alongside your Claude and Antigravity meters, so you can see which
  subscription has room before you start.
- **Added — A settings page for Command Code.** Settings → Command Code sets the
  model, reasoning effort, taste learning, and which cheap model handles its internal
  housekeeping — without having to open a session to reach `/config`. Your existing
  config file is preserved and backed up before the first change.

---

## 0.23.0 — 2026-08-23

- **Added — A Windows installer.** Releases now publish a Windows `.msi` alongside the
  macOS build, and the updater knows about it. The installer is not yet code-signed, so
  Windows will warn about an unrecognized app on first run.
- **Fixed — Conduit builds and runs on Windows again.** The Windows build had been
  broken for 76 commits behind a macOS-only CI gate. Windows is now compiled, linted, and
  tested on every change, so it cannot break silently again.
- **Fixed — Honest advice about session persistence on Windows.** Settings used to say
  sessions would survive a quit once you installed tmux, which cannot be done on Windows.
  It now says persistence isn't available there, and the nagging banner about it is gone.

---

## 0.22.2 — 2026-08-18

- **Fixed — Collapsed projects no longer leave a stray line in the sidebar.** Folding a
  project away collapsed its sessions but left a short vertical stub of the indent guide
  hanging under the project name, along with a sliver of empty space. The guide now folds
  away with the rows it belongs to.

---

## 0.22.1 — 2026-08-16

- **Fixed — Deleting a session no longer takes the window down.** Closing a session tore its
  pane down in an order the WebGL renderer could not survive, and the error blanked Conduit
  behind the "Something went wrong" screen every time. Panes now shut their renderer down
  first, so deleting a session just deletes the session.
- **Fixed — Deleting a worktree session no longer leaves its worktree behind.** Conduit
  checked the worktree for uncommitted work while the agent was still writing to it, then
  handed git the stale answer; git refused to remove the directory and the session vanished
  anyway. The agent is stopped first, so the question is asked about a tree that has stopped
  moving.
- **Fixed — The window stays responsive while a session is deleted.** Stopping the agent,
  tearing down its tmux session, and deleting a worktree's files no longer run on the thread
  that draws the UI, so a large checkout no longer beachballs the app on its way out.

## 0.22.0 — 2026-08-15

- **Changed — Terminals draw on the GPU by default.** Panes now render through WebGL, which
  draws a whole screen in one pass instead of stamping glyphs one at a time on the CPU. Heavy
  output and fast scrolling stay smoother, and typing echoes with less delay.
- **Added — Settings → Terminal.** A new section with a **Renderer** choice: WebGL or Canvas.
  WebGL needs one GPU context per open pane and the system limits how many exist at once, so
  Canvas is there for anyone running a large fleet of sessions. Switching repaints every open
  pane immediately — sessions, scrollback, and running agents are untouched.
- **Fixed — A pane that loses its GPU context keeps drawing.** Past the system's context
  limit, an affected pane falls back to Canvas on its own instead of going blank, and your
  Renderer preference is left as you set it.

## 0.21.0 — 2026-08-14

- **Added — Continuity panels in the right column.** When continuity is installed and has
  run, two new tabs sit beside Terminal and Git: **Decisions** lists the calls your sessions
  have committed to, and **Messages** lists what they have said to each other. Each row is
  one line; clicking it opens the full recorded prose. Both are read-only and scoped to the
  current project — including sessions you started in a plain terminal inside the same
  checkout. Messages that reached this project as a broadcast from another one are dimmed
  and badged `ext`, so another repo's traffic never reads as your own. Without continuity,
  the tabs do not appear.

## 0.20.0 — 2026-08-10

- **Added — Command palette (⌘K).** Reach any action by typing its name: switch to a session
  (searchable by its branch), jump to another project, start a session with or without a
  worktree, toggle the board, canvas, sidebar, right panel or maximized pane, zoom, and open
  any Settings page directly. Matching is loose, so "tgcv" finds Toggle Canvas.
- **Added — Search past conversations.** Type three or more characters in the palette and it
  also searches every transcript Conduit can reach, showing the surrounding sentence. Enter
  jumps to that session; a conversation whose session no longer exists says so instead.
- **Added — Right-click the canvas.** Add a session or a sticky note exactly where you
  clicked, instead of wherever the next free slot happens to be. Notes are free text you can
  drag, resize, and delete like anything else on the plane, and they are saved with the
  project's layout.
- **Added — Notes can say which session they are about.** Right-click a note to link it to a
  session: a dashed line joins the two on the canvas and the note carries that session's
  name, so a note still says what it belongs to when the card is off-screen. It is a label
  only — nothing about a link is sent to the agent. Deleting the session keeps the note and
  drops just the link.
- **Added — Context-window meter.** Every session tab now shows how full its context window
  is, amber past 70% and red past 90%, with the token counts and the model in its tooltip.
- **Added — Agents panel.** When a session fans out into subagents you can finally see them:
  the right panel's new Agents tab shows each one's activity — what it said, the tools it
  ran, and a one-line summary of each result.
- **Added — Terminals survive a reboot, not just a quit.** Recent output is kept on disk and
  replayed when a session comes back with no live tmux to reattach to, so a terminal is no
  longer blank after a restart of the machine.
- **Added — Abandoned sessions are retired.** Sessions kept running by persistence used to
  accumulate indefinitely. They are now retired when the machine is genuinely short of
  memory (or the count has run away), never merely because they are old, and never while
  attached or recently used. A retired session reopens exactly like one that survived a
  reboot.
- **Fixed — Finished sessions no longer sit on "needs input".** Claude's idle notification
  fires after every completed turn, and Conduit was treating it as a request for attention.
  Notifications are now told apart, so only the ones that genuinely want you raise a badge.
- **Fixed — A session interrupted with Esc no longer shows as running forever.** The same
  idle signal now retires a turn that ended without a stop event, and a 20-minute watchdog
  catches the rest (a killed CLI, a slept machine). A Conductor that died mid-turn could
  previously never be woken again.
- **Fixed — A finished turn stays finished.** A late tool event arriving behind the end of a
  turn no longer flips the session back to running with nothing left to clear it.
- **Fixed — tmux is no longer missing in silence.** When session persistence is on but tmux
  isn't installed, Conduit now says so and offers the right install command for the machine
  instead of failing quietly.

## 0.19.0 — 2026-08-10

- **Added — Sessions keep running after you quit.** Each session now runs inside tmux, so
  agents keep working when Conduit is closed and the next launch reattaches to the live
  session instead of replaying the conversation. Scrollback and anything mid-run survive
  too, including for agents that have no resume of their own. On by default where tmux is
  installed; Settings → General has the toggle, and the quit prompt now says the agent will
  keep running rather than that it will be stopped.
- **Added — Canvas view.** A third way to look at a project, next to the terminals and the
  board: every session as a card on a pan/zoom plane you can arrange spatially. Drag cards
  where you want them, zoom with pinch or ⌘-scroll, Fit to bring everything back into view,
  and double-click a card to open that session. Positions are remembered per project.
- **Fixed — Sessions no longer go silent after a restart.** Status badges, the To-dos panel,
  and usage could stop updating for a session if Conduit restarted onto a different port.
  Hook events now resolve the port when they fire rather than when the session started, so a
  session recovers on its own.

## 0.18.0 — 2026-07-24

- **Added — Bundled formatter fallback.** Format Document now works even when a project has
  no prettier installed: Conduit falls back to a bundled prettier, loaded on demand (kept
  out of the initial bundle, so it costs nothing until first used). Projects with their own
  prettier and config are unchanged and always take precedence.
- **Added — Format on save.** Opt-in (Settings → Formatting), off by default. Formats the
  document on every save for supported file types (prettier, rustfmt, gofmt); other files
  save instantly as before.
- **Added — Format button.** A Format button in the editor toolbar for formatter-eligible
  files, alongside the existing Edit → Format Document menu item.
- **Added — Formatting settings.** A Settings → Formatting page with global prettier rules
  (print width, indentation, quotes, semicolons, trailing commas, end of line) used by the
  bundled fallback; a project's own `.prettierrc` overrides them.
- **Fixed — Silent Format Document.** Formatting outcomes now surface as an in-app message
  instead of doing nothing — missing prettier, read-only or oversized files, and
  already-formatted buffers all report clearly.

## 0.17.2 — 2026-07-24

- **Changed — worktree sessions show a git-branch icon instead of the branch name.**
  A session running on its own worktree now carries a small branch icon in the sidebar
  rather than the truncated `worktree-…` text, which was crowding the session name. Hover
  the icon to see the full branch name; it also remains visible in the Files panel and the
  terminal.

## 0.17.1 — 2026-07-19

- **Fixed — panels and the companion shell now follow the session's real directory.**
  Files, Changes, Git, and the right-panel terminal all bind to one confirmed
  per-session directory: the session's worktree once it exists on disk, the project
  root otherwise. The companion shell no longer lands in the home directory when it
  opens before a worktree has been created — it waits for the directory, and respawns
  into the right place if the worktree is later deleted (falling back to the project
  root) or recreated.
- **Fixed — Escape no longer exits fullscreen.** Pressing Escape (in the terminal, a
  dialog, or anywhere else) no longer drops the app out of macOS fullscreen; Escape
  keeps its in-app meaning only.

## 0.17.0 — 2026-07-17

- **Added — handoffs & presence on the board.** Cards now show a **presence dot** for who's live
  on them and a **↪ badge** when another session has handed the work off with context. Click a card
  to open a detail panel with the incoming handoff — what was done, suggested next steps, and the
  handed-over state — plus the card's body, claim, labels, and comments. Reads Continuity live; if
  it isn't running the board just shows no dots/badges.

## 0.16.0 — 2026-07-17

- **Added — session coordination (Continuity).** Board-enabled projects now bundle Continuity:
  each Claude session gets its own identity and can hand off work — with the context it built up
  and suggested next steps — to another session, and reports presence so you can tell who's live.
  Zero-config (local SQLite); needs Node ≥22.5 and is skipped gracefully otherwise, so nothing
  changes if Node is absent. Surfacing this on the cards (presence dots, handoff badges) comes next.

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
- **Changed — board UX.** The board is now a **workspace tab** (not a floating overlay): a
  **Board** button in the tab strip opens it full-width below the strip while terminals stay alive.
  Columns stretch to fill the width, cards use the app's palette, and "+ Add" lives inside each
  column beneath its cards.

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
