# Plugin System — Increment #1, Plan 1: Substrate + Sandbox + Hooks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the plugin substrate — folder-drop loader, validated manifest, install consent + granted permissions, a one-Worker-per-plugin sandbox with a permission-gated RPC bridge — and prove it with the **hooks** capability (a plugin receives sanitized session/fleet/lifecycle events and can call one gated host method, `notify`).

**Architecture:** Untrusted plugin JS runs in a dedicated Web Worker with no DOM/IPC. It reaches the app only through `host.request(method, params)`, which a main-thread dispatcher checks against the plugin's granted permissions before forwarding to `invoke`/store/events. Events flow the other way, delivered only for granted hook permissions. The permission gate and event sanitizers are pure functions unit-tested with vitest; manifest parsing/validation is a pure Rust function unit-tested with `cargo test`. UI (Plugins settings panel, consent dialog) is verified by launching the app.

**Tech Stack:** Rust (Tauri v2 commands, serde), React 19 + TypeScript, Zustand, Web Workers, vitest (node env).

**Scope note:** This is Plan 1 of two for increment #1. The **commands / palette / hotkeys** capability is Plan 2 and rides this substrate. `commands` and `net` are accepted as *known* manifest permission ids here but their runtime wiring lands later; a plugin declaring them in Plan 1 gets no command registry / network yet.

**Conventions (from CLAUDE.md):** Conventional Commits, scoped (`feat(plugins): …`). **Never** add a `Co-Authored-By` / AI-attribution trailer. Work stays on the `feat/plugins` worktree. Pre-commit checks: `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm test`, `pnpm exec tsc --noEmit`.

---

## File Structure

**Rust (`src-tauri/src/`):**
- `plugins.rs` *(new)* — manifest model + `parse_manifest`/`validate_manifest` (pure, tested); `PluginRecord`; `PluginDescriptor`; Tauri commands (`list_plugins`, `read_plugin_source`, `set_plugin_enabled`, `set_plugin_grants`, `remove_plugin`, `open_plugins_dir`); the known/reserved permission id sets.
- `store.rs` *(modify)* — `PersistState.plugins`, `Store.plugins` (`Mutex<Vec<PluginRecord>>`), getters/setters + `persist`.
- `lib.rs` *(modify)* — `mod plugins;` + register the six commands.

**Frontend (`src/plugins/`):**
- `types.ts` *(new)* — TS mirror of `PluginManifest`, `PluginDescriptor`, `PluginRecord`, `PluginPermission`, runtime `PluginStatus`.
- `permissions.ts` *(new)* — permission taxonomy + `permissionForMethod`, `permissionForEvent`, `describe`. Pure, tested.
- `gate.ts` *(new)* — `checkGrant(grants, method)` / `checkEventGrant(grants, event)`. Pure, tested.
- `events.ts` *(new)* — plugin-facing event ids, `sanitize*` mappers, `sourceEventToPlugin`. Pure, tested.
- `sandbox.ts` *(new)* — `SandboxHost` interface + `WorkerSandbox` (spawn/terminate/post/onMessage/watchdog).
- `worker-runtime.ts` *(new)* — the bootstrap string injected into each Worker (builds the `conduit` SDK, loads plugin `main.js`, routes messages).
- `host.ts` *(new)* — `PluginHost`: discovery, lifecycle, the dispatcher, event fan-out.
- `sdk.d.ts` *(new)* — the `conduit` API types published for plugin authors.
- `index.ts` *(new)* — `initPlugins()` boot entry + re-exports.

**Frontend UI (`src/components/`):**
- `PluginConsentDialog.tsx` *(new)* — install/enable consent + escalation.
- `PluginsPanel.tsx` *(new)* — Settings → Plugins list/toggle/permissions/kill switch.
- `Settings.tsx` *(modify)* — add `"plugins"` to `SettingsTab`, `NAV`, and the render block.

**Frontend wiring:**
- `store.ts` *(modify)* — plugins slice + actions.
- `App.tsx` *(modify)* — `initPlugins()` on mount + feed event sources.

**Config / example:**
- `src-tauri/tauri.conf.json` *(modify)* — CSP lockdown.
- `examples/plugins/session-logger/{manifest.json,main.js}` *(new)* — smoke-test plugin.

---

## Task 1: Rust — plugin manifest model + validation

**Files:**
- Create: `src-tauri/src/plugins.rs`
- Test: inline `#[cfg(test)]` in `src-tauri/src/plugins.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/plugins.rs` with only the test module + the item signatures they call (leave bodies `todo!()` so it compiles-then-fails):

```rust
use serde::{Deserialize, Serialize};

/// Permission ids valid in increment #1. Unknown ids are rejected at validation.
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "commands",
    "hooks:session",
    "hooks:fleet",
    "hooks:lifecycle",
    "notifications",
    "clipboard:write",
    "net",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    #[serde(default)]
    pub commands: Vec<CommandContribution>,
    #[serde(default)]
    pub hooks: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    pub min_app_version: String,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: Contributes,
}

fn default_main() -> String {
    "main.js".to_string()
}

/// Parse manifest JSON. Returns the manifest or a human-readable error.
pub fn parse_manifest(json: &str) -> Result<PluginManifest, String> {
    todo!()
}

/// Validate a parsed manifest against the folder name + the current app version.
/// Returns the list of problems (empty = valid).
pub fn validate_manifest(m: &PluginManifest, folder_name: &str, app_version: &str) -> Vec<String> {
    todo!()
}

/// True if `id` matches reverse-DNS-ish `^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`.
pub fn is_valid_id(id: &str) -> bool {
    todo!()
}

/// True if `have` (semver) >= `need` (semver). Non-semver `have` counts as satisfied
/// (dev builds); non-semver `need` is a validation error handled by the caller.
pub fn version_satisfies(have: &str, need: &str) -> bool {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> PluginManifest {
        parse_manifest(
            r#"{"id":"com.acme.logger","name":"Logger","version":"1.0.0",
                "minAppVersion":"0.14.0","permissions":["hooks:session"],
                "contributes":{"hooks":["session.start"]}}"#,
        )
        .unwrap()
    }

    #[test]
    fn parses_camelcase_min_app_version() {
        let m = good();
        assert_eq!(m.min_app_version, "0.14.0");
        assert_eq!(m.main, "main.js"); // default applied
    }

    #[test]
    fn valid_manifest_has_no_problems() {
        assert!(validate_manifest(&good(), "com.acme.logger", "0.14.0").is_empty());
    }

    #[test]
    fn id_must_match_folder() {
        let p = validate_manifest(&good(), "com.acme.OTHER", "0.14.0");
        assert!(p.iter().any(|s| s.contains("folder")));
    }

    #[test]
    fn rejects_bad_id() {
        assert!(!is_valid_id("Com.Acme")); // uppercase
        assert!(!is_valid_id("-lead"));
        assert!(!is_valid_id("com..acme")); // still matches charset; ok to allow — only charset checked
        assert!(is_valid_id("com.acme.logger"));
    }

    #[test]
    fn rejects_unknown_permission() {
        let mut m = good();
        m.permissions = vec!["hooks:session".into(), "read:everything".into()];
        let p = validate_manifest(&m, "com.acme.logger", "0.14.0");
        assert!(p.iter().any(|s| s.contains("read:everything")));
    }

    #[test]
    fn rejects_hook_without_permission() {
        let mut m = good();
        m.permissions = vec![]; // declares a hook but not hooks:session
        m.contributes.hooks = vec!["session.start".into()];
        let p = validate_manifest(&m, "com.acme.logger", "0.14.0");
        assert!(p.iter().any(|s| s.contains("session.start")));
    }

    #[test]
    fn rejects_incompatible_app_version() {
        let p = validate_manifest(&good(), "com.acme.logger", "0.13.0");
        assert!(p.iter().any(|s| s.contains("minAppVersion") || s.contains("0.14.0")));
    }

    #[test]
    fn version_satisfies_basic() {
        assert!(version_satisfies("0.14.0", "0.14.0"));
        assert!(version_satisfies("0.15.2", "0.14.0"));
        assert!(!version_satisfies("0.13.9", "0.14.0"));
        assert!(version_satisfies("dev", "0.14.0")); // non-semver dev build passes
    }
}
```

Also declare the module so it compiles: add `mod plugins;` to `src-tauri/src/lib.rs` (see Task 3 for the exact spot; for now put it alphabetically after `mod pty;`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml plugins::`
Expected: compiles, tests FAIL / panic on `todo!()`.

- [ ] **Step 3: Implement the pure functions**

Replace the four `todo!()` bodies:

```rust
pub fn parse_manifest(json: &str) -> Result<PluginManifest, String> {
    serde_json::from_str::<PluginManifest>(json).map_err(|e| format!("invalid manifest.json: {e}"))
}

pub fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let ok = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-';
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    edge(bytes[0]) && edge(bytes[bytes.len() - 1]) && bytes.iter().all(|&c| ok(c))
}

/// Parse "a.b.c" into (u64,u64,u64); trailing junk / missing parts default to 0.
fn semver_triple(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .ok()
    });
    let a = it.next()??;
    let b = it.next().flatten().unwrap_or(0);
    let c = it.next().flatten().unwrap_or(0);
    Some((a, b, c))
}

pub fn version_satisfies(have: &str, need: &str) -> bool {
    match (semver_triple(have), semver_triple(need)) {
        (Some(h), Some(n)) => h >= n,
        (None, _) => true, // non-semver dev build: treat as satisfied
        (_, None) => true, // caller separately flags a bad need
    }
}

pub fn validate_manifest(m: &PluginManifest, folder_name: &str, app_version: &str) -> Vec<String> {
    let mut problems = Vec::new();
    if !is_valid_id(&m.id) {
        problems.push(format!("invalid plugin id '{}': must be lowercase [a-z0-9.-]", m.id));
    }
    if m.id != folder_name {
        problems.push(format!("plugin id '{}' must equal its folder name '{}'", m.id, folder_name));
    }
    if semver_triple(&m.version).is_none() {
        problems.push(format!("invalid version '{}'", m.version));
    }
    if semver_triple(&m.min_app_version).is_none() {
        problems.push(format!("invalid minAppVersion '{}'", m.min_app_version));
    } else if !version_satisfies(app_version, &m.min_app_version) {
        problems.push(format!(
            "requires Conduit >= {} (this is {})",
            m.min_app_version, app_version
        ));
    }
    if m.main.contains("..") || m.main.starts_with('/') {
        problems.push(format!("main '{}' must stay inside the plugin folder", m.main));
    }
    for perm in &m.permissions {
        if !KNOWN_PERMISSIONS.contains(&perm.as_str()) {
            problems.push(format!("unknown permission '{}'", perm));
        }
    }
    // Every declared hook needs the matching hooks:<group> permission.
    for hook in &m.contributes.hooks {
        let group = hook.split('.').next().unwrap_or("");
        let need = format!("hooks:{group}");
        if !m.permissions.iter().any(|p| p == &need) {
            problems.push(format!("hook '{}' requires permission '{}'", hook, need));
        }
    }
    problems
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml plugins::`
Expected: all `plugins::tests::*` PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugins.rs src-tauri/src/lib.rs
git commit -m "feat(plugins): plugin manifest model + validation (Rust)"
```

---

## Task 2: Rust — PluginRecord persistence in the store

**Files:**
- Modify: `src-tauri/src/plugins.rs` (add `PluginRecord`)
- Modify: `src-tauri/src/store.rs:341-362` (PersistState), `364-376` (Store), `451-500` (new), `502-566`/`725-728` (save/persist)
- Test: inline `#[cfg(test)]` in `src-tauri/src/store.rs`

- [ ] **Step 1: Add the `PluginRecord` type**

In `src-tauri/src/plugins.rs`, above the `#[cfg(test)]` module:

```rust
/// Persisted per-plugin state. No secrets here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub granted_permissions: Vec<String>,
    /// The manifest version the user last consented to (for escalation detection).
    #[serde(default)]
    pub consented_version: String,
}
```

- [ ] **Step 2: Write the failing store test**

Add to the existing `#[cfg(test)]` module in `src-tauri/src/store.rs` (or create one if none):

```rust
#[test]
fn plugin_record_round_trips_in_persist_state() {
    let mut st = PersistState::default();
    st.plugins.push(crate::plugins::PluginRecord {
        id: "com.acme.logger".into(),
        enabled: true,
        granted_permissions: vec!["hooks:session".into()],
        consented_version: "1.0.0".into(),
    });
    let json = serde_json::to_string(&st).unwrap();
    let back: PersistState = serde_json::from_str(&json).unwrap();
    assert_eq!(back.plugins, st.plugins);
}

#[test]
fn legacy_state_without_plugins_defaults_empty() {
    let back: PersistState = serde_json::from_str(r#"{"projects":[]}"#).unwrap();
    assert!(back.plugins.is_empty());
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml store::`
Expected: FAIL to compile — `PersistState` has no `plugins` field.

- [ ] **Step 4: Add the field + Store plumbing**

In `store.rs`, add to `PersistState` (after `opencode`, line ~361):
```rust
    #[serde(default)]
    pub plugins: Vec<crate::plugins::PluginRecord>,
```
Add to `Store` (after `opencode`, line ~370):
```rust
    plugins: Mutex<Vec<crate::plugins::PluginRecord>>,
```
In `Store::new()` construction (line ~490), add:
```rust
            plugins: Mutex::new(state.plugins),
```
In `fn save(&self, ...)` (line ~504), add `plugins:` to the `PersistState { ... }` it builds:
```rust
        plugins: self.plugins.lock().unwrap_or_else(|e| e.into_inner()).clone(),
```
Add these methods in `impl Store` (near the other setters, before line 725):
```rust
    pub fn list_plugins(&self) -> Vec<crate::plugins::PluginRecord> {
        self.plugins.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Upsert a record by id, then persist.
    pub fn put_plugin_record(&self, rec: crate::plugins::PluginRecord) {
        {
            let mut v = self.plugins.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(existing) = v.iter_mut().find(|r| r.id == rec.id) {
                *existing = rec;
            } else {
                v.push(rec);
            }
        }
        self.persist();
    }

    pub fn remove_plugin_record(&self, id: &str) {
        {
            let mut v = self.plugins.lock().unwrap_or_else(|e| e.into_inner());
            v.retain(|r| r.id != id);
        }
        self.persist();
    }
```

- [ ] **Step 5: Run to verify pass, then commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml store:: plugins::`
Expected: PASS.
```bash
git add src-tauri/src/plugins.rs src-tauri/src/store.rs
git commit -m "feat(plugins): persist PluginRecord in the store"
```

---

## Task 3: Rust — plugin filesystem commands + lib.rs wiring

**Files:**
- Modify: `src-tauri/src/plugins.rs` (add `PluginDescriptor` + six `#[tauri::command]`s)
- Modify: `src-tauri/src/lib.rs:7-34` (mod decl — already added in Task 1) and `1288-1370` (handler)
- Test: inline test for the pure `descriptor_status` helper

- [ ] **Step 1: Add descriptor type + status helper with a test**

In `plugins.rs`:
```rust
use std::path::{Path, PathBuf};

/// What the frontend sees for one discovered plugin folder.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub id: String,
    pub path: String,
    /// Present when the manifest parsed. `None` when parse failed (see `error`).
    pub manifest: Option<PluginManifest>,
    /// Validation problems (empty when valid). Non-empty ⇒ cannot enable.
    pub problems: Vec<String>,
    pub record: Option<PluginRecord>,
}

/// The plugins directory: `<data_dir>/plugins`. Created if missing.
pub fn plugins_dir() -> PathBuf {
    let dir = crate::store::data_dir().join("plugins");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
```
Add a test:
```rust
#[test]
fn descriptor_problems_block_enable_semantics() {
    // A descriptor with problems must not be enableable — encoded as: problems non-empty.
    let m = parse_manifest(
        r#"{"id":"x","name":"x","version":"1.0.0","minAppVersion":"9.9.9"}"#,
    )
    .unwrap();
    let problems = validate_manifest(&m, "x", "0.14.0");
    assert!(!problems.is_empty()); // future-version requirement blocks it
}
```

- [ ] **Step 2: Run to verify (test passes trivially; commands not yet callable)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml plugins::`
Expected: PASS (this test exercises existing functions).

- [ ] **Step 3: Implement the six commands**

Append to `plugins.rs`. `app_version` comes from `env!("CARGO_PKG_VERSION")`.

```rust
use std::sync::Arc;
use tauri::State;

fn read_descriptor(dir: &Path, records: &[PluginRecord]) -> Option<PluginDescriptor> {
    let folder = dir.file_name()?.to_string_lossy().to_string();
    let manifest_path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let path = dir.to_string_lossy().to_string();
    match parse_manifest(&raw) {
        Ok(m) => {
            let problems = validate_manifest(&m, &folder, env!("CARGO_PKG_VERSION"));
            let record = records.iter().find(|r| r.id == m.id).cloned();
            Some(PluginDescriptor { id: m.id.clone(), path, manifest: Some(m), problems, record })
        }
        Err(e) => Some(PluginDescriptor {
            id: folder,
            path,
            manifest: None,
            problems: vec![e],
            record: None,
        }),
    }
}

#[tauri::command]
pub fn list_plugins(store: State<'_, Arc<crate::store::Store>>) -> Vec<PluginDescriptor> {
    let records = store.list_plugins();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(plugins_dir()) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(d) = read_descriptor(&p, &records) {
                    out.push(d);
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Return the plugin's `main.js` source, guarding against path escape.
#[tauri::command]
pub fn read_plugin_source(id: String) -> Result<String, String> {
    if !is_valid_id(&id) {
        return Err("invalid plugin id".into());
    }
    let dir = plugins_dir().join(&id);
    let manifest_raw = std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| e.to_string())?;
    let m = parse_manifest(&manifest_raw)?;
    if m.main.contains("..") || m.main.starts_with('/') {
        return Err("main path escapes plugin folder".into());
    }
    std::fs::read_to_string(dir.join(&m.main)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_plugin_enabled(
    id: String,
    enabled: bool,
    store: State<'_, Arc<crate::store::Store>>,
) -> Result<(), String> {
    let mut rec = store
        .list_plugins()
        .into_iter()
        .find(|r| r.id == id)
        .unwrap_or(PluginRecord { id: id.clone(), ..Default::default() });
    rec.enabled = enabled;
    store.put_plugin_record(rec);
    Ok(())
}

#[tauri::command]
pub fn set_plugin_grants(
    id: String,
    permissions: Vec<String>,
    consented_version: String,
    store: State<'_, Arc<crate::store::Store>>,
) -> Result<(), String> {
    let mut rec = store
        .list_plugins()
        .into_iter()
        .find(|r| r.id == id)
        .unwrap_or(PluginRecord { id: id.clone(), ..Default::default() });
    rec.granted_permissions = permissions;
    rec.consented_version = consented_version;
    store.put_plugin_record(rec);
    Ok(())
}

#[tauri::command]
pub fn remove_plugin(
    id: String,
    store: State<'_, Arc<crate::store::Store>>,
) -> Result<(), String> {
    if !is_valid_id(&id) {
        return Err("invalid plugin id".into());
    }
    let dir = plugins_dir().join(&id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    store.remove_plugin_record(&id);
    Ok(())
}

#[tauri::command]
pub fn open_plugins_dir() -> Result<String, String> {
    Ok(plugins_dir().to_string_lossy().into_owned())
}
```

- [ ] **Step 4: Register the commands in `lib.rs`**

Confirm `mod plugins;` sits in the mod block (`lib.rs:7-34`, added in Task 1). Add these lines inside `tauri::generate_handler![ ... ]` (before the closing `]` at line ~1369):
```rust
            plugins::list_plugins,
            plugins::read_plugin_source,
            plugins::set_plugin_enabled,
            plugins::set_plugin_grants,
            plugins::remove_plugin,
            plugins::open_plugins_dir,
```

- [ ] **Step 5: Build, then commit**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds clean (warnings ok).
```bash
git add src-tauri/src/plugins.rs src-tauri/src/lib.rs
git commit -m "feat(plugins): filesystem discovery + lifecycle commands"
```

---

## Task 4: Frontend — permission taxonomy

**Files:**
- Create: `src/plugins/types.ts`, `src/plugins/permissions.ts`
- Test: `src/plugins/permissions.test.ts`

- [ ] **Step 1: Write the types**

`src/plugins/types.ts`:
```ts
export type PluginPermission =
  | "commands"
  | "hooks:session"
  | "hooks:fleet"
  | "hooks:lifecycle"
  | "notifications"
  | "clipboard:write"
  | "net";

export interface CommandContribution { id: string; title: string; hotkey?: string; }
export interface Contributes { commands?: CommandContribution[]; hooks?: string[]; }

export interface PluginManifest {
  id: string; name: string; version: string;
  author?: string; description?: string;
  minAppVersion: string; main?: string;
  permissions?: PluginPermission[];
  contributes?: Contributes;
}

export interface PluginRecord {
  id: string; enabled: boolean;
  grantedPermissions: PluginPermission[];
  consentedVersion: string;
}

export interface PluginDescriptor {
  id: string; path: string;
  manifest: PluginManifest | null;
  problems: string[];
  record: PluginRecord | null;
}

export type PluginRuntimeStatus =
  | "disabled" | "running" | "errored" | "incompatible" | "needs-consent";
```

- [ ] **Step 2: Write the failing test**

`src/plugins/permissions.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { permissionForMethod, permissionForEvent, describe as describePerm } from "./permissions";

describe("permissions", () => {
  it("maps host methods to their required permission", () => {
    expect(permissionForMethod("notify")).toBe("notifications");
    expect(permissionForMethod("clipboard.write")).toBe("clipboard:write");
    expect(permissionForMethod("unknown.method")).toBeNull();
  });

  it("maps events to their required permission", () => {
    expect(permissionForEvent("session.start")).toBe("hooks:session");
    expect(permissionForEvent("fleet.spawn")).toBe("hooks:fleet");
    expect(permissionForEvent("lifecycle.stop")).toBe("hooks:lifecycle");
    expect(permissionForEvent("nope.nope")).toBeNull();
  });

  it("describes a permission with label + risk line", () => {
    const d = describePerm("notifications");
    expect(d.label.length).toBeGreaterThan(0);
    expect(d.riskLine.length).toBeGreaterThan(0);
  });
});
```

Run: `pnpm test src/plugins/permissions.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement `permissions.ts`**

```ts
import type { PluginPermission } from "./types";

interface PermissionInfo {
  label: string;
  riskLine: string;
  /** host.request methods this permission unlocks */
  methods: string[];
  /** plugin-facing event ids this permission delivers */
  events: string[];
}

export const PERMISSIONS: Record<PluginPermission, PermissionInfo> = {
  commands: {
    label: "Add commands to the palette and bind hotkeys",
    riskLine: "Can add commands and intercept keyboard shortcuts you press.",
    methods: ["commands.register", "commands.unregister"],
    events: [],
  },
  "hooks:session": {
    label: "See when sessions start, stop, or are renamed",
    riskLine: "Can observe which sessions you open and close, and their titles.",
    methods: [],
    events: ["session.start", "session.stop", "session.rename"],
  },
  "hooks:fleet": {
    label: "See fleet / Conductor spawn and stop events",
    riskLine: "Can observe orchestration activity across your projects.",
    methods: [],
    events: ["fleet.spawn", "fleet.stop"],
  },
  "hooks:lifecycle": {
    label: "See agent activity signals",
    riskLine: "Can observe agent run/stop/notification signals (no transcript contents).",
    methods: [],
    events: ["lifecycle.run", "lifecycle.stop", "lifecycle.notify"],
  },
  notifications: {
    label: "Show desktop notifications",
    riskLine: "Can pop system notifications (possible nuisance or spoofing).",
    methods: ["notify"],
    events: [],
  },
  "clipboard:write": {
    label: "Write to the clipboard",
    riskLine: "Can replace your clipboard contents.",
    methods: ["clipboard.write"],
    events: [],
  },
  net: {
    label: "Make network requests to declared hosts",
    riskLine: "Can send data to the internet — only to hosts listed in the manifest.",
    methods: ["net.fetch"],
    events: [],
  },
};

const METHOD_TO_PERM = new Map<string, PluginPermission>();
const EVENT_TO_PERM = new Map<string, PluginPermission>();
for (const [perm, info] of Object.entries(PERMISSIONS) as [PluginPermission, PermissionInfo][]) {
  for (const m of info.methods) METHOD_TO_PERM.set(m, perm);
  for (const e of info.events) EVENT_TO_PERM.set(e, perm);
}

export function permissionForMethod(method: string): PluginPermission | null {
  return METHOD_TO_PERM.get(method) ?? null;
}
export function permissionForEvent(event: string): PluginPermission | null {
  return EVENT_TO_PERM.get(event) ?? null;
}
export function describe(perm: PluginPermission): PermissionInfo {
  return PERMISSIONS[perm];
}
export const ALL_EVENTS = [...EVENT_TO_PERM.keys()];
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/plugins/permissions.test.ts` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/types.ts src/plugins/permissions.ts src/plugins/permissions.test.ts
git commit -m "feat(plugins): frontend permission taxonomy"
```

---

## Task 5: Frontend — the permission gate

**Files:**
- Create: `src/plugins/gate.ts`
- Test: `src/plugins/gate.test.ts`

- [ ] **Step 1: Write the failing test**

`src/plugins/gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { checkGrant, checkEventGrant } from "./gate";

describe("permission gate", () => {
  it("allows a method only when its permission is granted", () => {
    expect(checkGrant(["notifications"], "notify")).toBe(true);
    expect(checkGrant([], "notify")).toBe(false);
    expect(checkGrant(["hooks:session"], "notify")).toBe(false);
  });

  it("rejects unknown methods regardless of grants", () => {
    expect(checkGrant(["notifications", "net"], "delete.everything")).toBe(false);
  });

  it("filters event delivery by grant", () => {
    expect(checkEventGrant(["hooks:session"], "session.stop")).toBe(true);
    expect(checkEventGrant(["hooks:fleet"], "session.stop")).toBe(false);
  });
});
```

Run: `pnpm test src/plugins/gate.test.ts` → Expected: FAIL.

- [ ] **Step 2: Implement `gate.ts`**

```ts
import type { PluginPermission } from "./types";
import { permissionForMethod, permissionForEvent } from "./permissions";

/** True iff `method` is known AND its required permission is in `grants`. Deny-by-default. */
export function checkGrant(grants: PluginPermission[], method: string): boolean {
  const need = permissionForMethod(method);
  return need !== null && grants.includes(need);
}

/** True iff `event` is known AND its required permission is in `grants`. */
export function checkEventGrant(grants: PluginPermission[], event: string): boolean {
  const need = permissionForEvent(event);
  return need !== null && grants.includes(need);
}
```

- [ ] **Step 3: Run to verify pass, then commit**

Run: `pnpm test src/plugins/gate.test.ts` → Expected: PASS.
```bash
git add src/plugins/gate.ts src/plugins/gate.test.ts
git commit -m "feat(plugins): permission-gate pure functions"
```

---

## Task 6: Frontend — event sources + sanitizers

**Files:**
- Create: `src/plugins/events.ts`
- Test: `src/plugins/events.test.ts`

- [ ] **Step 1: Write the failing test**

`src/plugins/events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sanitizeHookPayload, sanitizeSession } from "./events";

describe("event sanitizers", () => {
  it("strips hook body to a safe lifecycle event (no transcript/body)", () => {
    const out = sanitizeHookPayload({ session: "s1", event: "stop", body: { prompt: "secret text" } });
    expect(out).toEqual({ event: "lifecycle.stop", session: "s1" });
    expect(JSON.stringify(out)).not.toContain("secret text");
  });

  it("maps unknown hook verbs to lifecycle.notify", () => {
    expect(sanitizeHookPayload({ session: "s1", event: "weird", body: {} }).event).toBe("lifecycle.notify");
  });

  it("reduces a session to id + title only", () => {
    const out = sanitizeSession({ id: "s1", title: "My work", secretField: "x" } as any);
    expect(out).toEqual({ id: "s1", title: "My work" });
  });
});
```

Run: `pnpm test src/plugins/events.test.ts` → Expected: FAIL.

- [ ] **Step 2: Implement `events.ts`**

```ts
/** A plugin-facing event: an id from permissions.ts + a sanitized payload. */
export interface PluginEvent {
  event: string;
  [k: string]: unknown;
}

/** Frontend "hook" relay payload shape (mirrors App.tsx HookPayload). */
export interface HookPayload { session: string; event: string; body: unknown; }

const HOOK_VERB_TO_EVENT: Record<string, string> = {
  run: "lifecycle.run",
  stop: "lifecycle.stop",
  notify: "lifecycle.notify",
};

/** Map a raw hook relay to a sanitized lifecycle event. Never forwards `body`. */
export function sanitizeHookPayload(p: HookPayload): { event: string; session: string } {
  const event = HOOK_VERB_TO_EVENT[p.event] ?? "lifecycle.notify";
  return { event, session: p.session };
}

/** Reduce any session-like object to the safe fields plugins may see. */
export function sanitizeSession(s: { id: string; title?: string }): { id: string; title: string } {
  return { id: s.id, title: s.title ?? "" };
}
```

- [ ] **Step 3: Run to verify pass, then commit**

Run: `pnpm test src/plugins/events.test.ts` → Expected: PASS.
```bash
git add src/plugins/events.ts src/plugins/events.test.ts
git commit -m "feat(plugins): plugin event sanitizers"
```

---

## Task 7: Frontend — sandbox host + worker runtime + SDK types

**Files:**
- Create: `src/plugins/sandbox.ts`, `src/plugins/worker-runtime.ts`, `src/plugins/sdk.d.ts`

*(No unit test — this is Worker/DOM glue, exercised end-to-end in Task 13.)*

- [ ] **Step 1: Define the SandboxHost interface + WorkerSandbox**

`src/plugins/sandbox.ts`:
```ts
import { WORKER_BOOTSTRAP } from "./worker-runtime";

/** Messages the host receives from a worker. */
export type FromWorker =
  | { type: "request"; rid: number; method: string; params: unknown }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "pong" };

/** Messages the host sends to a worker. */
export type ToWorker =
  | { type: "load"; source: string }
  | { type: "event"; event: string; payload: unknown }
  | { type: "response"; rid: number; ok: boolean; value?: unknown; error?: string }
  | { type: "unload" }
  | { type: "ping" };

/** A swappable sandbox runtime. WorkerSandbox is the only impl in increment #1;
 *  a QuickJS impl could satisfy the same interface later. */
export interface SandboxHost {
  start(source: string, onMessage: (m: FromWorker) => void): void;
  send(m: ToWorker): void;
  terminate(): void;
}

export class WorkerSandbox implements SandboxHost {
  private worker: Worker | null = null;
  private url: string | null = null;

  start(source: string, onMessage: (m: FromWorker) => void): void {
    const blob = new Blob([WORKER_BOOTSTRAP], { type: "text/javascript" });
    this.url = URL.createObjectURL(blob);
    this.worker = new Worker(this.url, { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
    this.worker.onerror = (e) => onMessage({ type: "error", message: e.message });
    this.send({ type: "load", source });
  }

  send(m: ToWorker): void {
    this.worker?.postMessage(m);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
  }
}
```

- [ ] **Step 2: Write the worker bootstrap**

`src/plugins/worker-runtime.ts` (a string — it runs inside the Worker, so it must be self-contained and reference no host imports):
```ts
/** Injected into every plugin Worker. Builds the `conduit` SDK, loads the plugin's
 *  main.js from a blob module, and routes messages. Untrusted plugin code runs here
 *  with no DOM, no window IPC — only postMessage to the host. */
export const WORKER_BOOTSTRAP = /* js */ `
let plugin = null;
let ridSeq = 1;
const pending = new Map();          // rid -> {resolve,reject}
const eventHandlers = new Map();    // event -> Set<fn>
const commandHandlers = new Map();  // commandId -> fn

function request(method, params) {
  const rid = ridSeq++;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    self.postMessage({ type: "request", rid, method, params });
  });
}

const conduit = {
  hooks: {
    on(event, fn) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
      eventHandlers.get(event).add(fn);
    },
  },
  commands: {
    register(id, fn) { commandHandlers.set(id, fn); return request("commands.register", { id }); },
    unregister(id) { commandHandlers.delete(id); return request("commands.unregister", { id }); },
  },
  notify(title, body) { return request("notify", { title, body }); },
  clipboard: { write(text) { return request("clipboard.write", { text }); } },
  net: { fetch(url, init) { return request("net.fetch", { url, init }); } },
};

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      const blob = new Blob([m.source], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const mod = await import(url);
      URL.revokeObjectURL(url);
      const Ctor = mod.default;
      plugin = typeof Ctor === "function" ? new Ctor() : Ctor;
      if (plugin && typeof plugin.onload === "function") await plugin.onload(conduit);
      self.postMessage({ type: "ready" });
    } else if (m.type === "event") {
      const hs = eventHandlers.get(m.event);
      if (hs) for (const fn of hs) { try { await fn(m.payload); } catch (err) { self.postMessage({ type: "error", message: String(err) }); } }
    } else if (m.type === "response") {
      const p = pending.get(m.rid);
      if (p) { pending.delete(m.rid); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); }
    } else if (m.type === "unload") {
      if (plugin && typeof plugin.onunload === "function") await plugin.onunload();
    } else if (m.type === "ping") {
      self.postMessage({ type: "pong" });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.stack || err) });
  }
};
`;
```

*(Command routing to `commandHandlers` is used by Plan 2; it's harmless here.)*

- [ ] **Step 3: Publish the author-facing SDK types**

`src/plugins/sdk.d.ts`:
```ts
export interface ConduitPluginApi {
  hooks: { on(event: string, fn: (payload: unknown) => void | Promise<void>): void };
  commands: {
    register(id: string, fn: () => void | Promise<void>): Promise<void>;
    unregister(id: string): Promise<void>;
  };
  notify(title: string, body?: string): Promise<void>;
  clipboard: { write(text: string): Promise<void> };
  net: { fetch(url: string, init?: RequestInit): Promise<{ status: number; body: string }> };
}

export interface ConduitPlugin {
  onload(conduit: ConduitPluginApi): void | Promise<void>;
  onunload?(): void | Promise<void>;
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm exec tsc --noEmit`
Expected: no errors from `src/plugins/*`.
```bash
git add src/plugins/sandbox.ts src/plugins/worker-runtime.ts src/plugins/sdk.d.ts
git commit -m "feat(plugins): worker sandbox runtime + SDK types"
```

---

## Task 8: Frontend — PluginHost (dispatcher + lifecycle)

**Files:**
- Create: `src/plugins/host.ts`

- [ ] **Step 1: Implement the host**

`src/plugins/host.ts`. The dispatcher is the security chokepoint: it validates every request through `checkGrant` before touching `invoke`. It forwards `notify` to the existing `notify_user` command (see `App.tsx:692`).

```ts
import { invoke } from "@tauri-apps/api/core";
import { WorkerSandbox, type SandboxHost, type FromWorker } from "./sandbox";
import { checkGrant, checkEventGrant } from "./gate";
import type { PluginDescriptor, PluginPermission } from "./types";

interface Loaded {
  id: string;
  grants: PluginPermission[];
  sandbox: SandboxHost;
  hookEvents: Set<string>; // plugin-facing events it subscribed via manifest
}

class PluginHostImpl {
  private loaded = new Map<string, Loaded>();

  /** Start an enabled, consented plugin: spawn its worker, wire the dispatcher. */
  async start(desc: PluginDescriptor): Promise<void> {
    if (!desc.manifest || desc.problems.length || !desc.record?.enabled) return;
    if (this.loaded.has(desc.id)) return;
    const grants = (desc.record.grantedPermissions ?? []) as PluginPermission[];
    const source = await invoke<string>("read_plugin_source", { id: desc.id });
    const sandbox = new WorkerSandbox();
    const hookEvents = new Set(desc.manifest.contributes?.hooks ?? []);
    const entry: Loaded = { id: desc.id, grants, sandbox, hookEvents };
    this.loaded.set(desc.id, entry);
    sandbox.start(source, (m) => this.onMessage(entry, m));
  }

  stop(id: string): void {
    const e = this.loaded.get(id);
    if (!e) return;
    e.sandbox.send({ type: "unload" });
    e.sandbox.terminate();
    this.loaded.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.loaded.keys()]) this.stop(id);
  }

  /** Fan a sanitized event to every plugin that (a) granted its permission and
   *  (b) declared the plugin-facing event in its manifest. */
  emit(pluginEvent: string, payload: unknown): void {
    for (const e of this.loaded.values()) {
      // Deliver only if the plugin declared the event AND was granted its permission.
      if (!e.hookEvents.has(pluginEvent)) continue;
      if (!checkEventGrant(e.grants, pluginEvent)) continue;
      e.sandbox.send({ type: "event", event: pluginEvent, payload });
    }
  }

  private async onMessage(e: Loaded, m: FromWorker): Promise<void> {
    if (m.type === "request") {
      const ok = checkGrant(e.grants, m.method);
      if (!ok) {
        e.sandbox.send({ type: "response", rid: m.rid, ok: false, error: `permission denied: ${m.method}` });
        return;
      }
      try {
        const value = await this.forward(m.method, m.params);
        e.sandbox.send({ type: "response", rid: m.rid, ok: true, value });
      } catch (err) {
        e.sandbox.send({ type: "response", rid: m.rid, ok: false, error: String(err) });
      }
    } else if (m.type === "error") {
      console.error(`[plugin ${e.id}]`, m.message);
    }
  }

  /** Map a granted host method to a real app action. Only methods reachable in Plan 1. */
  private async forward(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "notify":
        await invoke("notify_user", { title: params?.title ?? "", body: params?.body ?? "" });
        return null;
      case "commands.register":
      case "commands.unregister":
        return null; // registry wired in Plan 2
      default:
        throw new Error(`method not available: ${method}`);
    }
  }
}

export const pluginHost = new PluginHostImpl();
```

> **Verify the `notify_user` signature** in `src-tauri/src/lib.rs` (the command called at `App.tsx:692`). If its params differ from `{ title, body }`, match them here.

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm exec tsc --noEmit`
Expected: clean.
```bash
git add src/plugins/host.ts
git commit -m "feat(plugins): PluginHost dispatcher + lifecycle"
```

---

## Task 9: Frontend — Zustand plugins slice

**Files:**
- Modify: `src/store.ts` (AppState interface ~631; store body ~908)

- [ ] **Step 1: Add state + actions to the `AppState` interface**

In the `AppState` interface (near the MCP slice, `store.ts:748-758`), add:
```ts
  // Plugins
  plugins: PluginDescriptor[];
  refreshPlugins: () => Promise<void>;
  enablePlugin: (id: string, grants: PluginPermission[], version: string) => Promise<void>;
  disablePlugin: (id: string) => Promise<void>;
  removePlugin: (id: string) => Promise<void>;
  setAllPluginsEnabled: (enabled: boolean) => Promise<void>;
```
Add the import at the top of `store.ts`:
```ts
import type { PluginDescriptor, PluginPermission } from "./plugins/types";
import { pluginHost } from "./plugins/host";
```

- [ ] **Step 2: Implement the actions in the store body**

Inside `create<AppState>((set, get) => { ... return { ... `, add to the returned object:
```ts
    plugins: [],
    refreshPlugins: async () => {
      const plugins = await invoke<PluginDescriptor[]>("list_plugins");
      set({ plugins });
    },
    enablePlugin: async (id, grants, version) => {
      await invoke("set_plugin_grants", { id, permissions: grants, consentedVersion: version });
      await invoke("set_plugin_enabled", { id, enabled: true });
      await get().refreshPlugins();
      const desc = get().plugins.find((p) => p.id === id);
      if (desc) await pluginHost.start(desc);
    },
    disablePlugin: async (id) => {
      pluginHost.stop(id);
      await invoke("set_plugin_enabled", { id, enabled: false });
      await get().refreshPlugins();
    },
    removePlugin: async (id) => {
      pluginHost.stop(id);
      await invoke("remove_plugin", { id });
      await get().refreshPlugins();
    },
    setAllPluginsEnabled: async (enabled) => {
      if (!enabled) pluginHost.stopAll();
      for (const p of get().plugins) {
        if (p.manifest && p.problems.length === 0) {
          await invoke("set_plugin_enabled", { id: p.id, enabled });
        }
      }
      await get().refreshPlugins();
    },
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm exec tsc --noEmit`
Expected: clean.
```bash
git add src/store.ts
git commit -m "feat(plugins): zustand plugins slice + actions"
```

---

## Task 10: Frontend — consent dialog

**Files:**
- Create: `src/components/PluginConsentDialog.tsx`

- [ ] **Step 1: Implement the dialog**

Shows plugin identity, version, and one row per requested permission (label + risk). "Added" permissions (escalation) are highlighted. Grant is all-or-nothing.

```tsx
import type { PluginManifest, PluginPermission } from "../plugins/types";
import { describe } from "../plugins/permissions";

export function PluginConsentDialog({
  manifest, previouslyGranted, onGrant, onCancel,
}: {
  manifest: PluginManifest;
  previouslyGranted: PluginPermission[];
  onGrant: () => void;
  onCancel: () => void;
}) {
  const requested = (manifest.permissions ?? []) as PluginPermission[];
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal plugin-consent" onClick={(e) => e.stopPropagation()}>
        <h2>Enable “{manifest.name}”?</h2>
        <p className="settings-intro">
          {manifest.author ? `By ${manifest.author}. ` : ""}Version {manifest.version}. This plugin
          is asking for the following access:
        </p>
        <ul className="perm-list">
          {requested.map((p) => {
            const info = describe(p);
            const isNew = !previouslyGranted.includes(p);
            return (
              <li key={p} className={isNew ? "perm-row new" : "perm-row"}>
                <div className="perm-label">{info.label}{isNew && previouslyGranted.length ? " (new)" : ""}</div>
                <div className="perm-risk">{info.riskLine}</div>
              </li>
            );
          })}
          {requested.length === 0 && <li className="perm-row">No special access requested.</li>}
        </ul>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onGrant}>Grant &amp; enable</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm exec tsc --noEmit`
Expected: clean.
```bash
git add src/components/PluginConsentDialog.tsx
git commit -m "feat(plugins): install consent dialog"
```

---

## Task 11: Frontend — Plugins settings panel + Settings wiring

**Files:**
- Create: `src/components/PluginsPanel.tsx`
- Modify: `src/components/Settings.tsx:13-22` (union), `25-50` (NAV), `104-154` (render)

- [ ] **Step 1: Implement the panel**

```tsx
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { PluginConsentDialog } from "./PluginConsentDialog";
import type { PluginDescriptor, PluginManifest, PluginPermission } from "../plugins/types";

function statusOf(d: PluginDescriptor): string {
  if (!d.manifest) return "error";
  if (d.problems.length) return "incompatible";
  return d.record?.enabled ? "enabled" : "disabled";
}

/** Enabling requires consent when granted set doesn't already cover the requested perms. */
function needsConsent(d: PluginDescriptor): boolean {
  const req = (d.manifest?.permissions ?? []) as PluginPermission[];
  const granted = d.record?.grantedPermissions ?? [];
  return req.some((p) => !granted.includes(p)) || d.record?.consentedVersion !== d.manifest?.version;
}

export function PluginsPanel() {
  const plugins = useStore((s) => s.plugins);
  const refresh = useStore((s) => s.refreshPlugins);
  const enablePlugin = useStore((s) => s.enablePlugin);
  const disablePlugin = useStore((s) => s.disablePlugin);
  const removePlugin = useStore((s) => s.removePlugin);
  const setAll = useStore((s) => s.setAllPluginsEnabled);
  const [consent, setConsent] = useState<PluginManifest | null>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  const onToggle = (d: PluginDescriptor) => {
    if (d.record?.enabled) { void disablePlugin(d.id); return; }
    if (needsConsent(d)) { setConsent(d.manifest); return; }
    void enablePlugin(d.id, (d.manifest?.permissions ?? []) as PluginPermission[], d.manifest!.version);
  };

  const grant = () => {
    if (!consent) return;
    void enablePlugin(consent.id, (consent.permissions ?? []) as PluginPermission[], consent.version);
    setConsent(null);
  };

  return (
    <div className="plugins-panel">
      <p className="settings-intro">
        Plugins extend Conduit. They run sandboxed and only get the access you grant.
        Drop a plugin folder into the plugins directory, then enable it here.
      </p>
      <div className="plugins-actions">
        <button onClick={() => void invoke("open_plugins_dir").then((p) => console.log("plugins dir:", p))}>
          Open plugins folder
        </button>
        <button onClick={() => void refresh()}>Rescan</button>
        <button className="danger" onClick={() => void setAll(false)}>Disable all</button>
      </div>
      <ul className="plugins-list">
        {plugins.map((d) => (
          <li key={d.id} className="plugin-row">
            <div className="plugin-meta">
              <div className="plugin-name">{d.manifest?.name ?? d.id}</div>
              <div className="plugin-sub">
                {d.manifest ? `v${d.manifest.version} — ${statusOf(d)}` : d.problems[0]}
              </div>
              {d.record?.enabled && (
                <div className="plugin-perms">
                  {(d.record.grantedPermissions ?? []).join(", ") || "no permissions"}
                </div>
              )}
            </div>
            <div className="plugin-controls">
              {d.manifest && d.problems.length === 0 && (
                <button onClick={() => onToggle(d)}>{d.record?.enabled ? "Disable" : "Enable"}</button>
              )}
              <button className="danger" onClick={() => void removePlugin(d.id)}>Remove</button>
            </div>
          </li>
        ))}
        {plugins.length === 0 && <li className="plugin-row empty">No plugins installed.</li>}
      </ul>
      {consent && (
        <PluginConsentDialog
          manifest={consent}
          previouslyGranted={
            (plugins.find((p) => p.id === consent.id)?.record?.grantedPermissions ?? []) as PluginPermission[]
          }
          onGrant={grant}
          onCancel={() => setConsent(null)}
        />
      )}
    </div>
  );
}
```
Add the invoke import at the top: `import { invoke } from "@tauri-apps/api/core";`

- [ ] **Step 2: Wire it into Settings**

`Settings.tsx` union (line 13-22) — add `"plugins"`:
```ts
  | "privacy"
  | "plugins"
  | "about";
```
`NAV` array (line 25-50) — add a group before the About group:
```ts
  { group: "Extensions", items: [{ id: "plugins", label: "Plugins" }] },
```
Render block (line 104-153) — add a branch and the import:
```tsx
  {tab === "plugins" && (<><p className="settings-intro">Community extensions.</p><PluginsPanel /></>)}
```
Import at top: `import { PluginsPanel } from "./PluginsPanel";`

- [ ] **Step 3: Typecheck + build + commit**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: clean build.
```bash
git add src/components/PluginsPanel.tsx src/components/Settings.tsx
git commit -m "feat(plugins): Plugins settings panel + nav"
```

---

## Task 12: Frontend — boot wiring + event sources

**Files:**
- Create: `src/plugins/index.ts`
- Modify: `src/App.tsx` (mount effect + hook/fleet/session event feeds)

- [ ] **Step 1: Add the boot entry**

`src/plugins/index.ts`:
```ts
import { useStore } from "../store";
import { pluginHost } from "./host";
import { sanitizeHookPayload, sanitizeSession, type HookPayload } from "./events";

/** Discover + start enabled plugins. Call once on app mount. */
export async function initPlugins(): Promise<void> {
  await useStore.getState().refreshPlugins();
  for (const desc of useStore.getState().plugins) {
    if (desc.record?.enabled) await pluginHost.start(desc);
  }
}

/** Feed a relayed "hook" event into the plugin host as a lifecycle.* event. */
export function feedHook(p: HookPayload): void {
  const { event, session } = sanitizeHookPayload(p);
  pluginHost.emit(event, { session });
}

/** Feed a session lifecycle change. */
export function feedSession(event: "session.start" | "session.stop" | "session.rename", s: { id: string; title?: string }): void {
  pluginHost.emit(event, sanitizeSession(s));
}

/** Feed a fleet event. */
export function feedFleet(event: "fleet.spawn" | "fleet.stop", payload: { session?: string }): void {
  pluginHost.emit(event, { session: payload.session ?? "" });
}
```

- [ ] **Step 2: Call initPlugins on mount + feed the hook listener**

In `src/App.tsx`, add near the other startup effects:
```tsx
import { initPlugins, feedHook, feedFleet } from "./plugins";
// ...
useEffect(() => { void initPlugins(); }, []);
```
Inside the existing `listen<HookPayload>("hook", ({ payload }) => { ... })` handler (App.tsx:124-183), add one line at the top of the callback so plugins observe lifecycle:
```tsx
    feedHook(payload);
```
Inside the existing `"fleet-spawn"` listener (App.tsx:368), add:
```tsx
    feedFleet("fleet.spawn", { session: /* the spawned session id available there */ payload?.session });
```
> Session start/stop feeds: emit `feedSession(...)` from the store actions that add/remove a session (`addSession` success, and the session-close path). If wiring those is noisy, it can be deferred — `hooks:lifecycle` + `hooks:fleet` already prove event delivery for Task 13.

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm exec tsc --noEmit`
Expected: clean.
```bash
git add src/plugins/index.ts src/App.tsx
git commit -m "feat(plugins): boot plugins on mount + feed hook/fleet events"
```

---

## Task 13: Example plugin + end-to-end verification

**Files:**
- Create: `examples/plugins/session-logger/manifest.json`, `examples/plugins/session-logger/main.js`

- [ ] **Step 1: Write the example plugin**

`examples/plugins/session-logger/manifest.json`:
```json
{
  "id": "session-logger",
  "name": "Session Logger",
  "version": "1.0.0",
  "author": "Conduit",
  "description": "Notifies when agent lifecycle events fire. Demonstrates hooks + notify.",
  "minAppVersion": "0.14.0",
  "main": "main.js",
  "permissions": ["hooks:lifecycle", "notifications"],
  "contributes": { "hooks": ["lifecycle.stop"] }
}
```
`examples/plugins/session-logger/main.js`:
```js
export default class SessionLogger {
  async onload(conduit) {
    this.count = 0;
    conduit.hooks.on("lifecycle.stop", async (p) => {
      this.count++;
      await conduit.notify("Session Logger", `Agent stopped (session ${p.session}). Count: ${this.count}`);
    });
  }
  async onunload() { /* nothing to clean up */ }
}
```

- [ ] **Step 2: Install it into the dev data dir**

Run:
```bash
mkdir -p "$HOME/Library/Application Support/ConduitTauri-dev/plugins" && \
cp -R examples/plugins/session-logger "$HOME/Library/Application Support/ConduitTauri-dev/plugins/"
```

- [ ] **Step 3: Launch the dev app (isolated data dir)**

Run: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`
> Never run without the override — it would clobber the installed app's `state.json`.

- [ ] **Step 4: Manual verification checklist**

- [ ] Settings → **Plugins** lists “Session Logger” as *disabled*.
- [ ] Click **Enable** → consent dialog shows two rows: “See agent activity signals” and “Show desktop notifications”, each with a risk line.
- [ ] **Grant & enable** → row shows *enabled* with its granted permissions.
- [ ] Trigger an agent stop in any session → a desktop notification fires from the plugin.
- [ ] **Disable** → notifications stop (worker terminated).
- [ ] Edit the manifest to add `"clipboard:write"` to `permissions`, **Rescan**, **Enable** → consent re-prompts with the new permission highlighted (escalation).
- [ ] In devtools console, confirm a denied call is rejected: temporarily add `conduit.clipboard.write("x")` to `main.js` *without* the grant and confirm the worker logs `permission denied: clipboard.write`.
- [ ] **Disable all** kills every worker.

- [ ] **Step 5: Commit**

```bash
git add examples/plugins/session-logger
git commit -m "feat(plugins): session-logger example + e2e smoke test"
```

---

## Task 14: CSP lockdown (hardening)

**Files:**
- Modify: `src-tauri/tauri.conf.json:24-26` (`app.security.csp`)

> Rationale (spec §8.1): a Worker has ambient `fetch`. With `csp: null`, untrusted plugin
> code could phone home. Lock `connect-src` to the app's own surfaces so no plugin can reach
> the internet in Plan 1 (no plugin is granted `net` yet; gated `net.fetch` arrives later).

- [ ] **Step 1: Set a restrictive CSP**

Replace `"csp": null` with:
```json
    "security": {
      "csp": "default-src 'self'; img-src 'self' data: blob: asset: https://asset.localhost; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:8423 http://127.0.0.1:8455 http://127.0.0.1:8475 https://github.com https://status.claude.com https://api.anthropic.com"
    }
```
> `script-src 'unsafe-inline'` + `blob:` are required by Vite output + the Worker blob bootstrap; `worker-src blob:` allows the sandbox. The `connect-src` localhost entries cover the internal hook/bridge/MCP servers; the https entries cover status + updater + usage. **Adjust these against the running app** — see Step 3.

- [ ] **Step 2: Rebuild + launch**

Run: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`

- [ ] **Step 3: Verify nothing broke (open devtools console)**

- [ ] Terminals (xterm) render + accept input.
- [ ] Monaco editor opens a file.
- [ ] Claude status pill + usage load (no CSP `connect-src` violations in console).
- [ ] Updater check runs without a CSP error.
- [ ] The session-logger plugin still enables + notifies.
- [ ] **If any `Refused to connect/load … Content Security Policy` error appears**, add the exact blocked origin to the matching `*-src` directive and re-launch. Do not widen to `*`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(plugins): lock CSP so sandboxed plugins cannot exfiltrate"
```

---

## Final verification (run before declaring Plan 1 done)

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — all pass.
- [ ] `pnpm test` — all `src/plugins/*.test.ts` pass.
- [ ] `pnpm exec tsc --noEmit` — clean.
- [ ] `pnpm build` — clean.
- [ ] Task 13 checklist fully green in the dev app.
- [ ] Task 14 checklist green (no CSP regressions).

---

## Self-review notes (author)

- **Spec coverage:** package format (Tasks 1,3,13), manifest + validation (1), Worker sandbox + gated bridge (5,7,8), permissions + consent + escalation + revoke (4,10,11), hooks capability (6,8,12,13), persistence (2,9), CSP hardening (14), example plugin + tests (1–6 vitest, 13 manual). Commands capability intentionally deferred to Plan 2 (host `forward` + worker `commandHandlers` are stubbed in place).
- **Deferred within increment #1:** command registry/palette/hotkeys (Plan 2); gated `net.fetch` (needs the CSP-plus-allowlist design; no plugin is granted `net` here); session.start/stop feeds are optional in Task 12 (lifecycle + fleet already prove delivery).
- **Type consistency:** `PluginPermission`, `PluginDescriptor`, `PluginRecord` shared across `types.ts` → store → host → panel; Rust `PluginRecord`/`PluginManifest` serialize camelCase to match. Method names (`notify`, `commands.register`, `clipboard.write`, `net.fetch`) consistent across `permissions.ts`, `worker-runtime.ts`, `host.ts`.
