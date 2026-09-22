# Conduit as a Claude Code IDE — design

**Date:** 2026-09-23
**Status:** approved (topology + scope approved in-session; protocol verified empirically)
**Branch:** `feat/ide-integration`

## What this is

Conduit announces itself to the `claude` CLI as an IDE, the way the VS Code and JetBrains
extensions do, so every Claude session Conduit spawns connects back over WebSocket/MCP and
gains the IDE feature set: diff review in Conduit instead of the terminal prompt, selection
context, at-mentions, `openFile`, and workspace/diagnostics queries.

Scope decisions made during brainstorming:

- **Full protocol including `openDiff`** — the marquee win is reviewing Claude's edits in a
  Monaco diff with Keep/Reject buttons.
- **Conduit-spawned sessions are first-class.** External `claude` processes running in the
  same checkout may discover Conduit via `/ide`, but that path is best-effort (see
  "Discovery validity" below for why it is structurally unreliable) and not a goal.
- **Memory footprint is a hard constraint.** No spawned server processes, no new async
  runtime. Everything is in-process listener threads on the existing sync `tungstenite`
  dependency (the `bridge.rs` pattern). Cost per running session ≈ one listener thread +
  one connection thread + socket buffers — tens of KB, not MB.

## The protocol (verified against claude 2.1.267, 2026-09-23)

The IDE protocol is undocumented; the reference implementation is `coder/claudecode.nvim`
(`PROTOCOL.md`). Everything below was **verified empirically** with a throwaway Bun WS
server against the real installed CLI (see "Empirical findings"), because the protocol has
drifted from that document.

- **Lock file** `<claude config home>/ide/<port>.lock`, perms 0600, JSON:
  `{ pid, workspaceFolders: [dir], ideName: "Conduit", transport: "ws", authToken }`.
  The file NAME is the port. `authToken` is 32 lowercase hex chars (128 bits, CSPRNG).
  2.1.267 also reads an optional `runningInWindows` (WSL bridging; set `true` on Windows
  builds). A non-JSON lock file is parsed as a legacy newline-separated folder list.
- **Env on the spawned `claude`:** `CLAUDE_CODE_SSE_PORT=<port>` is the auto-connect
  trigger in 2.1.267 (`ENABLE_IDE_INTEGRATION` no longer appears in the binary; we still
  set it to `true` for older CLIs — harmless either way). `CLAUDE_CODE_AUTO_CONNECT_IDE`
  also exists; not needed when SSE_PORT is set.
- **Transport:** plain `ws://127.0.0.1:<port>`. The client requests **WebSocket
  subprotocol `"mcp"`** — the handshake response must echo `Sec-WebSocket-Protocol: mcp`.
  Auth: header `X-Claude-Code-Ide-Authorization: <authToken>`; reject mismatches with 401.
- **MCP lifecycle** (JSON-RPC 2.0 over WS text frames, one message per frame):
  `initialize` (client protocolVersion `2025-11-25`; echo it back) →
  `notifications/initialized` → client notification `ide_connected {pid}` → `tools/list`,
  then `tools/call` as needed. Server-initiated notifications flow on the same socket.

### Empirical findings (probe transcript, 2026-09-23)

1. With only `CLAUDE_CODE_SSE_PORT` set and a matching lock file present, claude 2.1.267
   connected, authenticated, negotiated the `mcp` subprotocol, initialized, and sent
   `ide_connected {pid}` — under tmux, in a plain terminal.
2. In manual-approve mode, a Write triggered `tools/call openDiff` with
   `{old_file_path, new_file_path, new_file_contents, tab_name}` (tab_name like
   `✻ [Claude Code] hello.txt (87bc70) ⧉`), while the terminal showed its own permission
   prompt in parallel. The IDE response resolves that prompt.
3. **`openDiff` accept contract:** the response content MUST be two text items:
   `[{type:"text",text:"FILE_SAVED"},{type:"text",text:<final file contents>}]`.
   The binary's check is literally `e[0].text==="FILE_SAVED" && typeof e[1].text==="string"`.
   Claude substitutes the returned contents into its own Write/Edit input and **writes the
   file itself** — the IDE must NOT write the file (verified: probe never touched disk,
   the file appeared, prompt auto-resolved). A single-item `FILE_SAVED` is silently
   ignored and the terminal prompt stays up. The second item is how user edits made inside
   the diff view travel back.
4. **Reject contract:** `[{type:"text",text:"DIFF_REJECTED"}]` (single item), renders as
   "User rejected write" immediately.
5. After a verdict claude calls `close_tab {tab_name}` (sometimes twice) and
   `closeAllDiffTabs` before opening the next diff; reply `TAB_CLOSED`.
6. In auto-accept mode no `openDiff` is issued — edits apply directly. The diff review is
   the manual-mode flow.

### Discovery validity (why external `/ide` is best-effort)

For a lock file whose port does not match the client's `CLAUDE_CODE_SSE_PORT`, claude
validates the lock's `pid` as its own ancestor or a member of a hardcoded known-IDE
process scan (`ps aux | grep -E "Visual Studio Code|…|IntelliJ…"`). Conduit is not in that
list, and under tmux Conduit is never the claude process's ancestor. The port==env match
bypasses the check entirely, which is exactly the Conduit-spawned path. This is the
structural reason external discovery is out of scope. (`CLAUDE_CODE_IDE_SKIP_VALID_CHECK`
exists for debugging.)

## Topology: one server per session

Conduit is one window hosting many sessions across many projects — the protocol carries no
client identity on the wire, and VS Code's "one window = one workspace = one claude"
assumption does not hold. The only reliable identity recovery is making the port itself the
identity: **each running Claude session gets its own listener** (ephemeral port — bind
`127.0.0.1:0`, the lock file name is whatever the OS picked), its own lock file whose
`workspaceFolders` is that session's effective directory (worktree once it exists), and its
own auth token. A connection on that port IS that session; `openDiff` lands on the right
pane and `at_mentioned` reaches exactly one claude, with no pid forensics (impossible under
tmux anyway — the tmux server owns the process tree).

Rejected alternatives: one global server (cannot attribute `openDiff` to a session;
peer-port→pid forensics are platform-specific and broken by tmux) and per-project servers
(same ambiguity between a project's sessions, which is Conduit's whole point).

## Architecture

### Rust: `src-tauri/src/ide_host.rs` (new)

- `IdeHost` (managed state): `Mutex<HashMap<session_id, IdeSession>>` where `IdeSession`
  holds port, token, lock-file path, a shutdown flag, an outbound `mpsc::Sender` (server→
  client notifications), the latest editor context pushed by the frontend, and pending
  `openDiff` waiters.
- **Server loop:** `tungstenite::accept_hdr` validates `X-Claude-Code-Ide-Authorization`
  (constant-time compare) and echoes subprotocol `mcp`; then the `bridge.rs` pattern — a
  read timeout on the socket, JSON-RPC dispatch on message, outbound channel drained in
  the `WouldBlock` arm. One connection at a time per session; a new connection replaces
  the old (claude reconnects after a restart).
- **Dispatch takes a sink trait, not `AppHandle`** (the `cli_open.rs` lesson) so
  `src-tauri/tests/` can drive the real handler over a real socket with a real WS client.
- **`openDiff` blocks broker-style:** register a waiter, emit `ide-open-diff` to the
  frontend, park until the verdict arrives via the `ide_diff_verdict` Tauri command (or
  the session dies → `DIFF_REJECTED`). No server-side timeout — claude owns the timeout.
- **Spawn integration (`pty.rs`):** on a Claude agent spawn (adapter is Claude, not
  `shell_only`, pref enabled), `ide_host::start_for_session` binds the listener, writes
  the lock file, and hands back env pairs; teardown in `tear_down` (both retire and kill)
  closes the listener and removes the lock. App exit removes all locks.
- **Env transport:** POSIX — the vars join `build_script`'s existing `export` line
  (`cmd.env` dies at the tmux server boundary for every session after the first; the
  export line inside `sh -c` is the mechanism that already carries
  `CONDUIT_SESSION_ID`). Windows — `cmd.env`, which `build_script_win` documents as the
  native path (no tmux there).
- **Lock directory resolution mirrors `agent::claude_profile_env`:** an account whose
  `config_dir` ends in `.claude` redirects HOME → lock dir is
  `<profile root>/.claude/ide`; a custom dir sets `CLAUDE_CONFIG_DIR` → lock dir is
  `<config_dir>/ide`; ambient → `~/.claude/ide`. Writing to the real home for a redirected
  session would announce to a claude that can never see it.
- **Warm re-attach:** `Session.ide_port`/`ide_token` persist (`#[serde(default)]`,
  omitted when absent). A warm tmux re-attach re-binds the SAME port with the SAME token
  and rewrites the lock, so the still-running claude's `CLAUDE_CODE_SSE_PORT` stays
  valid and `/ide` inside that session lists Conduit again. If the bind fails, mint a
  fresh port; the old claude stays disconnected until its next cold spawn (accepted).
- **Startup sweep:** remove lock files with `ideName == "Conduit"` AND a dead pid, in
  every lock dir Conduit writes to. Never touch other IDEs' lock files.

### Tools served

| Tool | Behavior |
| --- | --- |
| `getWorkspaceFolders` | Session effective dir (+ project root when different). |
| `getCurrentSelection` / `getLatestSelection` | Answered from the pushed editor context. |
| `getOpenEditors` | Pushed editor context (the session's project's editor tabs). |
| `getDiagnostics` | Monaco markers from the pushed context; often empty — that is fine. |
| `openFile` | Emit `ide-open-file`; frontend opens the tab in that project's editor pane. |
| `openDiff` | Blocking review flow (above). Accept ⇒ `[FILE_SAVED, contents]`; reject ⇒ `[DIFF_REJECTED]`. Conduit never writes the file. |
| `checkDocumentDirty` / `saveDocument` | From/through the frontend; Conduit's editor autosaves, so dirty is almost always false. |
| `close_tab` / `closeAllDiffTabs` | Dismiss the named / all pending diff reviews for that session; reply `TAB_CLOSED`. |
| `executeCode` | **Omitted deliberately** — Jupyter-only, Conduit has no kernel. |

Notifications (server → claude): `selection_changed` (debounced Monaco selection, sent to
every connected session of the project owning the file) and `at_mentioned` (explicit user
action, sent to the active session only).

### Frontend

- `src/hooks/useIdeBridge.ts` — pushes editor context (open tabs, active file, selection,
  markers) to Rust on change (debounced ~150 ms); subscribes to `ide-open-diff` /
  `ide-open-file` events.
- `src/components/DiffReviewOverlay.tsx` — Monaco diff editor with Keep / Reject, an
  absolutely-positioned overlay (like `SessionChat.tsx`) so no terminal is ever
  reparented (keep-alive rule). One review at a time per session; further requests queue.
  The proposed side is editable; Keep sends the current (possibly edited) text as the
  second content item.
- Store: `pendingDiffs` map (runtime-only), setting `announceAsIde` (default on,
  Settings → General). Pure helpers (`src/ideBridge.ts`) stay importable without
  `store.ts` for the node-env vitest, same as `usageRows.ts`.

## Error handling

- Protocol drift degrades silently: unknown methods answered with an empty result (the
  probe showed claude tolerates this), unknown tools with a JSON-RPC error; the session
  keeps working as a plain terminal. Never crash a PTY over the IDE channel.
- The auth check runs before any request processing; a request with a bad or missing
  token gets 401 and no protocol response (not a token oracle).
- A dead frontend listener (event emitted, no verdict ever) is claude's timeout to
  handle; Conduit replies `DIFF_REJECTED` on session teardown so claude is never left
  hanging by a kill.
- The token is held in memory and the lock file (0600); it is never logged (Secrets rule).

## Testing

1. **Empirical probe (done, pre-implementation)** — findings above; the probe script is
   throwaway (scratchpad), its findings live in this spec.
2. **Rust unit tests:** lock JSON shape (exact field names, round-trip), token format,
   sweep predicate (only Conduit-named + dead-pid locks), lock-dir resolution per account
   shape, handshake accept/reject + subprotocol echo, openDiff waiter semantics
   (verdict, replace-on-reconnect, teardown ⇒ rejected), env-pair injection presence in
   `build_script` output.
3. **Integration test** (`src-tauri/tests/ide_host.rs`): real `tungstenite` client
   against the real handler over a real socket — auth, initialize, tools/list,
   getWorkspaceFolders, and a deferred openDiff answered by a second thread.
4. **Frontend vitest:** pure helpers — selection routing (file path → project sessions),
   diff queue reducer, context-push debounce shape.
5. **Manual verification in the dev app** (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`):
   claude session shows the IDE connected indicator; `/ide` lists Conduit; a manual-mode
   edit opens the overlay; Keep writes through claude; Reject shows "User rejected".

## Out of scope

- External-terminal discovery guarantees (structural, above).
- `executeCode`, Jupyter kernels.
- JetBrains-style file watching, `selection_changed` from the terminal panes (only the
  Monaco editor pane produces selections).
- agy / Command Code / other agents — the protocol is Claude's.
