# Worktree Isolation Per Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, per-session git worktree isolation by delegating creation to Claude Code's native `claude --worktree`, while keeping Conduit's panels and live-status hooks working inside the worktree.

**Architecture:** A new session can opt into isolation at creation time. Conduit computes the deterministic name/path Claude uses (`<repo>/.claude/worktrees/<slug>`, branch `worktree-<slug>`), spawns `claude --worktree <slug> --settings <hooks-file>` from the repo root (Claude creates the worktree and runs in it; `--settings` carries Conduit's hooks since the worktree doesn't see the project's `settings.local.json`), and points the file tree / git panel at the worktree. On delete, Conduit prompts keep-or-remove and runs `git worktree remove` (the one git mutation it owns; creation stays Claude's).

**Tech Stack:** Rust (Tauri v2, `portable-pty`, `serde_json`), React 19 + TypeScript + Zustand, `git` CLI.

**Spec:** `docs/superpowers/specs/2026-06-24-worktree-isolation-design.md`

**Note on commits:** every commit message must end with the repo's required `Co-Authored-By` trailer. Commit steps below omit it for brevity — add it when committing.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src-tauri/src/worktree.rs` | Pure name/path helpers + the two git mutations Conduit owns (dirty-check, remove) | Create |
| `src-tauri/src/hooks.rs` | Single source of hook entries; settings-file writer for `--settings` | Modify |
| `src-tauri/src/pty.rs` | Build the `claude` invocation (adds `--worktree`/`--settings`) | Modify |
| `src-tauri/src/store.rs` | `add_session` computes worktree fields when opted in | Modify |
| `src-tauri/src/lib.rs` | `pty_spawn` worktree decision; `add_session` signature; new worktree commands | Modify |
| `src/store.ts` | `addSession` options; worktree command wrappers; `isGitRepo` | Modify |
| `src/components/NewSessionDialog.tsx` | The create dialog (name + isolate toggle) | Create |
| `src/components/Sidebar.tsx` | Open dialog on "New session"; branch chip; delete-with-worktree flow | Modify |
| `src/components/WorkspaceCenter.tsx` | Spawn worktree sessions in repo root + pass `worktreeName` | Modify |
| `src/components/Terminal.tsx` | Forward `worktreeName` to `pty_spawn` | Modify |
| `src/theme.css` | Dialog + branch-chip styles | Modify |

---

## Task 1: worktree.rs — pure name/path helpers

**Files:**
- Create: `src-tauri/src/worktree.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod worktree;`)
- Test: in `src-tauri/src/worktree.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Register the module so it compiles.** In `src-tauri/src/lib.rs`, add `mod worktree;` to the module list near the top (with `mod git;`, `mod hooks;`, etc.):

```rust
mod fsops;
mod git;
mod hooks;
mod notify;
mod pty;
mod store;
mod worktree;
```

- [ ] **Step 2: Write the failing tests.** Create `src-tauri/src/worktree.rs` with only the test module and stub signatures:

```rust
//! Worktree helpers for per-session isolation. Creation is delegated to Claude Code
//! (`claude --worktree`); this module computes the deterministic names/paths Claude
//! uses and owns the one mutation Conduit performs: removing a worktree on delete.

pub fn slug(_name: &str, _uid: &str) -> String {
    unimplemented!()
}

pub fn worktree_path(_project_path: &str, _slug: &str) -> String {
    unimplemented!()
}

pub fn branch_name(_slug: &str) -> String {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_sanitizes_and_appends_uid() {
        assert_eq!(slug("My Feature", "abcdef123456"), "my-feature-abcdef");
    }

    #[test]
    fn slug_collapses_punctuation_and_trims() {
        assert_eq!(slug("a/b  c!!", "uid123"), "a-b-c-uid123");
    }

    #[test]
    fn slug_falls_back_when_empty() {
        assert_eq!(slug("   ", "abcdef12"), "session-abcdef");
    }

    #[test]
    fn worktree_path_is_deterministic() {
        assert_eq!(
            worktree_path("/repo", "feature-x"),
            "/repo/.claude/worktrees/feature-x"
        );
    }

    #[test]
    fn branch_name_prefixes_worktree() {
        assert_eq!(branch_name("feature-x"), "worktree-feature-x");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib worktree::`
Expected: FAIL — panics with `not implemented` (the `unimplemented!()` stubs).

- [ ] **Step 4: Implement the helpers.** Replace the three stub functions:

```rust
use std::path::Path;

/// A filesystem/branch-safe slug: lowercase ASCII alnum with single hyphens, plus a
/// short uid suffix so two sessions with the same name don't collide. Matches the
/// `<slug>` Claude turns into `.claude/worktrees/<slug>` and branch `worktree-<slug>`.
pub fn slug(name: &str, uid: &str) -> String {
    let mut base = String::new();
    let mut prev_hyphen = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            base.push(c.to_ascii_lowercase());
            prev_hyphen = false;
        } else if !prev_hyphen {
            base.push('-');
            prev_hyphen = true;
        }
    }
    let trimmed = base.trim_matches('-');
    let base = if trimmed.is_empty() { "session" } else { trimmed };
    let short = &uid[..uid.len().min(6)];
    format!("{base}-{short}")
}

/// The directory Claude creates for `--worktree <slug>`: `<repo>/.claude/worktrees/<slug>`.
pub fn worktree_path(project_path: &str, slug: &str) -> String {
    Path::new(project_path)
        .join(".claude")
        .join("worktrees")
        .join(slug)
        .to_string_lossy()
        .into_owned()
}

/// The branch Claude creates for `--worktree <slug>`: `worktree-<slug>`.
pub fn branch_name(slug: &str) -> String {
    format!("worktree-{slug}")
}
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib worktree::`
Expected: PASS — 5 passed.

- [ ] **Step 6: Commit.**

```bash
git add src-tauri/src/worktree.rs src-tauri/src/lib.rs
git commit -m "feat(worktree): pure slug/path/branch helpers"
```

---

## Task 2: worktree.rs — dirty-check and remove (the owned git mutation)

**Files:**
- Modify: `src-tauri/src/worktree.rs`
- Test: `src-tauri/src/worktree.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing integration test.** Add to the `tests` module. It builds a real temporary git repo + worktree, then exercises `is_dirty` and `remove`:

```rust
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn git(args: &[&str], dir: &std::path::Path) {
        let ok = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git {:?} failed", args);
    }

    fn fresh_repo(tag: &str) -> std::path::PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("conduit_wt_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git(&["init", "-q"], &dir);
        git(&["config", "user.email", "t@t"], &dir);
        git(&["config", "user.name", "t"], &dir);
        fs::write(dir.join("README.md"), "hi").unwrap();
        git(&["add", "."], &dir);
        git(&["commit", "-q", "-m", "init"], &dir);
        dir
    }

    #[test]
    fn is_dirty_reflects_worktree_state() {
        let repo = fresh_repo("dirty");
        let wt = worktree_path(repo.to_str().unwrap(), "feat");
        git(&["worktree", "add", "-q", &wt, "-b", "worktree-feat"], &repo);

        assert!(!is_dirty(&wt), "fresh worktree should be clean");
        fs::write(std::path::Path::new(&wt).join("new.txt"), "x").unwrap();
        assert!(is_dirty(&wt), "untracked file should read as dirty");
    }

    #[test]
    fn remove_deletes_clean_worktree() {
        let repo = fresh_repo("remove");
        let wt = worktree_path(repo.to_str().unwrap(), "gone");
        git(&["worktree", "add", "-q", &wt, "-b", "worktree-gone"], &repo);
        assert!(std::path::Path::new(&wt).exists());

        remove(repo.to_str().unwrap(), &wt, false).expect("clean remove should succeed");
        assert!(!std::path::Path::new(&wt).exists(), "worktree dir should be gone");
    }

    #[test]
    fn remove_force_discards_dirty_worktree() {
        let repo = fresh_repo("force");
        let wt = worktree_path(repo.to_str().unwrap(), "dirty");
        git(&["worktree", "add", "-q", &wt, "-b", "worktree-dirty"], &repo);
        fs::write(std::path::Path::new(&wt).join("new.txt"), "x").unwrap();

        assert!(remove(repo.to_str().unwrap(), &wt, false).is_err(), "dirty remove without force should fail");
        remove(repo.to_str().unwrap(), &wt, true).expect("force remove should succeed");
        assert!(!std::path::Path::new(&wt).exists());
    }
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib worktree::`
Expected: FAIL — `is_dirty`/`remove` not found (or `unimplemented`).

- [ ] **Step 3: Implement `is_dirty` and `remove`.** Add to `worktree.rs` (add `use std::process::Command;` to the top imports):

```rust
/// True if the worktree has uncommitted changes or untracked files, so a plain
/// `git worktree remove` would refuse and removal needs `--force`.
pub fn is_dirty(worktree_path: &str) -> bool {
    Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Remove a worktree via `git worktree remove`, run from the main repo. `force`
/// discards a dirty tree. The branch (`worktree-<slug>`) is left intact so commits
/// survive — branch deletion is out of scope.
pub fn remove(repo_path: &str, worktree_path: &str, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(worktree_path);
    let out = Command::new("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("git worktree remove: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib worktree::`
Expected: PASS — 8 passed.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/worktree.rs
git commit -m "feat(worktree): dirty-check and git worktree remove"
```

---

## Task 3: hooks.rs — single source of hook entries + settings-file writer

**Files:**
- Modify: `src-tauri/src/hooks.rs`
- Test: `src-tauri/src/hooks.rs` (existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests** for the new helpers. Add to the existing `tests` module in `hooks.rs`:

```rust
    #[test]
    fn settings_value_carries_all_events() {
        let v = settings_value(8423);
        let hooks = v.get("hooks").and_then(|h| h.as_object()).expect("hooks object");
        for ev in [
            "PostToolUse", "UserPromptSubmit", "Stop", "Notification",
            "PreToolUse", "PreCompact", "SessionStart", "SessionEnd",
        ] {
            assert!(hooks.contains_key(ev), "settings missing event {ev}");
        }
    }

    #[test]
    fn settings_value_command_carries_routing() {
        let v = settings_value(8431);
        let cmd = v["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .expect("command string");
        assert!(cmd.contains("event=sessionstart"));
        assert!(cmd.contains("CONDUIT_SESSION_ID"));
        assert!(cmd.contains("8431"));
    }
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib hooks::`
Expected: FAIL — `settings_value` not found.

- [ ] **Step 3: Extract the shared entry list, refactor `install`, add `settings_value` + `write_settings_file`.** In `hooks.rs`, replace the eight explicit `hooks.insert(...)` calls inside `install` with a loop over a shared list, and add the new functions.

First, add this function (place it just above `install`):

```rust
/// Single source of truth for the (event, entries) Conduit installs. Used by both the
/// project-file installer and the `--settings` writer so worktree and normal sessions
/// get identical hook behavior.
fn conduit_hook_entries(port: u16) -> Vec<(&'static str, Vec<Value>)> {
    vec![
        (
            "PostToolUse",
            vec![
                json!({ "matcher": "TodoWrite", "hooks": [command("todos", port)] }),
                json!({ "hooks": [command("tooluse", port)] }),
            ],
        ),
        ("UserPromptSubmit", vec![json!({ "hooks": [command("prompt", port)] })]),
        ("Stop", vec![json!({ "hooks": [command("stop", port)] })]),
        ("Notification", vec![json!({ "hooks": [command("notification", port)] })]),
        ("PreToolUse", vec![json!({ "hooks": [command("pretool", port)] })]),
        ("PreCompact", vec![json!({ "hooks": [command("precompact", port)] })]),
        ("SessionStart", vec![json!({ "hooks": [command("sessionstart", port)] })]),
        ("SessionEnd", vec![json!({ "hooks": [command("sessionend", port)] })]),
    ]
}
```

Then, inside `install`, replace the block from the first `hooks.insert(` through the last `);` of the `Notification` insert (the eight inserts) with:

```rust
    for (event, entries) in conduit_hook_entries(port) {
        let merged = merged(hooks.get(event), entries);
        hooks.insert(event.to_string(), merged);
    }
```

Then add the two new public functions (place after `install`):

```rust
/// A settings object containing only Conduit's hooks, for `claude --settings <file>`.
fn settings_value(port: u16) -> Value {
    let mut hooks = serde_json::Map::new();
    for (event, entries) in conduit_hook_entries(port) {
        hooks.insert(event.to_string(), Value::Array(entries));
    }
    json!({ "hooks": Value::Object(hooks) })
}

/// Write Conduit's hooks to a settings file in the app data dir and return its path.
/// Worktree sessions pass this via `claude --settings`, since a worktree is a separate
/// working tree that doesn't see the project's settings.local.json.
pub fn write_settings_file(port: u16) -> Option<String> {
    let base = dirs::data_dir()?.join("ConduitTauri");
    let _ = fs::create_dir_all(&base);
    let path = base.join("conduit-hooks.json");
    let data = serde_json::to_vec_pretty(&settings_value(port)).ok()?;
    fs::write(&path, data).ok()?;
    Some(path.to_string_lossy().into_owned())
}
```

- [ ] **Step 4: Run all hooks tests** — new ones pass AND the existing regression tests stay green (the refactor must not change `install` behavior).

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib hooks::`
Expected: PASS — 9 existing + 2 new = 11 passed.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/hooks.rs
git commit -m "refactor(hooks): single entry list; add --settings writer"
```

---

## Task 4: pty.rs — build the claude invocation with --worktree/--settings

**Files:**
- Modify: `src-tauri/src/pty.rs`
- Test: `src-tauri/src/pty.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests** for a pure command builder. Add a test module at the bottom of `pty.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_runs_bare_claude_without_worktree() {
        let s = claude_script("s1", 8423, "/repo", "/bin/zsh", None, None);
        assert!(s.contains("export CONDUIT_SESSION_ID='s1'"));
        assert!(s.contains("&& claude;"), "got: {s}");
        assert!(!s.contains("--worktree"));
        assert!(!s.contains("--settings"));
    }

    #[test]
    fn script_adds_worktree_and_settings() {
        let s = claude_script("s1", 8423, "/repo", "/bin/zsh", Some("feat-x"), Some("/d/h.json"));
        assert!(s.contains("claude --worktree 'feat-x' --settings '/d/h.json';"), "got: {s}");
    }
}
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib pty::`
Expected: FAIL — `claude_script` not found.

- [ ] **Step 3: Add the builder** near `shell_quote` at the bottom of `pty.rs`:

```rust
/// Build the `sh -c` script that launches a `claude` session. `worktree` adds
/// `--worktree <slug>` (Claude creates `<repo>/.claude/worktrees/<slug>` and runs in it);
/// `settings` adds `--settings <path>` so Conduit's hooks load inside the worktree.
fn claude_script(
    session_id: &str,
    port: u16,
    working_directory: &str,
    shell: &str,
    worktree: Option<&str>,
    settings: Option<&str>,
) -> String {
    let mut claude = String::from("claude");
    if let Some(name) = worktree {
        claude.push_str(&format!(" --worktree {}", shell_quote(name)));
    }
    if let Some(path) = settings {
        claude.push_str(&format!(" --settings {}", shell_quote(path)));
    }
    format!(
        "export CONDUIT_SESSION_ID={sid} CONDUIT_HOOK_PORT={port} CLAUDE_CODE_ENABLE_TASKS=0; cd {dir} && {claude}; exec {shell} -i -l",
        sid = shell_quote(session_id),
        port = port,
        dir = shell_quote(working_directory),
        claude = claude,
        shell = shell,
    )
}
```

- [ ] **Step 4: Run to verify the builder passes.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib pty::`
Expected: PASS — 2 passed.

- [ ] **Step 5: Wire the builder into `spawn`.** Change the `spawn` signature to accept the new optional args and use `claude_script` for the non-shell branch.

Change the signature (add two params before `on_event`):

```rust
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        session_id: String,
        working_directory: String,
        cols: u16,
        rows: u16,
        hook_port: u16,
        shell_only: bool,
        worktree_name: Option<String>,
        settings_path: Option<String>,
        on_event: Channel<String>,
    ) -> Result<(), String> {
```

Replace the `let inner = if shell_only { ... } else { ... };` block with:

```rust
        let inner = if shell_only {
            format!(
                "cd {dir} && exec {shell} -i -l",
                dir = shell_quote(&working_directory),
                shell = shell,
            )
        } else {
            claude_script(
                &session_id,
                hook_port,
                &working_directory,
                &shell,
                worktree_name.as_deref(),
                settings_path.as_deref(),
            )
        };
```

(The `cmd.env("CONDUIT_SESSION_ID", ...)` block below it is unchanged.)

- [ ] **Step 6: Run the full pty + build check** (signature change must compile; `lib.rs` will be updated to match in Task 6).

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib pty::`
Expected: PASS for the `pty::tests`. The crate will not fully build until `lib.rs` passes the new args (Task 6) — that's expected; this step only runs the `pty::` unit tests, which compile the module in isolation enough to pass. If the whole-crate build is attempted and fails on the `pty.spawn(...)` call in `lib.rs`, proceed to Task 6 before the final build.

- [ ] **Step 7: Commit.**

```bash
git add src-tauri/src/pty.rs
git commit -m "feat(pty): claude_script builder with --worktree/--settings"
```

---

## Task 5: store.rs — compute worktree fields on opt-in

**Files:**
- Modify: `src-tauri/src/store.rs`
- Test: `src-tauri/src/store.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test.** Add a test module at the bottom of `store.rs` (uses a temp save path so it never touches real app state):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    impl Store {
        fn for_test(dir: &std::path::Path) -> Self {
            Store {
                projects: Mutex::new(Vec::new()),
                save_path: dir.join("state.json"),
            }
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conduit_store_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn add_session_without_worktree_leaves_fields_empty() {
        let dir = temp_dir("plain");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store.add_session(&p.id, "Session 1".into(), false).unwrap();
        assert!(!s.use_worktree);
        assert!(s.worktree_path.is_none());
        assert!(s.branch.is_none());
    }

    #[test]
    fn add_session_with_worktree_computes_path_and_branch() {
        let dir = temp_dir("wt");
        let store = Store::for_test(&dir);
        let p = store.add_project("/repo".into());
        let s = store.add_session(&p.id, "My Feature".into(), true).unwrap();
        assert!(s.use_worktree);
        let path = s.worktree_path.unwrap();
        assert!(path.starts_with("/repo/.claude/worktrees/"), "got {path}");
        assert!(s.branch.unwrap().starts_with("worktree-"));
    }
}
```

- [ ] **Step 2: Run to verify failure.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib store::`
Expected: FAIL — `add_session` takes 2 args, not 3 (type error / arity).

- [ ] **Step 3: Update `add_session`** in `store.rs` to take `use_worktree` and compute fields:

```rust
    pub fn add_session(&self, project_id: &str, name: String, use_worktree: bool) -> Option<Session> {
        let mut projects = self.projects.lock().unwrap_or_else(|e| e.into_inner());
        let project = projects.iter_mut().find(|p| p.id == project_id)?;
        let id = Uuid::new_v4().to_string();
        let (worktree_path, branch) = if use_worktree {
            let slug = crate::worktree::slug(&name, &id);
            (
                Some(crate::worktree::worktree_path(&project.path, &slug)),
                Some(crate::worktree::branch_name(&slug)),
            )
        } else {
            (None, None)
        };
        let session = Session {
            id,
            name,
            use_worktree,
            worktree_path,
            branch,
        };
        project.sessions.push(session.clone());
        self.save(&projects);
        Some(session)
    }
```

- [ ] **Step 4: Run to verify it passes.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib store::`
Expected: PASS — 2 passed.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/store.rs
git commit -m "feat(store): add_session computes worktree path/branch on opt-in"
```

---

## Task 6: lib.rs — wire pty_spawn, add_session signature, worktree commands

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the `Path` import.** Near the top of `lib.rs`, add to the `std` imports:

```rust
use std::path::Path;
```

- [ ] **Step 2: Update `pty_spawn`** to decide cwd / `--worktree` / `--settings`. Replace the whole `pty_spawn` command with:

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
    pty: State<PtyManager>,
    hook_state: State<Arc<HookState>>,
) -> Result<(), String> {
    let port = hook_state.port.load(Ordering::SeqCst);

    let (cwd, worktree_arg, settings_path) = if shell_only {
        (working_directory.clone(), None, None)
    } else if let Some(slug) = worktree_name.as_deref() {
        // Worktree session: hooks load via --settings (the worktree won't see the
        // project's settings.local.json). If Claude already created the worktree on a
        // previous run, re-enter it directly instead of recreating it.
        let settings = hooks::write_settings_file(port);
        let wt_path = worktree::worktree_path(&working_directory, slug);
        if Path::new(&wt_path).exists() {
            (wt_path, None, settings)
        } else {
            (working_directory.clone(), Some(slug.to_string()), settings)
        }
    } else {
        // Normal session: install hooks into the project's settings.local.json.
        hooks::install(&working_directory, port);
        (working_directory.clone(), None, None)
    };

    pty.spawn(
        session_id,
        cwd,
        cols,
        rows,
        port,
        shell_only,
        worktree_arg,
        settings_path,
        on_event,
    )
}
```

- [ ] **Step 3: Update the `add_session` command** to take `use_worktree`:

```rust
#[tauri::command]
fn add_session(
    project_id: String,
    name: String,
    use_worktree: bool,
    store: State<Store>,
) -> Option<Session> {
    store.add_session(&project_id, name, use_worktree)
}
```

- [ ] **Step 4: Add the two worktree commands** (place near the git commands):

```rust
// ---- Worktree lifecycle ------------------------------------------------------

#[tauri::command]
fn worktree_is_dirty(worktree_path: String) -> bool {
    worktree::is_dirty(&worktree_path)
}

#[tauri::command]
fn worktree_remove(repo_path: String, worktree_path: String, force: bool) -> Result<(), String> {
    worktree::remove(&repo_path, &worktree_path, force)
}
```

- [ ] **Step 5: Register the new commands** in `tauri::generate_handler![ ... ]` — add `worktree_is_dirty,` and `worktree_remove,` to the list (the `add_session` and `pty_spawn` entries already exist).

- [ ] **Step 6: Build the whole crate.**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: Finished with no errors.

- [ ] **Step 7: Run the full Rust test suite.**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — all `worktree::`, `hooks::`, `pty::`, `store::` tests green.

- [ ] **Step 8: Commit.**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lib): wire worktree spawn decision + worktree commands"
```

---

## Task 7: Approach A validation + fallback (decision record, no code)

Approach A's open risk — that hooks supplied via `--settings` actually fire inside a worktree session — is validated empirically during **Task 13's manual smoke** (the "hooks fire inside the worktree" check). That is the first point a worktree session can be created and spawned through the UI, so the validation lives there rather than in a premature standalone step. This task records the decision and the fallback.

- [ ] **If hooks DO fire in the worktree session (Task 13):** Approach A confirmed — add a one-line note to the spec's "Risks" section.
- [ ] **If hooks do NOT fire:** switch to Approach B (user-scope install). The UI tasks (8–12) are unaffected; only hook delivery changes:
  - In `hooks.rs`, add a function that installs `conduit_hook_entries(port)` into `~/.claude/settings.json` (reuse the read-merge-preserve-write shape of `install`, pointed at the user settings file). Call it once at startup, or in `pty_spawn` for worktree sessions, instead of relying on `--settings`.
  - Routing still works via the per-process `CONDUIT_SESSION_ID` env var; unrelated `claude` usage emits to session `unknown` (ignored by the frontend) and the curl fails fast when Conduit is not listening.
  - Re-run the worktree smoke to confirm, then note the switch in the spec's "Risks" section.

---

## Task 8: store.ts — addSession options + worktree command wrappers

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: Update the `addSession` action type** in the `AppState` interface:

```ts
  addSession: (projectId: string, opts?: { name?: string; useWorktree?: boolean }) => Promise<void>;
```

- [ ] **Step 2: Update the `addSession` implementation** to pass `use_worktree` and an optional name:

```ts
    addSession: async (projectId, opts) => {
      const project = get().projects.find((p) => p.id === projectId);
      const name = opts?.name?.trim() || `Session ${(project?.sessions.length ?? 0) + 1}`;
      const useWorktree = opts?.useWorktree ?? false;
      const session = await invoke<Session | null>("add_session", {
        projectId,
        name,
        useWorktree,
      });
      if (!session) return;
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId ? { ...p, sessions: [...p.sessions, session] } : p,
        ),
        selectedProjectId: projectId,
      }));
      applyLayout(projectId, (l) => rOpenTab(l, { kind: "session", ref: session.id }));
    },
```

- [ ] **Step 3: Add exported helpers** at the bottom of `store.ts` (next to `openInVscode`):

```ts
/** True if `dir` is inside a git work tree (used to gate the worktree toggle). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await invoke<string | null>("git_branch", { dir })) != null;
  } catch {
    return false;
  }
}

/** True if a worktree has uncommitted/untracked changes (so removal needs force). */
export async function worktreeIsDirty(worktreePath: string): Promise<boolean> {
  try {
    return await invoke<boolean>("worktree_is_dirty", { worktreePath });
  } catch {
    return false;
  }
}

/** Remove a session's worktree via git. `force` discards a dirty tree. */
export async function worktreeRemove(
  repoPath: string,
  worktreePath: string,
  force: boolean,
): Promise<void> {
  await invoke("worktree_remove", { repoPath, worktreePath, force });
}
```

- [ ] **Step 4: Typecheck.**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (Callers of `addSession(project.id)` still compile — `opts` is optional. The Sidebar call is updated in Task 10.)

- [ ] **Step 5: Commit.**

```bash
git add src/store.ts
git commit -m "feat(store.ts): addSession options + worktree/git helpers"
```

---

## Task 9: WorkspaceCenter + Terminal — spawn worktree sessions in the repo root

**Files:**
- Modify: `src/components/Terminal.tsx`
- Modify: `src/components/WorkspaceCenter.tsx`

- [ ] **Step 1: Add a `worktreeName` prop to `TerminalView`.** In `src/components/Terminal.tsx`, extend `Props`:

```ts
interface Props {
  sessionId: string;
  workingDirectory: string;
  visible: boolean;
  /** Slug to pass as `claude --worktree <slug>` for an isolated session. */
  worktreeName?: string;
  /** Plain login shell instead of launching `claude` (the bottom-panel terminal). */
  shellOnly?: boolean;
  style?: React.CSSProperties;
}
```

Destructure it in the component signature (add `worktreeName,` next to `workingDirectory,`).

- [ ] **Step 2: Forward it to `pty_spawn`.** In the `invoke("pty_spawn", {...})` call, add `worktreeName`:

```ts
        void invoke("pty_spawn", {
          sessionId,
          workingDirectory,
          cols,
          rows,
          shellOnly,
          worktreeName: worktreeName ?? null,
          onEvent: channel,
        }).catch((e) => term.write(`\r\n[spawn error: ${e}]\r\n`));
```

- [ ] **Step 3: Spawn worktree sessions in the repo root + pass the slug.** In `src/components/WorkspaceCenter.tsx`, update the `TerminalView` render in the `term-stack` (currently `workingDirectory={workingDirOf(project, session)}`):

```tsx
              <TerminalView
                key={session.id}
                sessionId={session.id}
                workingDirectory={session.useWorktree ? project.path : workingDirOf(project, session)}
                worktreeName={
                  session.useWorktree && session.worktreePath
                    ? baseName(session.worktreePath)
                    : undefined
                }
                visible={pl.visible}
                style={pl.style}
              />
```

(`baseName` is already imported in this file. Panels and the VS Code button keep using `workingDirOf`, which returns the worktree path — they correctly follow the worktree.)

- [ ] **Step 4: Typecheck + build.**

Run: `pnpm build`
Expected: `tsc` clean, vite build succeeds.

- [ ] **Step 5: Commit.**

```bash
git add src/components/Terminal.tsx src/components/WorkspaceCenter.tsx
git commit -m "feat(workspace): spawn worktree sessions in repo root with --worktree"
```

---

## Task 10: NewSessionDialog + Sidebar create flow

**Files:**
- Create: `src/components/NewSessionDialog.tsx`
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Create the dialog component.** `src/components/NewSessionDialog.tsx`:

```tsx
import { useEffect, useState } from "react";
import { isGitRepo } from "../store";

export function NewSessionDialog({
  projectPath,
  onCancel,
  onCreate,
}: {
  projectPath: string;
  onCancel: () => void;
  onCreate: (opts: { name?: string; useWorktree: boolean }) => void;
}) {
  const [name, setName] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [gitOk, setGitOk] = useState(false);

  useEffect(() => {
    let alive = true;
    void isGitRepo(projectPath).then((ok) => {
      if (alive) setGitOk(ok);
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = () => onCreate({ name: name.trim() || undefined, useWorktree: useWorktree && gitOk });

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">New session</div>
        <input
          className="dialog-input"
          placeholder="Name (optional)"
          autoFocus
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <label className={`dialog-toggle ${gitOk ? "" : "disabled"}`} title={gitOk ? "" : "Not a git repository"}>
          <input
            type="checkbox"
            checked={useWorktree && gitOk}
            disabled={!gitOk}
            onChange={(e) => setUseWorktree(e.target.checked)}
          />
          <span>Isolate in a git worktree</span>
        </label>
        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Open the dialog from "New session".** In `src/components/Sidebar.tsx`, add `useState` to the existing React import (line 1 is `import { useEffect, useRef } from "react";`) and import the dialog:

```ts
import { useEffect, useRef, useState } from "react";
import { NewSessionDialog } from "./NewSessionDialog";
```

In `ProjectBlock`, add state and replace the New session button's handler:

```tsx
function ProjectBlock({ project }: { project: Project }) {
  const addSession = useStore((s) => s.addSession);
  const openMenu = useStore((s) => s.openMenu);
  const [showNew, setShowNew] = useState(false);
  // ... existing openProjectMenu ...
```

Change the button:

```tsx
        <button className="new-session" onClick={() => setShowNew(true)}>
          <PlusIcon size={12} />
          <span>New session</span>
        </button>
```

And render the dialog (just before the closing `</div>` of `project-block`):

```tsx
      {showNew && (
        <NewSessionDialog
          projectPath={project.path}
          onCancel={() => setShowNew(false)}
          onCreate={(opts) => {
            setShowNew(false);
            void addSession(project.id, opts);
          }}
        />
      )}
```

- [ ] **Step 3: Typecheck + build.**

Run: `pnpm build`
Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add src/components/NewSessionDialog.tsx src/components/Sidebar.tsx
git commit -m "feat(sidebar): New session dialog with worktree toggle"
```

---

## Task 11: Sidebar — branch chip + delete-with-worktree flow

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Show the branch on a worktree session row.** In `SessionRow`, after the name span (before `<StatusAccessory ... />`), add:

```tsx
      {!editing && session.branch && (
        <span className="branch-chip" title={session.branch}>
          {session.branch}
        </span>
      )}
```

- [ ] **Step 2: Add the delete handler** that prompts keep/remove for worktree sessions. Add the import for the helpers at the top of `Sidebar.tsx`:

```ts
import { worktreeIsDirty, worktreeRemove } from "../store";
import { invoke } from "@tauri-apps/api/core";
```

Add this async helper near the top of the file (module scope):

```ts
async function deleteSession(
  projects: Project[],
  projectId: string,
  sessionId: string,
  removeSession: (p: string, s: string) => Promise<void>,
) {
  const found = findSession(projects, sessionId);
  const session = found?.session;
  if (!session) return;
  if (!confirm(`Delete session "${session.name}"?`)) return;

  if (session.useWorktree && session.worktreePath) {
    const dirty = await worktreeIsDirty(session.worktreePath);
    const msg = dirty
      ? `Also remove its git worktree (${session.branch})?\n\nIt has uncommitted changes that will be permanently lost.`
      : `Also remove its git worktree (${session.branch})?\n\nThe branch is kept; only the working copy is removed.`;
    if (confirm(msg)) {
      // Kill the live process first so git can release the worktree lock.
      await invoke("pty_kill", { sessionId }).catch(() => {});
      await invoke("pty_kill", { sessionId: `${sessionId}::term` }).catch(() => {});
      try {
        await worktreeRemove(found.project.path, session.worktreePath, dirty);
      } catch (e) {
        void invoke("notify_user", { title: "Conduit", body: `Worktree not removed: ${e}` }).catch(() => {});
      }
    }
  }
  await removeSession(projectId, sessionId);
}
```

- [ ] **Step 3: Call it from the context menu Delete button.** In `SessionContextMenu`, replace the Delete button's `onClick` body:

```tsx
        onClick={() => {
          void deleteSession(projects, menu.projectId, sid, removeSession);
          closeMenu();
        }}
```

(Remove the now-duplicated inline `confirm(...)`/`removeSession` from that handler.)

- [ ] **Step 4: Typecheck + build.**

Run: `pnpm build`
Expected: clean.

- [ ] **Step 5: Commit.**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(sidebar): branch chip + worktree-aware delete"
```

---

## Task 12: theme.css — dialog + branch-chip styles

**Files:**
- Modify: `src/theme.css`

- [ ] **Step 1: Append styles** to `src/theme.css` (reuse existing tokens, mirroring `.context-menu` and the pill styles):

```css
/* New session dialog */
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}
.dialog {
  min-width: 320px;
  background: var(--sidebar-bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 16px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dialog-title {
  font-size: 13px;
  color: var(--text-bright);
}
.dialog-input {
  font-family: inherit;
  font-size: 12px;
  color: var(--text-bright);
  background: var(--panel-bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 6px 8px;
  outline: none;
  caret-color: var(--accent);
}
.dialog-input:focus {
  border-color: var(--accent);
}
.dialog-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-mid);
  cursor: pointer;
}
.dialog-toggle.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dialog-actions button {
  font-size: 12px;
  color: var(--text-bright);
  padding: 6px 12px;
  border-radius: 5px;
}
.dialog-actions button:hover {
  background: var(--selection-bg);
}
.dialog-actions button.primary {
  background: var(--accent);
  color: var(--sidebar-bg);
}

/* branch chip on a worktree session row */
.branch-chip {
  font-size: 9.5px;
  color: var(--text-mid);
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
```

- [ ] **Step 2: Build.**

Run: `pnpm build`
Expected: clean; CSS bundle grows.

- [ ] **Step 3: Commit.**

```bash
git add src/theme.css
git commit -m "style: new session dialog + branch chip"
```

---

## Task 13: Final verification

- [ ] **Step 1: Full Rust suite.** Run: `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Step 2: Frontend build.** Run: `pnpm build` — `tsc` clean, vite succeeds.
- [ ] **Step 3: Manual smoke (`pnpm tauri dev`):**
  - Non-git project: "New session" dialog shows the worktree toggle disabled.
  - Git project: create a session with the toggle on → a worktree session starts; `git worktree list` shows `worktree-<slug>`; the file tree / git panel reflect the worktree; the branch chip shows in the sidebar.
  - Submit a prompt → status dot and to-dos update (hooks fire inside the worktree).
  - Create a normal session (toggle off) → unchanged behavior; no worktree created.
  - Delete a clean worktree session → prompted; choose remove → worktree gone, branch retained (`git branch` still lists it).
  - Delete a dirty worktree session → prompt warns about data loss; remove uses force.
  - Reload the window mid-session → re-attaches to the running worktree session (no recreate error).
- [ ] **Step 4: Commit any final fixes.**

---

## Done criteria

- All Rust unit/integration tests pass; existing `hooks.rs` regression tests stay green.
- Normal (non-worktree) sessions behave exactly as before.
- Opt-in worktree sessions create/enter the worktree, show live status, and surface the branch.
- Delete prompts keep/remove and never silently discards uncommitted work.
