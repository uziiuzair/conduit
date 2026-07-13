//! Read-only git queries for the right panel. Ports GitInfo.swift. Never mutates.

use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub status: String,
    pub path: String,
    pub added: i64,
    pub removed: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub subject: String,
}

/// A commit with enough topology to draw a branch graph.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    /// Decorations from %D, e.g. "HEAD -> main, origin/main, tag: v1" ("" if none).
    pub refs: String,
}

fn run(args: &[&str], dir: &str) -> String {
    use crate::NoWindow;
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .no_window()
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Like `run` but for user-invoked queries: nonzero exit / spawn failure surface as
/// Err(stderr) instead of silently becoming "". Polling keeps `run`'s contract.
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

/// Absolute path -> repo-relative with forward slashes (what `git show HEAD:<p>`
/// wants). Canonicalizes both sides so macOS /tmp-symlinks and Windows verbatim
/// prefixes can't break the strip.
fn repo_relative(dir: &str, path: &str) -> Result<String, String> {
    let top = run_checked(&["rev-parse", "--show-toplevel"], dir)?
        .trim()
        .to_string();
    let top = std::fs::canonicalize(&top).map_err(|e| format!("repo root: {e}"))?;
    let abs = std::fs::canonicalize(path).map_err(|e| format!("path: {e}"))?;
    abs.strip_prefix(&top)
        .map_err(|_| "file is outside the repository".to_string())
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

/// Max diff text returned to a phone — a big diff is unreadable there anyway.
const DIFF_TEXT_CAP: usize = 48 * 1024;

/// Unified diff of one file against HEAD, for phone review. An untracked file (not
/// in HEAD) is shown as all-added via `--no-index` against /dev/null. Output is
/// capped with a truncation marker.
pub fn diff_text(dir: &str, path: &str) -> Result<String, String> {
    let rel = repo_relative(dir, path)?;
    let mut out = run_checked(&["diff", "HEAD", "--", &rel], dir)?;
    if out.trim().is_empty() {
        // `--no-index` exits 1 when the files differ, so use the unchecked `run`.
        let added = run(&["diff", "--no-index", "--", "/dev/null", &rel], dir);
        out = if added.trim().is_empty() {
            format!("(no changes to {rel} against HEAD)")
        } else {
            added
        };
    }
    if out.len() > DIFF_TEXT_CAP {
        out.truncate(DIFF_TEXT_CAP);
        out.push_str("\n… (diff truncated — review the rest on the desktop)");
    }
    Ok(out)
}

/// Same 24 MB bound as fsops::read_file — a diff original larger than the editor
/// would load anyway is refused rather than truncated (a truncated original would
/// render as a giant bogus deletion).
const SHOW_CAP: usize = 24 * 1024 * 1024;

/// Content of `HEAD:<path>` for the diff editor's original (left) side. A path that
/// exists on disk but not in HEAD (new/untracked file) resolves to Ok("") so the
/// diff renders as all-added instead of erroring.
pub fn show_head(dir: &str, path: &str) -> Result<String, String> {
    let rel = repo_relative(dir, path)?;
    let spec = format!("HEAD:{rel}");
    if run_checked(&["cat-file", "-e", &spec], dir).is_err() {
        return Ok(String::new());
    }
    let content = run_checked(&["show", &spec], dir)?;
    if content.len() > SHOW_CAP {
        return Err("file at HEAD is too large to diff".into());
    }
    Ok(content)
}

/// One contiguous change against HEAD, expressed in NEW-file line numbers, parsed
/// from a `git diff -U0` hunk header. `deleted` hunks have count 0 — they mark the
/// gap AFTER line `start` (start may be 0 for a deletion at the top of the file).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// "added" | "modified" | "deleted"
    pub kind: String,
    /// First affected line in the new file (1-based; see `deleted` caveat above).
    pub start: u32,
    /// Affected line count in the new file (0 for pure deletions).
    pub count: u32,
}

/// Parse `@@ -a[,b] +c[,d] @@` headers out of `git diff -U0` output. Pure so it's
/// unit-testable; everything that isn't a hunk header is ignored.
pub fn parse_hunks(diff: &str) -> Vec<Hunk> {
    let mut out = Vec::new();
    for line in diff.lines() {
        let Some(rest) = line.strip_prefix("@@ -") else {
            continue;
        };
        let Some((ranges, _)) = rest.split_once(" @@") else {
            continue;
        };
        let Some((old, new)) = ranges.split_once(" +") else {
            continue;
        };
        let parse_range = |r: &str| -> Option<(u32, u32)> {
            match r.split_once(',') {
                Some((s, c)) => Some((s.parse().ok()?, c.parse().ok()?)),
                None => Some((r.parse().ok()?, 1)),
            }
        };
        let (Some((_, old_count)), Some((new_start, new_count))) =
            (parse_range(old), parse_range(new))
        else {
            continue;
        };
        let kind = if new_count == 0 {
            "deleted"
        } else if old_count == 0 {
            "added"
        } else {
            "modified"
        };
        out.push(Hunk {
            kind: kind.into(),
            start: new_start,
            count: new_count,
        });
    }
    out
}

/// Gutter change stripes: hunks of the working tree vs HEAD for one file.
/// A file not in HEAD yields no hunks — the frontend already knows it's all-new
/// from show_head() == "".
pub fn diff_hunks(dir: &str, path: &str) -> Result<Vec<Hunk>, String> {
    let rel = repo_relative(dir, path)?;
    let out = run_checked(&["diff", "-U0", "HEAD", "--", &rel], dir)?;
    Ok(parse_hunks(&out))
}

/// Everything Quick Open can offer in a repo: tracked + untracked, gitignore-aware.
/// Paths come back repo-relative (forward slashes) exactly as git prints them.
pub const LS_FILES_CAP: usize = 20_000;

pub fn ls_files(dir: &str) -> Result<Vec<String>, String> {
    let out = run_checked(&["ls-files", "-co", "--exclude-standard"], dir)?;
    Ok(out
        .lines()
        .filter(|l| !l.is_empty())
        .take(LS_FILES_CAP)
        .map(String::from)
        .collect())
}

pub fn current_branch(dir: &str) -> Option<String> {
    let out = run(&["rev-parse", "--abbrev-ref", "HEAD"], dir)
        .trim()
        .to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn changes(dir: &str) -> Vec<Change> {
    // numstat: added/removed counts per path
    let mut counts: std::collections::HashMap<String, (i64, i64)> =
        std::collections::HashMap::new();
    for line in run(&["diff", "--numstat", "HEAD"], dir).lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() == 3 {
            counts.insert(
                parts[2].to_string(),
                (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0)),
            );
        }
    }

    let mut out = Vec::new();
    // -uall expands untracked directories to individual files (otherwise an
    // untracked dir shows as a single "foo/" entry).
    for line in run(&["status", "--porcelain", "-uall"], dir).lines() {
        if line.len() <= 3 {
            continue;
        }
        let field = line[..2].trim();
        let path = line[3..].to_string();
        let letter = field
            .chars()
            .next()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "M".into());
        let (added, removed) = counts.get(&path).copied().unwrap_or((0, 0));
        out.push(Change {
            status: if letter == "?" { "A".into() } else { letter },
            path,
            added,
            removed,
        });
    }
    out
}

pub fn commits(dir: &str, limit: usize) -> Vec<Commit> {
    run(
        &["log", "--pretty=%h\u{1f}%s", "-n", &limit.to_string()],
        dir,
    )
    .lines()
    .filter_map(|line| {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() == 2 {
            Some(Commit {
                hash: parts[0].to_string(),
                subject: parts[1].to_string(),
            })
        } else {
            None
        }
    })
    .collect()
}

pub fn graph(dir: &str, limit: usize) -> Vec<GraphCommit> {
    // %h hash · %p parents (space-sep) · %s subject · %an author · %D decorations
    run(
        &[
            "log",
            "--pretty=tformat:%h\u{1f}%p\u{1f}%s\u{1f}%an\u{1f}%D",
            "-n",
            &limit.to_string(),
        ],
        dir,
    )
    .lines()
    .filter_map(|line| {
        let f: Vec<&str> = line.splitn(5, '\u{1f}').collect();
        if f.len() < 5 {
            return None;
        }
        Some(GraphCommit {
            hash: f[0].to_string(),
            parents: f[1].split_whitespace().map(String::from).collect(),
            subject: f[2].to_string(),
            author: f[3].to_string(),
            refs: f[4].to_string(),
        })
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(kind: &str, start: u32, count: u32) -> Hunk {
        Hunk {
            kind: kind.into(),
            start,
            count,
        }
    }

    #[test]
    fn parse_hunks_classifies_add_modify_delete() {
        let diff = "diff --git a/f b/f\nindex 111..222 100644\n--- a/f\n+++ b/f\n\
                    @@ -0,0 +1,3 @@\n+a\n+b\n+c\n\
                    @@ -10,2 +13,2 @@ fn ctx() {\n-x\n-y\n+x2\n+y2\n\
                    @@ -20,4 +23,0 @@\n-gone\n";
        assert_eq!(
            parse_hunks(diff),
            vec![h("added", 1, 3), h("modified", 13, 2), h("deleted", 23, 0)]
        );
    }

    #[test]
    fn parse_hunks_handles_singular_ranges_without_counts() {
        // git omits ",1": "@@ -5 +5 @@" means one line each side.
        assert_eq!(parse_hunks("@@ -5 +5 @@\n"), vec![h("modified", 5, 1)]);
        assert_eq!(parse_hunks("@@ -0,0 +1 @@\n"), vec![h("added", 1, 1)]);
        assert_eq!(parse_hunks("@@ -3 +2,0 @@\n"), vec![h("deleted", 2, 0)]);
    }

    #[test]
    fn parse_hunks_ignores_non_header_noise() {
        // Content lines that merely CONTAIN header-ish text must not parse: the
        // "@@ -1,2 +3,4 @@" here is diff BODY (prefixed with +).
        let diff = "+@@ -1,2 +3,4 @@\n@@ malformed @@\n@@ -x,y +1,2 @@\n";
        assert!(parse_hunks(diff).is_empty());
    }
}
