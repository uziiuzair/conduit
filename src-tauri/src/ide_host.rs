//! Conduit-as-IDE host: per-session WebSocket/MCP servers the `claude` CLI connects
//! back to, making Conduit a recognized Claude Code IDE (diff review, selection
//! context, at-mentions, openFile).
//!
//! Topology: ONE server per running Claude session (ephemeral port). The protocol
//! carries no client identity on the wire, and under tmux Conduit is never the
//! claude process's ancestor, so the port itself is the identity: a connection on a
//! session's port IS that session. That is what lets `openDiff` land on the right
//! pane with no pid forensics.
//!
//! Wire details (auth header, `mcp` subprotocol, the two-item FILE_SAVED contract)
//! are EMPIRICAL against claude 2.1.267 — see
//! `docs/superpowers/specs/2026-09-23-ide-integration-design.md` before "fixing"
//! anything that looks odd here.

use std::path::{Path, PathBuf};

/// 128-bit auth token as 32 lowercase hex chars — the shape claude's own IDE
/// extensions mint. Never logged, never persisted to state.json (Secrets rule);
/// it lives in memory and in the 0600 lock file, nowhere else.
pub fn mint_token() -> String {
    // No `rand` dep (lean-deps rule): /dev/urandom on unix; a time+pid FNV fold as
    // the fallback for the effectively-unheard-of read failure. Localhost-only,
    // per-spawn token — this is belt-and-braces, not a KDF.
    let mut buf = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .is_ok();
    if !ok {
        let seed = format!(
            "{:?}-{}-{:?}",
            std::time::SystemTime::now(),
            std::process::id(),
            std::time::Instant::now()
        );
        let mut h: u128 = 0xcbf29ce484222325cbf29ce484222325;
        for b in seed.bytes() {
            h ^= b as u128;
            h = h.wrapping_mul(0x100000001b3);
        }
        buf = h.to_le_bytes();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// The lock file body, exactly the fields claude 2.1.267 parses. `runningInWindows`
/// only on Windows builds (it exists for WSL bridging: it tells a WSL claude to dial
/// the Windows host instead of localhost).
pub fn lock_json(pid: u32, dir: &str, token: &str) -> String {
    let mut v = serde_json::json!({
        "pid": pid,
        "workspaceFolders": [dir],
        "ideName": "Conduit",
        "transport": "ws",
        "authToken": token,
    });
    if cfg!(windows) {
        v["runningInWindows"] = serde_json::Value::Bool(true);
    }
    v.to_string()
}

/// Where THIS session's claude looks for lock files. Mirrors
/// `agent::claude_profile_env`: a `.claude`-rooted account redirects HOME to the
/// profile root (claude then reads `<root>/.claude/ide` — which IS `<dir>/ide`);
/// any other explicit dir becomes CLAUDE_CONFIG_DIR (claude reads `<dir>/ide`);
/// ambient is `~/.claude/ide`. Both explicit routes collapse to `<dir>/ide`, which
/// is why there is no `.claude`-suffix branch here — the test documents both.
/// Writing to the real home for a redirected session would announce to a claude
/// that can never see it.
pub fn lock_dir(account_config_dir: Option<&str>, home: &Path) -> PathBuf {
    match account_config_dir {
        Some(d) => PathBuf::from(d).join("ide"),
        None => home.join(".claude").join("ide"),
    }
}

/// Sweep guard: only files WE wrote are ever candidates. Unparseable contents are
/// not ours (claude itself tolerates a legacy newline-list format — leave those to
/// their owner).
pub fn is_conduit_lock(contents: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(contents)
        .ok()
        .is_some_and(|v| v["ideName"] == "Conduit")
}

/// Startup hygiene: remove OUR stale lock files (ideName == "Conduit") whose port no
/// longer answers. The probe is injected so tests need no sockets; production passes
/// a TCP connect. Deliberately keyed on "is anything listening" rather than pid
/// liveness — that is the actual question, and it needs no platform-split syscall.
pub fn sweep_lock_dir(dir: &Path, probe: &dyn Fn(u16) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(port) = name
            .to_str()
            .and_then(|n| n.strip_suffix(".lock"))
            .and_then(|p| p.parse::<u16>().ok())
        else {
            continue;
        };
        let Ok(contents) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        if is_conduit_lock(&contents) && !probe(port) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_32_lowercase_hex() {
        let t = mint_token();
        assert_eq!(t.len(), 32);
        assert!(t
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(mint_token(), t); // not constant
    }

    #[test]
    fn lock_json_has_exact_field_names() {
        let j: serde_json::Value = serde_json::from_str(&lock_json(42, "/w", "abc")).unwrap();
        assert_eq!(j["pid"], 42);
        assert_eq!(j["workspaceFolders"], serde_json::json!(["/w"]));
        assert_eq!(j["ideName"], "Conduit");
        assert_eq!(j["transport"], "ws");
        assert_eq!(j["authToken"], "abc");
        // exactly the five keys claude reads (+ runningInWindows on windows builds)
        let n = j.as_object().unwrap().len();
        assert_eq!(n, if cfg!(windows) { 6 } else { 5 });
    }

    #[test]
    fn lock_dir_follows_the_profile_redirect() {
        let home = Path::new("/home/u");
        // ambient: ~/.claude/ide
        assert_eq!(lock_dir(None, home), home.join(".claude/ide"));
        // `.claude`-rooted profile: HOME is redirected, so the lock goes to the profile
        assert_eq!(
            lock_dir(Some("/profiles/work/.claude"), home),
            Path::new("/profiles/work/.claude/ide")
        );
        // custom dir (CLAUDE_CONFIG_DIR case): <config_dir>/ide
        assert_eq!(
            lock_dir(Some("/opt/claudecfg"), home),
            Path::new("/opt/claudecfg/ide")
        );
    }

    #[test]
    fn only_conduit_locks_are_sweepable() {
        assert!(is_conduit_lock(r#"{"ideName":"Conduit","pid":1}"#));
        assert!(!is_conduit_lock(r#"{"ideName":"VS Code","pid":1}"#));
        assert!(!is_conduit_lock("not json"));
    }

    #[test]
    fn sweep_removes_only_dead_conduit_locks() {
        let dir = std::env::temp_dir().join(format!("ide-sweep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("1001.lock"), r#"{"ideName":"Conduit"}"#).unwrap();
        std::fs::write(dir.join("1002.lock"), r#"{"ideName":"Conduit"}"#).unwrap();
        std::fs::write(dir.join("1003.lock"), r#"{"ideName":"VS Code"}"#).unwrap();
        // probe: 1002 is "still listening", everything else dead
        sweep_lock_dir(&dir, &|port| port == 1002);
        assert!(!dir.join("1001.lock").exists(), "dead Conduit lock swept");
        assert!(dir.join("1002.lock").exists(), "live Conduit lock kept");
        assert!(
            dir.join("1003.lock").exists(),
            "other IDE's lock never touched"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
