# Profile Windows (Obsidian-style Multi-Window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in setting under which picking a profile opens (or focuses) a separate window pinned to that profile, with each window mounting only its profile's sessions.

**Architecture:** Partitioned windows — a Rust `WindowRegistry` maps window label → profile; the PTY sink becomes detachable (`Option<Channel>`) so window close never zombifies a reader; events stay broadcast with frontend `inProfile` guards except `menu`/`cli-open` which get Rust `emit_to`; cross-window state converges via one coarse `store-saved` event + debounced slice refetch.

**Tech Stack:** Tauri v2 (WebviewWindowBuilder, emit_to, per-label window-state), Rust (DashMap, OnceLock), React 19 + Zustand, vitest + cargo test.

**Spec:** `docs/superpowers/specs/2026-09-23-profile-windows-design.md` — read it first; every task argues from it.

## Global Constraints

- Never add a `Co-Authored-By: Claude` (or any AI attribution) trailer to commits.
- Conventional Commits, scoped: `feat(profiles): …`, `fix(pty): …`.
- `cargo clippy -D warnings` must stay clean; fix lints, never weaken the gate.
- No `#[cfg]`-gating of new window code except the macOS-only `title_bar_style` builder call — both CI legs (macOS + Windows) must compile everything else.
- New UI selects use `src/components/Dropdown.tsx`, never native `<select>`.
- Keep-alive rule: nothing in this plan may unmount or respawn an agent terminal at runtime. The mount-set filter is computed ONCE per window boot (restart-gated pref), never varies live.
- `usageRows.ts`/`profiles.ts`/`startup.ts`-style pure modules must not import `store.ts` (node-env vitest).
- Dev app runs need `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev` (installed app is running).
- Gates before claiming done: `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`, `cargo fmt --check`, `cargo clippy`, `cargo test` (all `--manifest-path src-tauri/Cargo.toml`), plus `pnpm build:e2e && pnpm test:e2e`.
- The pref default is `"switch"`: with it, EVERY behavior in the app must be byte-identical to today. Window mode activates only when the pref reads `"window"` at boot.

## Review Focus

1. **Reader survival while a window is closed** — output keeps flowing to a dead channel; expected: reader flips to detached and keeps the ring buffer warm, never exits with the child alive. → test in Task 2.
2. **`open_profile_window` with a dangling/unknown profile id** — expected: refused (like `set_active_profile`), no window created. → test in Task 3.
3. **`remove_profile` while that profile's window is open** — expected: window closes (detach path) before projects fall back to Default. → registry lookup pinned in Task 1's tests; the destroy itself needs an AppHandle, covered by Task 13's manual smoke.
4. **`store-saved` refetch racing local optimistic writes** — expected: merge is idempotent, preserves layouts this window owns, never remounts a terminal (React keys stay session ids). → test in Task 9.
5. **Foreign-session events in the wrong window** (`fleet-spawn` for a project of another profile) — expected: appended to state everywhere (store must converge) but PTY spawned only in the owning window. → test in Task 10.

---

### Task 1: Rust `WindowRegistry` + pure label helpers

**Files:**
- Create: `src-tauri/src/window_registry.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod window_registry;`, `.manage()`)

**Interfaces:**
- Produces: `WindowRegistry::{register, remove, profile_of, label_for}`, `profile_window_label(profile: &Option<String>) -> String`. Managed as `Arc<WindowRegistry>`. Later tasks (3, 4, 6, 7) consume all four methods.

- [ ] **Step 1: Write failing tests** in the new module:

```rust
//! Which window shows which profile. One registry, managed state; the label is the
//! Tauri window label ("main", "profile-<id>", "profile-default"). `None` = Default.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct WindowRegistry {
    map: Mutex<HashMap<String, Option<String>>>,
}

/// Label a secondary window for `profile` gets. Pure; "main" is never produced here.
pub fn profile_window_label(profile: &Option<String>) -> String {
    match profile {
        Some(id) => format!("profile-{id}"),
        None => "profile-default".to_string(),
    }
}

impl WindowRegistry {
    pub fn register(&self, label: &str, profile: Option<String>) { /* insert */ }
    pub fn remove(&self, label: &str) { /* remove */ }
    /// Outer None = unknown label; inner None = Default profile.
    pub fn profile_of(&self, label: &str) -> Option<Option<String>> { /* get cloned */ }
    /// First label currently showing `profile` ("main" counts).
    pub fn label_for(&self, profile: &Option<String>) -> Option<String> { /* scan */ }
}
```

Tests (same file, `#[cfg(test)]`): register main as Default then `label_for(&None) == Some("main")`; register `profile-a` for `Some("a")` and look it up; `remove` makes `profile_of` return outer `None`; two windows on different profiles resolve independently; `profile_window_label(&None) == "profile-default"`.

- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml window_registry` — FAIL (unimplemented).
- [ ] **Step 3:** Implement the four methods (plain `Mutex<HashMap>` ops, `unwrap_or_else(|e| e.into_inner())` like `store.rs`).
- [ ] **Step 4:** Test passes. In `lib.rs`: `mod window_registry;` and `.manage(Arc::new(window_registry::WindowRegistry::default()))` beside the other manages; in `setup`, after `store` is cloned: `app.state::<Arc<window_registry::WindowRegistry>>().register("main", store.active_profile());`.
- [ ] **Step 5:** `cargo clippy`, `cargo fmt`, commit `feat(profiles): window registry mapping labels to profiles`.

---

### Task 2: Detachable PTY sink (fixes the orphan-sink zombie)

**Files:**
- Modify: `src-tauri/src/pty.rs` (`Sink` type at :30, spawn fast path :309-318, cold-restore send :555-558, reader loop :571-641, exit notice :624-626)

**Interfaces:**
- Produces: `PtyManager::detach(&self, session_id: &str)`; `Sink = Arc<Mutex<Option<Channel<String>>>>`. Task 4 consumes `detach`.

- [ ] **Step 1: Write failing test.** `Channel::new(|_| Ok(()))` constructs a channel in tests. Add to `pty.rs` tests:

```rust
#[test]
fn detached_sink_send_never_counts_a_failure() {
    // Pure helper the reader loop uses; None = detached, must not tick the fail counter.
    let sink: Sink = Arc::new(Mutex::new(None));
    assert_eq!(send_to_sink(&sink, "x".into()), SinkSend::Detached);
    let live: Sink = Arc::new(Mutex::new(Some(tauri::ipc::Channel::new(|_| Ok(())))));
    assert_eq!(send_to_sink(&live, "x".into()), SinkSend::Ok);
}

#[test]
fn detach_flips_sink_and_reattach_restores() {
    let sink: Sink = Arc::new(Mutex::new(Some(tauri::ipc::Channel::new(|_| Ok(())))));
    *sink.lock().unwrap() = None; // what detach() does
    assert_eq!(send_to_sink(&sink, "x".into()), SinkSend::Detached);
    *sink.lock().unwrap() = Some(tauri::ipc::Channel::new(|_| Ok(())));
    assert_eq!(send_to_sink(&sink, "x".into()), SinkSend::Ok);
}
```

- [ ] **Step 2:** Run — FAIL (`send_to_sink`/`SinkSend` undefined).
- [ ] **Step 3: Implement.**

```rust
type Sink = Arc<Mutex<Option<Channel<String>>>>;

#[derive(Debug, PartialEq, Eq)]
enum SinkSend { Ok, Failed, Detached }

/// One reader-loop send. Detached is NOT a failure — it's the window being closed.
fn send_to_sink(sink: &Sink, encoded: String) -> SinkSend {
    match sink.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(ch) => if ch.send(encoded).is_ok() { SinkSend::Ok } else { SinkSend::Failed },
            None => SinkSend::Detached,
        },
        Err(_) => SinkSend::Failed,
    }
}
```

Rewire every sink touchpoint:
- construction: `Arc::new(Mutex::new(Some(on_event)))`;
- fast re-attach path (:311-313): `*sink = Some(on_event);`
- cold-restore send (:557): `let _ = sink.lock().map(|s| { if let Some(ch) = s.as_ref() { let _ = ch.send(encoded); } });`
- reader loop success arm: replace the `ok`/`consecutive_fails` block with:

```rust
match send_to_sink(&sink, encoded) {
    SinkSend::Ok => consecutive_fails = 0,
    SinkSend::Detached => {} // window closed; ring buffer + scrollback keep running
    SinkSend::Failed => {
        consecutive_fails += 1;
        if consecutive_fails > 2000 {
            // The channel is dead but the child is alive: detach instead of the old
            // `break` that left a zombie entry whose next spawn re-attached to silence.
            if let Ok(mut s) = sink.lock() { *s = None; }
            consecutive_fails = 0;
        }
    }
}
```

- exit-notice send (:624-626): same `if let Some(ch)` shape.
- new method:

```rust
/// Detach a session's desktop consumer (its window closed). The PTY, tmux session and
/// reader thread all keep running; the next `pty_spawn` re-attaches warm.
pub fn detach(&self, session_id: &str) {
    if let Some(entry) = self.sessions.get(session_id) {
        if let Ok(s) = entry.lock() {
            if let Ok(mut sink) = s.sink.lock() { *sink = None; }
        }
    }
}
```

- [ ] **Step 4:** `cargo test` — new tests pass, existing pty/scrollback tests pass.
- [ ] **Step 5:** clippy/fmt, commit `fix(pty): detachable sink — window close no longer zombifies the reader`.

---

### Task 3: `window_profile` / `open_profile_window` / `close_window` commands + capabilities

**Files:**
- Modify: `src-tauri/src/lib.rs` (new commands, register in `invoke_handler`)
- Modify: `src-tauri/capabilities/default.json` (`"windows": ["main", "profile-*"]`)
- Test: `src-tauri/src/window_registry.rs` (capability pin), `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1's registry.
- Produces: commands `window_profile() -> WindowProfileInfo { label: String, profile_id: Option<String>, is_main: bool }` (serde camelCase), `open_profile_window(profile_id: Option<String>) -> Result<(), String>`, `close_window(label: String)`. Tasks 7–12 consume them from TS.

- [ ] **Step 1: Failing tests.** (a) In `window_registry.rs`, pin the capability file the way `cli_shim.rs` pins `release.yml`:

```rust
#[test]
fn capability_covers_profile_windows() {
    let raw = include_str!("../capabilities/default.json");
    assert!(raw.contains("\"profile-*\""), "secondary windows would have zero permissions");
    assert!(raw.contains("\"main\""));
}
```

(b) In `lib.rs` tests: `open_profile_window` refuses an unknown profile id — factor the validation pure: `fn resolve_open_target(profiles: &[store::Profile], id: &Option<String>) -> Result<Option<String>, String>` returning the normalized profile (Err for unknown Some(id)); test known/unknown/None.

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.** Edit `capabilities/default.json` windows array. Commands:

```rust
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WindowProfileInfo { label: String, profile_id: Option<String>, is_main: bool }

#[tauri::command]
fn window_profile(window: tauri::Window, reg: State<Arc<window_registry::WindowRegistry>>) -> WindowProfileInfo {
    let label = window.label().to_string();
    let profile_id = reg.profile_of(&label).flatten();
    WindowProfileInfo { is_main: label == "main", label, profile_id }
}

#[tauri::command]
fn open_profile_window(
    app: tauri::AppHandle,
    profile_id: Option<String>,
    reg: State<Arc<window_registry::WindowRegistry>>,
    store: State<Arc<Store>>,
) -> Result<(), String> {
    let target = resolve_open_target(&store.list_profiles(), &profile_id)?;
    if let Some(label) = reg.label_for(&target) {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus();
            return Ok(());
        }
        reg.remove(&label); // stale entry: window died without Destroyed cleanup
    }
    let label = window_registry::profile_window_label(&target);
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::default())
        .title("Conduit")
        .inner_size(1100.0, 720.0)
        .min_inner_size(980.0, 600.0)
        .theme(Some(tauri::Theme::Dark))
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    // Register BEFORE build: the new webview's first `window_profile` call must find it.
    reg.register(&label, target.clone());
    builder.build().map_err(|e| { reg.remove(&label); format!("open window: {e}") })?;
    Ok(())
}

#[tauri::command]
fn close_window(app: tauri::AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) { let _ = w.destroy(); }
}
```

Register all three in `invoke_handler`.

- [ ] **Step 4:** `cargo test` + clippy on BOTH the default target and confirm no non-macOS cfg besides `title_bar_style`.
- [ ] **Step 5:** Commit `feat(profiles): open/focus profile windows with registry-backed labels`.

---

### Task 4: Per-window close semantics + per-label DirtyGuard + detach on Destroyed

**Files:**
- Modify: `src-tauri/src/lib.rs` (`DirtyGuard` :91-96, `set_dirty_count` :1811, `on_window_event` :2114-2128)
- Modify: `src-tauri/src/menu.rs` (quit arm :249-262 reads the summed count)
- Modify: `src-tauri/src/store.rs` (new `sessions_for_profile`)

**Interfaces:**
- Consumes: `PtyManager::detach` (Task 2), registry (Task 1).
- Produces: `DirtyGuard(pub DashMap<String, usize>)` with `total() -> usize` and `for_label(&str) -> usize`; `Store::sessions_for_profile(profile: &Option<String>) -> Vec<String>`; frontend event `"menu"` payload `"close-window"` targeted at one label. Task 11 consumes the payload.

- [ ] **Step 1: Failing tests.** (a) `DirtyGuard` sums across labels and reads one label (plain unit test). (b) `Store::sessions_for_profile`: build a store with two projects (one `profile_id: Some("a")`, one `None`), sessions in each; `sessions_for_profile(&Some("a".into()))` returns only that project's session ids; a DANGLING profile id normalizes to Default (returned for `&None`). Follow the existing store test setup pattern (`Store` has in-memory constructors used by current tests — reuse them).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.**

```rust
#[derive(Default)]
pub(crate) struct DirtyGuard(pub dashmap::DashMap<String, usize>);
impl DirtyGuard {
    pub fn total(&self) -> usize { self.0.iter().map(|e| *e.value()).sum() }
    pub fn for_label(&self, label: &str) -> usize { self.0.get(label).map(|e| *e.value()).unwrap_or(0) }
}

#[tauri::command]
fn set_dirty_count(window: tauri::Window, count: usize, dirty: State<DirtyGuard>) {
    dirty.0.insert(window.label().to_string(), count);
}
```

`menu.rs` quit arm and the last-window quit path read `.total()`. `store.rs`:

```rust
/// Session ids of every project belonging to `profile` (dangling ids = Default).
pub fn sessions_for_profile(&self, profile: &Option<String>) -> Vec<String> {
    let known: std::collections::HashSet<String> =
        self.list_profiles().into_iter().map(|p| p.id).collect();
    let normalize = |id: &Option<String>| id.clone().filter(|i| known.contains(i));
    self.projects.lock().unwrap_or_else(|e| e.into_inner()).iter()
        .filter(|p| normalize(&p.profile_id) == normalize(profile))
        .flat_map(|p| p.sessions.iter().map(|s| s.id.clone()))
        .collect()
}
```

`on_window_event` rework:

```rust
.on_window_event(|window, event| {
    let app = window.app_handle();
    let label = window.label().to_string();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if app.webview_windows().len() > 1 {
                // Not the last window: closing detaches, never quits. Only this
                // window's OWN dirty buffers gate it; running agents keep running.
                if app.state::<DirtyGuard>().for_label(&label) > 0 {
                    api.prevent_close();
                    let _ = app.emit_to(&label, "menu", "close-window");
                }
            } else {
                // Last window = the app quit path, exactly as before (summed dirty).
                let dirty = app.state::<DirtyGuard>().total();
                let running = live_running_agent(app);
                if dirty > 0 || running {
                    api.prevent_close();
                    let _ = app.emit_to(&label, "menu", "quit");
                }
            }
        }
        tauri::WindowEvent::Destroyed => {
            let reg = app.state::<Arc<window_registry::WindowRegistry>>();
            if let Some(profile) = reg.profile_of(&label) {
                let store = app.state::<Arc<Store>>();
                let pty = app.state::<Arc<PtyManager>>();
                for sid in store.sessions_for_profile(&profile) { pty.detach(&sid); }
            }
            reg.remove(&label);
            app.state::<DirtyGuard>().0.remove(&label);
        }
        _ => {}
    }
})
```

- [ ] **Step 4:** `cargo test` all green; grep confirms no remaining `.0.load(` on DirtyGuard.
- [ ] **Step 5:** Commit `feat(profiles): per-window close semantics — detach on destroy, per-label dirty counts`.

---

### Task 5: `store-saved` broadcast from `Store::save`

**Files:**
- Modify: `src-tauri/src/store.rs` (field + `set_on_save` + call at end of `save()` :668)
- Modify: `src-tauri/src/lib.rs` (`setup` wires the emit)

**Interfaces:**
- Produces: event `"store-saved"` (payload: `u64` generation) broadcast after every persisted mutation. Task 9 consumes it.

- [ ] **Step 1: Failing test** in `store.rs`:

```rust
#[test]
fn save_fires_on_save_hook() {
    let store = Store::for_test(&temp_dir("on_save")); // existing test-only constructor at store.rs:1905
    // NOTE: the new `on_save` field must be initialized (`OnceLock::new()`) in BOTH
    // `Store::new()` and `Store::for_test`.
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let h = hits.clone();
    store.set_on_save(Box::new(move || { h.fetch_add(1, Ordering::SeqCst); }));
    store.add_profile("x");
    assert!(hits.load(Ordering::SeqCst) >= 1);
}
```

- [ ] **Step 2:** FAIL. **Step 3:** Field `on_save: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>` on `Store` (skip in any Default/new derive by initializing empty), `pub fn set_on_save(&self, f: Box<dyn Fn() + Send + Sync>) { let _ = self.on_save.set(f); }`, and at the END of `save()` (after the atomic rename): `if let Some(f) = self.on_save.get() { f(); }`. In `lib.rs` setup:

```rust
let gen = Arc::new(std::sync::atomic::AtomicU64::new(0));
let handle = app.handle().clone();
store.set_on_save(Box::new(move || {
    let _ = handle.emit("store-saved", gen.fetch_add(1, Ordering::SeqCst));
}));
```

- [ ] **Step 4:** Tests pass. **Step 5:** Commit `feat(store): store-saved event after every persisted write`.

---

### Task 6: Explicit profile stamping + guarded profile commands

**Files:**
- Modify: `src-tauri/src/store.rs` (`add_project` :766, `add_root_chat` :812)
- Modify: `src-tauri/src/lib.rs` (the `add_project`/`add_root_chat`/`set_active_profile`/`remove_profile` commands)
- Modify: `src/store.ts` + any TS `invoke("add_project"` / `invoke("add_root_chat"` callers pass `profileId`

**Interfaces:**
- Consumes: registry (Task 1), `close_window` (Task 3).
- Produces: `Store::add_project(path: String, profile_id: Option<String>)`, `Store::add_root_chat(profile_id: Option<String>)` (both stamp the ARGUMENT, not the global); command `set_active_profile` takes `window: tauri::Window` and returns `false` for non-main labels; command `remove_profile` closes the profile's window first. TS callers pass `s.windowProfile.profileId` (Task 8 adds that field — until then pass `s.activeProfileId`, which is identical in switch mode).

- [ ] **Step 1: Failing tests** (store.rs): `add_project("/tmp/x", Some("p1"))` stamps `profile_id: Some("p1")` even when the store's `active_profile_id` global says otherwise; `add_root_chat(None)` stamps `None` likewise.
- [ ] **Step 2:** FAIL. **Step 3:** Replace the `self.active_profile_id.lock()…` reads at :781 and :827 with the parameter. Thread the parameter through the two Tauri commands (grep `store.add_project(` / `store.add_root_chat(` for OTHER Rust callers — any found pass `store.active_profile()` to preserve behavior). `set_active_profile` command: `if window.label() != "main" { return false; }` before delegating. `remove_profile` command, before the store mutation:

```rust
if let Some(label) = reg.label_for(&Some(id.clone())) {
    if label != "main" { if let Some(w) = app.get_webview_window(&label) { let _ = w.destroy(); } }
}
```

TS: `addProject` in `store.ts` and every other `invoke("add_project")`/`invoke("add_root_chat")` call site (grep) gains `profileId: get().activeProfileId` for now.
- [ ] **Step 4:** `cargo test` + `pnpm exec tsc --noEmit` green. **Step 5:** Commit `feat(profiles): explicit profile stamping; main-only active-profile writes`.

---

### Task 7: Rust-side event targeting — `menu` and `cli-open`

**Files:**
- Modify: `src-tauri/src/menu.rs` (:242-267)
- Modify: `src-tauri/src/hooks.rs` (:103-118)
- Modify: `src-tauri/src/store.rs` (new `project_profile_for_path`)
- Test: `src-tauri/src/store.rs`

**Interfaces:**
- Consumes: registry.
- Produces: `focused_label(app) -> Option<String>` helper in `lib.rs` (pub(crate)); `Store::project_profile_for_path(path: &str) -> Option<Option<String>>` (Some(profile) when a project contains `path`, matching `src/cliOpen.ts`'s `matchProjectByPath` rule — read that file and copy its exact containment semantics AND its test vectors from `src/cliOpen.test.ts`).

- [ ] **Step 1: Failing tests:** port 4+ vectors from `cliOpen.test.ts` into a `project_profile_for_path` test (exact path match, subdirectory match, non-member path → None, trailing-slash handling — whatever the TS tests pin).
- [ ] **Step 2:** FAIL. **Step 3: Implement.**

```rust
// lib.rs
pub(crate) fn focused_label(app: &tauri::AppHandle) -> Option<String> {
    app.webview_windows().iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(l, _)| l.clone())
}
```

`menu.rs`: both `app.emit("menu", …)` sites become `emit_to(target, "menu", …)` with `let target = crate::focused_label(app).unwrap_or_else(|| "main".into());`. `hooks.rs` cli-open sink: resolve target = `store.project_profile_for_path(&open.path)` → `reg.label_for(&profile)`, else `focused_label`, else `"main"`; `get_webview_window(&target)` for the show/unminimize/focus nudge (falling back to ANY window if that label is gone), then `emit_to(&target, "cli-open", &open)`. This makes exactly one window run `add_project`. NOTE: the sink closure gains `store` + `reg` clones — `hooks::start` already receives `store`; add the registry arg.
- [ ] **Step 4:** `cargo test` green. **Step 5:** Commit `feat(profiles): route menu and cli-open events to one window`.

---

### Task 8: Frontend window identity, pref, and pure guards

**Files:**
- Modify: `src/profiles.ts` (+ `src/profiles.test.ts`)
- Modify: `src/store.ts` (pref + `windowProfile` + `load()` wiring)
- Modify: `src/components/GeneralSettings.tsx`

**Interfaces:**
- Consumes: `window_profile` command (Task 3).
- Produces: `WindowProfile { label, profileId, isMain }` type; `eventInWindow(itemProfileId, windowProfileId, knownIds)` in `profiles.ts`; store fields `windowProfile: WindowProfile` (default `{label:"main", profileId:null, isMain:true}`), `profileWindowMode: "switch"|"window"` (+ setter, localStorage key `conduit.profileWindowMode`), and boot-frozen `windowed: boolean` (mode === "window", read ONCE at module init — restart-gated). Tasks 9-12 consume all three.

- [ ] **Step 1: Failing vitest** (`profiles.test.ts`): `eventInWindow` — same-profile true, cross-profile false, dangling item id matches Default window, dangling WINDOW id matches Default items.

```ts
export function eventInWindow(
  itemProfileId: string | null | undefined,
  windowProfileId: string | null,
  knownIds: ReadonlySet<string>,
): boolean {
  return inProfile(itemProfileId, windowProfileId, knownIds);
}
```

(Yes, it's an alias today — it exists so call sites read as intent and so a future divergence has one home. The test pins the semantics, not the delegation.)
- [ ] **Step 2:** `pnpm test profiles` — FAIL. **Step 3:** Implement helper. Store: follow the `readAutoProjectColors`/`writeAutoProjectColors` pattern for the pref (`readProfileWindowMode(): "switch"|"window"`, unknown value → `"switch"`); module-level `export const WINDOWED = readProfileWindowMode() === "window"` in `store.ts` (boot-frozen); `load()` starts with `const wp = await invoke<WindowProfile>("window_profile").catch(() => ({label:"main", profileId:null, isMain:true}));` and includes it in the final `set`. For a SECONDARY window (`!wp.isMain`): `selectedProjectId` = first project of `wp.profileId` (ignore `readLastProject()`), and the `useStore.subscribe` at the bottom of `store.ts` that writes `conduit.lastProject` is gated on `get().windowProfile.isMain`. GeneralSettings row (toggle, matching the existing `dialog-toggle` blocks):

```tsx
<label className="dialog-toggle">
  <input type="checkbox" checked={profileWindowMode === "window"}
    onChange={(e) => setProfileWindowMode(e.target.checked ? "window" : "switch")} />
  <span>
    Open profiles in their own windows — picking a profile opens (or focuses) a separate
    window pinned to it, like Obsidian vaults, instead of re-filtering this one.
    Takes effect after restarting Conduit.
  </span>
</label>
```

- [ ] **Step 4:** `pnpm test` + `tsc --noEmit` green. **Step 5:** Commit `feat(profiles): window identity, profileWindowMode pref, eventInWindow guard`.

---

### Task 9: Cross-window state sync (`store-saved` → slice refetch)

**Files:**
- Create: `src/hooks/useStoreSync.ts`
- Create: `src/storeSync.ts` (+ `src/storeSync.test.ts`) — pure merge
- Modify: `src/App.tsx` (mount the hook), `src/store.ts` (a `mergeSyncedSlices` action)

**Interfaces:**
- Consumes: `store-saved` event (Task 5).
- Produces: `mergeSlices(current: {projects, layouts}, fetched: Project[]): {projects, layouts, addedProjectIds}` in `storeSync.ts` — pure, no store import.

- [ ] **Step 1: Failing vitest** for `mergeSlices`: (a) a fetched project absent locally is added and gets a layout entry (caller supplies `makeLayout(p)` callback so `storeSync.ts` stays free of `store.ts`); (b) an existing project keeps its LOCAL layout object identity; (c) Rust is authoritative — a project absent from `fetched` is dropped; (d) session arrays adopt fetched content but the returned `projects` array preserves reference equality for projects whose JSON is unchanged (compare via `JSON.stringify` per project — small N, runs at most every 300 ms).
- [ ] **Step 2:** FAIL. **Step 3:** Implement pure merge; then `useStoreSync.ts`:

```ts
// Debounced convergence: any window's persisted write refetches read slices here.
// The originator refetches its own write too — harmless, the merge is idempotent.
useEffect(() => {
  let timer: number | undefined;
  const un = listen("store-saved", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void useStore.getState().mergeSyncedSlices(), 300);
  });
  return () => { window.clearTimeout(timer); void un.then((f) => f()); };
}, []);
```

`mergeSyncedSlices` action: `Promise.all` of `load_projects` / `list_profiles` / `list_accounts` / `get_default_accounts` (each `.catch` → keep current), run `mergeSlices` with `validateLayout`-based `makeLayout`, `registry.acquire` file-tab refs for ADDED projects only (mirror `load()` :1786-1792), single `set`. Also refetch `list_root_chats` via the existing `loadRootChats()`.
- [ ] **Step 4:** vitest + tsc green. **Step 5:** Commit `feat(profiles): cross-window store convergence via store-saved refetch`.

---

### Task 10: Partitioned mounting + sidebar filter + foreign-tab placeholder

**Files:**
- Modify: `src/components/WorkspaceCenter.tsx` (`allSessions` :313-315, pane tab render)
- Modify: `src/components/Sidebar.tsx` (filter source), `src/App.tsx` (plugin init gate)
- Test: `src/layout.test.ts` or new `src/windowMount.test.ts` (pure helper)

**Interfaces:**
- Consumes: `WINDOWED`, `windowProfile`, `eventInWindow` (Task 8).
- Produces: `mountedInWindow(project: {profileId?}, windowed: boolean, windowProfileId: string|null, knownIds): boolean` — pure, in `src/profiles.ts`; placeholder CSS class `.foreign-session-tab`.

- [ ] **Step 1: Failing vitest:** `mountedInWindow` returns true for everything when `windowed` is false (switch mode mounts ALL projects — today's behavior); when true, only own-profile projects.
- [ ] **Step 2:** FAIL. **Step 3:** Implement helper. `WorkspaceCenter`:

```ts
const allSessions = projects
  .filter((p) => mountedInWindow(p, WINDOWED, windowProfile.profileId, knownProfileIds))
  .flatMap((p) => p.sessions.map((s) => ({ project: p, session: s })))
  .sort((a, b) => a.session.id.localeCompare(b.session.id));
```

The mount set is boot-stable (WINDOWED is frozen; a project's profile never changes at runtime — there is no move-between-profiles UI), so this filter can never unmount a live terminal. Borrowed tab whose session is NOT in `allSessions` (cross-profile borrow): the pane body renders a placeholder instead of an empty slot —

```tsx
<div className="foreign-session-tab">
  <span>This session lives in another profile's window.</span>
  <button onClick={() => void invoke("open_profile_window", { profileId: foreignProfileId })}>
    Open that window
  </button>
</div>
```

(`foreignProfileId` = the session's project's normalized profile id.) Sidebar: the project/HQ filter reads `WINDOWED ? windowProfile.profileId : activeProfileId`. `App.tsx`: `initPlugins()` and canvas-mode entry are gated on `windowProfile.isMain` (secondaries hide the canvas toggle).
- [ ] **Step 4:** vitest + tsc + `pnpm build` green. **Step 5:** Commit `feat(profiles): windows mount only their profile's sessions`.

---

### Task 11: Frontend event guards + close-window confirm + ProfileBar routing

**Files:**
- Modify: `src/App.tsx` (listeners :202-603; `menu` handler gains `"close-window"`)
- Modify: `src/components/Sidebar.tsx` (`ProfileBar` onChange :252-261)
- Modify: `src/components/NewProjectDialog.tsx` + the Rust clone command in `lib.rs` (:1704 emit) for `requestId`

**Interfaces:**
- Consumes: `eventInWindow`, `windowProfile`, `WINDOWED`, `open_profile_window`, `close_window` (Tasks 3, 8).
- Produces: every project/chat-tagged listener guarded; `clone-progress` payload gains `requestId: string` (dialog generates `crypto.randomUUID()`, passes it to the clone invoke, Rust echoes it).

- [ ] **Step 1:** No new pure logic here beyond what Task 8 tested — this task is wiring; its "test" is the gate suite plus grep assertions. Write a checklist in the commit body of every guarded listener: `fleet-spawn` (skip session append→spawn when project fails `eventInWindow` — the STORE converges via Task 9; only the mount/select is skipped), `bridge-open-session`, `conductor-confirm` (guard by session's project), `root-chat-item/done/error/created` + `pending-decision` (guard by chat/card profile), `hook` (feed UI state only for own-profile sessions; plugin feed already main-only from Task 10).
- [ ] **Step 2: Implement.** `menu` handler: payload `"close-window"` opens the existing dirty-buffer confirm scoped to this window's dirty files; on confirm `void invoke("close_window", { label: windowProfile.label })`. ProfileBar:

```ts
onChange={(v) => {
  const target = v || null;
  if (!WINDOWED) { void setActiveProfile(target); return; }
  if (target === windowProfile.profileId) return; // already this window
  void invoke("open_profile_window", { profileId: target });
}}
```

Clone progress: dialog holds `requestRef = crypto.randomUUID()`, sends it with the clone invoke, filters events by `payload.requestId === requestRef`; Rust threads the string through and includes it in the emitted payload struct.
- [ ] **Step 3:** `tsc --noEmit`, `pnpm test`, `cargo test` green.
- [ ] **Step 4:** Commit `feat(profiles): per-window event guards, close confirm, ProfileBar window routing`.

---

### Task 12: Hot-exit per-label union

**Files:**
- Modify: `src-tauri/src/hotexit.rs`, `src-tauri/src/lib.rs` (:1728-1734), `src/store.ts` (:3105 caller unchanged — Rust reads the label from `window`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `hotexit::save_for(label: &str, entries: &[HotExitEntry])` backed by an in-process `Mutex<HashMap<String, Vec<HotExitEntry>>>`; the on-disk format stays a flat `Vec<HotExitEntry>` (the union) — old files load unchanged.

- [ ] **Step 1: Failing test** (hotexit.rs): two labels save disjoint sets → the written file contains both; label A re-saving empty removes only A's entries; a file written by the OLD code (flat vec) still loads.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (module-level `static SETS: Mutex<HashMap<…>>` or a small managed struct — prefer a `HotExitState` managed in lib.rs to avoid a global; command `hotexit_save(window: tauri::Window, entries, state)` unions and writes). `hotexit_load` unchanged.
- [ ] **Step 4:** `cargo test` green. **Step 5:** Commit `fix(hotexit): per-window sets union on disk — no cross-window clobber`.

---

### Task 13: Full gate sweep + manual two-window smoke

**Files:** none (verification only) — fixes discovered here fold back into the owning task's files.

- [ ] **Step 1:** `pnpm exec tsc --noEmit && pnpm test && pnpm build`.
- [ ] **Step 2:** `cargo fmt --check && cargo clippy && cargo test` (`--manifest-path src-tauri/Cargo.toml`).
- [ ] **Step 3:** `pnpm build:e2e && pnpm test:e2e` — the existing 7 assertions must stay green (they exercise cli-open routing and `add_project`, both touched here).
- [ ] **Step 4: Manual smoke** (launch with `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`): create profile "B"; Settings → General → enable profile windows; restart dev app; pick B in ProfileBar → second window opens pinned to B; create a project + session in each window; confirm sessions run simultaneously; close B's window → B's session keeps running (`tmux ls`); reopen B → terminal reattaches warm (no duplicate replay); pick B again in main's ProfileBar → focuses the open window; quit → single confirm, both windows' dirty counts honored.
- [ ] **Step 5:** Commit any fixes under their owning scope (`fix(profiles): …`).

---

### Task 14: Version bump + changelog

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml` (line 3), `src-tauri/tauri.conf.json`, `CHANGELOG.md`, `src-tauri/Cargo.lock` (via cargo build)

- [ ] **Step 1:** Check current version at execution time (`sed -n '3p' src-tauri/Cargo.toml`) — the pending IDE-integration branch may have claimed 0.38.0. Bump MINOR to the next free `0.X.0` in all three files.
- [ ] **Step 2:** `cargo build --manifest-path src-tauri/Cargo.toml` so `Cargo.lock` follows; run the CLAUDE.md grep sanity check.
- [ ] **Step 3:** `CHANGELOG.md` top entry, same style as existing:

```markdown
## 0.X.0 — <date>

- **Added — Profiles can open in their own windows.** A new Settings → General option makes
  picking a profile open (or focus) a separate window pinned to it, Obsidian-style — run two
  profiles side by side. Each window shows and runs only its profile's projects; closing a
  window leaves its sessions running and they reattach warm when it reopens.
- **Fixed — closed-window terminals no longer go permanently silent.** A terminal whose
  window disappeared used to be unrecoverable after ~2000 dropped frames; it now detaches
  cleanly and reattaches on the next open.
```

- [ ] **Step 4:** Commit `chore(release): 0.X.0`.
