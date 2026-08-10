//! tmux-backed session persistence.
//!
//! Conduit spawns each session as a child of the app process, so quitting kills every
//! agent and "restore" means asking the CLI to replay its transcript. That reconstructs
//! the conversation but not the session: work in flight is lost, scrollback is gone, and
//! agents with no `--resume` equivalent (Codex, opencode, a plain shell) get nothing.
//!
//! Attaching to a tmux session instead makes the agent outlive the app. Every decision
//! that can be made without a live PTY is made here, as a pure function with a test, so
//! `pty.rs` -- already the most load-bearing file in the backend -- only gains a thin
//! wrapper.
//!
//! Design: docs/superpowers/specs/2026-08-10-tmux-session-persistence-design.md

#![cfg(not(windows))]

use std::path::{Path, PathBuf};
use std::process::Command;

/// Conduit's private tmux socket, namespaced by data dir.
///
/// Private in both directions: Conduit's sessions never show up in the user's own
/// `tmux ls`, and a `tmux kill-server` in their terminal never touches ours.
///
/// Namespaced because the ORPHAN SWEEP is destructive and its notion of "live" comes from
/// one data dir. `CONDUIT_DATA_DIR_NAME` is how a dev build is isolated from the installed
/// app, so on a shared socket the dev build would boot, see the installed app's `cdt-*`
/// sessions, find none of them in its own (empty) store, and kill every running agent.
/// One socket per data dir makes each install's sweep structurally unable to see anyone
/// else's sessions.
pub fn socket() -> String {
    match std::env::var("CONDUIT_DATA_DIR_NAME") {
        Ok(name) if !name.is_empty() && name != "ConduitTauri" => {
            let safe: String = name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect();
            format!("conduit-{safe}")
        }
        _ => "conduit".to_string(),
    }
}

/// Prefix identifying a Conduit-owned tmux session. Also what the orphan sweep matches on.
const PREFIX: &str = "cdt-";

/// Per-session tmux name. This is the PERSISTENCE KEY -- changing it after release
/// orphans every existing session, so it must stay stable.
///
/// tmux session names may not contain `.` or `:` (it parses them as
/// window/pane addressing), and Conduit's companion-shell ids are `<uuid>::term`, so the
/// sanitization is load-bearing rather than defensive.
pub fn session_name(session_id: &str) -> String {
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{PREFIX}{safe}")
}

/// Absolute path to a usable tmux, or None.
///
/// Deliberately subprocess-free. The obvious implementation -- a login shell running
/// `command -v tmux` -- sources the user's profile, which on a machine with nvm or conda
/// costs 100-800ms, on whatever thread asked. nodeterm shipped that, measured it, and
/// removed it; this starts where they ended up.
pub fn find_tmux() -> Option<PathBuf> {
    for candidate in [
        "/opt/homebrew/bin/tmux",
        "/usr/local/bin/tmux",
        "/usr/bin/tmux",
        "/bin/tmux",
    ] {
        let p = Path::new(candidate);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    find_in_path("tmux", std::env::var("PATH").ok().as_deref())
}

/// A one-shot command that installs tmux on this host, with a caption for the button.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct InstallHint {
    pub command: String,
    /// Says up front when more than tmux is being installed.
    pub label: String,
}

/// The install command to suggest for `platform`, or None when there is nothing sensible to
/// suggest (Windows; a Linux with no package manager we recognize).
///
/// `has` answers "is this command on PATH", injected so the mapping is testable without the
/// test machine's own tooling deciding the answer.
///
/// macOS without Homebrew is the case worth spelling out: macOS ships no package manager, so
/// the suggestion chains the official Homebrew installer and then calls the *fresh* brew by
/// ABSOLUTE path. A bare `brew install tmux` would fail immediately after the install
/// succeeded, because the brew that now exists is not on the PATH of the shell that just ran
/// the installer.
pub fn install_hint(platform: &str, has: impl Fn(&str) -> bool) -> Option<InstallHint> {
    let hint = |command: &str, label: &str| {
        Some(InstallHint {
            command: command.to_string(),
            label: label.to_string(),
        })
    };
    match platform {
        "macos" => {
            if has("brew") {
                return hint("brew install tmux", "Install tmux");
            }
            hint(
                "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\" \
                 && { [ -x /opt/homebrew/bin/brew ] && /opt/homebrew/bin/brew install tmux \
                 || /usr/local/bin/brew install tmux; }",
                "Install Homebrew and tmux",
            )
        }
        "linux" => {
            // Debian family first (the most common target), then the other majors.
            for (mgr, cmd) in [
                (
                    "apt-get",
                    "sudo apt-get update && sudo apt-get install -y tmux",
                ),
                ("dnf", "sudo dnf install -y tmux"),
                ("pacman", "sudo pacman -S --noconfirm tmux"),
                ("zypper", "sudo zypper install -y tmux"),
                ("apk", "sudo apk add tmux"),
            ] {
                if has(mgr) {
                    return hint(cmd, "Install tmux");
                }
            }
            None
        }
        // tmux is Unix-only; Conduit on Windows keeps the non-persistent path.
        _ => None,
    }
}

/// `install_hint` for the running host, resolving `has` against the real PATH.
pub fn install_hint_here() -> Option<InstallHint> {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    };
    install_hint(platform, |bin| {
        // Homebrew's own locations first: a Mac that has brew but hasn't opened a shell
        // that adds it to PATH still has brew.
        if bin == "brew"
            && (Path::new("/opt/homebrew/bin/brew").is_file()
                || Path::new("/usr/local/bin/brew").is_file())
        {
            return true;
        }
        find_in_path(bin, std::env::var("PATH").ok().as_deref()).is_some()
    })
}

/// Scan a `PATH`-shaped string for an executable. Split out so it can be tested without
/// depending on the machine's real environment.
pub fn find_in_path(bin: &str, path: Option<&str>) -> Option<PathBuf> {
    path?
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(bin))
        .find(|p| p.is_file())
}

/// The generated tmux config.
///
/// Generated rather than inherited so the user's `~/.tmux.conf` cannot reach in: a prefix
/// rebind, a status bar, or a plugin manager inside a Conduit pane would all be
/// astonishing, and `status off` in particular matters because a status bar would eat a
/// row of the pane the user is trying to read.
///
/// `mouse on` looks like the wrong call and is not. The instinct is to leave scrolling to
/// xterm.js so it keeps its own scrollback -- nodeterm shipped exactly that and recorded
/// why it fails structurally: tmux is a screen PAINTER, not a stream, so every redraw
/// pushes fragments of repainted frames into the client's scrollback instead of a
/// coherent history. With `mouse on`, the wheel scrolls tmux's own history, which is the
/// only copy that is correct.
///
/// `set-clipboard on` is what gets a copy out of tmux's copy-mode via OSC 52. On tmux
/// 3.2+ this is the supported route; the older `terminal-overrides ',xterm*:Ms=...'`
/// form does not work there.
pub fn conf_body(scrollback: u32) -> String {
    format!(
        "# Generated by Conduit. Edits are overwritten on every launch.\n\
         set -g status off\n\
         set -g history-limit {scrollback}\n\
         set -g escape-time 0\n\
         set -g mouse on\n\
         set -g focus-events on\n\
         set -g set-clipboard on\n\
         set -g destroy-unattached off\n\
         set -g default-terminal \"xterm-256color\"\n\
         set -ga terminal-overrides \",xterm-256color:Tc\"\n"
    )
}

/// Where the generated config lives. In the data dir, so `CONDUIT_DATA_DIR_NAME` keeps a
/// dev build's config off the installed app's.
pub fn conf_path() -> PathBuf {
    crate::store::data_dir().join("conduit.tmux.conf")
}

/// Write the config and push it into any already-running server.
///
/// The push is not optional. A tmux server outlives the app and will NOT re-read its `-f`
/// file on relaunch, so without `source-file` a config change would not take effect until
/// the user killed every session -- which is exactly the thing this feature exists to
/// avoid doing.
pub fn ensure_conf(tmux: &Path, scrollback: u32) -> Option<PathBuf> {
    let path = conf_path();
    if let Err(e) = std::fs::write(&path, conf_body(scrollback)) {
        eprintln!("conduit: could not write tmux config: {e}");
        return None;
    }
    let _ = Command::new(tmux)
        .args(["-L", &socket(), "source-file"])
        .arg(&path)
        .output();
    Some(path)
}

/// Wrap an existing spawn script so it runs inside a persistent tmux session.
///
/// `-A` is attach-or-create, and it is what makes resume conditional for free: on create
/// tmux runs `inner` (which already carries whatever `--resume` flag the adapter built);
/// on attach tmux ignores the command entirely, so a live agent is never resumed out from
/// under itself. No branch in the resume logic is needed -- it simply stops being reached.
///
/// `-D` detaches any other client, which cleans up a client stranded by a crashed app and
/// guarantees exactly one client per session, so tmux's multi-client size negotiation
/// (whose smallest-client-wins rule would shrink the pane) never applies.
///
/// `exec` replaces the login shell, leaving no extra process between the PTY and tmux.
pub fn wrap_command(
    tmux: &Path,
    conf: Option<&Path>,
    name: &str,
    dir: &str,
    inner: &str,
) -> String {
    let conf_flag = match conf {
        Some(p) => format!(" -f {}", crate::pty::shell_quote(&p.to_string_lossy())),
        None => String::new(),
    };
    format!(
        "exec {tmux}{conf} -L {socket} new-session -A -D -s {name} -c {dir} sh -c {inner}",
        tmux = crate::pty::shell_quote(&tmux.to_string_lossy()),
        conf = conf_flag,
        socket = socket(),
        name = crate::pty::shell_quote(name),
        dir = crate::pty::shell_quote(dir),
        inner = crate::pty::shell_quote(inner),
    )
}

/// Destroy one session and everything running in it. Called ONLY from destroy intents
/// (`PtyManager::kill`), never from app quit -- see the asymmetry note on `kill_all`.
pub fn kill_session(tmux: &Path, session_id: &str) {
    let _ = Command::new(tmux)
        .args([
            "-L",
            &socket(),
            "kill-session",
            "-t",
            &session_name(session_id),
        ])
        .output();
}

/// Is there already a live tmux session for this Conduit session?
///
/// Asked at spawn time, before `new-session -A` runs, because attach-or-create deliberately
/// erases the difference and afterwards nothing can tell an attach from a create. The
/// answer decides whether the scrollback snapshot is replayed: on an attach tmux repaints
/// the pane itself, so a replay would print the same screen twice.
pub fn has_session(tmux: &Path, session_id: &str) -> bool {
    Command::new(tmux)
        .args([
            "-L",
            &socket(),
            "has-session",
            "-t",
            &session_name(session_id),
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Names of every live Conduit-owned tmux session, or an empty vec if tmux is absent,
/// not running, or owns nothing.
pub fn list_sessions(tmux: &Path) -> Vec<String> {
    let out = Command::new(tmux)
        .args(["-L", &socket(), "list-sessions", "-F", "#{session_name}"])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new(); // "no server running on ..." is the normal cold case
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with(PREFIX))
        .map(str::to_string)
        .collect()
}

/// Which of `existing` no longer has a session behind it.
///
/// Pure, and computed forwards rather than backwards: `session_name` is lossy, so a name
/// cannot be decoded back into an id. Mapping the LIVE ids through the same function and
/// diffing is both correct and total.
///
/// A tmux session with no Conduit session is a real leak -- it holds a process forever and
/// nothing will ever attach to it again.
pub fn orphans(existing: &[String], live_session_ids: &[String]) -> Vec<String> {
    let live: Vec<String> = live_session_ids.iter().map(|id| session_name(id)).collect();
    existing
        .iter()
        .filter(|name| !live.contains(name))
        .cloned()
        .collect()
}

/// Kill every tmux session whose Conduit session is gone. Best-effort and silent.
pub fn sweep_orphans(tmux: &Path, live_session_ids: &[String]) {
    for name in orphans(&list_sessions(tmux), live_session_ids) {
        let _ = Command::new(tmux)
            .args(["-L", &socket(), "kill-session", "-t", &name])
            .output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_name_is_prefixed_and_sanitized() {
        assert_eq!(
            session_name("11111111-2222-3333-4444-555555555555"),
            "cdt-11111111-2222-3333-4444-555555555555"
        );
        // The companion shell's `::term` suffix — tmux parses `.` and `:` as
        // window/pane addressing, so leaving them in would make `-t` ambiguous.
        assert_eq!(session_name("abc::term"), "cdt-abc__term");
        assert_eq!(session_name("a.b:c"), "cdt-a_b_c");
    }

    #[test]
    fn session_name_is_idempotent_and_total() {
        for id in ["", "  ", "a/b", "$(rm -rf /)", "é", "a b"] {
            let n = session_name(id);
            assert!(n.starts_with("cdt-"));
            assert!(
                n.chars()
                    .skip(4)
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "{id} -> {n}"
            );
        }
    }

    #[test]
    fn distinct_ids_keep_distinct_names() {
        // Sanitization is lossy, so this is a real risk rather than a formality: two ids
        // colliding here would silently make two sessions share one agent.
        let a = session_name("11111111-2222-3333-4444-555555555555");
        let b = session_name("11111111-2222-3333-4444-555555555555::term");
        assert_ne!(a, b);
    }

    #[test]
    fn conf_hides_the_status_bar_and_takes_the_scrollback() {
        let c = conf_body(50_000);
        assert!(c.contains("set -g status off"));
        assert!(c.contains("set -g history-limit 50000"));
        assert!(c.contains("set -g mouse on"));
        assert!(c.contains("set -g set-clipboard on"));
    }

    #[test]
    fn wrap_command_attaches_or_creates_on_the_private_socket() {
        let cmd = wrap_command(
            Path::new("/opt/homebrew/bin/tmux"),
            Some(Path::new("/data/conduit.tmux.conf")),
            "cdt-s1",
            "/work/proj",
            "echo hi",
        );
        assert!(cmd.starts_with("exec '/opt/homebrew/bin/tmux'"));
        assert!(cmd.contains("-L conduit"));
        assert!(cmd.contains("new-session -A -D"));
        assert!(cmd.contains("-s 'cdt-s1'"));
        assert!(cmd.contains("-c '/work/proj'"));
        assert!(cmd.contains("-f '/data/conduit.tmux.conf'"));
        assert!(cmd.ends_with("sh -c 'echo hi'"));
    }

    #[test]
    fn wrap_command_quotes_a_hostile_inner_script() {
        // The inner script is the existing build_script output, which interpolates a
        // user-chosen initial prompt. It reaches tmux as ONE argv element or not at all.
        let inner = "claude --prompt 'it'\\''s $HOME `whoami`'";
        let cmd = wrap_command(Path::new("/usr/bin/tmux"), None, "cdt-s1", "/w", inner);
        let quoted = crate::pty::shell_quote(inner);
        assert!(cmd.ends_with(&format!("sh -c {quoted}")));
        // No unescaped single quote can terminate the argument early.
        assert!(!cmd.ends_with("sh -c 'claude --prompt 'it''"));
    }

    #[test]
    fn wrap_command_omits_the_config_flag_when_there_is_none() {
        let cmd = wrap_command(Path::new("/usr/bin/tmux"), None, "cdt-s1", "/w", "sh");
        assert!(!cmd.contains(" -f "));
        assert!(cmd.contains("-L conduit"));
    }

    #[test]
    fn orphans_are_the_names_with_no_live_session() {
        let existing = vec![
            "cdt-alive".to_string(),
            "cdt-dead".to_string(),
            "cdt-alive__term".to_string(),
        ];
        let live = vec!["alive".to_string(), "alive::term".to_string()];
        assert_eq!(orphans(&existing, &live), vec!["cdt-dead".to_string()]);
    }

    #[test]
    fn orphans_of_nothing_is_nothing() {
        assert!(orphans(&[], &["a".to_string()]).is_empty());
        // Every tmux session is an orphan when no Conduit session survives — a state
        // reachable by deleting the last project, and one that must sweep rather than
        // leave processes running forever.
        assert_eq!(orphans(&["cdt-a".to_string()], &[]), vec!["cdt-a"]);
    }

    #[test]
    fn socket_is_namespaced_by_the_data_dir_override() {
        // Serialized implicitly: these are the only tests touching this var.
        std::env::remove_var("CONDUIT_DATA_DIR_NAME");
        assert_eq!(socket(), "conduit");
        std::env::set_var("CONDUIT_DATA_DIR_NAME", "ConduitTauri");
        assert_eq!(
            socket(),
            "conduit",
            "the default name is not a separate namespace"
        );
        std::env::set_var("CONDUIT_DATA_DIR_NAME", "ConduitTauri-dev");
        assert_eq!(socket(), "conduit-ConduitTauri-dev");
        // A socket name reaches a command line, so anything exotic is flattened.
        std::env::set_var("CONDUIT_DATA_DIR_NAME", "a b/../$(x)");
        assert_eq!(socket(), "conduit-a-b------x-");
        std::env::remove_var("CONDUIT_DATA_DIR_NAME");
    }

    #[test]
    fn find_in_path_scans_and_tolerates_junk() {
        assert!(find_in_path("tmux", None).is_none());
        assert!(find_in_path("tmux", Some("")).is_none());
        assert!(find_in_path("definitely-not-a-binary", Some("/usr/bin:/bin")).is_none());
        // `sh` exists on every machine this code runs on.
        assert_eq!(
            find_in_path("sh", Some("::/nonexistent:/bin")),
            Some(PathBuf::from("/bin/sh"))
        );
    }

    #[test]
    fn a_mac_with_homebrew_just_installs_tmux() {
        let h = install_hint("macos", |b| b == "brew").unwrap();
        assert_eq!(h.command, "brew install tmux");
        assert_eq!(h.label, "Install tmux");
    }

    #[test]
    fn a_mac_without_homebrew_installs_brew_first_and_calls_it_by_absolute_path() {
        let h = install_hint("macos", |_| false).unwrap();
        assert!(
            h.command.contains("Homebrew/install"),
            "chains the official installer"
        );
        // The trap this guards: the freshly installed brew is not on the launching shell's
        // PATH, so a bare `brew install tmux` fails right after the install succeeds.
        assert!(h.command.contains("/opt/homebrew/bin/brew install tmux"));
        assert!(h.command.contains("/usr/local/bin/brew install tmux"));
        assert!(
            !h.command.contains("&& brew install"),
            "must never call a bare brew after installing it"
        );
        // The label warns that this does more than install tmux.
        assert!(h.label.contains("Homebrew"));
    }

    #[test]
    fn linux_prefers_the_debian_family_then_falls_through_the_majors() {
        let apt = install_hint("linux", |b| b == "apt-get" || b == "dnf").unwrap();
        assert!(
            apt.command.starts_with("sudo apt-get"),
            "apt wins when both exist"
        );
        for (mgr, expect) in [
            ("dnf", "sudo dnf install -y tmux"),
            ("pacman", "sudo pacman -S --noconfirm tmux"),
            ("zypper", "sudo zypper install -y tmux"),
            ("apk", "sudo apk add tmux"),
        ] {
            let h = install_hint("linux", |b| b == mgr).unwrap();
            assert_eq!(h.command, expect, "for {mgr}");
        }
    }

    #[test]
    fn nothing_is_suggested_when_nothing_sensible_exists() {
        assert!(install_hint("linux", |_| false).is_none());
        assert!(install_hint("windows", |_| true).is_none());
        assert!(install_hint("other", |_| true).is_none());
    }
}
