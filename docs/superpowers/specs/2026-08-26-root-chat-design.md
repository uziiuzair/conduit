# Root Chat — Design

**Date:** 2026-08-26
**Status:** Approved (brainstormed + section-by-section approval in session)
**Scope decision:** Ship read-only analyst (Option B below), keep a documented rail to the Conduit-copilot upgrade (Option C). No copilot tooling in this increment.

## 1. What this is

A root-level chat surface in Conduit, backed by the real `claude` CLI, that is **not a code
agent**. It is a project-management and ideation partner that lives above all projects: it
can read anything under a configured workspace root (e.g. `~/ooozzy`), knows the user's
registered Conduit projects, and holds multiple persistent conversations — but it has no
terminal, no directory watching, no git panels, and it can never write code or mutate files.

The user-facing shape:

- A pinned root node in the sidebar (working label: **"HQ"**) above the project list, with
  a list of chats under it and a "+" to start a new one.
- Selecting a chat swaps the main area to a clean chat interface: markdown bubbles,
  streaming responses, collapsed tool chips, a composer.
- Conversations persist across app restarts and are resumable indefinitely.

### Scope ladder (decided)

- **A. Pure advisor** — conversation only. Rejected as needlessly weak: Claude's own
  read tools are free capability.
- **B. Read-only analyst (this increment)** — chat + guaranteed read-only file access
  across the workspace root, enforced by CLI tool policy, not prompt language.
- **C. Conduit copilot (future)** — B plus MCP tools into Conduit itself (list projects,
  peek sessions, dispatch work). Explicitly out of scope; §8 records the rail.

## 2. Backend mechanism (decided): spawn-per-message headless

Each user message runs one short-lived headless CLI invocation:

```
claude -p <message> \
  --resume <claude_session_id>          # omitted on the first message of a chat
  --output-format stream-json --verbose \
  --allowedTools Read Glob Grep WebSearch WebFetch \
  --disallowedTools Bash Write Edit NotebookEdit \
  --strict-mcp-config \
  --append-system-prompt <charter>
```

with `cwd` = the workspace root. Rust parses the stream-json lines from stdout and emits
Tauri events; the React chat view renders them. The first turn captures the CLI-chosen
`session_id` from the `init` event and stores it on the chat record; every later turn
resumes it.

Why this over the alternatives considered:

- **Hidden interactive PTY + transcript read** (the mobile-companion write path):
  rejected. The write channel is keystroke injection into a TUI, and interactive Claude
  renders permission prompts inside that invisible TUI — the chat would silently hang.
- **Persistent `claude -p --input-format stream-json` process per chat:** viable v2 if
  per-message spawn latency (~1–2 s) annoys. Costs process-lifecycle management (idle
  chats holding live children, hibernation interplay) that spawn-per-message avoids
  entirely.

Properties that fall out of spawn-per-message:

- **Chats are data, not terminals.** No PTY, no tmux wrap, no scrollback.rs snapshot, no
  session_budget reaping, no keep-alive constraint. The transcript on disk *is* the
  state; `--resume` reconstitutes it.
- **Zero memory when idle.** No child process exists between turns.
- **The charter is rebuilt every turn** (see §4) — the registered-project roster and
  settings are never stale.
- **Interrupt is trivial:** kill the child.
- **No permission prompts can block invisibly:** in `-p` mode, tools outside the
  allowlist are auto-denied.

## 3. Data model and Rust backend

### Store (`store.rs`)

- New top-level `root_chats: Vec<RootChat>` in `state.json` — deliberately **not**
  sessions inside a project.

  ```rust
  struct RootChat {
      id: String,                        // Conduit-side id
      title: String,
      claude_session_id: Option<String>, // captured from init event on first turn
      account_id: Option<String>,        // pinned at creation, immutable (see §6)
      created_at: String, // same timestamp convention store.rs already uses
  }
  ```

- New setting `workspace_root: Option<PathBuf>`; default the user's home directory.
  Surfaced in Settings.

### New module `src-tauri/src/root_chat.rs`

- `root_chat_send(chat_id, text)` — spawns the invocation above.
  - `cwd` = workspace root.
  - Must call `env_remove("npm_config_prefix")` — same nvm gotcha as the two existing
    spawn sites (`pty.rs`, the `claude -p` titler in `lib.rs`).
  - Account env resolved through the existing `ProviderAdapter::account_env` seam using
    the chat's pinned `account_id` (chat → global default → env), mirroring
    `session_account_config_dir` resolution.
  - A reader thread parses stdout line-by-line into a `RootChatEvent` enum (pure
    function, unit-tested) and emits Tauri events:
    - `root-chat-delta` — assistant text chunks for streaming render
    - `root-chat-tool` — tool_use name + input summary (for collapsed chips)
    - `root-chat-done` — result record (cost, duration, turn count)
    - `root-chat-error` — spawn failure, non-zero exit, resume failure
  - On the first turn, writes the captured `session_id` back to the store.
  - **One live child per chat.** A send while a child is running for that chat is
    rejected; the UI disables the composer instead of queueing.
- `root_chat_stop(chat_id)` — kills the live child, if any.
- `root_chat_history(chat_id)` — reads the chat's Claude transcript through the existing
  `transcript.rs` chat-item parser (the mobile read channel, reused wholesale) and
  returns renderable history. Resolves the transcript directory per the chat's account,
  exactly like the four existing transcript consumers.
- Title generation reuses the existing `claude -p` titler after the first exchange.

### What root chat explicitly does NOT touch

No `pty.rs`, no `tmux.rs`, no `fleet.rs`/status hooks, no `sessionDirs`/`workingDirOf`/
`effectiveDirOf` seam (`store.seam.test.ts` untouched), no Conductor visibility, no
session budget. It is invisible to the entire terminal architecture.

## 4. Read-only hardening and the charter

Enforcement is **flags first, prompt second**:

1. `--allowedTools Read Glob Grep WebSearch WebFetch` — in `-p` mode, anything unlisted
   is denied without a prompt.
2. `--disallowedTools Bash Write Edit NotebookEdit` — belt and braces on the mutating
   tools.
3. `--strict-mcp-config` with no MCP config supplied — the user's global MCP servers
   (mail, databases, payments, …) never load into root chat. Faster spawn, no
   side-channel write capability.

The **charter** goes in via `--append-system-prompt` and is rebuilt fresh on every spawn:

- Role: project-management and ideation partner across all of the user's projects.
  Never writes code, never modifies files. When a conversation reaches "this should be
  built," the deliverable is a concise implementation brief the user carries into a
  Conduit work session (phrased to leave room for future dispatch — the rail to C).
- The workspace root path.
- The registered-project roster: each Conduit project's name and path, pulled from the
  store at spawn time. This covers projects outside the workspace root too.

## 5. Frontend

### Sidebar (`Sidebar.tsx`)

Pinned root node above the projects list; chats beneath it; "+" for new chat;
right-click menu: rename, delete.

### Main area — keep-alive constraint (load-bearing)

Selecting a root chat must **not** unmount the terminal grid. The chat view is a
CSS-shown layer over CSS-hidden terminals — the same mechanism that keeps PTYs alive
across project switches. Never conditionally render the grid away.

### `RootChatView.tsx`

- Message list: user bubbles plain, assistant bubbles markdown-rendered.
  - New frontend deps: `react-markdown` + `remark-gfm`. (The lean-dependency rule in
    CLAUDE.md governs the Rust side; this is a frontend rendering concern.)
- Streaming: assistant text accumulates from `root-chat-delta` events.
- Tool chips: `root-chat-tool` events render as collapsed one-line chips
  ("Read src/store.ts") — visible proof of read-only work without transcript noise.
- Composer: textarea; Enter sends, Shift+Enter inserts newline; Stop button while a
  child is live; composer disabled (not queued) while running.
- Empty state for a fresh chat.
- On open, history loads via `root_chat_history`; live turns append via events. The
  frontend persists no messages itself.

### Right column and tab strip

Hidden for root chats: no Files/Changes/Git panels, no directory path in the tab strip,
no Open-in-VS-Code, no companion shell. Root chats never enter the `sessionDirs` map.

### Store (`store.ts`)

`rootChats` list + per-chat message state + streaming/running flags, filled by the
events above. Pure reducer logic (append, delta accumulation, send-while-running block)
lives in testable functions.

## 6. Persistence, restore, shutdown

- `root_chats` persists in `state.json`. Restore is trivial: the list is just there;
  opening a chat replays the transcript. Nothing spawns at launch —
  `restoreSessionsOnOpen` does not apply.
- **Quit guard:** a live root-chat child counts as a running agent — folded into the
  `live_running_agent` check so quitting mid-turn asks for confirmation.
- **Account pinning:** `account_id` is fixed at chat creation and immutable. Transcripts
  live under the account's config dir; switching accounts mid-chat would orphan the
  resume chain.

## 7. Edge cases

- **Resume failure** (transcript deleted, CLI error): surface an error bubble with a
  "start fresh thread" action — clears `claude_session_id`, keeps the chat record and
  title; prior history is gone and the UI says so.
- **Chat deletion:** removes the `RootChat` record only. The transcript on disk belongs
  to Claude's own store and stays (palette search over past conversations still finds
  it).
- **`claude` not on PATH:** same error surface as the existing titler path.
- **Context growth:** each `--resume` reloads the whole conversation; the user's lever
  is starting a new chat. A per-chat context meter via `context_window.rs` is a natural
  v2, not in scope.

## 8. Rail to Option C (documented, not built)

When the copilot increment happens:

- Add `--mcp-config` pointing at an in-app HTTP MCP endpoint (the `fleet_mcp.rs`
  precedent) serving root-scoped tools (`project_list`, `session_spawn`, …), and widen
  the charter and tool allowlist accordingly.
- **Precondition:** the caller-role guardrail gap in `dispatch_tool` (orchestration-v2
  design doc §2.0) must be closed before any root-chat MCP exposure — root chat must
  never inherit worker/Conductor tool surface by accident.
- The `--strict-mcp-config` flag stays; C means *one deliberately supplied config*, not
  re-opening the user's global MCP fleet.

## 9. Testing

- **Rust (`#[cfg(test)]`, colocated):**
  - stream-json line parser: line → `RootChatEvent` (init, delta, tool_use, result,
    error, junk line tolerance).
  - charter builder: roster injection, workspace-root fallback to home.
- **Frontend (vitest, colocated):** root-chat store slice — message append, delta
  accumulation, send-while-running rejection.
- **Manual gate (per CLAUDE.md, UI changes require launching the app):** converse,
  restart the app, reopen the chat and verify replay; ask the chat to write a file and
  verify the denial; verify terminals stay alive across the view swap.
- CI (typecheck, vitest, build, fmt, clippy, cargo test) covers the rest.

## 10. Versioning

User-facing feature → MINOR bump to **0.23.0** with a matching `CHANGELOG.md` entry when
it ships (three version files + changelog in lockstep, per CLAUDE.md).
