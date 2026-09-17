//! Creating a project folder and cloning a repository from the New Project dialog.
//!
//! Both operations land in a user-chosen parent directory and hand the final path back
//! to the frontend, which adds it as a project. The clone shells out to `git` (the
//! lean-dependency rule — no HTTP client in Rust) with two guards that are easy to
//! lose: `--` before the URL so a pasted string starting with `-` can never become a
//! git option, and `GIT_TERMINAL_PROMPT=0` so a private/nonexistent HTTPS remote fails
//! fast instead of hanging forever on a credential prompt no one can see.

use std::path::PathBuf;

/// Validate a project folder name; returns the trimmed name. Separators are rejected
/// unconditionally — both slashes, on every platform — so the macOS and Windows CI
/// legs run identical rules (mirrors `validateProjectName` in src/projectNew.ts).
pub fn validate_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Project name is required".into());
    }
    if n == "." || n == ".." {
        return Err("Not a valid folder name".into());
    }
    if n.contains('/') || n.contains('\\') {
        return Err("Name cannot contain path separators".into());
    }
    Ok(n.to_string())
}

/// The argv for a clone, as data — pure so the injection guard is testable without
/// spawning git. `git clone --progress -- <url> <name>`.
pub fn clone_args(url: &str, name: &str) -> Result<Vec<String>, String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("Repository URL is required".into());
    }
    // `--` below already stops git parsing options, but refuse outright too: a URL
    // shaped like an option is never what the user meant.
    if u.starts_with('-') {
        return Err("Not a valid repository URL".into());
    }
    let n = validate_name(name)?;
    Ok(vec![
        "clone".into(),
        "--progress".into(),
        "--".into(),
        u.into(),
        n,
    ])
}

/// Split a raw stderr chunk into displayable lines. Git's progress ("Receiving
/// objects: 42%") overwrites one line via carriage returns, so `\r` separates updates
/// exactly like `\n` separates lines; empties are dropped.
pub fn progress_lines(chunk: &str) -> Vec<String> {
    chunk
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Resolve and vet the target: parent must exist (a remembered location may have been
/// deleted since), target must not.
fn target_path(parent: &str, name: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(parent);
    if !p.is_dir() {
        return Err("The chosen location no longer exists".into());
    }
    let target = p.join(name);
    if target.exists() {
        return Err(format!("\"{name}\" already exists in that location"));
    }
    Ok(target)
}

/// Create `<parent>/<name>`, optionally `git init` it. Returns the created path.
pub fn create_project(parent: &str, name: &str, git_init: bool) -> Result<String, String> {
    let name = validate_name(name)?;
    let target = target_path(parent, &name)?;
    std::fs::create_dir(&target).map_err(|e| format!("could not create folder: {e}"))?;
    if git_init {
        use crate::NoWindow;
        let out = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&target)
            .no_window()
            .output()
            .map_err(|e| format!("failed to run git: {e}"))?;
        if !out.status.success() {
            // The folder itself is fine — report the init failure, keep the project.
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() {
                format!("git init exited with {}", out.status)
            } else {
                err
            });
        }
    }
    Ok(target.to_string_lossy().into_owned())
}

/// Run the clone, feeding each progress line to `on_line`. Returns the cloned path.
/// The sink (not an AppHandle) is what lets tests drive the real thing — same seam as
/// cli_open's handler.
pub fn run_clone(
    url: &str,
    parent: &str,
    name: &str,
    on_line: &mut dyn FnMut(String),
) -> Result<String, String> {
    use crate::NoWindow;
    use std::io::Read;

    let name = validate_name(name)?;
    let args = clone_args(url, &name)?;
    let target = target_path(parent, &name)?;

    let mut child = std::process::Command::new("git")
        .args(&args)
        .current_dir(parent)
        // No tty: a credential prompt would hang the dialog forever. Fail fast.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("failed to run git: {e}"))?;

    // Progress and errors both arrive on stderr. Keep a bounded tail so a failure can
    // report git's own words without ever holding a full transfer log.
    let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let mut buf = [0u8; 4096];
    let mut pending = String::new();
    loop {
        let n = stderr.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        pending.push_str(&String::from_utf8_lossy(&buf[..n]));
        // Split off complete lines; a chunk may end mid-line, so hold the remainder.
        let complete = match pending.rfind(['\r', '\n']) {
            Some(i) => {
                let rest = pending.split_off(i + 1);
                std::mem::replace(&mut pending, rest)
            }
            None => continue,
        };
        for line in progress_lines(&complete) {
            if tail.len() >= 20 {
                tail.pop_front();
            }
            tail.push_back(line.clone());
            on_line(line);
        }
    }
    for line in progress_lines(&pending) {
        if tail.len() >= 20 {
            tail.pop_front();
        }
        tail.push_back(line.clone());
        on_line(line);
    }

    let status = child.wait().map_err(|e| format!("wait: {e}"))?;
    if !status.success() {
        let err = tail.iter().cloned().collect::<Vec<_>>().join("\n");
        return Err(if err.is_empty() {
            format!("git clone exited with {status}")
        } else {
            err
        });
    }
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(label: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "conduit_project_new_{label}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn validate_name_accepts_plain_and_trims() {
        assert_eq!(validate_name(" my-app ").unwrap(), "my-app");
    }

    #[test]
    fn validate_name_rejects_empty_dots_and_separators() {
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name(".").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
    }

    #[test]
    fn clone_args_shape_pins_the_injection_guard() {
        let args = clone_args("https://example.com/user/repo.git", "repo").unwrap();
        assert_eq!(
            args,
            vec![
                "clone",
                "--progress",
                "--",
                "https://example.com/user/repo.git",
                "repo"
            ]
        );
    }

    #[test]
    fn clone_args_rejects_option_shaped_urls() {
        assert!(clone_args("--upload-pack=/bin/sh", "x").is_err());
        assert!(clone_args("-o evil", "x").is_err());
        assert!(clone_args("", "x").is_err());
        assert!(clone_args("   ", "x").is_err());
    }

    #[test]
    fn progress_lines_split_on_cr_and_lf() {
        assert_eq!(
            progress_lines("Receiving objects: 10%\rReceiving objects: 42%\ndone.\n"),
            vec!["Receiving objects: 10%", "Receiving objects: 42%", "done."]
        );
        assert!(progress_lines("\r\n\r").is_empty());
    }

    #[test]
    fn create_project_makes_dir_without_git() {
        let parent = tmp("plain");
        let path = create_project(parent.to_str().unwrap(), "proj", false).unwrap();
        let p = PathBuf::from(&path);
        assert!(p.is_dir());
        assert!(!p.join(".git").exists());
    }

    #[test]
    fn create_project_git_init_makes_repo() {
        let parent = tmp("init");
        let path = create_project(parent.to_str().unwrap(), "proj", true).unwrap();
        assert!(PathBuf::from(&path).join(".git").exists());
    }

    #[test]
    fn create_project_refuses_existing_target() {
        let parent = tmp("exists");
        std::fs::create_dir(parent.join("proj")).unwrap();
        let err = create_project(parent.to_str().unwrap(), "proj", false).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn create_project_refuses_missing_parent() {
        let parent = tmp("gone").join("missing");
        let err = create_project(parent.to_str().unwrap(), "proj", false).unwrap_err();
        assert!(err.contains("location"), "got: {err}");
    }

    #[test]
    fn run_clone_clones_local_repo_and_reports_lines() {
        // Hermetic: build a source repo with one commit, clone it by path.
        let src = tmp("src");
        let run = |args: &[&str], dir: &PathBuf| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", dir)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"], &src);
        run(
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "--allow-empty",
                "-q",
                "-m",
                "x",
            ],
            &src,
        );

        let parent = tmp("dst");
        let mut lines = Vec::new();
        let path = run_clone(
            src.to_str().unwrap(),
            parent.to_str().unwrap(),
            "cloned",
            &mut |l| lines.push(l),
        )
        .unwrap();
        assert!(PathBuf::from(&path).join(".git").exists());
        assert!(!lines.is_empty(), "expected at least one progress line");
    }

    #[test]
    fn run_clone_bad_source_reports_stderr_not_hang() {
        let parent = tmp("bad");
        let missing = parent.join("no-such-repo");
        let err = run_clone(
            missing.to_str().unwrap(),
            parent.to_str().unwrap(),
            "x",
            &mut |_| {},
        )
        .unwrap_err();
        assert!(!err.is_empty());
    }
}
