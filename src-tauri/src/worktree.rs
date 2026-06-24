//! Worktree helpers for per-session isolation. Creation is delegated to Claude Code
//! (`claude --worktree`); this module computes the deterministic names/paths Claude
//! uses and owns the one mutation Conduit performs: removing a worktree on delete.

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
