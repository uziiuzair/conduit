# Multi-Agent Phase 3b — MCP matrix (Claude / Codex / Gemini)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** A shared MCP-server registry with a per-agent enable matrix in Settings (and the onboarding MCP step) that wires servers into each agent **via the agent's own `mcp add`/`mcp remove` CLI** (user scope).

**Key design decision (simpler + safer than editing config files):** use the agents' first-party MCP CLIs — `claude mcp add -s user`, `codex mcp add`, `gemini mcp add -s user` (and the matching `remove`) — run through the login shell (same mechanism as `detect_agents`/spawn). This sidesteps every per-format trap the grounding flagged (Codex TOML underscore, Gemini's hooks+MCP shared file, JSON merge/idempotency) because each CLI owns its own config write. Conduit owns the **registry** (the list of server defs + which agents each is enabled for), persisted in `localStorage`; the matrix reflects Conduit's registry, and toggling a cell shells out to add/remove.

**Grounded in:** `docs/superpowers/specs/2026-06-29-multi-agent-cli-support-ux-design.md` §3.4 (matrix UX/states) + `docs/superpowers/specs/2026-06-29-phase-2-3-grounding.md` (per-agent MCP facts).

**Tech Stack:** Rust (`cargo test` TDD for the command builders) + React/TS (`tsc` + `build` + launch).

**Scope:** Claude + Codex + Gemini. **Deferred:** OpenCode (its `opencode.json`/argv-array shape — later). **Caveat to surface in UI:** writing user-scope MCP does not bypass an agent's own trust/approval prompt on first use.

---

## File Structure
- **Modify** `src-tauri/src/agent.rs` — `mcp_add_command(&Server)` / `mcp_remove_command(name)` on the trait (Claude/Codex/Gemini impls; `None` default for OpenCode).
- **Modify** `src-tauri/src/lib.rs` — `mcp_apply(agent, action, server)` Tauri command (login-shell shell-out) + register it.
- **Modify** `src/store.ts` — MCP registry state (`mcpServers`, `mcpEnabled`) + actions + localStorage persistence + `applyMcp` invoke wrapper with per-cell status.
- **Create** `src/components/McpMatrix.tsx` — the matrix + add-server form (shared by Settings + wizard).
- **Modify** `src/components/Settings.tsx` — add the "MCP servers" tab.
- **Modify** `src/components/Onboarding.tsx` — insert an MCP step (Welcome → Agents → **MCP** → Done).
- **Append** `src/theme.css` — matrix/form styles.

---

## Task 1: Rust — per-adapter MCP CLI command builders

**Files:** `src-tauri/src/agent.rs`

- [ ] **Step 1: Failing tests** (agent.rs tests):
```rust
#[test]
fn mcp_command_builders_per_agent() {
    let s = crate::agent::McpServer {
        name: "context7".into(), transport: "stdio".into(),
        command: "npx".into(), args: vec!["-y".into(), "@upstash/context7-mcp".into()],
        url: String::new(), env: vec![("API_KEY".into(), "x".into())],
    };
    // Claude: user scope, env via -e, stdio after `--`
    assert_eq!(
        ClaudeAdapter.mcp_add_command(&s).unwrap(),
        "claude mcp add -s user -e API_KEY=x context7 -- npx -y @upstash/context7-mcp"
    );
    assert_eq!(ClaudeAdapter.mcp_remove_command("context7").unwrap(), "claude mcp remove -s user context7");
    // Codex: home scope (no -s), env via --env
    assert_eq!(
        CodexAdapter.mcp_add_command(&s).unwrap(),
        "codex mcp add --env API_KEY=x context7 -- npx -y @upstash/context7-mcp"
    );
    // Gemini: user scope, env via -e
    assert!(GeminiAdapter.mcp_add_command(&s).unwrap().starts_with("gemini mcp add -s user"));
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — add to `agent.rs`:
```rust
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub transport: String,           // "stdio" | "http"
    #[serde(default)] pub command: String,
    #[serde(default)] pub args: Vec<String>,
    #[serde(default)] pub url: String,
    #[serde(default)] pub env: Vec<(String, String)>,  // [(K,V)]
}

fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@=".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}
```
Add trait methods (default `None`) and impls. Each builds the agent's CLI string; return `None` if the transport isn't supported by that builder yet (http for some). Example for Claude:
```rust
fn mcp_add_command(&self, s: &McpServer) -> Option<String> {
    let env: String = s.env.iter().map(|(k, v)| format!(" -e {}={}", sh_quote(k), sh_quote(v))).collect();
    match s.transport.as_str() {
        "stdio" => {
            let args: String = s.args.iter().map(|a| format!(" {}", sh_quote(a))).collect();
            Some(format!("claude mcp add -s user{env} {} -- {}{}", sh_quote(&s.name), sh_quote(&s.command), args))
        }
        "http" => Some(format!("claude mcp add -s user --transport http {} {}", sh_quote(&s.name), sh_quote(&s.url))),
        _ => None,
    }
}
fn mcp_remove_command(&self, name: &str) -> Option<String> { Some(format!("claude mcp remove -s user {}", sh_quote(name))) }
```
Codex: drop `-s user` (home scope), env flag is `--env`, remove = `codex mcp remove <name>`. Gemini: `gemini mcp add -s user [-e K=V]... <name> <command> <args...>` (gemini takes command/args positionally, no `--`), remove = `gemini mcp remove <name>`.
> **Verify during the live smoke (Task 5):** confirm each CLI's exact flag syntax with `<agent> mcp add --help` on the installed binary; adjust the builder if a flag differs. The builders are the single place to fix.
- [ ] **Step 4: Run → pass.** `cargo test --manifest-path src-tauri/Cargo.toml agent::`
- [ ] **Step 5: Commit** `feat(agent): per-adapter MCP CLI command builders`.

---

## Task 2: Rust — `mcp_apply` command

**Files:** `src-tauri/src/lib.rs`

- [ ] **Step 1:** Add a command that runs the builder's output through the login shell (mirrors `detect_agents`' shell handling, incl. `npm_config_prefix` scrub) and register it in the `invoke_handler!` list:
```rust
#[tauri::command(async)]
fn mcp_apply(agent: crate::agent::AgentId, action: String, server: crate::agent::McpServer) -> Result<(), String> {
    let adapter = crate::agent::adapter_for(agent);
    let cmd = match action.as_str() {
        "add" => adapter.mcp_add_command(&server),
        "remove" => adapter.mcp_remove_command(&server.name),
        _ => return Err(format!("unknown action {action}")),
    }.ok_or_else(|| format!("{} can't write MCP for transport {}", adapter.binary(), server.transport))?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let out = std::process::Command::new(&shell)
        .args(["-i", "-l", "-c", &cmd])
        .env_remove("npm_config_prefix")
        .output()
        .map_err(|e| format!("spawn {}: {e}", adapter.binary()))?;
    if out.status.success() { Ok(()) }
    else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}
```
- [ ] **Step 2: Verify** `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml` (rustfmt ONLY agent.rs + lib.rs; never whole-crate `cargo fmt`).
- [ ] **Step 3: Commit** `feat(mcp): mcp_apply command runs each agent's mcp CLI`.

---

## Task 3: Frontend store — MCP registry + apply wrapper

**Files:** `src/store.ts`

- [ ] **Step 1:** Add types (in `agents.ts` or `store.ts`): `McpServer = { name; transport: "stdio"|"http"; command?; args?: string[]; url?; env?: [string,string][] }`. Add store state (localStorage-backed, like `defaultAgent`):
```ts
mcpServers: McpServer[];                       // the shared registry
mcpEnabled: Record<string, AgentId[]>;          // serverName -> agents it's written to
mcpBusy: Record<string, "pending" | { error: string } | undefined>; // key `${name}:${agent}` (transient, not persisted)
addMcpServer: (s: McpServer) => string | null;  // returns error (e.g. duplicate name) or null
removeMcpServer: (name: string) => Promise<void>;  // also removes from all enabled agents
setMcpEnabled: (name: string, agent: AgentId, on: boolean) => Promise<void>;
```
- [ ] **Step 2:** Implement. `mcpServers`/`mcpEnabled` persist to `localStorage` (JSON) on every change (mirror the `defaultAgent` pattern with a `conduit.mcp` key). `addMcpServer` blocks duplicate names (inline error). `setMcpEnabled(name, agent, on)`:
```ts
setMcpEnabled: async (name, agent, on) => {
  const server = get().mcpServers.find((s) => s.name === name);
  if (!server) return;
  const key = `${name}:${agent}`;
  set((s) => ({ mcpBusy: { ...s.mcpBusy, [key]: "pending" } }));
  try {
    await invoke("mcp_apply", { agent, action: on ? "add" : "remove", server });
    set((s) => {
      const cur = new Set(s.mcpEnabled[name] ?? []);
      on ? cur.add(agent) : cur.delete(agent);
      const mcpEnabled = { ...s.mcpEnabled, [name]: [...cur] };
      persistMcp(s.mcpServers, mcpEnabled);
      return { mcpEnabled, mcpBusy: { ...s.mcpBusy, [key]: undefined } };
    });
  } catch (e) {
    set((s) => ({ mcpBusy: { ...s.mcpBusy, [key]: { error: String(e) } } })); // cell reverts (enabled unchanged)
  }
},
```
`removeMcpServer(name)` calls `setMcpEnabled(name, a, false)` for each enabled agent (best-effort), then drops it from the registry. (Propagation = remove from every agent it was written to, per spec §3.4.)
- [ ] **Step 3: Typecheck.** **Commit** `feat(store): MCP registry + per-cell apply with status`.

---

## Task 4: `McpMatrix` component + Settings tab + wizard step

**Files:** Create `src/components/McpMatrix.tsx`; modify `src/components/Settings.tsx`, `src/components/Onboarding.tsx`; append `src/theme.css`.

- [ ] **Step 1:** Create `McpMatrix.tsx` — rows = `mcpServers`, columns = **installed** agents (`store.agents` where `found`), cells = toggles driven by `mcpEnabled`/`mcpBusy`; an "Add server" form (name + transport select + command/url + args + env, with validation: required name (unique), command required for stdio / url required for http); per-server remove. Render as an ARIA `grid` (`role="grid"`, cells `role="gridcell"` with a checkbox; arrow-key roving tabindex). A non-installed agent has no column. Cell states: off / on (✓) / pending (spinner) / error (revert + title=error). Show a one-line note: "Writing user-scope MCP — the agent may still prompt to approve a server on first use." Use `agentMeta` for column glyphs/labels. (Follow spec §3.4 for the full state list; implement add/toggle/remove + validation + per-cell async + duplicate-name block now; "import from agent" is out of scope this round.)
- [ ] **Step 2:** In `Settings.tsx`: add tab state, render two tabs ("Agents" / "MCP servers"), show `<AgentList/>` or `<McpMatrix/>` accordingly.
- [ ] **Step 3:** In `Onboarding.tsx`: change `steps` to `["Welcome","Agents","MCP","Done"]`, add a `step === 2` branch rendering `<McpMatrix/>` (with a "Skip — add later in Settings" affordance), and shift "Done" to `step === 3`. Continue/Done button logic updates to `step < 3`.
- [ ] **Step 4:** Append matrix/form CSS to `theme.css` (warm-dark tokens; reuse `.agent-glyph`, dialog styles).
- [ ] **Step 5: Typecheck + build** `pnpm exec tsc --noEmit && pnpm build`. **Commit** `feat(ui): MCP matrix (Settings tab + onboarding step)`.

---

## Task 5: Verify + live smoke

- [ ] **Step 1: Gates** `pnpm exec tsc --noEmit && pnpm build && cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml`.
- [ ] **Step 2: Live smoke** (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, with claude/codex/gemini installed):
  - **First** confirm each CLI's `mcp add` syntax: run `claude mcp add --help`, `codex mcp add --help`, `gemini mcp add --help`; fix the Task 1 builders if any flag differs.
  - In Settings → MCP servers: add a server (e.g. context7 stdio: `npx -y @upstash/context7-mcp`); toggle it ON for Claude → cell shows pending → ✓; verify `claude mcp list` shows it at user scope. Toggle OFF → gone. Repeat for Codex/Gemini. A bad command → cell shows error and reverts.
  - Onboarding MCP step renders the matrix and is skippable.
- [ ] **Step 3:** Commit any builder-syntax fixes. No whole-crate `cargo fmt`.

---

## Deferred
- OpenCode MCP (`opencode.json` argv-array/`environment` shape). "Import from agent" (seed registry from existing configs). Curated server catalog. Per-project (vs user) MCP scope.
