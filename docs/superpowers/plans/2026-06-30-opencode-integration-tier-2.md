# OpenCode Integration (Tier 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode as a fourth selectable agent in Conduit with live per-tool status parity to Codex/Gemini, via a Conduit-installed OpenCode JS plugin. MCP for OpenCode is deferred.

**Architecture:** OpenCode sits on the existing `ProviderAdapter` seam like Codex/Gemini, plus one additive capability — a *plugin profile* (parallel to `HooksProfile`) because OpenCode has no shell-hook config. At spawn, Conduit writes `.opencode/plugin/conduit-status.js` (auto-loaded by OpenCode); the plugin POSTs lifecycle verbs to Conduit's existing HTTP listener in the same shape the curl hooks use, so the listener and the frontend dispatch are unchanged.

**Tech Stack:** Rust (Tauri backend, `#[cfg(test)]` unit tests), React 19 + TypeScript (no test runner — `tsc --noEmit` + manual smoke), Zustand store.

**Spec:** [docs/superpowers/specs/2026-06-30-opencode-integration-tier-2-design.md](../specs/2026-06-30-opencode-integration-tier-2-design.md)

**Conventions (from CLAUDE.md):**
- Run Rust tests with `cargo test --manifest-path src-tauri/Cargo.toml`.
- **Format ONLY the files you touch** (`rustfmt src-tauri/src/<file>.rs …`) — `main` is not whole-crate rustfmt-clean, so `cargo fmt` churns unrelated files. Never run whole-crate `cargo fmt`.
- Frontend: `pnpm exec tsc --noEmit`. A typecheck is not proof a UI works — the final task includes a launch smoke.
- All commits are on branch `feat/opencode-integration` (already created). End every commit message with the `Co-Authored-By: Claude …` trailer.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src-tauri/src/hooks.rs` | HTTP listener + status-integration installers | **Add** `PluginProfile`, `opencode_plugin_js()`, `install_plugin()` + tests |
| `src-tauri/src/agent.rs` | Provider adapters + detection | **Add** `plugin_profile()` trait method, `AgentId::OpenCode`, `OpenCodeAdapter`, registrations + tests |
| `src-tauri/src/lib.rs` | Tauri commands incl. `pty_spawn` | **Modify** spawn to install the plugin profile |
| `src/agents.ts` | Agent metadata (frontend) | **Modify** `AgentId` union, `AgentMeta` (`supportsMcp`), `AGENTS` |
| `src/App.tsx` | Hook→status dispatch + `toolActivity` | **Modify** add OpenCode tool-label branch |
| `src/components/McpMatrix.tsx` | MCP enable matrix | **Modify** omit non-`supportsMcp` columns + footnote |

No `theme.css` change: `AgentGlyph` reads the tint inline from `AGENTS` metadata.

---

## Task 1: OpenCode status plugin installer (`hooks.rs`)

**Files:**
- Modify: `src-tauri/src/hooks.rs` (add struct + two fns near the existing `HooksProfile`/`install_profile`; tests in the existing `#[cfg(test)] mod tests`)

> **Note:** between this task and Task 3, `install_plugin` / `opencode_plugin_js` / `PluginProfile` are used only by tests, so a transient `dead_code` warning may appear. That is expected — they're wired into production in Task 3. **Do NOT add `#[allow(dead_code)]`**; it would be wrong by Task 3.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of the `mod tests` block in `src-tauri/src/hooks.rs` (before the closing `}`):

```rust
    #[test]
    fn install_plugin_writes_conduit_status_js_with_routing() {
        let dir = fresh_test_dir("ocplugin");
        let profile = PluginProfile {
            config_rel_path: ".opencode/plugin/conduit-status.js",
        };
        install_plugin(dir.to_str().unwrap(), 8431, &profile);

        let p = dir.join(".opencode/plugin/conduit-status.js");
        let js = fs::read_to_string(&p).expect("plugin js should be written");
        assert!(js.contains("CONDUIT_SESSION_ID"), "session routing missing: {js}");
        assert!(js.contains("/hook?session="), "hook url missing: {js}");
        assert!(js.contains("&event="), "event tag missing: {js}");
        assert!(js.contains("8431"), "fallback port missing: {js}");
        assert!(js.contains("session.idle"), "stop mapping missing: {js}");
        assert!(js.contains("tool.execute.before"), "pretool mapping missing: {js}");
        assert!(js.contains("chat.message"), "prompt mapping missing: {js}");
    }

    #[test]
    fn install_plugin_is_idempotent_overwrite() {
        let dir = fresh_test_dir("ocplugin_idem");
        let profile = PluginProfile {
            config_rel_path: ".opencode/plugin/conduit-status.js",
        };
        install_plugin(dir.to_str().unwrap(), 8423, &profile);
        install_plugin(dir.to_str().unwrap(), 8423, &profile);

        let p = dir.join(".opencode/plugin/conduit-status.js");
        let js = fs::read_to_string(&p).unwrap();
        assert_eq!(
            js.matches("export const ConduitStatus").count(),
            1,
            "re-install must overwrite, not duplicate the plugin body"
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml install_plugin`
Expected: FAIL — compile error `cannot find type PluginProfile` / `cannot find function install_plugin`.

- [ ] **Step 3: Implement `PluginProfile`, `opencode_plugin_js`, `install_plugin`**

In `src-tauri/src/hooks.rs`, immediately AFTER the `HooksProfile` struct definition (after its closing `}` around the `structured_todos` field), add:

```rust
/// What a plugin-based agent (OpenCode) installs for status: a single JS file written
/// relative to the working dir. Parallel to `HooksProfile`, which is for shell-hook agents.
pub struct PluginProfile {
    pub config_rel_path: &'static str,
}

/// The OpenCode status-bridge plugin source, with `port` baked in as the env fallback.
/// OpenCode auto-loads any `.opencode/plugin/*.js`; this one translates OpenCode's plugin
/// hooks + bus events into Conduit's normalized verbs and POSTs them to the listener in the
/// same `{ tool_name, tool_input }` shape the curl hooks use. URL is built by concatenation
/// (no JS template literals) so it embeds cleanly in a Rust raw string.
pub(crate) fn opencode_plugin_js(port: u16) -> String {
    const TEMPLATE: &str = r#"// Conduit status bridge — auto-generated; do not edit.
const PORT = process.env.CONDUIT_HOOK_PORT || "__PORT__";
const SID = process.env.CONDUIT_SESSION_ID || "unknown";
const post = (event, body) => {
  try {
    fetch("http://127.0.0.1:" + PORT + "/hook?session=" + SID + "&event=" + event, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).catch(() => {});
  } catch (e) {}
};
export const ConduitStatus = async () => ({
  event: async ({ event }) => {
    if (event && event.type === "session.created") post("sessionstart", {});
    else if (event && event.type === "session.idle") post("stop", {});
  },
  "chat.message": async () => { post("prompt", {}); },
  "tool.execute.before": async (input, output) => {
    post("pretool", {
      tool_name: input && input.tool,
      tool_input: (output && output.args) || (input && input.args),
    });
  },
  "tool.execute.after": async (input) => {
    post("tooluse", { tool_name: input && input.tool, tool_input: input && input.args });
  },
});
"#;
    TEMPLATE.replace("__PORT__", &port.to_string())
}

/// Write the OpenCode status plugin into <dir>/<config_rel_path>. Conduit-owned file:
/// re-install simply overwrites (idempotent). Creates parent dirs as needed.
pub fn install_plugin(dir: &str, port: u16, profile: &PluginProfile) {
    let path = Path::new(dir).join(profile.config_rel_path);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, opencode_plugin_js(port));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml install_plugin`
Expected: PASS — `install_plugin_writes_conduit_status_js_with_routing` and `install_plugin_is_idempotent_overwrite` both green.

- [ ] **Step 5: Format the touched file and commit**

```bash
rustfmt src-tauri/src/hooks.rs
git add src-tauri/src/hooks.rs
git commit -m "$(printf 'feat(opencode): add status-plugin installer (PluginProfile + install_plugin)\n\nWrites .opencode/plugin/conduit-status.js with the hook port baked in.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 2: `OpenCodeAdapter` + `plugin_profile()` trait method (`agent.rs`)

**Files:**
- Modify: `src-tauri/src/agent.rs` (trait method, enum variant, adapter, three registrations; tests in the existing `#[cfg(test)] mod tests`)

> **Note:** adding the `OpenCode` enum variant makes the `match` in `adapter_for()` and `label_for()` non-exhaustive — a hard compile error until both arms are added (all in this task). That's the compiler keeping you honest.

- [ ] **Step 1: Write the failing test**

Add to the bottom of the `mod tests` block in `src-tauri/src/agent.rs` (before the closing `}`):

```rust
    #[test]
    fn opencode_metadata_and_plugin_profile() {
        assert_eq!(OpenCodeAdapter.id(), AgentId::OpenCode);
        assert_eq!(OpenCodeAdapter.binary(), "opencode");
        assert!(!OpenCodeAdapter.supports_worktree());
        assert_eq!(
            OpenCodeAdapter.build_invocation("sid", None, ""),
            "opencode || opencode"
        );
        assert!(
            OpenCodeAdapter.hooks_profile().is_none(),
            "opencode uses a plugin, not a hooks profile"
        );
        let pp = OpenCodeAdapter
            .plugin_profile()
            .expect("opencode must supply a plugin profile");
        assert_eq!(pp.config_rel_path, ".opencode/plugin/conduit-status.js");
        assert_eq!(adapter_for(AgentId::OpenCode).id(), AgentId::OpenCode);
        assert!(all_adapters().iter().any(|a| a.id() == AgentId::OpenCode));
    }

    #[test]
    fn hook_agents_have_no_plugin_profile() {
        assert!(ClaudeAdapter.plugin_profile().is_none());
        assert!(CodexAdapter.plugin_profile().is_none());
        assert!(GeminiAdapter.plugin_profile().is_none());
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml opencode_metadata`
Expected: FAIL — compile error `no variant named OpenCode` / `cannot find OpenCodeAdapter` / `no method plugin_profile`.

- [ ] **Step 3a: Add the `plugin_profile()` trait method**

In `src-tauri/src/agent.rs`, inside `trait ProviderAdapter`, AFTER the `hooks_profile()` method and BEFORE `build_invocation`, add:

```rust
    /// The status plugin this adapter installs at spawn. OpenCode has no shell-hook
    /// config, so it ships a JS plugin instead of a `hooks_profile()`. None for
    /// hook-based agents (Claude/Codex/Gemini).
    fn plugin_profile(&self) -> Option<crate::hooks::PluginProfile> {
        None
    }
```

- [ ] **Step 3b: Add the `OpenCode` enum variant**

In the `AgentId` enum, add `OpenCode` after `Gemini`:

```rust
pub enum AgentId {
    #[default]
    Claude,
    Codex,
    Gemini,
    OpenCode,
}
```

- [ ] **Step 3c: Add the `OpenCodeAdapter`**

In `src-tauri/src/agent.rs`, AFTER the `CodexAdapter` impl block (after its closing `}`, before `pub fn adapter_for`), add:

```rust
pub struct OpenCodeAdapter;

impl ProviderAdapter for OpenCodeAdapter {
    fn id(&self) -> AgentId {
        AgentId::OpenCode
    }
    fn binary(&self) -> &'static str {
        "opencode"
    }
    // Fresh launch like Codex/Gemini: opencode generates its own session ids, so there is
    // no caller-pinned resume; worktree isolation is out of scope for this tier.
    fn build_invocation(
        &self,
        _session_id: &str,
        _projects_dir: Option<&Path>,
        _flags: &str,
    ) -> String {
        "opencode || opencode".to_string()
    }
    fn plugin_profile(&self) -> Option<crate::hooks::PluginProfile> {
        Some(crate::hooks::PluginProfile {
            config_rel_path: ".opencode/plugin/conduit-status.js",
        })
    }
}
```

- [ ] **Step 3d: Register in `adapter_for`, `all_adapters`, `label_for`**

In `adapter_for`, add the arm:

```rust
        AgentId::Gemini => Box::new(GeminiAdapter),
        AgentId::OpenCode => Box::new(OpenCodeAdapter),
```

In `all_adapters`, append to the `vec![...]`:

```rust
        Box::new(GeminiAdapter),
        Box::new(OpenCodeAdapter),
```

In `label_for`, add the arm:

```rust
        AgentId::Gemini => "Gemini CLI",
        AgentId::OpenCode => "OpenCode",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — the two new tests are green AND all pre-existing `agent`/`hooks` tests still pass (no regressions).

- [ ] **Step 5: Format the touched file and commit**

```bash
rustfmt src-tauri/src/agent.rs
git add src-tauri/src/agent.rs
git commit -m "$(printf 'feat(opencode): add OpenCodeAdapter + plugin_profile() trait method\n\nFresh spawn (opencode || opencode), no worktree, installs the status plugin.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 3: Wire the plugin install into `pty_spawn` (`lib.rs`)

**Files:**
- Modify: `src-tauri/src/lib.rs:65-71` (the normal-session `else` branch of `pty_spawn`)

> No unit test (this is Tauri-wired command glue). Verification is the full Rust suite + clippy staying clean; behavior is confirmed in the Task 7 launch smoke.

- [ ] **Step 1: Edit the normal-session branch**

In `src-tauri/src/lib.rs`, replace this block:

```rust
    } else {
        // Normal session: install this agent's hook profile (if it has one).
        if let Some(profile) = adapter.hooks_profile() {
            hooks::install_profile(&working_directory, port, &profile);
        }
        (working_directory.clone(), None, None)
    };
```

with:

```rust
    } else {
        // Normal session: install this agent's status integration. Hook-based agents
        // (Claude/Codex/Gemini) write a settings/hooks file; OpenCode installs a JS
        // status plugin instead. An agent has one or the other, never both.
        if let Some(profile) = adapter.hooks_profile() {
            hooks::install_profile(&working_directory, port, &profile);
        }
        if let Some(plugin) = adapter.plugin_profile() {
            hooks::install_plugin(&working_directory, port, &plugin);
        }
        (working_directory.clone(), None, None)
    };
```

- [ ] **Step 2: Build, test, and lint**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — entire suite green, and NO `dead_code` warning for `install_plugin`/`PluginProfile`/`opencode_plugin_js` (now reachable from production).

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: no new warnings attributable to `agent.rs` / `hooks.rs` / `lib.rs`.

- [ ] **Step 3: Format the touched file and commit**

```bash
rustfmt src-tauri/src/lib.rs
git add src-tauri/src/lib.rs
git commit -m "$(printf 'feat(opencode): install the status plugin at session spawn\n\nSymmetric with the existing hooks_profile install in pty_spawn.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 4: Frontend agent metadata (`agents.ts`)

**Files:**
- Modify: `src/agents.ts:1-18` (the `AgentId` union, `AgentMeta` interface, `AGENTS` array)

- [ ] **Step 1: Widen the union and add the `supportsMcp` capability**

Replace `src/agents.ts:1` :

```ts
export type AgentId = "claude" | "codex" | "gemini";
```

with:

```ts
export type AgentId = "claude" | "codex" | "gemini" | "opencode";
```

Replace the `AgentMeta` interface (`src/agents.ts:3-12`) — add the `supportsMcp` field:

```ts
export interface AgentMeta {
  id: AgentId;
  label: string;
  /** Monogram letter shown in the glyph. */
  letter: string;
  /** CSS color token for the glyph tint. */
  tint: string;
  /** Whether Conduit's worktree isolation is offered for this agent (Phase 1: Claude only). */
  supportsWorktree: boolean;
  /** Whether the MCP matrix can manage servers for this agent (OpenCode: not yet — Tier 3). */
  supportsMcp: boolean;
}
```

Replace the `AGENTS` array (`src/agents.ts:14-18`):

```ts
export const AGENTS: AgentMeta[] = [
  { id: "claude",   label: "Claude Code", letter: "C", tint: "#ce8a6e", supportsWorktree: true,  supportsMcp: true  },
  { id: "codex",    label: "Codex CLI",   letter: "x", tint: "#9aa6b2", supportsWorktree: false, supportsMcp: true  },
  { id: "gemini",   label: "Gemini CLI",  letter: "G", tint: "#7e9cff", supportsWorktree: false, supportsMcp: true  },
  { id: "opencode", label: "OpenCode",    letter: "o", tint: "#6cc29a", supportsWorktree: false, supportsMcp: false },
];
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (0 errors). Adding the field forces all 4 `AGENTS` entries to set `supportsMcp` (they do); the union widening is consumed only by metadata lookups and `toolActivity`'s `default`.

- [ ] **Step 3: Commit**

```bash
git add src/agents.ts
git commit -m "$(printf 'feat(opencode): add OpenCode agent metadata + supportsMcp capability\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 5: OpenCode tool-label branch in `toolActivity` (`App.tsx`)

**Files:**
- Modify: `src/App.tsx:290` (insert a new branch immediately before the `// claude (and any unknown agent)` comment)

- [ ] **Step 1: Add the OpenCode branch**

In `src/App.tsx`, immediately BEFORE this existing line:

```ts
  // claude (and any unknown agent): keep the existing PascalCase switch body unchanged.
```

insert:

```ts
  if (agent === "opencode") {
    switch (toolName) {
      case "bash":
        return "Running a command";
      case "edit":
      case "write":
      case "patch": {
        const p = toolInput?.filePath ?? toolInput?.path ?? toolInput?.file_path;
        const f = typeof p === "string" && p ? baseName(p) : undefined;
        return f ? `Editing ${f}` : "Editing files";
      }
      case "read":
        return "Reading files";
      case "grep":
      case "glob":
      case "list":
        return "Searching the code";
      case "webfetch":
        return "Browsing the web";
      case "todowrite":
      case "todoread":
        return undefined; // surfaced in the To-dos panel instead (when present)
      case "task":
        return "Running a subagent";
      default:
        return toolName;
    }
  }

```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (0 errors). `baseName` and the `toolInput`/`toolName` params are already in scope in `toolActivity`.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "$(printf 'feat(opencode): map OpenCode tool names to sidebar activity labels\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 6: Omit OpenCode from the MCP matrix (`McpMatrix.tsx`)

**Files:**
- Modify: `src/components/McpMatrix.tsx:23-24` (column derivation) and `:120-124` (add a footnote)

- [ ] **Step 1: Filter columns by `supportsMcp` and collect the unsupported labels**

In `src/components/McpMatrix.tsx`, replace these two lines (around `:23-24`):

```ts
  // Only show columns for agents that are actually installed.
  const cols: AgentId[] = (agents ?? []).filter((a) => a.found).map((a) => a.id);
```

with:

```ts
  // Only show columns for agents that are installed AND support MCP management.
  const cols: AgentId[] = (agents ?? [])
    .filter((a) => a.found && agentMeta(a.id).supportsMcp)
    .map((a) => a.id);

  // Installed agents Conduit can't manage MCP for yet (e.g. OpenCode) — surfaced as a note.
  const mcpUnsupported: string[] = (agents ?? [])
    .filter((a) => a.found && !agentMeta(a.id).supportsMcp)
    .map((a) => agentMeta(a.id).label);
```

- [ ] **Step 2: Add the footnote under the scope note**

In `src/components/McpMatrix.tsx`, immediately AFTER this existing block:

```tsx
      {/* Scope disclaimer */}
      <p className="mcp-scope-note">
        Writing user-scope MCP — the agent may still prompt to approve a server on first use.
      </p>
```

insert:

```tsx
      {mcpUnsupported.length > 0 && (
        <p className="mcp-scope-note">
          MCP management for {mcpUnsupported.join(", ")} is coming soon.
        </p>
      )}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (0 errors). `agentMeta` is already imported at the top of the file.

- [ ] **Step 4: Commit**

```bash
git add src/components/McpMatrix.tsx
git commit -m "$(printf 'feat(opencode): omit OpenCode from MCP matrix with a coming-soon note\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 7: Full verification + live smoke

**Files:** none (verification only)

- [ ] **Step 1: Full Rust suite + lint**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — all tests green.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: no new warnings from `agent.rs` / `hooks.rs` / `lib.rs`.

- [ ] **Step 2: Frontend typecheck + build**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (0 errors).

Run: `pnpm build`
Expected: builds successfully.

- [ ] **Step 3: Confirm no stray reformatting leaked in**

Run: `git status --porcelain`
Expected: clean (everything committed). If any file outside the six in the File Structure table shows as modified (e.g. from a whole-crate `cargo fmt`), `git restore` it before proceeding.

- [ ] **Step 4: Live smoke (REQUIRED — typecheck is not proof)**

Run the dev build isolated from the installed app:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

In the app, verify:
1. The New Session dialog shows an **OpenCode** tile with its green `o` glyph and a `✓ ready` pill (it's on the nvm PATH).
2. Create an OpenCode session; it spawns into the TUI (`opencode`).
3. The sidebar row shows the OpenCode glyph.
4. Send a prompt that triggers a tool (e.g. "run `echo hi`"); the status pill shows **running / a per-tool activity label**, then settles to **done** when the agent goes idle. (This confirms the plugin's `tool.execute.*` → `pretool`/`tooluse` and `session.idle` → `stop` wiring fires in TUI mode, which the headless spike couldn't prove.)
5. Open Settings → MCP servers: there is **no OpenCode column**, and the "MCP management for OpenCode is coming soon" note appears.

If status does not light up: check that `~/<project>/.opencode/plugin/conduit-status.js` was written and that `CONDUIT_HOOK_PORT`/`CONDUIT_SESSION_ID` are set in the session's env (the plugin reads them); set `CONDUIT_HOOK_LOG=1` to log inbound hook POSTs in the dev console.

- [ ] **Step 5: Final integration commit (if any verification-driven tweaks were needed)**

Only if Step 4 surfaced a fix. Otherwise this task adds no commit.

---

## Self-Review

- **Spec coverage:** §3.1 plugin → Task 1; §3.2 adapter/spawn → Tasks 2–3; §3.3 frontend metadata/toolActivity/matrix → Tasks 4–6; §6 testing → Tasks 1–2 (unit) + Task 7 (smoke). MCP (§5) explicitly deferred — `supportsMcp:false` + matrix omission (Task 6) is the only OpenCode-MCP surface in this tier. ✓
- **Type consistency:** `PluginProfile.config_rel_path` (defined Task 1) is referenced identically in Task 2 (`OpenCodeAdapter::plugin_profile`) and Task 3 (`hooks::install_plugin`). `plugin_profile()` signature matches across trait + impl + call site. `supportsMcp` added in Task 4 is consumed in Task 6. ✓
- **Placeholder scan:** every code/test step contains complete code; every run step has an exact command + expected result. ✓
