# Multi-Agent CLI Support — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a Rust `ProviderAdapter` seam so Conduit can launch agents other than Claude (Phase 0), then ship the first visible second agent — **Codex** — with a tile picker, per-session sidebar identity, and Claude-widget gating (Phase 1).

**Architecture:** A new `src-tauri/src/agent.rs` defines an `AgentId` enum + `ProviderAdapter` trait; `ClaudeAdapter` carries today's exact behavior. Each `Session` gains a persisted `agent` field; `pty_spawn` resolves the agent from the Store and selects the adapter at spawn time (never remounting the PTY). The frontend gains an `AgentId` type, an `AgentGlyph`, a tile picker in the New Session dialog driven by a `detect_agents` PATH scan, a leading-glyph SessionRow, and gating of the Claude-only ambient widgets.

**Tech Stack:** Rust (Tauri v2, `portable-pty`, `serde`, `cargo test`), React 19 + TypeScript + Zustand. **The frontend has no test runner** (per CLAUDE.md) — Rust tasks are TDD with `cargo test`; frontend tasks are verified with `pnpm exec tsc --noEmit` and by launching the app.

**Run the dev app SAFELY** (per CLAUDE.md — never clobber the installed app's state):
```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

**Phase-1 deliberate limitations (documented, not omissions):**
- Codex sessions in Phase 1 spawn **fresh** (no `--resume` pinning — Codex doesn't take a caller UUID; resume is a later phase).
- Codex sessions get **no Claude hooks** → no per-session live status yet (that's Phase 2); status stays `idle`.
- The **"Isolate in a git worktree"** toggle is **disabled for non-Claude agents** (Conduit-owned worktrees are a later phase).
- **Auto-titling** (`maybeAutoName`) is driven by the Claude `prompt` hook, so Codex sessions keep their `Session N` name until renamed.

---

## File Structure

**Created:**
- `src-tauri/src/agent.rs` — `AgentId` enum, `ProviderAdapter` trait, `ClaudeAdapter`, `CodexAdapter`, `adapter_for()`, and the `detect_agents` scan. One responsibility: "how to launch / detect each agent."
- `src/agents.ts` — frontend agent metadata (id, label, glyph letter, tint, `supportsWorktree`) + the `AgentId` type. Single source of agent UI truth.
- `src/components/AgentGlyph.tsx` — the rounded-square monogram used by the picker and SessionRow.

**Modified:**
- `src-tauri/src/pty.rs` — `spawn` takes `agent`; `claude_script`→adapter-driven `build_script`; move `claude_invocation` into `ClaudeAdapter`.
- `src-tauri/src/store.rs` — `Session` gains `agent`; `add_session` takes `agent`; add `session_agent()` lookup.
- `src-tauri/src/lib.rs` — `pty_spawn` resolves agent from Store + branches hooks/worktree on it; `add_session` command takes `agent`; register `detect_agents`.
- `src-tauri/src/lib.rs` (module decl) — add `mod agent;`.
- `src/store.ts` — `Session` gains `agent`; `addSession` accepts/threads it.
- `src/components/NewSessionDialog.tsx` — tile picker + detection + worktree-gating.
- `src/components/Terminal.tsx` — (no change needed; `pty_spawn` resolves agent server-side).
- `src/components/Sidebar.tsx` — SessionRow leading glyph; gate `ClaudeStatusWarning`/`ClaudeUsagePanel`/`ClaudeStatusPill`.

---

# PHASE 0 — Adapter seam (Rust, Claude-only, no behavior change)

## Task 1: `agent.rs` — AgentId + ProviderAdapter + ClaudeAdapter

**Files:**
- Create: `src-tauri/src/agent.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod agent;` near the other `mod` lines, ~line 8)

- [ ] **Step 1: Write the failing test** — create `src-tauri/src/agent.rs` with only the test module + a stub, so the test compiles against the intended API:

```rust
//! Agent provider adapters: how to launch and detect each terminal coding agent.

use std::path::Path;

/// Which coding-agent CLI a session runs. Persisted on each Session; serializes
/// as a lowercase string ("claude"/"codex"). Unknown/absent → Claude (back-compat).
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    #[default]
    Claude,
    Codex,
}

/// Knows how to launch one agent CLI inside Conduit's `sh -c` cold-spawn script.
pub trait ProviderAdapter {
    fn id(&self) -> AgentId;
    /// The binary name to look for on PATH (also used by `detect_agents`).
    fn binary(&self) -> &'static str;
    /// Whether this adapter supports Conduit's `--worktree` isolation (Phase 1: Claude only).
    fn supports_worktree(&self) -> bool {
        false
    }
    /// Extra env vars to set on the child process for this agent.
    fn env_overrides(&self) -> Vec<(&'static str, &'static str)> {
        Vec::new()
    }
    /// The agent command that runs after `cd <dir> &&`, including the `|| <bare>`
    /// fallback. `flags` carries already-quoted extra args (e.g. ` --worktree 'x'`).
    /// `projects_dir` is Claude's transcript store (used only by adapters that resume).
    fn build_invocation(&self, session_id: &str, projects_dir: Option<&Path>, flags: &str)
        -> String;
}

pub struct ClaudeAdapter;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_pins_a_new_session_when_no_transcript() {
        // projects_dir = None → no transcript → pin a new session id.
        let cmd = ClaudeAdapter.build_invocation("abc-123", None, "");
        assert_eq!(cmd, "claude --session-id 'abc-123' || claude");
    }

    #[test]
    fn claude_applies_flags_to_both_primary_and_fallback() {
        let cmd = ClaudeAdapter.build_invocation("id", None, " --worktree 'wt'");
        assert_eq!(
            cmd,
            "claude --worktree 'wt' --session-id 'id' || claude --worktree 'wt'"
        );
    }

    #[test]
    fn claude_metadata() {
        assert_eq!(ClaudeAdapter.id(), AgentId::Claude);
        assert_eq!(ClaudeAdapter.binary(), "claude");
        assert!(ClaudeAdapter.supports_worktree());
        assert_eq!(
            ClaudeAdapter.env_overrides(),
            vec![("CLAUDE_CODE_ENABLE_TASKS", "0")]
        );
    }
}
```

Add `mod agent;` to `src-tauri/src/lib.rs` (next to `mod claude_status;` / `mod claude_usage;`, ~line 8).

- [ ] **Step 2: Run the test to verify it fails (won't compile)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent::`
Expected: FAIL — `ClaudeAdapter` doesn't implement `ProviderAdapter` / missing methods.

- [ ] **Step 3: Implement `ClaudeAdapter`** — add below the `pub struct ClaudeAdapter;` line. This moves the exact logic from `pty.rs::claude_invocation` (including `shell_quote` and `transcript_exists`, which we reuse from `pty.rs`):

```rust
impl ProviderAdapter for ClaudeAdapter {
    fn id(&self) -> AgentId {
        AgentId::Claude
    }
    fn binary(&self) -> &'static str {
        "claude"
    }
    fn supports_worktree(&self) -> bool {
        true
    }
    fn env_overrides(&self) -> Vec<(&'static str, &'static str)> {
        // Disables the Task-tool migration that breaks the TodoWrite hook (see CLAUDE.md).
        vec![("CLAUDE_CODE_ENABLE_TASKS", "0")]
    }
    fn build_invocation(&self, session_id: &str, projects_dir: Option<&Path>, flags: &str) -> String {
        let id = crate::pty::shell_quote(session_id);
        if projects_dir.is_some_and(|d| crate::pty::transcript_exists(session_id, d)) {
            format!("claude{flags} --resume {id} || claude{flags}")
        } else {
            format!("claude{flags} --session-id {id} || claude{flags}")
        }
    }
}
```

> Note: `shell_quote` and `transcript_exists` are currently private to `pty.rs`. In Task 2 we change their visibility to `pub(crate)`. To compile Task 1 standalone, temporarily `pub(crate)` them now (Step 3a below) — Task 2 keeps them that way.

- [ ] **Step 3a: Make the two pty.rs helpers crate-visible** — in `src-tauri/src/pty.rs` change `fn shell_quote` → `pub(crate) fn shell_quote` (line ~348) and `fn transcript_exists` → `pub(crate) fn transcript_exists` (line ~315).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent::`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agent.rs src-tauri/src/lib.rs src-tauri/src/pty.rs
git commit -m "feat(agent): add ProviderAdapter trait + ClaudeAdapter (no behavior change)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Route `pty.rs` spawn through the adapter

**Files:**
- Modify: `src-tauri/src/pty.rs` (`spawn` ~64-145, `claude_script` ~369-394, delete `claude_invocation` ~338-345, tests ~396+)

- [ ] **Step 1: Update the pty.rs tests to the new API** — find the test(s) that call `claude_invocation` / `claude_script` (in the `#[cfg(test)] mod tests` at the bottom of `pty.rs`). Replace any `claude_invocation(...)` assertions with the `ClaudeAdapter.build_invocation(...)` equivalents (already covered in Task 1, so delete now-duplicated `claude_invocation` tests). Keep/adjust the `claude_script`/`build_script` test to assert the full `sh -c` body still contains `export CONDUIT_SESSION_ID=...` and the adapter invocation. Example replacement test:

```rust
#[test]
fn build_script_wraps_adapter_invocation_with_conduit_env() {
    let script = build_script(
        &crate::agent::ClaudeAdapter,
        "sid-1",
        7777,
        "/repo",
        "/bin/zsh",
        None,
        None,
        None,
    );
    assert!(script.contains("export CONDUIT_SESSION_ID='sid-1' CONDUIT_HOOK_PORT=7777"));
    assert!(script.contains("claude --session-id 'sid-1' || claude"));
    assert!(script.contains("cd '/repo' &&"));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::`
Expected: FAIL — `build_script` doesn't take an adapter yet / `claude_invocation` removed.

- [ ] **Step 3: Refactor `claude_script` → `build_script` and delete `claude_invocation`** — replace `pty.rs::claude_script` (lines ~369-394) with:

```rust
/// Build the `sh -c` script that launches one agent session. The agent invocation
/// (and its `|| <bare>` fallback) is delegated to the adapter; Conduit's own env
/// (CONDUIT_SESSION_ID/HOOK_PORT) and the worktree/settings flags are applied here.
/// `worktree`/`settings` are only set by callers when the adapter supports worktrees.
fn build_script(
    adapter: &dyn crate::agent::ProviderAdapter,
    session_id: &str,
    port: u16,
    working_directory: &str,
    shell: &str,
    worktree: Option<&str>,
    settings: Option<&str>,
    projects_dir: Option<&Path>,
) -> String {
    let mut flags = String::new();
    if let Some(name) = worktree {
        flags.push_str(&format!(" --worktree {}", shell_quote(name)));
    }
    if let Some(path) = settings {
        flags.push_str(&format!(" --settings {}", shell_quote(path)));
    }
    let invocation = adapter.build_invocation(session_id, projects_dir, &flags);
    format!(
        "export CONDUIT_SESSION_ID={sid} CONDUIT_HOOK_PORT={port}; cd {dir} && {invocation}; exec {shell} -i -l",
        sid = shell_quote(session_id),
        port = port,
        dir = shell_quote(working_directory),
        invocation = invocation,
        shell = shell,
    )
}
```

Delete the now-unused `claude_invocation` function (lines ~334-345). Note `CLAUDE_CODE_ENABLE_TASKS=0` is **removed from the script string** — it moves to the per-child env via `env_overrides()` in Step 4.

- [ ] **Step 4: Thread `agent` + adapter env into `spawn`** — change the `spawn` signature (line ~64) to add `agent: crate::agent::AgentId,` **right before `on_event: Channel<String>,`** (so it matches the `pty.spawn(...)` call order in Task 4: `…, settings_path, agent, on_event`). In the `inner` cold-spawn branch (lines ~110-123) build the adapter and call `build_script`:

```rust
        let adapter = crate::agent::adapter_for(agent);
        let inner = if shell_only {
            format!(
                "cd {dir} 2>/dev/null; exec {shell} -i -l",
                dir = shell_quote(&working_directory),
                shell = shell,
            )
        } else {
            build_script(
                adapter.as_ref(),
                &session_id,
                hook_port,
                &working_directory,
                &shell,
                worktree_name.as_deref(),
                settings_path.as_deref(),
                claude_projects_dir().as_deref(),
            )
        };
```

Then replace the hardcoded `CLAUDE_CODE_ENABLE_TASKS` env block (lines ~136-140) with adapter-driven env:

```rust
        if !shell_only {
            cmd.env("CONDUIT_SESSION_ID", &session_id);
            cmd.env("CONDUIT_HOOK_PORT", hook_port.to_string());
            for (k, v) in adapter.env_overrides() {
                cmd.env(k, v);
            }
        }
```

(`adapter_for` is added in Task 6; for Phase 0 add a minimal version now — see Step 4a.)

- [ ] **Step 4a: Add a minimal `adapter_for` to `agent.rs`** (Phase 0 = Claude only; Task 6 extends it):

```rust
/// Resolve the adapter for an agent id.
pub fn adapter_for(agent: AgentId) -> Box<dyn ProviderAdapter> {
    match agent {
        AgentId::Claude => Box::new(ClaudeAdapter),
        AgentId::Codex => Box::new(ClaudeAdapter), // TEMP until Task 6 adds CodexAdapter
    }
}
```

- [ ] **Step 5: Run to verify pty tests pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (all modules). If `spawn`'s new arg breaks `lib.rs::pty_spawn`, that's fixed in Task 4 — temporarily insert `crate::agent::AgentId::Claude,` just before `on_event,` in the `pty.spawn(...)` call (`lib.rs` ~63-73) to keep it compiling between tasks; Task 4 replaces it with the resolved `agent`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty.rs src-tauri/src/agent.rs src-tauri/src/lib.rs
git commit -m "refactor(pty): build spawn script via ProviderAdapter" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Persist `agent` on Session

**Files:**
- Modify: `src-tauri/src/store.rs` (`Session` ~14-25, `add_session` ~144-167, tests ~216-237)
- Modify: `src-tauri/src/lib.rs` (`add_session` command ~119-127)

- [ ] **Step 1: Update store.rs tests for the new arg + a back-compat test**

```rust
#[test]
fn add_session_defaults_agent_to_claude() {
    let dir = temp_dir("agent_default");
    let store = Store::for_test(&dir);
    let p = store.add_project("/repo".into());
    let s = store
        .add_session(&p.id, "Session 1".into(), false, crate::agent::AgentId::Claude)
        .unwrap();
    assert_eq!(s.agent, crate::agent::AgentId::Claude);
}

#[test]
fn old_state_json_without_agent_deserializes_as_claude() {
    let json = r#"{"id":"x","name":"n","useWorktree":false}"#;
    let s: Session = serde_json::from_str(json).unwrap();
    assert_eq!(s.agent, crate::agent::AgentId::Claude);
}
```

Also update the two existing tests (`add_session_without_worktree_leaves_fields_empty`, `add_session_with_worktree_computes_path_and_branch`) to pass the new 4th arg `crate::agent::AgentId::Claude` to `add_session(...)`.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml store::`
Expected: FAIL — `Session` has no `agent` field; `add_session` takes 3 args.

- [ ] **Step 3: Add the field + thread the arg** — in `store.rs` add to `Session` (after `branch`, line ~24):

```rust
    #[serde(default)]
    pub agent: crate::agent::AgentId,
```

Change `add_session` (line ~144) signature to `pub fn add_session(&self, project_id: &str, name: String, use_worktree: bool, agent: crate::agent::AgentId) -> Option<Session>` and set `agent` in the `Session { ... }` literal (line ~157-163, add `agent,`).

In `lib.rs`, change the `add_session` command (lines ~119-127) to accept and forward the agent:

```rust
#[tauri::command]
fn add_session(
    project_id: String,
    name: String,
    use_worktree: bool,
    agent: crate::agent::AgentId,
    store: State<Store>,
) -> Option<Session> {
    store.add_session(&project_id, name, use_worktree, agent)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/store.rs src-tauri/src/lib.rs
git commit -m "feat(store): persist agent id on Session (defaults to claude)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Resolve the agent at spawn (Store lookup) + branch hooks/worktree on it

**Files:**
- Modify: `src-tauri/src/store.rs` (add `session_agent`)
- Modify: `src-tauri/src/lib.rs` (`pty_spawn` ~31-74)

- [ ] **Step 1: Test the Store lookup**

```rust
#[test]
fn session_agent_returns_stored_agent_else_claude() {
    let dir = temp_dir("lookup");
    let store = Store::for_test(&dir);
    let p = store.add_project("/repo".into());
    let s = store
        .add_session(&p.id, "S".into(), false, crate::agent::AgentId::Codex)
        .unwrap();
    assert_eq!(store.session_agent(&s.id), crate::agent::AgentId::Codex);
    assert_eq!(store.session_agent("missing"), crate::agent::AgentId::Claude);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml store::session_agent`
Expected: FAIL — no such method.

- [ ] **Step 3: Implement `session_agent`** (add to `impl Store`, near `add_session`):

```rust
    /// The agent for a session id, searching all projects. Defaults to Claude for an
    /// unknown id (back-compat / shell-only companions that were never persisted).
    pub fn session_agent(&self, session_id: &str) -> crate::agent::AgentId {
        let projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        projects
            .iter()
            .flat_map(|p| &p.sessions)
            .find(|s| s.id == session_id)
            .map(|s| s.agent)
            .unwrap_or_default()
    }
```

- [ ] **Step 4: Wire `pty_spawn` to resolve + branch on the agent** — replace `pty_spawn` (lib.rs ~31-74). Add `store: State<Store>` to the signature, resolve the agent first, and only install Claude hooks / use `--worktree` when the adapter supports it:

```rust
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    session_id: String,
    working_directory: String,
    cols: u16,
    rows: u16,
    shell_only: bool,
    worktree_name: Option<String>,
    on_event: Channel<String>,
    pty: State<Arc<PtyManager>>,
    hook_state: State<Arc<HookState>>,
    store: State<Store>,
) -> Result<(), String> {
    let port = hook_state.port.load(Ordering::SeqCst);
    let agent = if shell_only {
        crate::agent::AgentId::Claude // shell companion: agent is irrelevant
    } else {
        store.session_agent(&session_id)
    };
    let adapter = crate::agent::adapter_for(agent);

    let (cwd, worktree_arg, settings_path) = if shell_only {
        (working_directory.clone(), None, None)
    } else if worktree_name.is_some() && adapter.supports_worktree() {
        let slug = worktree_name.as_deref().unwrap();
        let settings = hooks::write_settings_file(port);
        let wt_path = worktree::worktree_path(&working_directory, slug);
        let exists = Path::new(&wt_path).exists();
        let (cwd, worktree_arg) = worktree::spawn_target(&working_directory, slug, &wt_path, exists);
        (cwd, worktree_arg, settings)
    } else {
        // Normal session: install Claude hooks ONLY for Claude (other agents get
        // their own hook wiring in a later phase). Non-Claude → plain cwd, no hooks.
        if matches!(agent, crate::agent::AgentId::Claude) {
            hooks::install(&working_directory, port);
        }
        (working_directory.clone(), None, None)
    };

    pty.spawn(
        session_id, cwd, cols, rows, port, shell_only, worktree_arg, settings_path, agent, on_event,
    )
}
```

> Note the new `agent` argument to `pty.spawn(...)` — its position must match Task 2's `spawn` signature (after `shell_only`/`worktree`/`settings`, before `on_event`). Adjust the order in Task 2 Step 4 and here to match exactly: `(session_id, cwd, cols, rows, port, shell_only, worktree_arg, settings_path, agent, on_event)`.

- [ ] **Step 5: Run the full Rust suite + clippy**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: PASS, no clippy errors.

- [ ] **Step 6: Launch-verify Phase 0 is a no-op** — `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, create a session, confirm Claude launches and resumes exactly as before. Then **Commit**:

```bash
git add src-tauri/src/store.rs src-tauri/src/lib.rs
git commit -m "feat(pty): resolve session agent from store at spawn; gate hooks/worktree on it" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend — `agent` on the TS Session + addSession (still Claude-only)

**Files:**
- Create: `src/agents.ts`
- Modify: `src/store.ts` (`Session` ~15-21, `addSession` type ~254 + impl ~366-379)

- [ ] **Step 1: Create `src/agents.ts`** (the single source of agent UI metadata):

```ts
export type AgentId = "claude" | "codex";

export interface AgentMeta {
  id: AgentId;
  label: string;
  /** Monogram letter shown in the glyph. */
  letter: string;
  /** CSS color token for the glyph tint. */
  tint: string;
  /** Whether Conduit's worktree isolation is offered for this agent (Phase 1: Claude only). */
  supportsWorktree: boolean;
}

export const AGENTS: AgentMeta[] = [
  { id: "claude", label: "Claude Code", letter: "C", tint: "#ce8a6e", supportsWorktree: true },
  { id: "codex", label: "Codex CLI", letter: "x", tint: "#9aa6b2", supportsWorktree: false },
];

export const DEFAULT_AGENT: AgentId = "claude";

export function agentMeta(id: AgentId): AgentMeta {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}
```

- [ ] **Step 2: Add `agent` to the `Session` interface** (`src/store.ts` ~15-21):

```ts
export interface Session {
  id: string;
  name: string;
  useWorktree: boolean;
  worktreePath?: string | null;
  branch?: string | null;
  agent: AgentId;
}
```

Add `import { type AgentId, DEFAULT_AGENT } from "./agents";` at the top of `store.ts`.

- [ ] **Step 3: Thread agent through `addSession`** — update the action type (~254) and impl (~366-370):

```ts
// type:
addSession: (projectId: string, opts?: { name?: string; useWorktree?: boolean; agent?: AgentId }) => Promise<void>;

// impl head:
addSession: async (projectId, opts) => {
  const project = get().projects.find((p) => p.id === projectId);
  const name = opts?.name?.trim() || `Session ${(project?.sessions.length ?? 0) + 1}`;
  const useWorktree = opts?.useWorktree ?? false;
  const agent = opts?.agent ?? DEFAULT_AGENT;
  const session = await invoke<Session | null>("add_session", { projectId, name, useWorktree, agent });
  if (!session) return;
  // ...unchanged...
},
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no type errors). Existing `NewSessionDialog.onCreate` still compiles (agent is optional on `addSession`).

- [ ] **Step 5: Commit**

```bash
git add src/agents.ts src/store.ts
git commit -m "feat(store): add agent id to the TS Session model (defaults to claude)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **Phase 0 done.** Behavior is identical; every Session now carries `agent: "claude"`. `cargo test` green, `tsc` green, app launches and runs Claude as before.

---

# PHASE 1 — First sibling (Codex) + picker + identity + gating

## Task 6: `CodexAdapter` + real `adapter_for`

**Files:**
- Modify: `src-tauri/src/agent.rs`

- [ ] **Step 1: Test the Codex invocation** (Phase 1: spawn fresh, no resume pinning, no env overrides):

```rust
#[test]
fn codex_spawns_fresh_with_fallback() {
    let cmd = CodexAdapter.build_invocation("sid", None, "");
    assert_eq!(cmd, "codex || codex");
    assert_eq!(CodexAdapter.id(), AgentId::Codex);
    assert_eq!(CodexAdapter.binary(), "codex");
    assert!(!CodexAdapter.supports_worktree());
    assert!(CodexAdapter.env_overrides().is_empty());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent::tests::codex`
Expected: FAIL — `CodexAdapter` undefined.

- [ ] **Step 3: Implement `CodexAdapter` and the real `adapter_for`** — add to `agent.rs`:

```rust
pub struct CodexAdapter;

impl ProviderAdapter for CodexAdapter {
    fn id(&self) -> AgentId {
        AgentId::Codex
    }
    fn binary(&self) -> &'static str {
        "codex"
    }
    // Phase 1: launch fresh (Codex doesn't accept a caller-pinned session id);
    // worktrees and resume are later phases. `_flags` is unused (no worktree flags
    // are ever passed for an agent whose supports_worktree() is false).
    fn build_invocation(&self, _session_id: &str, _projects_dir: Option<&Path>, _flags: &str) -> String {
        "codex || codex".to_string()
    }
}
```

Replace the temporary `adapter_for` (from Task 2 Step 4a) so Codex maps to `CodexAdapter`:

```rust
pub fn adapter_for(agent: AgentId) -> Box<dyn ProviderAdapter> {
    match agent {
        AgentId::Claude => Box::new(ClaudeAdapter),
        AgentId::Codex => Box::new(CodexAdapter),
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agent.rs
git commit -m "feat(agent): add CodexAdapter (Phase 1: spawn fresh)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `detect_agents` — PATH scan command

**Files:**
- Modify: `src-tauri/src/agent.rs` (add `AgentInfo` + `detect_one` + `detect_agents` impl)
- Modify: `src-tauri/src/lib.rs` (add `detect_agents` tauri command + register it)

- [ ] **Step 1: Test the pure parsing helper** (`detect_one` interprets a `command -v` result):

```rust
#[test]
fn detect_one_marks_found_when_path_nonempty() {
    let info = AgentInfo::from_probe(AgentId::Codex, "codex", "Codex CLI", "/opt/homebrew/bin/codex\n");
    assert!(info.found);
    assert_eq!(info.path.as_deref(), Some("/opt/homebrew/bin/codex"));
    let missing = AgentInfo::from_probe(AgentId::Codex, "codex", "Codex CLI", "");
    assert!(!missing.found);
    assert!(missing.path.is_none());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent::tests::detect_one`
Expected: FAIL — `AgentInfo` undefined.

- [ ] **Step 3: Implement detection** — add to `agent.rs`:

```rust
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: AgentId,
    pub label: String,
    pub binary: String,
    pub found: bool,
    pub path: Option<String>,
}

impl AgentInfo {
    /// Build from the stdout of `command -v <binary>` (empty = not found).
    pub fn from_probe(id: AgentId, binary: &str, label: &str, probe_stdout: &str) -> Self {
        let path = probe_stdout.trim();
        AgentInfo {
            id,
            label: label.to_string(),
            binary: binary.to_string(),
            found: !path.is_empty(),
            path: (!path.is_empty()).then(|| path.to_string()),
        }
    }
}

/// All known agents, for the UI to label/detect. Order = display order.
pub fn all_adapters() -> Vec<Box<dyn ProviderAdapter>> {
    vec![Box::new(ClaudeAdapter), Box::new(CodexAdapter)]
}

fn label_for(id: AgentId) -> &'static str {
    match id {
        AgentId::Claude => "Claude Code",
        AgentId::Codex => "Codex CLI",
    }
}

/// Scan the user's LOGIN-shell PATH for each agent binary. We run through
/// `$SHELL -i -l -c 'command -v <bin>'` (and scrub npm_config_prefix) so detection
/// sees the same PATH the spawned sessions will — nvm/Homebrew/etc. (mirrors pty.rs).
pub fn detect_agents() -> Vec<AgentInfo> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    all_adapters()
        .iter()
        .map(|a| {
            let bin = a.binary();
            let out = std::process::Command::new(&shell)
                .args(["-i", "-l", "-c", &format!("command -v {bin}")])
                .env_remove("npm_config_prefix")
                .output();
            let stdout = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
            AgentInfo::from_probe(a.id(), bin, label_for(a.id()), &stdout)
        })
        .collect()
}
```

In `lib.rs` add the command and register it in the `invoke_handler!` list (near `add_session`, ~line 361):

```rust
#[tauri::command]
fn detect_agents() -> Vec<crate::agent::AgentInfo> {
    crate::agent::detect_agents()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml agent:: && cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: PASS, no clippy errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agent.rs src-tauri/src/lib.rs
git commit -m "feat(agent): detect installed agent binaries on the login-shell PATH" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `AgentGlyph` component

**Files:**
- Create: `src/components/AgentGlyph.tsx`
- Create: a small CSS block in `src/theme.css` (append) for `.agent-glyph`

- [ ] **Step 1: Implement the glyph** (`src/components/AgentGlyph.tsx`):

```tsx
import { agentMeta, type AgentId } from "../agents";

/** Rounded-square monogram identifying an agent. Accessible: shape + letter + color,
 *  with the agent name as the title (not color alone). */
export function AgentGlyph({ id, size = 14 }: { id: AgentId; size?: number }) {
  const m = agentMeta(id);
  return (
    <span
      className="agent-glyph"
      title={m.label}
      aria-label={m.label}
      style={{ width: size, height: size, background: m.tint, fontSize: Math.round(size * 0.6) }}
    >
      {m.letter}
    </span>
  );
}
```

Append to `src/theme.css`:

```css
.agent-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: #161310;
  font-weight: 700;
  flex-shrink: 0;
  line-height: 1;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/AgentGlyph.tsx src/theme.css
git commit -m "feat(ui): add AgentGlyph monogram component" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Tile picker in the New Session dialog

**Files:**
- Modify: `src/components/NewSessionDialog.tsx`
- Append CSS to `src/theme.css` for `.agent-tiles` / `.agent-tile`

- [ ] **Step 1: Implement the picker + detection + worktree gating** — replace `src/components/NewSessionDialog.tsx` body. It now: fetches detection on mount, renders a 2×2 tile grid, pre-selects the default if ready, disables non-installed tiles, disables the worktree toggle for agents that don't support it, and passes `agent` to `onCreate`:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isGitRepo } from "../store";
import { AGENTS, DEFAULT_AGENT, agentMeta, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";

interface AgentInfo {
  id: AgentId;
  label: string;
  binary: string;
  found: boolean;
  path?: string | null;
}

export function NewSessionDialog({
  projectPath,
  onCancel,
  onCreate,
}: {
  projectPath: string;
  onCancel: () => void;
  onCreate: (opts: { name?: string; useWorktree: boolean; agent: AgentId }) => void;
}) {
  const [name, setName] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [gitOk, setGitOk] = useState(false);
  const [agent, setAgent] = useState<AgentId>(DEFAULT_AGENT);
  const [detected, setDetected] = useState<AgentInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    void isGitRepo(projectPath).then((ok) => alive && setGitOk(ok));
    void invoke<AgentInfo[]>("detect_agents").then((d) => {
      if (!alive) return;
      setDetected(d);
      // Pre-select the default if it's installed, else the first installed agent.
      const ready = new Set(d.filter((a) => a.found).map((a) => a.id));
      if (!ready.has(DEFAULT_AGENT)) {
        const first = d.find((a) => a.found);
        if (first) setAgent(first.id);
      }
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isReady = (id: AgentId) => !detected || detected.find((a) => a.id === id)?.found === true;
  const anyReady = !detected || detected.some((a) => a.found);
  const worktreeAllowed = gitOk && agentMeta(agent).supportsWorktree;
  const submit = () => {
    if (!isReady(agent)) return;
    onCreate({ name: name.trim() || undefined, useWorktree: useWorktree && worktreeAllowed, agent });
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">New session</div>

        <div className="dialog-label">Agent</div>
        <div className="agent-tiles" role="radiogroup" aria-label="Agent">
          {AGENTS.map((a) => {
            const ready = isReady(a.id);
            return (
              <button
                key={a.id}
                role="radio"
                aria-checked={agent === a.id}
                aria-label={`${a.label}${ready ? "" : " (not installed)"}`}
                className={`agent-tile ${agent === a.id ? "sel" : ""} ${ready ? "" : "disabled"}`}
                disabled={!ready}
                onClick={() => ready && setAgent(a.id)}
              >
                <AgentGlyph id={a.id} size={20} />
                <span className="nm">{a.label}</span>
                {a.id === DEFAULT_AGENT && <span className="df">default</span>}
                {!ready && <span className="off">not installed</span>}
              </button>
            );
          })}
        </div>

        <input
          className="dialog-input"
          placeholder="Name (optional)"
          autoFocus
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <label
          className={`dialog-toggle ${worktreeAllowed ? "" : "disabled"}`}
          title={
            !gitOk
              ? "Not a git repository"
              : agentMeta(agent).supportsWorktree
                ? ""
                : `Worktrees aren't supported for ${agentMeta(agent).label} yet`
          }
        >
          <input
            type="checkbox"
            checked={useWorktree && worktreeAllowed}
            disabled={!worktreeAllowed}
            onChange={(e) => setUseWorktree(e.target.checked)}
          />
          <span>Isolate in a git worktree</span>
        </label>

        {!anyReady && (
          <div className="dialog-note">No agents installed — install one to start.</div>
        )}

        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!isReady(agent)}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
```

Append to `src/theme.css`:

```css
.dialog-label { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); margin: 2px 0 6px; }
.agent-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
.agent-tile { display: flex; align-items: center; gap: 7px; padding: 8px; border: 1px solid var(--selection-bg); border-radius: 6px; background: var(--panel-bg); color: var(--text-dim); cursor: pointer; text-align: left; }
.agent-tile.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--text-bright); }
.agent-tile.disabled { opacity: 0.5; cursor: not-allowed; }
.agent-tile .nm { font-size: 11px; }
.agent-tile .df { margin-left: auto; font-size: 8px; color: var(--accent); letter-spacing: 0.04em; }
.agent-tile .off { margin-left: auto; font-size: 8px; color: var(--text-dim); }
.dialog-note { font-size: 11px; color: var(--text-dim); margin: 4px 0 8px; }
```

- [ ] **Step 2: Update the `ProjectBlock` caller** in `src/components/Sidebar.tsx` (`onCreate` ~151-154) — its `addSession` call already spreads `opts`, but `onCreate`'s type now requires `agent`. Confirm the call site compiles:

```tsx
onCreate={(opts) => {
  setShowNew(false);
  void addSession(project.id, opts); // opts now includes { name, useWorktree, agent }
}}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Launch-verify** — `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`. Open New Session: the tile grid shows Claude + Codex; Codex disabled if not installed; the worktree toggle disables when Codex is selected. Create a Claude session → still works. **Commit**:

```bash
git add src/components/NewSessionDialog.tsx src/components/Sidebar.tsx src/theme.css
git commit -m "feat(ui): agent tile picker in the New Session dialog" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: End-to-end — spawn a Codex session

**Files:** none (verification task — the data path is already wired: picker → `addSession` → `add_session` (persists `agent`) → `pty_spawn` (Store lookup) → adapter).

- [ ] **Step 1: Launch + create a Codex session** (requires `codex` on PATH; if not installed, install per Codex docs first). `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev` → New Session → pick **Codex** → Create. Expected: the terminal launches `codex` in the project dir (no Claude hooks installed, no worktree). The session row exists; status stays `idle` (Phase 2 adds Codex status).
- [ ] **Step 2: Verify persistence** — quit and relaunch dev; the Codex session reloads with `agent: "codex"` (check `…/ConduitTauri-dev/state.json`).
- [ ] **Step 3: Verify Claude is unaffected** — a Claude session still installs hooks, shows live status, and resumes.
- [ ] **Step 4:** No commit (verification only). If a wiring bug is found, fix it in the relevant task's file and commit there.

---

## Task 11: Sidebar leading glyph (per-session identity)

**Files:**
- Modify: `src/components/Sidebar.tsx` (`SessionRow` ~161-211)

- [ ] **Step 1: Replace the leading `TerminalIcon` with `AgentGlyph`** — in `SessionRow`, import `AgentGlyph` and read the session's agent; swap the icon (line ~194):

```tsx
// add import:
import { AgentGlyph } from "./AgentGlyph";

// in SessionRow's returned JSX, replace:
//   <TerminalIcon size={12} className="term-icon" />
// with:
<AgentGlyph id={session.agent} size={14} />
```

Remove the now-unused `TerminalIcon` import if no other usage remains (grep first: `grep -n TerminalIcon src/components/Sidebar.tsx`).

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Launch-verify** — sidebar rows show the agent glyph (Claude clay "C", Codex steel "x"); status pills on the right unchanged. **Commit**:

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(ui): show per-session agent glyph in the sidebar" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Gate the Claude-only ambient widgets

**Files:**
- Modify: `src/components/Sidebar.tsx` (the `Sidebar` function ~79-101)

- [ ] **Step 1: Compute whether the selected session is a Claude session** — the ambient widgets (`ClaudeStatusWarning`, `ClaudeUsagePanel`, `ClaudeStatusPill`) are Claude-only (§5 of the spec). Show them only when the selected session is Claude (or no session is selected — keep the default Claude-centric view). Add a selector and gate:

```tsx
// in Sidebar(), add:
const selectedAgent = useStore((s) => {
  const id = globalSelectedSessionId(s);
  if (!id) return "claude" as const;
  return findSession(s.projects, id)?.session.agent ?? "claude";
});
const showClaudeAmbient = selectedAgent === "claude";

// then gate the three widgets:
{showClaudeAmbient && <ClaudeStatusWarning />}
// ...
{showClaudeAmbient && <ClaudeUsagePanel />}
// ...
{showClaudeAmbient && <ClaudeStatusPill />}
```

(Import `findSession` and `globalSelectedSessionId` are already imported in `Sidebar.tsx`.)

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Launch-verify** — select a Codex session: the status warning, usage panel, and status pill hide. Select a Claude session: they reappear. **Commit**:

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(ui): gate Claude-only ambient widgets by selected session agent" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Final verification + pre-PR gates

**Files:** none.

- [ ] **Step 1: Run every pre-PR check** (per CONTRIBUTING.md / CLAUDE.md):

```bash
pnpm exec tsc --noEmit
pnpm build
cargo test   --manifest-path src-tauri/Cargo.toml
cargo fmt    --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```
Expected: all pass; `cargo fmt` leaves no diff (or commit the formatting).

- [ ] **Step 2: Manual smoke matrix** (launch with `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`):
  - Create a Claude session → hooks/status/resume work; glyph "C"; ambient widgets visible.
  - Create a Codex session (codex installed) → spawns `codex`; glyph "x"; no ambient widgets when selected; status idle.
  - Codex tile disabled when `codex` not on PATH; worktree toggle disabled for Codex.
  - Old `state.json` (pre-`agent`) loads with sessions defaulting to Claude.
- [ ] **Step 3:** If `cargo fmt` changed files, `git add -A && git commit -m "style: cargo fmt"`. Otherwise nothing to commit.

---

## Spec coverage check (self-review)

- §3.1 picker (tile grid, default pre-select, disabled-when-not-ready, worktree gating, zero-agent note) → Task 9 ✓
- §3.2 sidebar leading glyph (shape+letter+color, status accessory unchanged) → Tasks 8, 11 ✓
- §3.0 detection (ready/not-found via PATH scan) → Task 7 ✓ *(the `not-ready`/`scan-error` states and full onboarding wizard are Phase 3 — out of scope here)*
- §4 data model (`agent` field, serde default, `add_session`→`pty_spawn` via Store lookup, adapter env map) → Tasks 1–5 ✓
- §5 keep-alive invariant (agent chosen at spawn; glyph render-only; no remount) → Tasks 4, 11 ✓
- §5 ambient widgets Claude-only/hidden → Task 12 ✓
- §9 Phase 0 (adapter seam) + Phase 1 (first sibling + picker + identity + gating) → all tasks ✓

**Out of scope for this plan (later phases):** Gemini/OpenCode adapters, per-agent hooks/status (Phase 2), onboarding wizard + Settings/MCP matrix (Phase 3), Codex resume + Conduit-owned worktrees, the `not-ready`/auth detection state, per-adapter titling.
