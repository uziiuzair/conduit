# Continuity C1 — Conduit Plumbing (bundle + spawn wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Ship the continuity plugin inside Conduit and, for every session spawned in a board-enabled project (when Node ≥22.5 is present), enable continuity (MCP tools **and** its presence hooks) with a distinct `CONTINUITY_SESSION_ID`. If Node is absent/old, skip silently — the board and all existing features are unaffected.

**Architecture:** Continuity is a Claude Code plugin: a stdio MCP server (`plugin/mcp/launch.mjs`) plus hooks (SessionStart→checkin, SessionEnd→checkout, UserPromptSubmit→focus) that drive presence. Conduit already installs profiles/plugins into a session's Claude config (`hooks.rs`) and writes per-session MCP config + env (`fleet.rs`/`pty.rs`). We reuse those seams to enable continuity per board-enabled session, gated on a Node-version probe.

**Tech Stack:** Rust (Tauri), the bundled continuity plugin (pure JS), Node ≥22.5 at runtime.

**Depends on:** C0 (`CONTINUITY_SESSION_ID` shipped in the continuity bundle). Vendor the C0-built `plugin/` into Conduit (Task 1).

**Spec:** `docs/superpowers/specs/2026-07-17-continuity-board-integration-design.md` (§Shipping continuity, §Data flow).

---

## Task 0: Investigate the two install seams (no code)

**Goal:** Before writing spawn wiring, know exactly how Conduit (a) writes a session's MCP config + env at spawn and (b) installs a Claude plugin's hooks. Report findings as comments in the PR / a scratch note; they parameterize Tasks 3–4.

- [ ] **Step 1** — Read how a session gets its MCP config + env today: `src-tauri/src/fleet.rs` `write_mcp_config`/`mcp_config_json`, `src-tauri/src/pty.rs` spawn (where `--mcp-config` + `CONDUIT_SESSION_ID`/env are applied, POSIX ~710-745 and Windows paths), and `src-tauri/src/lib.rs` `gets_fleet_mcp`/`board_enabled_for_session` gate. Confirm: can the same `--mcp-config` JSON declare a **stdio** MCP server (`{command, args, env}`) alongside the existing http fleet server? (Claude's `--mcp-config` supports both types.)
- [ ] **Step 2** — Read how Conduit installs a plugin's HOOKS: `src-tauri/src/hooks.rs` `install_plugin`/`install_profile` (writes into the project's `.claude/settings.json` at `profile.config_rel_path`, backs up pristine as `*.conduit-backup`). Determine whether continuity's `plugin/hooks/hooks.json` (9 hooks) can be merged into that same settings path, and whether hooks reference the bundled script paths absolutely.
- [ ] **Step 3** — Decide the minimal enablement that yields **presence**: MCP-config-only gives the *tools* (handoff_*, agent_report_focus) but NOT the automatic checkin/checkout/focus lifecycle (those are hooks). Confirm we need to install continuity's hooks (Step 2 path) to get live presence, and record the exact settings file + merge shape. If installing full hooks is out of scope/too invasive, record the fallback: MCP-tools-only + rely on agents calling `agent_report_focus` (weaker presence), and note it for the spec.

Output of Task 0: the concrete file paths + JSON shapes Tasks 3–4 will write. **If Step 3 finds hooks install is infeasible in this pass, descope presence to "manual focus" and update the spec's §Card anatomy note.**

---

## Task 1: Vendor the continuity plugin as a Conduit asset

**Files:** create `src-tauri/assets/continuity-plugin/` (copy of continuity's `plugin/`); modify `.gitignore` if needed.

- [ ] **Step 1** — Copy the C0-built `~/ooozzy/continuity-mcp/plugin/` (its `.claude-plugin/`, `.mcp.json`, `hooks/`, `scripts/`, `mcp/{launch.mjs,index.mjs}`) into `src-tauri/assets/continuity-plugin/`. Record the bundled continuity version (`0.1.0-alpha.3`) in a sibling `VERSION` file.
- [ ] **Step 2** — Confirm it's pure JS + committed (no node_modules). `du -sh src-tauri/assets/continuity-plugin` (~≤1MB).
- [ ] **Step 3** — Add a resolver `fn continuity_asset_dir() -> PathBuf` that returns the bundled plugin path at runtime. In dev it's `src-tauri/assets/continuity-plugin`; in a packaged app it's under the Tauri resource dir. Follow how Conduit resolves other bundled assets (grep for existing `resource_dir()`/asset resolution; if none, use `tauri::path` resource resolution). Add a Rust test asserting the dir + `mcp/launch.mjs` exist in dev.
- [ ] **Step 4** — Commit.
```bash
git add src-tauri/assets/continuity-plugin src-tauri/src/<resolver>.rs
git commit -m "feat(continuity): vendor the continuity plugin as a bundled asset"
```

---

## Task 2: Node ≥22.5 probe (pure, tested)

**Files:** create `src-tauri/src/continuity.rs` (module: probe + config assembly); register `mod continuity;` in `lib.rs`.

- [ ] **Step 1: Failing test.** In `continuity.rs`:
```rust
/// Parse `node --version` output ("v22.5.0", "v24.1.0", "v20.11.1") into (major, minor).
pub fn parse_node_version(s: &str) -> Option<(u32, u32)> {
    let s = s.trim().trim_start_matches('v');
    let mut it = s.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}
/// node:sqlite requires Node ≥ 22.5.
pub fn node_supports_sqlite(v: (u32, u32)) -> bool { v.0 > 22 || (v.0 == 22 && v.1 >= 5) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn parses_and_gates_node_versions() {
        assert_eq!(parse_node_version("v22.5.0"), Some((22, 5)));
        assert_eq!(parse_node_version("v24.1.0"), Some((24, 1)));
        assert!(node_supports_sqlite((22, 5)));
        assert!(node_supports_sqlite((24, 0)));
        assert!(!node_supports_sqlite((22, 4)));
        assert!(!node_supports_sqlite((20, 11)));
        assert_eq!(parse_node_version("garbage"), None);
    }
}
```
- [ ] **Step 2** — `cargo test --manifest-path src-tauri/Cargo.toml continuity::` → PASS.
- [ ] **Step 3** — Add `pub fn detect_node() -> Option<(u32,u32)>` that runs `node --version` (via `std::process::Command`, `.no_window()` per the NoWindow trait, scrubbing `npm_config_prefix` like the other spawn sites) and parses it; returns `None` if node is missing or too old. Not unit-tested (env-dependent); exercised at runtime + in Task 5.
- [ ] **Step 4** — Commit.
```bash
git add src-tauri/src/continuity.rs src-tauri/src/lib.rs
git commit -m "feat(continuity): Node >=22.5 probe for node:sqlite support"
```

---

## Task 3: Continuity MCP-config assembly (pure, tested)

**Files:** `src-tauri/src/continuity.rs`

- [ ] **Step 1: Failing test.** Add a function that builds the continuity stdio-server entry for a session's `--mcp-config` JSON:
```rust
use serde_json::{json, Value};
/// The mcpServers entry Conduit adds so a session can reach continuity in local flavor.
/// `launch` = absolute path to the bundled `mcp/launch.mjs`; `session_id` = Conduit's session id.
pub fn continuity_mcp_entry(launch: &str, session_id: &str) -> Value {
    json!({
        "command": "node",
        "args": [launch],
        // SESSION_ID → distinct cwd_hash (C0); AGENT_ID → agent_label == Conduit sid (C2 presence join).
        "env": { "CONTINUITY_SESSION_ID": session_id, "CONTINUITY_AGENT_ID": session_id }
        // Local flavor: CONTINUITY_API_URL/KEY intentionally unset.
    })
}
#[cfg(test)]
mod cfg_tests {
    use super::*;
    #[test] fn builds_stdio_entry_with_identity() {
        let e = continuity_mcp_entry("/a/mcp/launch.mjs", "s2");
        assert_eq!(e["command"], "node");
        assert_eq!(e["args"][0], "/a/mcp/launch.mjs");
        assert_eq!(e["env"]["CONTINUITY_SESSION_ID"], "s2");
        assert_eq!(e["env"]["CONTINUITY_AGENT_ID"], "s2");
        assert!(e["env"].get("CONTINUITY_API_URL").is_none());
    }
}
```
- [ ] **Step 2** — Run → PASS.
- [ ] **Step 3** — Extend `fleet.rs::mcp_config_json` (or wherever the session's `--mcp-config` is assembled) so that, when continuity is enabled for the session, the returned `mcpServers` map ALSO includes `"continuity": continuity_mcp_entry(...)` next to the existing `conduit-fleet` http entry. Keep the http fleet entry unchanged. Gate: only add continuity when `board_enabled_for_session` AND `detect_node()` is `Some`.
- [ ] **Step 4: Commit.**
```bash
git add src-tauri/src/continuity.rs src-tauri/src/fleet.rs
git commit -m "feat(continuity): add continuity stdio server to session MCP config (gated)"
```

---

## Task 4: Enable continuity hooks + env at spawn (per Task 0 findings)

**Files:** `src-tauri/src/lib.rs` (spawn selection), `src-tauri/src/pty.rs` (env), possibly `src-tauri/src/hooks.rs` (plugin install)

- [ ] **Step 1** — At the spawn site that writes MCP config (where `gets_fleet_mcp` / `write_mcp_config` run in `lib.rs`), compute `continuity_on = board_enabled_for_session(&session_id) && continuity::detect_node().is_some() && !shell_only`. When true: (a) the session's `--mcp-config` includes the continuity entry (Task 3); (b) install continuity's hooks per Task 0's finding (reuse `hooks.rs` install path to merge `assets/continuity-plugin/hooks/hooks.json` into the session's Claude settings) — OR, if Task 0 descoped hooks, skip (b) and rely on tools-only presence.
- [ ] **Step 2** — Ensure **both** identity envs reach the continuity process + hooks:
  - `CONTINUITY_SESSION_ID = <session_id>` — folds into `cwd_hash` (C0) so each session is a distinct continuity row.
  - `CONTINUITY_AGENT_ID = <session_id>` — becomes the continuity `agent_label`, which is how C2's presence lookup joins a card's `claim.by` (a Conduit session id) to its continuity presence. **Set both to the Conduit session id.**
  Put them in the MCP-config `env` (Task 3) AND export in the PTY env (`pty.rs`, alongside `CONDUIT_SESSION_ID`) so the continuity HOOKS (separate Node processes) also see them. Scrub `npm_config_prefix` as the other spawn sites do.
- [ ] **Step 3** — Graceful skip: when `detect_node()` is `None`, add nothing (no continuity server, no hooks, no env). Emit a one-time `notify_user`/log line ("Continuity coordination needs Node ≥22.5; skipping — the board still works."). Never error the spawn.
- [ ] **Step 4** — `cargo build --manifest-path src-tauri/Cargo.toml` → clean. Add a Rust test for the gate decision (`continuity_on` true iff board-enabled + node present + not shell) using injected inputs (factor the boolean into a pure `fn continuity_enabled(board_enabled: bool, node: Option<(u32,u32)>, shell_only: bool) -> bool` and test it).
- [ ] **Step 5: Commit.**
```bash
git add src-tauri/src/lib.rs src-tauri/src/pty.rs src-tauri/src/hooks.rs src-tauri/src/continuity.rs
git commit -m "feat(continuity): enable continuity per board-enabled session with per-session identity"
```

---

## Task 5: End-to-end verification + changelog + version

**Files:** `CHANGELOG.md`, version files

- [ ] **Step 1** — `cargo test --manifest-path src-tauri/Cargo.toml` + `cargo build` + `cargo clippy` → green.
- [ ] **Step 2: Live check** (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, Node ≥22.5 installed): open a board-enabled project; spawn two Claude sessions. In session A, have it call the continuity handoff tool for a card (`handoff_create` with `project_scope: "conduit:<projectId>:card:<cardId>"`, some context). In session B, `handoff_pending` → sees A's handoff → `handoff_accept`. Confirm `~/.continuity/continuity.db` exists and both sessions are distinct `agent_sessions` rows (distinct `cwd_hash` thanks to `CONTINUITY_SESSION_ID`): `node <asset>/mcp/launch.mjs --doctor` or a sqlite dump.
- [ ] **Step 3: Node-absent check** — temporarily point PATH away from node (or test on a machine without Node ≥22.5): spawn a session; confirm the board + terminals work, no continuity server, the skip notice appears once, no error.
- [ ] **Step 4: Version + changelog** (MINOR — new user-facing capability): bump the three Conduit version files + `cargo build` for `Cargo.lock`; CHANGELOG entry:
```
- **Added — session coordination (continuity).** Board-enabled projects now bundle Continuity:
  every session gets a distinct identity and can hand off work with context to another session and
  report presence. Needs Node ≥22.5; skipped gracefully otherwise. (UI surfacing lands next.)
```
- [ ] **Step 5: Commit.**
```bash
git add -A && git commit -m "release: bundle continuity coordination for board-enabled sessions"
```

---

## Self-review (coverage)
- Bundle asset → Task 1. Node gate → Task 2 (+ tests). MCP config → Task 3 (+ tests). Hooks/env/skip → Task 4 (+ gate test). E2E + graceful degrade → Task 5.
- **Known unknown owned by Task 0:** the exact hooks-install mechanism; if infeasible, presence descopes to manual `agent_report_focus` and the spec note is updated — handoffs still work regardless (they're pure MCP tools).
