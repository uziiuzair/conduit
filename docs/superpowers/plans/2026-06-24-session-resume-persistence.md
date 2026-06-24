# Session Resume Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude conversations survive a full Conduit restart by pinning each session's Claude session id to Conduit's own UUID and resuming it on cold spawn.

**Architecture:** On a cold (non-reattach) spawn, Rust checks whether a transcript file named `<session-id>.jsonl` exists anywhere under `~/.claude/projects/*/`. If it does, launch `claude --resume <id>`; if not, launch `claude --session-id <id>` to pin Claude's id to ours. Both fall back to bare `claude`. The change is confined to `src-tauri/src/pty.rs` — no schema, frontend, or IPC changes.

**Tech Stack:** Rust (Tauri backend), `portable-pty`, `dirs` crate, `cargo test`/`cargo clippy`. The reference design is `docs/superpowers/specs/2026-06-24-session-resume-persistence-design.md`.

---

## File Structure

- **Modify:** `src-tauri/src/pty.rs`
  - Add `use std::fs;` and `use std::path::{Path, PathBuf};` to the imports.
  - Add three module-level helper fns near `shell_quote`: `claude_projects_dir`, `transcript_exists`, `claude_invocation`.
  - Replace the literal `claude` in the non-`shell_only` branch of `spawn` with `claude_invocation(...)`.
  - Add a `#[cfg(test)] mod tests` (pty.rs has none today) covering `transcript_exists` and `claude_invocation`.

No other files change. The existing `pty_spawn` Tauri command already passes `session_id` and `working_directory`, so its signature is untouched.

---

### Task 1: Transcript detection (`transcript_exists`)

**Files:**
- Modify: `src-tauri/src/pty.rs` (imports near lines 16-18; new fn + new test module at end of file)
- Test: same file, new `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

Append to the end of `src-tauri/src/pty.rs`:

```rust
#[cfg(test)]
mod tests {
    // `super::*` brings in `fs`, `Path`, and `PathBuf` from the file's top-level
    // imports (same pattern as the hooks.rs test module).
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const ID: &str = "11111111-2222-3333-4444-555555555555";

    /// A unique, empty `.../projects` dir for one test.
    fn fresh_projects_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("conduit_pty_test_{tag}_{}_{n}", std::process::id()))
            .join("projects");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp projects dir");
        dir
    }

    /// Plant `<projects>/<slug>/<id>.jsonl` to simulate a Claude transcript.
    fn plant_transcript(projects: &Path, slug: &str, id: &str) {
        let slug_dir = projects.join(slug);
        fs::create_dir_all(&slug_dir).unwrap();
        fs::write(slug_dir.join(format!("{id}.jsonl")), b"{}\n").unwrap();
    }

    #[test]
    fn transcript_absent_in_empty_store() {
        let projects = fresh_projects_dir("absent");
        assert!(!transcript_exists(ID, &projects));
    }

    #[test]
    fn transcript_found_under_any_slug() {
        let projects = fresh_projects_dir("found");
        // Arbitrary slug incl. dots — detection must NOT depend on the cwd-slug algorithm.
        plant_transcript(&projects, "-some-weird-Slug.with.dots", ID);
        assert!(transcript_exists(ID, &projects));
    }

    #[test]
    fn transcript_other_ids_ignored() {
        let projects = fresh_projects_dir("others");
        plant_transcript(&projects, "-proj", "99999999-0000-0000-0000-000000000000");
        assert!(!transcript_exists(ID, &projects));
    }

    #[test]
    fn transcript_missing_dir_is_false() {
        let missing = std::env::temp_dir().join("conduit_pty_does_not_exist_dir/projects");
        let _ = fs::remove_dir_all(&missing);
        assert!(!transcript_exists(ID, &missing));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcript`
Expected: FAIL — does not compile, `cannot find function transcript_exists in this scope`.

- [ ] **Step 3: Add imports and the minimal implementation**

Change the imports at the top of `src-tauri/src/pty.rs` from:

```rust
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
```

to:

```rust
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
```

Then add this fn just above `fn shell_quote` near the bottom of the file (before the `#[cfg(test)]` module):

```rust
/// True if a transcript named `<session_id>.jsonl` exists under any project-slug
/// subdirectory of `projects_dir`. Matching by the globally-unique UUID filename
/// means we never reproduce Claude's cwd-slug algorithm (so worktree cwds work too).
fn transcript_exists(session_id: &str, projects_dir: &Path) -> bool {
    let file = format!("{session_id}.jsonl");
    let Ok(entries) = fs::read_dir(projects_dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.path().join(&file).exists())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcript`
Expected: PASS — 4 tests (`transcript_absent_in_empty_store`, `transcript_found_under_any_slug`, `transcript_other_ids_ignored`, `transcript_missing_dir_is_false`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "$(cat <<'EOF'
feat(pty): detect a session's Claude transcript by uuid filename

Slug-independent: scans ~/.claude/projects/*/ for <id>.jsonl so it
works for worktree cwds without reproducing Claude's slug algorithm.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Command selection (`claude_invocation` + `claude_projects_dir`)

**Files:**
- Modify: `src-tauri/src/pty.rs` (two new fns near `transcript_exists`; new tests in the existing `mod tests`)
- Test: same file

- [ ] **Step 1: Write the failing tests**

Add these test fns inside the existing `#[cfg(test)] mod tests` block in `src-tauri/src/pty.rs`:

```rust
    #[test]
    fn invocation_resumes_when_transcript_exists() {
        let projects = fresh_projects_dir("resume");
        plant_transcript(&projects, "-proj", ID);
        let cmd = claude_invocation(ID, Some(projects.as_path()));
        assert!(cmd.contains(&format!("--resume '{ID}'")), "got: {cmd}");
        assert!(cmd.ends_with("|| claude"), "missing fallback: {cmd}");
    }

    #[test]
    fn invocation_pins_new_session_when_absent() {
        let projects = fresh_projects_dir("pin");
        let cmd = claude_invocation(ID, Some(projects.as_path()));
        assert!(cmd.contains(&format!("--session-id '{ID}'")), "got: {cmd}");
        assert!(cmd.ends_with("|| claude"), "missing fallback: {cmd}");
    }

    #[test]
    fn invocation_without_store_is_first_launch() {
        let cmd = claude_invocation(ID, None);
        assert!(cmd.contains("--session-id"), "got: {cmd}");
        assert!(!cmd.contains("--resume"), "must not resume without a store: {cmd}");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml invocation`
Expected: FAIL — does not compile, `cannot find function claude_invocation in this scope`.

- [ ] **Step 3: Write the minimal implementation**

Add this fn directly below `transcript_exists` in `src-tauri/src/pty.rs`:

```rust
/// The `claude` invocation for a *cold* spawn. Resume the pinned conversation when
/// its transcript exists; otherwise start a new session pinned to our id. Each branch
/// falls back to a bare `claude` so a resume/pin failure never strands the user.
fn claude_invocation(session_id: &str, projects_dir: Option<&Path>) -> String {
    let id = shell_quote(session_id);
    if projects_dir.is_some_and(|d| transcript_exists(session_id, d)) {
        format!("claude --resume {id} || claude")
    } else {
        format!("claude --session-id {id} || claude")
    }
}
```

(`claude_projects_dir`, the only lib-side consumer that uses `PathBuf`, is added in Task 3 where it's wired into `spawn` — keeping every gated step free of "never used" warnings.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml invocation`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "$(cat <<'EOF'
feat(pty): build resume vs pinned-new claude invocation

Resume <id> when its transcript exists, else --session-id <id> to pin
Claude's id to ours. Every branch falls back to bare claude so a failed
resume never strands the user.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire selection into `spawn`

**Files:**
- Modify: `src-tauri/src/pty.rs` (new `claude_projects_dir` fn near the others; the `inner` construction in `spawn`, the non-`shell_only` branch, ~lines 88-102)

- [ ] **Step 1: Add the transcript-store resolver**

Add this fn directly above `claude_invocation` in `src-tauri/src/pty.rs`:

```rust
/// Resolve Claude's transcript store: `$CLAUDE_CONFIG_DIR/projects` if set,
/// else `~/.claude/projects`. None when no home dir is available.
fn claude_projects_dir() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(cfg) if !cfg.is_empty() => Some(PathBuf::from(cfg).join("projects")),
        _ => dirs::home_dir().map(|h| h.join(".claude").join("projects")),
    }
}
```

This is the first lib-side use of `PathBuf` (the import was added in Task 1; until now only the test module referenced it), so it now resolves clean in a non-test build too.

- [ ] **Step 2: Replace the bare `claude` with the computed invocation**

In `fn spawn`, replace this block:

```rust
        let inner = if shell_only {
            format!(
                "cd {dir} && exec {shell} -i -l",
                dir = shell_quote(&working_directory),
                shell = shell,
            )
        } else {
            format!(
                "export CONDUIT_SESSION_ID={sid} CONDUIT_HOOK_PORT={port} CLAUDE_CODE_ENABLE_TASKS=0; cd {dir} && claude; exec {shell} -i -l",
                sid = shell_quote(&session_id),
                port = hook_port,
                dir = shell_quote(&working_directory),
                shell = shell,
            )
        };
```

with:

```rust
        let inner = if shell_only {
            format!(
                "cd {dir} && exec {shell} -i -l",
                dir = shell_quote(&working_directory),
                shell = shell,
            )
        } else {
            // Cold spawn only: the re-attach fast-path above returns before reaching
            // here, so a live session is never "resumed" out from under itself.
            let invocation = claude_invocation(&session_id, claude_projects_dir().as_deref());
            format!(
                "export CONDUIT_SESSION_ID={sid} CONDUIT_HOOK_PORT={port} CLAUDE_CODE_ENABLE_TASKS=0; cd {dir} && {invocation}; exec {shell} -i -l",
                sid = shell_quote(&session_id),
                port = hook_port,
                dir = shell_quote(&working_directory),
                shell = shell,
            )
        };
```

(`{invocation}` is captured directly from the local; the other named args are unchanged.)

- [ ] **Step 3: Verify it compiles clean (no new clippy warnings)**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`
Expected: builds successfully with **no warnings referencing `src-tauri/src/pty.rs`**. (Plain `cargo clippy` matches this repo's established verification practice; don't add `-D warnings`, which could trip on pre-existing baseline lints unrelated to this change.)

- [ ] **Step 4: Run the full backend test suite (no regressions)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — the 7 new `pty::tests` plus all existing `hooks::tests` stay green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "$(cat <<'EOF'
feat(pty): resume Claude on cold spawn so sessions survive restart

Cold spawns now resume a session's pinned transcript (or pin a new one)
instead of always launching a fresh claude. Re-attach fast-path and the
shell_only terminal are untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Manual end-to-end verification

There is no automated E2E harness in this repo, so confirm the live behavior by hand. This is also where the one design assumption — that plain `--resume` is non-forking — gets proven.

**Files:** none (runtime verification)

- [ ] **Step 1: Launch the app**

Run: `pnpm tauri dev`
Expected: Conduit opens; existing projects/sessions appear in the sidebar.

- [ ] **Step 2: Scenario A — basic resume across a full restart**

1. Create a new session, click into it, and send one message to Claude (e.g. "remember the word PERSIMMON").
2. Wait for Claude to reply, then fully quit the app (Cmd+Q / close — triggers `ExitRequested` → `kill_all`).
3. Relaunch (`pnpm tauri dev`), click the same session.

Expected: the prior conversation replays and you land at the prompt. Ask "what word did I tell you to remember?" — Claude answers PERSIMMON.

- [ ] **Step 3: Scenario B — non-forking across repeated restarts**

1. In that resumed session, send a second message (e.g. "also remember APRICOT").
2. Quit fully and relaunch again, click the session.

Expected: BOTH rounds are present (Claude recalls PERSIMMON and APRICOT). Confirm on disk that a single transcript accumulated:
Run: `ls -lt ~/.claude/projects/*/<session-id>.jsonl` (use the session's id; it appears once, growing across restarts).
Expected: exactly one file for that id, modified after the latest exchange. If a *second* id-file appeared, `--resume` forked — stop and revisit (the design's must-verify risk).

- [ ] **Step 4: Scenario C — two sessions, one project, no cross-talk**

1. In a single (non-worktree) project, create two sessions. Tell session 1 the word "ALPHA" and session 2 the word "BETA".
2. Quit fully, relaunch, open each session.

Expected: session 1 recalls ALPHA, session 2 recalls BETA — each resumed its own transcript.

- [ ] **Step 5: Record the result**

If all three scenarios pass, the feature is verified. If Scenario B forks, note it on the spec's "Risks" section and pause for redesign.

---

## Notes for the implementer

- **Why `--manifest-path` instead of `cd src-tauri`:** keeps commands runnable from the repo root without a directory change.
- **Pre-feature sessions:** a session created before this change has no transcript under its Conduit id, so its first post-change launch takes the `--session-id` (first-launch) path and starts fresh — expected, per the spec's non-goals.
- **The re-attach fast-path is load-bearing:** the early `return Ok(())` in `spawn` (when the session is already in the DashMap) means resume logic runs only on genuinely cold spawns. Do not move `claude_invocation` above that check.
