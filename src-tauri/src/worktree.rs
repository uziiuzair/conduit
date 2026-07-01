//! Worktree helpers for per-session isolation. Creation is delegated to Claude Code
//! (`claude --worktree`); this module computes the deterministic names/paths Claude
//! uses and owns the one mutation Conduit performs: removing a worktree on delete.

use std::path::Path;
use std::process::Command;

use crate::NoWindow;

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
    // uid is always an ASCII UUID, so byte-slicing here can't split a multibyte char.
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

/// Decide where a worktree session should run and whether to pass `--worktree`.
/// If the worktree dir already exists, re-enter it directly (cwd = `wt_path`, no
/// `--worktree`, so Claude doesn't try to recreate it). Otherwise stay in the repo
/// root and pass `--worktree <slug>` so Claude creates it.
pub fn spawn_target(
    repo_root: &str,
    slug: &str,
    wt_path: &str,
    wt_exists: bool,
) -> (String, Option<String>) {
    if wt_exists {
        (wt_path.to_string(), None)
    } else {
        (repo_root.to_string(), Some(slug.to_string()))
    }
}

/// True if the worktree has uncommitted changes or untracked files, so a plain
/// `git worktree remove` would refuse and removal needs `--force`. If git can't be
/// run or errors, we assume DIRTY — this gates a destructive force-remove, so the
/// safe default for an unknown state is to keep the data and warn.
pub fn is_dirty(worktree_path: &str) -> bool {
    match Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .no_window()
        .output()
    {
        Ok(o) if o.status.success() => !o.stdout.is_empty(),
        _ => true,
    }
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
        .no_window()
        .output()
        .map_err(|e| format!("git worktree remove: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
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
        // Normalize separators so the assertion holds on Windows (`\`) too -- the path is
        // built with `Path::join`, which is native-separator by design.
        assert_eq!(
            worktree_path("/repo", "feature-x").replace('\\', "/"),
            "/repo/.claude/worktrees/feature-x"
        );
    }

    #[test]
    fn branch_name_prefixes_worktree() {
        assert_eq!(branch_name("feature-x"), "worktree-feature-x");
    }

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
    fn is_dirty_detects_modified_tracked_file() {
        let repo = fresh_repo("modified");
        let wt = worktree_path(repo.to_str().unwrap(), "mod");
        git(&["worktree", "add", "-q", &wt, "-b", "worktree-mod"], &repo);
        assert!(!is_dirty(&wt), "fresh worktree is clean");
        // README.md is a committed tracked file (created in fresh_repo).
        fs::write(std::path::Path::new(&wt).join("README.md"), "changed").unwrap();
        assert!(is_dirty(&wt), "modified tracked file should read as dirty");
    }

    #[test]
    fn is_dirty_assumes_dirty_when_git_errors() {
        // A path with no git repo / nonexistent dir: git errors → we must assume dirty
        // so a destructive force-remove is never silently allowed.
        assert!(is_dirty("/nonexistent/path/conduit-should-not-exist"));
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

    #[test]
    fn spawn_target_reenters_existing_worktree() {
        let (cwd, arg) = spawn_target("/repo", "feat", "/repo/.claude/worktrees/feat", true);
        assert_eq!(cwd, "/repo/.claude/worktrees/feat");
        assert_eq!(arg, None);
    }

    #[test]
    fn spawn_target_creates_when_absent() {
        let (cwd, arg) = spawn_target("/repo", "feat", "/repo/.claude/worktrees/feat", false);
        assert_eq!(cwd, "/repo");
        assert_eq!(arg, Some("feat".to_string()));
    }
}
