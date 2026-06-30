# OpenCode Integration (Tier 2 — Status Parity) — Design

- **Date:** 2026-06-30
- **Status:** Approved
- **Scope:** Add OpenCode as a fourth selectable agent inside Conduit, with live per-tool
  status parity to Codex/Gemini. **MCP for OpenCode is explicitly deferred** to a Tier 3
  fast-follow.
- **Predecessor:** [Multi-Agent CLI Support — UX Design](./2026-06-29-multi-agent-cli-support-ux-design.md).
  OpenCode was in the v1 roster there but deferred in implementation; the `ProviderAdapter`
  seam, picker, onboarding, settings, and hook→status pipeline already exist and ship Claude +
  Codex + Gemini.

---

## 1. Why OpenCode is different (verified empirically)

The predecessor spec (§1, §5) assumed "all four agents ship Claude-shaped hooks." A spike against
the installed `opencode` **1.17.11** disproved that and established the real shape:

- **No shell-hook config.** Claude/Codex/Gemini each take a *config file listing shell commands*
  (`HooksProfile` → `curl` POSTs to Conduit's listener). OpenCode's extensibility is a **JS plugin**.
  A plugin dropped at `.opencode/plugin/*.js` **auto-loads with no `opencode.json` entry** (confirmed:
  the spike's probe fired with an `opencode.json` containing only `$schema`).
- **Plugin event surface (observed live):** the plugin context exposes `client`, `directory`, `$`,
  `serverUrl`; it can read `process.env`. The hooks/events that fire on a real run:

  | OpenCode source | Payload (observed) | → Conduit verb |
  | --- | --- | --- |
  | `chat.message` hook | `{sessionID, agent, model, messageID}` | `prompt` |
  | `tool.execute.before` hook | input `{tool, sessionID, callID}` + `{args}` | `pretool` |
  | `tool.execute.after` hook | input `{tool, sessionID, callID, args}` | `tooluse` |
  | bus event `session.created` | `{sessionID, info}` | `sessionstart` |
  | bus event `session.idle` | `{sessionID}` | `stop` |

  No native compact/todos/notification/sessionend events were observed → those verbs simply don't
  fire for OpenCode (best-effort, exactly as the predecessor spec §5 permits).
- **Tool names are OpenCode's own lowercase vocabulary** (`bash`, `read`, `edit`, `write`, `grep`,
  `glob`, `list`, `webfetch`, `task`, …) — distinct from Claude's PascalCase, so `toolActivity`
  needs an OpenCode branch.
- **MCP diverges too (out of scope here):** `opencode mcp add` exposes only `--url/--env/--header`
  (**no `--command` for local stdio**), and there is **no `opencode mcp remove`**. Reliable
  add/remove therefore requires atomic, comment-preserving edits to `opencode.json` (which is
  `.jsonc`). That is the Tier 3 fast-follow, not this pass.

## 2. Locked decision

**Tier 2 — status parity, MCP deferred.** OpenCode becomes a first-class *runnable* agent
(tile, glyph, onboarding, picker, fresh spawn) **and** its status pill lights up per-tool like
Codex/Gemini, via a Conduit-installed OpenCode plugin. OpenCode is **omitted from the MCP matrix**
in this tier.

## 3. Architecture

OpenCode sits on the existing `ProviderAdapter` seam (`src-tauri/src/agent.rs`) exactly like
Codex/Gemini, with **one additive capability**: a *plugin profile* parallel to the existing
`HooksProfile`. No code path used by Claude/Codex/Gemini changes — the new method defaults to
`None`, so all existing adapters and tests are untouched.

```
spawn (lib.rs pty_spawn)
  └─ adapter = adapter_for(session.agent)
       ├─ if Some(hooks)  = adapter.hooks_profile()  → install_profile(...)   // Claude/Codex/Gemini
       └─ if Some(plugin) = adapter.plugin_profile() → install_plugin(...)    // OpenCode (NEW)
```

### 3.1 The plugin (the only novel mechanism)

- **Install:** at spawn, `install_plugin()` writes a small JS file to
  **`<workdir>/.opencode/plugin/conduit-status.js`** (project-relative, mirroring Claude's
  `.claude/settings.local.json`). Idempotent: the file is Conduit-owned and simply overwritten.
  No `opencode.json` editing (auto-load confirmed).
- **Runtime:** the plugin reads `CONDUIT_HOOK_PORT` / `CONDUIT_SESSION_ID` from `process.env`
  (pty.rs already injects both on every spawned agent process), with the listener's bound port
  baked into the generated JS as a fallback — matching how the curl `command()` builds
  `${CONDUIT_HOOK_PORT:-<port>}`.
- **Emit:** `fetch`-POSTs to `http://127.0.0.1:<port>/hook?session=<sid>&event=<verb>` with a
  JSON body of `{ tool_name, tool_input }` for tool events — **byte-identical to the shape the
  existing curl hooks send**, so `hooks.rs` and `App.tsx` need no change to the dispatch itself.
- **Mapping:** `chat.message → prompt`, `tool.execute.before → pretool`,
  `tool.execute.after → tooluse`, bus `session.created → sessionstart`, bus `session.idle → stop`.
  Tool body is `{ tool_name: input.tool, tool_input: <args> }` where `<args>` is read defensively
  as `output?.args ?? input?.args` — the spike showed `before` carries `args` in its **second
  (output)** param while `after` carries `args` in its **input**. Errors are swallowed
  (`try/catch`, `fetch(...).catch(() => {})`) so the plugin can never disrupt the agent.

### 3.2 Adapter & spawn

- `AgentId::OpenCode` added to the enum (serializes as `"opencode"`; `#[serde(default)]` keeps
  Claude as the back-compat default for older `state.json`).
- `OpenCodeAdapter`: `binary() = "opencode"`, `build_invocation() = "opencode || opencode"`
  (fresh launch, like Codex/Gemini — `-s/--session` resumes an *existing* id but OpenCode generates
  ids, so no caller-pinned resume), `supports_worktree() = false`, `env_overrides() = []`,
  `hooks_profile() = None`, **`plugin_profile() = Some(...)`**, `mcp_add_command/mcp_remove_command`
  left as the trait default `None` (Tier 3).
- Registered in `adapter_for()`, `all_adapters()` (display order: after Gemini), and `label_for()`
  (`"OpenCode"`).
- New in `hooks.rs`: `pub struct PluginProfile { config_rel_path: &'static str }`,
  `pub fn install_plugin(dir, port, profile)`, and the JS template (rendered with the fallback
  port). The trait gains `fn plugin_profile(&self) -> Option<PluginProfile> { None }`.
- `lib.rs` `pty_spawn`: after the existing `hooks_profile()` install, add the symmetric
  `plugin_profile()` install. Worktree gating is unchanged (OpenCode is non-worktree).

### 3.3 Frontend

- `src/agents.ts`: `AgentId` gains `"opencode"`; `AGENTS` gains an OpenCode entry (label, glyph
  monogram + tint following the existing visual system); a new **`supportsMcp: boolean`** capability
  on the agent metadata (true for Claude/Codex/Gemini, false for OpenCode).
- `src/App.tsx`: `toolActivity` gains an `agent === "opencode"` branch:
  `bash → "Running a command"`, `edit/write/patch → "Editing {file}"` (file from
  `toolInput.filePath ?? toolInput.path`), `read → "Reading files"`, `grep/glob/list →
  "Searching the code"`, `webfetch → "Browsing the web"`, `todowrite/todoread → undefined`,
  `task → "Running a subagent"`, default → raw tool name. `agentOf()` already resolves the new id.
- **Picker & onboarding auto-include OpenCode** via `detect_agents()` / `all_adapters()` — no
  per-surface code.
- **MCP matrix** (`src/components/McpMatrix.tsx`): omit columns for agents where
  `supportsMcp === false`, with a one-line footnote ("OpenCode MCP support is coming soon"). This is
  a clean omission, not a disabled-but-present column (which the matrix reserves for *not-ready*
  agents).

## 4. States, edge cases & invariants

- **Keep-alive PTY invariant (load-bearing):** unchanged — OpenCode is selected at spawn only; the
  sidebar glyph is render-only; nothing remounts `TerminalView`/`xterm`.
- **Plugin write failure:** `install_plugin` failing (e.g. unwritable dir) must not block the spawn —
  the session still launches; status degrades to coarse PTY-derived idle/running (same graceful
  degradation as an agent with no hooks).
- **Ambient widgets:** OpenCode is non-Claude, so the Claude service-status/usage widgets stay hidden
  for its sessions (existing gating already keys on agent).
- **Back-compat:** existing persisted sessions (no `agent` field, or `"claude"`) are unaffected;
  the new enum variant only appears on newly created OpenCode sessions.
- **TUI vs headless:** the spike exercised headless `opencode run`; the plugin hook/event surface is
  served by the same backend in TUI mode, so the same verbs fire when Conduit spawns the TUI. This is
  the one thing to confirm with an in-app smoke test (§6).

## 5. Out of scope (Tier 3 / future)

- **OpenCode in the MCP matrix** — atomic, comment-preserving `opencode.json` add/remove/edit
  (no usable `mcp add --command`, no `mcp remove`), preserving user-authored entries.
- Compact/notification/todos status verbs for OpenCode (no native events).
- Worktree isolation and caller-pinned resume for OpenCode.
- Session auto-naming for OpenCode — its `chat.message` payload carries no prompt text,
  so OpenCode sessions keep their default `Session N` name.

## 6. Testing

- **Rust unit tests** (`agent.rs`, `hooks.rs`): `OpenCodeAdapter` metadata (`id`, `binary`,
  `build_invocation == "opencode || opencode"`, `!supports_worktree`, `hooks_profile().is_none()`,
  `plugin_profile().is_some()`); `adapter_for(OpenCode)`/`all_adapters` include it; `install_plugin`
  writes `.opencode/plugin/conduit-status.js`, the JS contains the routing
  (`CONDUIT_SESSION_ID`, `event=`, the fallback port), and re-install is idempotent.
- **Frontend:** `pnpm exec tsc --noEmit` (no test runner).
- **Live smoke (required, per CLAUDE.md "never claim a UI change works from a typecheck alone"):**
  run the dev build isolated (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`), create an OpenCode session,
  confirm: the tile/glyph render; the session spawns; the status pill shows per-tool activity during
  a tool call and settles to "done" on idle.

## 7. Files touched

| File | Change |
| --- | --- |
| `src-tauri/src/agent.rs` | `AgentId::OpenCode`, `OpenCodeAdapter`, `plugin_profile()` trait method, registrations, tests |
| `src-tauri/src/hooks.rs` | `PluginProfile`, `install_plugin()`, JS template, tests |
| `src-tauri/src/lib.rs` | install `plugin_profile()` at spawn (symmetric with `hooks_profile()`) |
| `src/agents.ts` | `"opencode"` id, `AGENTS` entry, `supportsMcp` capability |
| `src/App.tsx` | `toolActivity` OpenCode branch |
| `src/components/McpMatrix.tsx` | omit non-`supportsMcp` columns + footnote |
| `src/theme.css` | OpenCode glyph tint (if a new token is needed) |
