# Session Hibernate + Per-Session MCP Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user stop a session's processes (freeing ~600 MB) without deleting the session, and let a session declare which MCP servers it loads.

**Architecture:** Two new `#[serde(default)]` fields on the Rust `Session` (`stopped`, `mcp_servers`) drive everything. Stopping is three Tauri commands that kill the session's two PTYs and persist intent; restarting reuses the existing cold-spawn resume path (`claude --resume <id>`). The MCP allowlist generates a per-session `--mcp-config` file and adds `--strict-mcp-config`, reusing the seam the Conductor's fleet config already uses.

**Tech Stack:** Rust (Tauri v2, `portable_pty`, `serde_json`), React 19 + TypeScript, Zustand.

**Spec:** `docs/superpowers/specs/2026-08-13-session-hibernate-and-mcp-allowlist-design.md`

## Global Constraints

- Work happens on branch `feat/session-hibernate-mcp-allowlist` in the worktree `.worktrees/session-hibernate`. Never push or merge to `main` without explicit human approval.
- **Never** add a `Co-Authored-By: Claude` or any AI-attribution trailer to a commit.
- Commits are Conventional Commits, scoped: `feat(hibernate): …`, `fix(mcp): …`, `test(mcp): …`.
- **Keep-alive rule stands.** No change may unmount, reparent, or conditionally render a `TerminalView`, and no agent PTY may be killed by a tab switch, layout change, or directory change. The only new killers are the explicit user gestures in this plan.
- Every new persisted field is `#[serde(default)]` so an existing `~/Library/Application Support/ConduitTauri/state.json` loads unchanged.
- `--strict-mcp-config` and the allowlist apply to **Claude only**. Do not add MCP flags to any other adapter's invocation.
- Rust checks: `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo fmt --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml`.
- Frontend checks: `pnpm exec tsc --noEmit` and `pnpm build`. There is **no frontend test runner** — never claim a UI change works from a typecheck alone.
- Run the dev app only as `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, so it cannot clobber the installed app's `state.json`.
- Ships as version `0.19.0` in three files plus a `CHANGELOG.md` entry (Task 9).

---

### Task 1: Persisted session state (`stopped`, `mcp_servers`)

**Files:**
- Modify: `src-tauri/src/store.rs` — `Session` struct (ends ~line 95), `add_session` (~line 663), new setters near `set_session_account` (~line 1068)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `Session.stopped: bool`
  - `Session.mcp_servers: Option<Vec<String>>`
  - `Store::set_session_stopped(&self, session_id: &str, stopped: bool)`
  - `Store::set_session_mcp_servers(&self, session_id: &str, servers: Option<Vec<String>>)`
  - `Store::session_mcp_servers(&self, session_id: &str) -> Option<Vec<String>>`
  - `Store::add_session(..., mcp_servers: Option<Vec<String>>)` — one new trailing parameter

- [ ] **Step 1: Add the two fields to `Session`**

Append inside `pub struct Session { … }`, after `agent_conversation_id`:

```rust
    /// User stopped this session's processes without deleting it. The session, its
    /// transcript and its worktree are untouched; only the PTYs are gone. Persisted so
    /// hibernation survives a restart -- otherwise the eager restore-on-open path in
    /// `Terminal.tsx` would relaunch it on the next project open, undoing the decision.
    /// This records INTENT; whether a PTY exists is `PtyManager::has`.
    #[serde(default)]
    pub stopped: bool,
    /// MCP servers this session may load, by registry name. None = inherit whatever the
    /// agent would load on its own (user scope, project `.mcp.json`, plugins) -- today's
    /// behavior exactly. Some(list) = load exactly these and nothing else, via a generated
    /// `--mcp-config` plus `--strict-mcp-config`. Some(vec![]) is meaningful: no MCP at all.
    /// None and Some(<every server>) are deliberately NOT the same: strict mode also
    /// suppresses a repo's own `.mcp.json`.
    #[serde(default)]
    pub mcp_servers: Option<Vec<String>>,
```

- [ ] **Step 2: Thread the allowlist through `add_session`**

Add a trailing parameter to the signature:

```rust
    pub fn add_session(
        &self,
        project_id: &str,
        name: String,
        use_worktree: bool,
        agent: crate::agent::AgentId,
        role: SessionRole,
        mcp_servers: Option<Vec<String>>,
    ) -> Option<Session> {
```

In the `Session { … }` literal this function builds, set `stopped: false` and
`mcp_servers`. If the literal uses `..Default::default()`, both fields are covered
already and only `mcp_servers` needs setting explicitly.

- [ ] **Step 3: Add the setters**

Place immediately after `set_session_account`:

```rust
    /// Persist the user's stop/start intent for a session. Cheap and idempotent; the
    /// caller (`stop_session` / `start_session` in lib.rs) owns killing or spawning.
    pub fn set_session_stopped(&self, session_id: &str, stopped: bool) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        for p in projects.iter_mut() {
            if let Some(s) = p.sessions.iter_mut().find(|s| s.id == session_id) {
                if s.stopped != stopped {
                    s.stopped = stopped;
                    changed = true;
                }
                break;
            }
        }
        if changed {
            self.save(&projects);
        }
    }

    /// Replace a session's MCP allowlist. None restores inherit-everything.
    pub fn set_session_mcp_servers(&self, session_id: &str, servers: Option<Vec<String>>) {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        for p in projects.iter_mut() {
            if let Some(s) = p.sessions.iter_mut().find(|s| s.id == session_id) {
                s.mcp_servers = servers;
                break;
            }
        }
        self.save(&projects);
    }

    /// A session's MCP allowlist, if it has one. None = inherit (no flags at spawn).
    pub fn session_mcp_servers(&self, session_id: &str) -> Option<Vec<String>> {
        let projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        projects
            .iter()
            .flat_map(|p| p.sessions.iter())
            .find(|s| s.id == session_id)
            .and_then(|s| s.mcp_servers.clone())
    }
```

- [ ] **Step 4: Fix the one `add_session` caller**

`src-tauri/src/lib.rs`'s `add_session` command (~line 659) and any `fleet`/`fleet_mcp`
caller must pass the new argument. Find them all:

```bash
grep -rn "add_session(" src-tauri/src/
```

The Tauri command gains a matching parameter:

```rust
fn add_session(
    project_id: String,
    name: String,
    use_worktree: bool,
    agent: crate::agent::AgentId,
    role: Option<SessionRole>,
    mcp_servers: Option<Vec<String>>,
    store: State<Arc<Store>>,
) -> Option<Session> {
    store.add_session(
        &project_id,
        name,
        use_worktree,
        agent,
        role.unwrap_or_default(),
        mcp_servers,
    )
}
```

Backend fleet spawns pass `None`.

- [ ] **Step 5: Verify it compiles**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: builds and all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/store.rs src-tauri/src/lib.rs
git commit -m "feat(hibernate): persist Session.stopped + Session.mcp_servers"
```

---

### Task 2: Stop / start / stop-idle commands

**Files:**
- Modify: `src-tauri/src/lib.rs` — new commands near `remove_session` (~line 863), registration in the `invoke_handler!` list (~line 1532)

**Interfaces:**
- Consumes: `Store::set_session_stopped` (Task 1), `PtyManager::{kill, has}`, `FleetState::{running_sessions, set_running}`
- Produces: Tauri commands `stop_session(session_id)`, `start_session(session_id)`, `stop_idle_sessions(project_id) -> Vec<String>`; pure helper `idle_stop_targets(&[String], &HashSet<String>, &HashSet<String>) -> Vec<String>`

- [ ] **Step 1: Write the failing test for the pure selection rule**

Add to the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/lib.rs` (create
the module if there isn't one):

```rust
    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    fn set(v: &[&str]) -> std::collections::HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn idle_targets_stops_alive_and_not_running() {
        let got = idle_stop_targets(&ids(&["a", "b"]), &set(&["a", "b"]), &set(&["b"]));
        assert_eq!(got, ids(&["a"]), "b is running, so only a is stopped");
    }

    #[test]
    fn idle_targets_skips_sessions_with_no_pty() {
        // `c` was never spawned: stopping it would silently opt it out of restore-on-open.
        let got = idle_stop_targets(&ids(&["a", "c"]), &set(&["a"]), &set(&[]));
        assert_eq!(got, ids(&["a"]));
    }

    #[test]
    fn idle_targets_empty_project_stops_nothing() {
        assert!(idle_stop_targets(&[], &set(&[]), &set(&[])).is_empty());
    }
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml idle_targets`
Expected: FAIL — `cannot find function 'idle_stop_targets' in this scope`.

- [ ] **Step 3: Write the helper and the three commands**

Insert above the `remove_session` command in `src-tauri/src/lib.rs`:

```rust
/// Which of `session_ids` a bulk "stop idle sessions" should stop: those with a live PTY
/// that the fleet does not report as running. A session with no live PTY is skipped --
/// it costs nothing, and marking it stopped would silently opt it out of restore-on-open.
fn idle_stop_targets(
    session_ids: &[String],
    alive: &std::collections::HashSet<String>,
    running: &std::collections::HashSet<String>,
) -> Vec<String> {
    session_ids
        .iter()
        .filter(|id| alive.contains(*id) && !running.contains(*id))
        .cloned()
        .collect()
}

/// Stop a session without deleting it: kill its agent PTY and its companion shell, and
/// persist the intent so restore-on-open leaves it alone. The conversation is untouched --
/// the next spawn resumes it (`claude --resume <id>`, agy `--conversation=<id>`).
#[tauri::command]
fn stop_session(
    session_id: String,
    store: State<Arc<Store>>,
    pty: State<Arc<PtyManager>>,
    fleet: State<Arc<crate::fleet::FleetState>>,
) {
    pty.kill(&session_id);
    pty.kill(&format!("{session_id}::term"));
    fleet.set_running(&session_id, false);
    store.set_session_stopped(&session_id, true);
}

/// Clear the stopped flag. Spawning is the frontend's job (`TerminalView` owns the
/// cols/rows this command doesn't have), so this only records intent.
#[tauri::command]
fn start_session(session_id: String, store: State<Arc<Store>>) {
    store.set_session_stopped(&session_id, false);
}

/// Stop every idle session in a project. Returns the ids actually stopped so the UI can
/// report a count.
#[tauri::command]
fn stop_idle_sessions(
    project_id: String,
    store: State<Arc<Store>>,
    pty: State<Arc<PtyManager>>,
    fleet: State<Arc<crate::fleet::FleetState>>,
) -> Vec<String> {
    let session_ids: Vec<String> = store
        .list()
        .into_iter()
        .find(|p| p.id == project_id)
        .map(|p| p.sessions.into_iter().map(|s| s.id).collect())
        .unwrap_or_default();
    let alive: std::collections::HashSet<String> = pty.session_ids().into_iter().collect();
    let running: std::collections::HashSet<String> =
        fleet.running_sessions().into_iter().collect();
    let targets = idle_stop_targets(&session_ids, &alive, &running);
    for id in &targets {
        pty.kill(id);
        pty.kill(&format!("{id}::term"));
        fleet.set_running(id, false);
        store.set_session_stopped(id, true);
    }
    targets
}
```

- [ ] **Step 4: Register the commands**

Add `stop_session,`, `start_session,` and `stop_idle_sessions,` to the
`tauri::generate_handler![…]` list (near `pty_kill`, ~line 1532).

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, including the three new `idle_targets_*` tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(hibernate): stop_session / start_session / stop_idle_sessions commands"
```

---

### Task 3: MCP config generation + `--strict-mcp-config`

**Files:**
- Modify: `src-tauri/src/agent.rs` — new `session_mcp_config_json` near `McpServer` (~line 24); tests in its `#[cfg(test)]` module
- Modify: `src-tauri/src/pty.rs` — `build_script` (~line 700) and `build_script_win` (~line 776) gain `strict_mcp: bool`; both call sites (~lines 227, 262); tests (~line 913 onward)

**Interfaces:**
- Consumes: `crate::agent::McpServer` (existing struct: `name`, `transport`, `command`, `args`, `url`, `env`)
- Produces:
  - `pub fn session_mcp_config_json(servers: &[McpServer], fleet_block: Option<&str>) -> String`
  - `build_script(..., resume_token: Option<&str>, strict_mcp: bool)` — new trailing parameter
  - `build_script_win(..., resume_token: Option<&str>, strict_mcp: bool)` — new trailing parameter

- [ ] **Step 1: Write the failing tests for the config generator**

Add to `src-tauri/src/agent.rs`'s test module:

```rust
    fn stdio_server(name: &str) -> McpServer {
        McpServer {
            name: name.to_string(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "some-server".into()],
            url: String::new(),
            env: vec![("TOKEN".into(), "abc".into())],
        }
    }

    #[test]
    fn session_mcp_config_emits_stdio_server_with_args_and_env() {
        let json = session_mcp_config_json(&[stdio_server("ctx7")], None);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let s = &v["mcpServers"]["ctx7"];
        assert_eq!(s["command"], "npx");
        assert_eq!(s["args"][1], "some-server");
        assert_eq!(s["env"]["TOKEN"], "abc");
    }

    #[test]
    fn session_mcp_config_emits_http_server_as_typed_url() {
        let http = McpServer {
            name: "remote".into(),
            transport: "http".into(),
            command: String::new(),
            args: vec![],
            url: "https://example.test/mcp".into(),
            env: vec![],
        };
        let json = session_mcp_config_json(&[http], None);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["mcpServers"]["remote"]["type"], "http");
        assert_eq!(v["mcpServers"]["remote"]["url"], "https://example.test/mcp");
    }

    #[test]
    fn session_mcp_config_empty_allowlist_is_valid_and_has_no_servers() {
        let json = session_mcp_config_json(&[], None);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v["mcpServers"].as_object().unwrap().is_empty());
    }

    #[test]
    fn session_mcp_config_merges_the_fleet_block() {
        // A Conductor with an allowlist must keep its fleet tools: strict mode would
        // otherwise drop the very server that makes it a Conductor.
        let fleet = crate::fleet::mcp_config_json(1234, "cond-1");
        let json = session_mcp_config_json(&[stdio_server("ctx7")], Some(&fleet));
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(v["mcpServers"]["ctx7"].is_object());
        assert!(v["mcpServers"]["conduit-fleet"]["url"]
            .as_str()
            .unwrap()
            .contains("conductor=cond-1"));
    }
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session_mcp_config`
Expected: FAIL — `cannot find function 'session_mcp_config_json'`.

- [ ] **Step 3: Implement the generator**

Add to `src-tauri/src/agent.rs`, below the `McpServer` struct:

```rust
/// Build a `--mcp-config` document for ONE session's allowlist. Emits the standard
/// `{"mcpServers": {...}}` shape: stdio servers as `{command, args, env}`, http servers as
/// `{"type": "http", "url": ...}`. `fleet_block` is `fleet::mcp_config_json`'s output for a
/// Conductor or fleet worker; merging it here is what keeps `--strict-mcp-config` from
/// stripping the fleet server out from under an orchestrating session.
pub fn session_mcp_config_json(servers: &[McpServer], fleet_block: Option<&str>) -> String {
    let mut map = serde_json::Map::new();
    // The fleet block goes in first so an allowlisted server with a colliding name would
    // override it rather than be silently dropped -- a user-named server winning its own
    // name is the less surprising of the two.
    if let Some(raw) = fleet_block {
        if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(serde_json::Value::Object(inner)) = obj.get("mcpServers") {
                for (k, v) in inner {
                    map.insert(k.clone(), v.clone());
                }
            }
        }
    }
    for s in servers {
        let entry = if s.transport == "http" {
            serde_json::json!({ "type": "http", "url": s.url })
        } else {
            let env: serde_json::Map<String, serde_json::Value> = s
                .env
                .iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                .collect();
            serde_json::json!({ "command": s.command, "args": s.args, "env": env })
        };
        map.insert(s.name.clone(), entry);
    }
    serde_json::json!({ "mcpServers": serde_json::Value::Object(map) }).to_string()
}
```

- [ ] **Step 4: Run the generator tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session_mcp_config`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing tests for the strict flag**

Add to `src-tauri/src/pty.rs`'s test module. Copy the argument list from the neighbouring
`build_script_wraps_adapter_invocation_with_conduit_env` test and append the new trailing
`true` / `false`:

```rust
    #[test]
    fn build_script_appends_strict_mcp_config_when_set() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::Claude);
        let s = build_script(
            adapter.as_ref(),
            "sid",
            9999,
            "/tmp/wd",
            "/bin/zsh",
            None,
            None,
            Some("/cfg/mcp.json"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            true,
        );
        assert!(s.contains("--strict-mcp-config"));
        assert!(s.contains("--mcp-config /cfg/mcp.json"));
    }

    #[test]
    fn build_script_omits_strict_mcp_config_by_default() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::Claude);
        let s = build_script(
            adapter.as_ref(),
            "sid",
            9999,
            "/tmp/wd",
            "/bin/zsh",
            None,
            None,
            Some("/cfg/mcp.json"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            false,
        );
        assert!(!s.contains("--strict-mcp-config"));
    }
```

Add the Windows counterpart inside the existing `#[cfg(windows)]` test region, mirroring
`build_script_win_quotes_spaced_flags`'s argument list with a trailing `true`:

```rust
    #[cfg(windows)]
    #[test]
    fn build_script_win_appends_strict_mcp_config_when_set() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::Claude);
        let s = build_script_win(
            adapter.as_ref(),
            "sid",
            None,
            None,
            Some("C:\\cfg\\mcp.json"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            true,
        );
        assert!(s.contains("--strict-mcp-config"));
    }
```

- [ ] **Step 6: Run them to confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml strict_mcp`
Expected: FAIL — argument-count mismatch on `build_script`.

- [ ] **Step 7: Add the parameter to both builders**

In `build_script`, add `strict_mcp: bool` as the final parameter and append the flag
immediately after the existing `--mcp-config` block:

```rust
    if let Some(cfg) = mcp_config {
        flags.push_str(&format!(" --mcp-config {}", shell_quote(cfg)));
        // Only ever set alongside a config we generated for a session allowlist. It
        // suppresses ALL other MCP sources (user scope, the repo's own `.mcp.json`), so it
        // must never be added for a session that didn't opt in.
        if strict_mcp {
            flags.push_str(" --strict-mcp-config");
        }
    }
```

Make the identical change in `build_script_win` (which quotes with `quote_arg`; the flag
itself is bare and needs no quoting).

- [ ] **Step 8: Thread `strict_mcp` through `PtyManager::spawn`**

Add `strict_mcp: bool` to `spawn`'s parameter list, immediately after `resume_token`, and
pass it to both `build_script` / `build_script_win` call sites. Update the one caller in
`lib.rs` to pass `false` for now — Task 4 computes the real value.

- [ ] **Step 9: Run the full Rust suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/agent.rs src-tauri/src/pty.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): per-session mcp-config generator + --strict-mcp-config flag"
```

---

### Task 4: Wire the allowlist into `pty_spawn`

**Files:**
- Modify: `src-tauri/src/lib.rs` — `pty_spawn` signature (~line 90), the mcp/persona resolution block (~line 256), the `pty.spawn(…)` call (~line 381)

**Interfaces:**
- Consumes: `session_mcp_config_json` (Task 3), `Store::session_mcp_servers` (Task 1)
- Produces: `pty_spawn` accepts `mcp_allowlist: Option<Vec<crate::agent::McpServer>>` (camelCase `mcpAllowlist` from the frontend)

- [ ] **Step 1: Add the parameter**

In `pty_spawn`'s signature, after `initial_prompt`:

```rust
    /// Resolved MCP server definitions for this session's allowlist. The registry lives in
    /// the frontend's localStorage, so Rust cannot resolve names itself -- the caller sends
    /// the definitions it already holds. None = inherit (today's behavior, no flags).
    mcp_allowlist: Option<Vec<crate::agent::McpServer>>,
```

- [ ] **Step 2: Generate the config when an allowlist is present**

Replace the `let (mcp_config_path, system_prompt_file) = if is_conductor { … }` block so
the allowlist composes with the fleet block instead of competing with it:

```rust
    let fleet_mcp_port = fleet.mcp_port.load(Ordering::SeqCst);
    let wants_fleet_mcp =
        (is_conductor || gets_fleet_mcp) && agent == crate::agent::AgentId::Claude;
    let fleet_block =
        wants_fleet_mcp.then(|| crate::fleet::mcp_config_json(fleet_mcp_port, &session_id));
    let system_prompt_file = if is_conductor {
        crate::fleet::write_persona_file(&session_id, crate::fleet::CONDUCTOR_PERSONA)
    } else if wants_fleet_mcp {
        crate::fleet::write_persona_file(&session_id, crate::fleet::WORKER_BRIEF_SUFFIX)
    } else {
        None
    };
    // An allowlist (Claude only) replaces the fleet-only config with a merged one and turns
    // on strict mode. No allowlist -> byte-for-byte the previous behavior.
    let allowlist = (!shell_only && agent == crate::agent::AgentId::Claude)
        .then_some(mcp_allowlist)
        .flatten();
    let (mcp_config_path, strict_mcp) = match allowlist {
        Some(servers) => {
            let json = crate::agent::session_mcp_config_json(&servers, fleet_block.as_deref());
            let path = crate::store::data_dir().join(format!("session-mcp-{session_id}.json"));
            match std::fs::write(&path, json) {
                Ok(()) => (Some(path.to_string_lossy().to_string()), true),
                Err(e) => {
                    // Never fail a spawn over MCP: fall back to inherit-everything.
                    eprintln!("conduit: session mcp-config write failed ({e}); inheriting MCP");
                    (
                        fleet_block.and_then(|_| {
                            crate::fleet::write_mcp_config(fleet_mcp_port, &session_id)
                        }),
                        false,
                    )
                }
            }
        }
        None => (
            fleet_block.and_then(|_| crate::fleet::write_mcp_config(fleet_mcp_port, &session_id)),
            false,
        ),
    };
```

- [ ] **Step 3: Pass `strict_mcp` to the spawn call**

In the `pty.spawn(…)` argument list, replace Task 3's placeholder `false` with `strict_mcp`.

- [ ] **Step 4: Verify**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml`
Expected: PASS with no new warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(mcp): resolve per-session allowlist at spawn (Claude only)"
```

---

### Task 5: Frontend store — session fields and stop/start actions

**Files:**
- Modify: `src/store.ts` — `Session` interface (~line 47), `AppState` action declarations (~line 919), implementations near `removeSession` (~line 1657), `addSession` (~line 1539)

**Interfaces:**
- Consumes: Tauri commands `stop_session`, `start_session`, `stop_idle_sessions` (Task 2); `add_session`'s new `mcpServers` parameter (Task 1)
- Produces:
  - `Session.stopped?: boolean`, `Session.mcpServers?: string[] | null`
  - `stopSession(projectId: string, sessionId: string): Promise<void>`
  - `startSession(projectId: string, sessionId: string): Promise<void>`
  - `stopIdleSessions(projectId: string): Promise<number>`
  - `addSession(projectId, opts)` gains `opts.mcpServers?: string[] | null`

- [ ] **Step 1: Extend the `Session` interface**

```ts
  /** User stopped this session's processes without deleting it (persisted). */
  stopped?: boolean;
  /** MCP registry names this session may load; absent/null = inherit everything. */
  mcpServers?: string[] | null;
```

- [ ] **Step 2: Declare the three actions in `AppState`**

Next to `removeSession`:

```ts
  /** Kill a session's processes but keep the session, its history and its scrollback. */
  stopSession: (projectId: string, sessionId: string) => Promise<void>;
  /** Clear the stopped flag; TerminalView respawns (and resumes) from there. */
  startSession: (projectId: string, sessionId: string) => Promise<void>;
  /** Stop every idle session in a project; resolves with how many were stopped. */
  stopIdleSessions: (projectId: string) => Promise<number>;
```

- [ ] **Step 3: Implement them**

Add next to `removeSession`. Each one mirrors the flag into local state so
`TerminalView` reacts immediately rather than waiting for a projects reload:

```ts
    stopSession: async (projectId, sessionId) => {
      await invoke("stop_session", { sessionId }).catch(() => {});
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                sessions: p.sessions.map((x) =>
                  x.id === sessionId ? { ...x, stopped: true } : x,
                ),
              }
            : p,
        ),
        // A stopped session has no agent: clear its hook-driven status so the sidebar
        // can't keep showing "running" for a process that no longer exists.
        live: { ...s.live, [sessionId]: { status: "idle", todos: [] } },
      }));
    },

    startSession: async (projectId, sessionId) => {
      await invoke("start_session", { sessionId }).catch(() => {});
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                sessions: p.sessions.map((x) =>
                  x.id === sessionId ? { ...x, stopped: false } : x,
                ),
              }
            : p,
        ),
      }));
    },

    stopIdleSessions: async (projectId) => {
      const stopped = await invoke<string[]>("stop_idle_sessions", { projectId }).catch(
        () => [] as string[],
      );
      if (!stopped.length) return 0;
      const done = new Set(stopped);
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                sessions: p.sessions.map((x) => (done.has(x.id) ? { ...x, stopped: true } : x)),
              }
            : p,
        ),
        live: stopped.reduce(
          (acc, id) => ({ ...acc, [id]: { status: "idle" as const, todos: [] } }),
          s.live,
        ),
      }));
      return stopped.length;
    },
```

- [ ] **Step 4: Thread the allowlist through `addSession`**

Widen the `opts` type with `mcpServers?: string[] | null` and pass it to the command:

```ts
      const mcpServers = opts?.mcpServers ?? null;
      const session = await invoke<Session | null>("add_session", { projectId, name, useWorktree, agent, role, mcpServers });
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts
git commit -m "feat(hibernate): store actions for stop / start / stop-idle sessions"
```

---

### Task 6: `TerminalView` hibernate behavior

**Files:**
- Modify: `src/components/Terminal.tsx` — props (~line 20), eager-restore effect (~line 411), new stopped effect
- Modify: `src/components/WorkspaceCenter.tsx` — the `TerminalView` element (~line 242)

**Interfaces:**
- Consumes: `Session.stopped` (Task 5)
- Produces: `TerminalView` prop `stopped?: boolean` (default `false`)

- [ ] **Step 1: Add the prop**

```ts
  /**
   * The user stopped this session (Feature A). The PTY is killed and NOT respawned until
   * this goes false again. The xterm instance stays mounted throughout — the keep-alive
   * rule is untouched — so scrollback survives a stop/start cycle.
   */
  stopped?: boolean;
```

Destructure it with `stopped = false`.

- [ ] **Step 2: Add the stop/start effect**

Place directly after the shell-only respawn effect (~line 444). It deliberately skips its
own first run so mounting an already-stopped session doesn't try to kill a PTY that was
never spawned:

```tsx
  // Feature A (session hibernate): the user stopped or restarted this session.
  // false→true kills both PTYs and leaves the buffer intact; true→false respawns, which
  // cold-starts the agent's resume path (`claude --resume <id>` / agy `--conversation`).
  // NOTE: this is the ONLY path that may kill an agent PTY without deleting the session —
  // it is driven by an explicit user gesture, never by layout, visibility or dir changes.
  const prevStoppedRef = useRef(stopped);
  useEffect(() => {
    const was = prevStoppedRef.current;
    prevStoppedRef.current = stopped;
    if (was === stopped) return;

    if (stopped) {
      if (!spawnedRef.current) return;
      // Bump the generation FIRST so the doomed PTY's late frames (including
      // "[process exited]") can't paint over the stop marker.
      spawnGenRef.current++;
      spawnedRef.current = false;
      spawnedDirRef.current = null;
      // No reset(): the scrollback above the marker is the point of hibernating rather
      // than deleting.
      termRef.current?.write("\r\n\x1b[2m── session stopped — click this tab to resume ──\x1b[0m\r\n");
      void invoke("pty_kill", { sessionId }).catch(() => {});
      void invoke("pty_kill", { sessionId: `${sessionId}::term` }).catch(() => {});
      return;
    }

    // Restarting: spawn only if this pane is actually on screen; a hidden pane picks it
    // up through the reveal path in the `visible` effect.
    const term = termRef.current;
    if (!term || !visibleRef.current || !dirReady) return;
    const gen = spawnGenRef.current;
    spawnPty(term.cols || 80, term.rows || 24);
    // Cold-spawn repaint: `claude --resume` replays into the alternate screen and nothing
    // repaints it (pty_spawn's re-attach fast path nudges the winsize for exactly this
    // reason; the cold path does not). Nudge it here, on the resume path only.
    window.setTimeout(() => {
      if (disposedRef.current || gen !== spawnGenRef.current || !spawnedRef.current) return;
      const t = termRef.current;
      if (!t) return;
      void invoke("pty_resize", { sessionId, cols: t.cols, rows: t.rows + 1 })
        .then(() => invoke("pty_resize", { sessionId, cols: t.cols, rows: t.rows }))
        .catch(() => {});
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped]);
```

- [ ] **Step 3: Gate the two spawn paths on `stopped`**

In the reveal effect (~line 391), change the spawn condition:

```tsx
      if (!spawnedRef.current) {
        if (dirReady && !stopped) spawnPty(cols, rows);
      } else {
```

and add `stopped` to that effect's dependency array (`[visible, dirReady, stopped]`).

In the eager restore-on-open effect (~line 411), add the guard as the first line of the
body:

```tsx
    if (spawnedRef.current || shellOnly || stopped) return;
```

and add `stopped` to its dependency array.

- [ ] **Step 4: Pass the prop from `WorkspaceCenter`**

On the `TerminalView` element (~line 253, next to `role={session.role}`):

```tsx
                stopped={session.stopped ?? false}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/Terminal.tsx src/components/WorkspaceCenter.tsx
git commit -m "feat(hibernate): TerminalView stops and resumes in place, keeping scrollback"
```

---

### Task 7: The three user gestures

**Files:**
- Modify: `src/store.ts` — `requestCloseTab` (~line 1928)
- Modify: `src/components/Sidebar.tsx` — session context menu (~line 710), project context menu (~line 614), the session row's status dot
- Modify: `src/theme.css` — one rule for the stopped row

**Interfaces:**
- Consumes: `stopSession`, `startSession`, `stopIdleSessions`, `pushToast` (Task 5 / existing)
- Produces: no new exports

- [ ] **Step 1: Make tab close stop the session**

In `requestCloseTab`, before `s.closeTab(...)`:

```ts
      // A session tab's X now stops the session (Feature A) — closing the tab was already
      // the gesture users reached for to free memory, and it previously did nothing to the
      // process. Confirm only when the agent is mid-task, since a stop is recoverable:
      // the next start resumes the conversation.
      if (tab?.kind === "session") {
        const session = findSession(s.projects, ref)?.session;
        if (session && !session.stopped) {
          if (s.live[ref]?.status === "running") {
            const ok = await ask(
              `"${session.name}" is still working. Stop it?\n\nIts conversation is kept — reopening the session resumes it.`,
              { title: "Conduit", kind: "warning" },
            );
            if (!ok) return;
          }
          await s.stopSession(projectId, ref);
          s.pushToast(`Stopped "${session.name}" — reopen it to resume.`);
        }
      }
```

- [ ] **Step 2: Add Stop / Start to the session context menu**

Insert after the "Open to the Side" button:

```tsx
      <button
        onClick={() => {
          if (!menuSession) return;
          if (menuSession.stopped) void startSession(menu.projectId, sid);
          else {
            if (live[sid]?.status === "running" && !confirm(`"${menuSession.name}" is still working. Stop it?\n\nIts conversation is kept.`)) {
              closeMenu();
              return;
            }
            void stopSession(menu.projectId, sid);
          }
          closeMenu();
        }}
        title={
          menuSession?.stopped
            ? "Relaunch this session and resume its conversation"
            : "Kill this session's processes and free its memory. History and scrollback are kept."
        }
      >
        {menuSession?.stopped ? "Start session" : "Stop session"}
      </button>
```

Pull `stopSession`, `startSession` and `live` from the store at the top of the component,
alongside the existing selectors.

- [ ] **Step 3: Add "Stop idle sessions" to the project context menu**

Insert after "Open board":

```tsx
        <button
          onClick={() => {
            void stopIdleSessions(menu.projectId).then((n) => {
              pushToast(
                n === 0 ? "No idle sessions to stop." : `Stopped ${n} idle session${n === 1 ? "" : "s"}.`,
              );
            });
            closeMenu();
          }}
          title="Free memory: stop every session in this project that isn't mid-task. Conversations are kept."
        >
          Stop idle sessions
        </button>
```

- [ ] **Step 4: Dim the stopped session row**

Find where a session row's class list is built in `Sidebar.tsx` and add `stopped` when
`session.stopped` is true. Then in `src/theme.css`:

```css
/* A hibernated session: no processes, but fully alive as a session. Dimmed rather than
   hidden — clicking it relaunches and resumes. */
.session-row.stopped .session-name { opacity: 0.55; }
.session-row.stopped .status-dot { background: transparent; border: 1px solid currentColor; opacity: 0.5; }
```

Match the actual class names in the file; if the dot element differs, adapt the selector
rather than renaming existing classes.

- [ ] **Step 5: Typecheck and build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/components/Sidebar.tsx src/theme.css
git commit -m "feat(hibernate): stop from tab close, sidebar menu, and bulk stop-idle"
```

---

### Task 8: MCP picker in the new-session dialog

**Files:**
- Modify: `src/components/NewSessionDialog.tsx` — `onCreate` type (~line 15), state (~line 25), a new section before the create button (~line 160)
- Modify: `src/components/Sidebar.tsx` — the `onCreate` handler that calls `addSession`
- Modify: `src/components/Terminal.tsx` — resolve names to definitions at spawn

**Interfaces:**
- Consumes: `mcpServers: McpServer[]` and `mcpEnabled: Record<string, AgentId[]>` from the store; `addSession`'s `opts.mcpServers` (Task 5); `pty_spawn`'s `mcpAllowlist` (Task 4)
- Produces: `onCreate` opts gain `mcpServers?: string[] | null`

- [ ] **Step 1: Add state and the eligible-server list**

```tsx
  const mcpServers = useStore((s) => s.mcpServers);
  const mcpEnabled = useStore((s) => s.mcpEnabled);
  // Claude is the only agent whose CLI we've verified can be restricted
  // (`--strict-mcp-config`). Servers not enabled for Claude wouldn't load anyway.
  const mcpCandidates =
    effectiveAgent === "claude"
      ? mcpServers.filter((s) => (mcpEnabled[s.name] ?? []).includes("claude"))
      : [];
  const [mcpOff, setMcpOff] = useState<string[]>([]);
```

`mcpOff` holds the *unchecked* names, so a server added to the registry later defaults to
on and an empty `mcpOff` means "inherit".

- [ ] **Step 2: Render the section**

Place before the create button, and only when there is something to show:

```tsx
        {mcpCandidates.length > 0 && (
          <fieldset className="mcp-picker">
            <legend>MCP servers</legend>
            {mcpCandidates.map((s) => (
              <label key={s.name} className="dialog-toggle">
                <input
                  type="checkbox"
                  checked={!mcpOff.includes(s.name)}
                  onChange={(e) =>
                    setMcpOff((prev) =>
                      e.target.checked ? prev.filter((n) => n !== s.name) : [...prev, s.name],
                    )
                  }
                />
                <span>{s.name}</span>
              </label>
            ))}
            <p className="hint">
              Each MCP server costs memory in every session that loads it. Unchecking any
              server restricts this session to exactly the ones left checked.
            </p>
          </fieldset>
        )}
```

- [ ] **Step 3: Serialize on create**

In both `onCreate(...)` calls (the Conductor branch and the worker branch):

```tsx
      // All checked → null (inherit). An explicit "everything" allowlist is NOT the same:
      // strict mode would also suppress the repo's own .mcp.json.
      const mcp = mcpOff.length === 0 ? null : mcpCandidates.filter((s) => !mcpOff.includes(s.name)).map((s) => s.name);
```

and pass `mcpServers: mcp` in the opts object. Widen the `onCreate` prop type with
`mcpServers?: string[] | null`, and forward it from `Sidebar.tsx` into `addSession`.

- [ ] **Step 4: Resolve names to definitions at spawn**

In `Terminal.tsx`'s `spawnPty`, build the payload before `invoke`:

```tsx
    // The MCP registry lives in localStorage, so Rust can't resolve a name to a command.
    // Send definitions, looked up fresh each spawn: editing a server in the matrix takes
    // effect on the next start without rewriting any session record.
    const st = useStore.getState();
    const names = st.projects
      .flatMap((p) => p.sessions)
      .find((s) => s.id === sessionId)?.mcpServers;
    const mcpAllowlist =
      names == null ? null : st.mcpServers.filter((s) => names.includes(s.name));
```

and pass `mcpAllowlist` in the `pty_spawn` argument object.

- [ ] **Step 5: Typecheck and build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/components/NewSessionDialog.tsx src/components/Sidebar.tsx src/components/Terminal.tsx
git commit -m "feat(mcp): pick a session's MCP servers when creating it"
```

---

### Task 9: Verify in the real app, then release

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml` (line 3), `src-tauri/tauri.conf.json`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Full check suite**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm exec tsc --noEmit
pnpm build
```

Expected: clean. Fix anything that isn't before continuing.

- [ ] **Step 2: Launch the dev app and walk the manual checks**

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Verify each, and write down what actually happened:

1. Create two Claude sessions; note memory in Activity Monitor.
2. Close one session's tab → its `claude` process is gone and memory drops.
3. Its sidebar row is dimmed; the session is still listed.
4. Click it → it relaunches, the conversation is back, **and the screen paints** (the resume nudge).
5. Scrollback from before the stop is still above the stop marker.
6. Quit and relaunch with restore-on-open enabled → the stopped session stays stopped; the other comes back.
7. Ask a session a long question, then close its tab mid-answer → the confirm appears.
8. Project right-click → "Stop idle sessions" leaves the busy one running and reports a count.
9. New session with a subset of MCP servers checked → `/mcp` in that session lists exactly those.
10. New session with everything checked → `/mcp` matches a pre-change session.

- [ ] **Step 3: Settle the continuity/plugin-MCP question**

With the board enabled for the project, create a Claude session with a restricted MCP
allowlist, then run `/mcp` in it and check whether continuity's tools are listed.

Record the answer in the spec's "Open risk" section (replacing the open question with the
finding) and, if the tools are suppressed, add a one-line warning to the dialog's hint text
and a note to `CLAUDE.md`.

- [ ] **Step 4: Bump the version in all three files**

`package.json` `"version"`, `src-tauri/Cargo.toml` line 3, `src-tauri/tauri.conf.json`
`"version"` → `0.19.0`. Then refresh the lockfile:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
```

Expected: all three read `0.19.0`.

- [ ] **Step 5: Write the changelog entry**

At the top of `CHANGELOG.md`:

```markdown
## 0.19.0 — 2026-08-13

- **Added — Stop a session without deleting it.** Closing a session's tab now shuts down its agent and frees its memory instead of just hiding the tab. The session stays in the sidebar, dimmed; clicking it relaunches and resumes the conversation exactly where it left off, scrollback included. Right-click a session for Stop/Start, or a project for "Stop idle sessions" to reclaim everything that isn't mid-task. Stopped sessions stay stopped across restarts.
- **Added — Choose a session's MCP servers.** New Claude sessions can launch with only the MCP servers they need. Every server loads into every session that allows it, so trimming the list cuts memory directly. Leave everything checked and nothing changes.
```

- [ ] **Step 6: Update `CLAUDE.md`**

Add a short section pointing at the feature, in the style of the existing "Where … lives"
entries: the two `Session` fields, the three commands in `lib.rs`, the `stopped` effect in
`Terminal.tsx`, `session_mcp_config_json` in `agent.rs`, and the spec path. State plainly
that the stopped effect is the one sanctioned agent-PTY kill outside deletion, and that the
keep-alive rule is otherwise unchanged.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "release: session hibernate + per-session MCP allowlist (v0.19.0)"
```

- [ ] **Step 8: Report to the human**

Summarize what was verified in the running app (with the actual observations from Step 2),
what the continuity check found, and stop. **Do not merge to `main`** — that needs explicit
approval.

---

## Self-review notes

- **Spec coverage:** `stopped` field → Task 1; three commands → Task 2; terminal
  stop/resume + repaint nudge + eager-restore skip → Task 6; the three gestures, dimming
  and toasts → Task 7; `mcp_servers` field → Task 1; config generator + strict flag →
  Task 3; spawn wiring → Task 4; dialog → Task 8; the `None` vs `Some(everything)`
  distinction → Task 8 Step 3; continuity risk → Task 9 Step 3; version and changelog →
  Task 9.
- **Naming consistency:** Rust `stopped` / `mcp_servers` ↔ TS `stopped` / `mcpServers`
  (serde `rename_all = "camelCase"`); command names `stop_session` / `start_session` /
  `stop_idle_sessions` are invoked as-is; `pty_spawn`'s parameter is `mcp_allowlist` in
  Rust and `mcpAllowlist` in the invoke payload.
