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

/// Like `run` but user-invoked: nonzero exit / spawn failure surface as Err(stderr).
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

/// Absolute path -> repo-relative (forward slashes), for `git diff -- <p>`.
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
