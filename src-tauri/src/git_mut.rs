//! MUTATING git operations — deliberately separate from git.rs, whose contract is
//! "never mutates". Everything here changes the working tree and must stay behind
//! an explicit, confirm-guarded user action in the UI.

use std::process::Command;

fn run_checked(args: &[&str], dir: &str) -> Result<String, String> {
    use crate::NoWindow;
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("git exited with {}", out.status)
        } else {
            err
        })
    }
}

/// Discard a file's working-tree changes back to HEAD. Tracked files are restored;
/// untracked files (status "?" — HEAD has nothing to restore to) are deleted, which
/// IS the discard semantic for them. Returns which action ran ("restored" |
/// "deleted") so the UI can phrase the toast. `path` is relative to `dir` exactly
/// as `git_changes` reported it.
pub fn discard_file(dir: &str, path: &str) -> Result<String, String> {
    let tracked = run_checked(&["ls-files", "--error-unmatch", "--", path], dir).is_ok();
    if tracked {
        run_checked(&["restore", "--source=HEAD", "--worktree", "--", path], dir)?;
        Ok("restored".into())
    } else {
        // Untracked: delete via fsops so the deletion honors its safety rails
        // (trash-like recursive remove is NOT used here — single file only).
        let abs = std::path::Path::new(dir).join(path);
        std::fs::remove_file(&abs).map_err(|e| format!("delete {}: {e}", abs.display()))?;
        Ok("deleted".into())
    }
}
