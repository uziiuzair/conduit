//! Reap long-idle DETACHED tmux sessions under memory pressure.
//!
//! Session persistence deliberately lets agents outlive the app, and the orphan sweep only
//! removes sessions whose Conduit session was deleted. A session that still exists but has
//! been abandoned for days keeps its agent process — and its memory — forever. nodeterm's
//! field report on the same design: 95 sessions and 34 GB of idle agent processes on one
//! host.
//!
//! This is a BUDGET, not an expiry, and the difference matters. Nothing is reaped on a
//! healthy machine no matter how old a session is; sessions are only retired when the host
//! is actually short of memory (or when the count has run away entirely). The rules are the
//! ones a cache eviction uses: never evict what is in use, protect the recently touched,
//! and converge gradually rather than mass-killing toward a target in one pass.
//!
//! The safety contract is what makes it acceptable: a reap kills the tmux session and
//! NOTHING else — not the scrollback snapshot, not the session record, not the transcript.
//! To Conduit a reaped session is indistinguishable from one that lost its tmux server to a
//! reboot: the next open finds no session, replays the snapshot (`scrollback`), and resumes
//! the agent. Break that and the reaper stops being safe.

#![cfg(not(windows))]

use std::path::Path;
use std::process::Command;

/// One tmux session as reported by `list-sessions`.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionInfo {
    pub name: String,
    /// A client (i.e. a Conduit PTY) is attached right now.
    pub attached: bool,
    /// Last activity, in epoch seconds.
    pub activity_sec: i64,
}

/// Host memory in MB. `None` from the reader means "could not read", which is a different
/// statement from "plenty" and is handled as such: the pressure trigger simply does not
/// fire, rather than guessing a number.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MemInfo {
    pub available_mb: u64,
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Kill switch (`CONDUIT_SESSION_REAP_DISABLED=1`): every sweep becomes a no-op.
    pub disabled: bool,
    /// Reap only while host available memory is below this — the primary trigger.
    pub min_available_mb: u64,
    /// Backstop: the most detached sessions to keep even on a host with memory to spare.
    pub max_detached: usize,
    /// A session touched more recently than this is never reaped.
    pub grace_sec: i64,
    /// Most kills per sweep. Convergence is gradual and re-evaluated next sweep.
    pub batch_max: usize,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            disabled: false,
            // Below ~1.5 GB available, a Mac is already swapping and another idle agent is
            // the difference between slow and unusable.
            min_available_mb: 1536,
            // Well past any plausible working set; this only catches genuine runaway.
            max_detached: 24,
            // Six hours protects a same-day project switch, which is the case where a
            // reap would be most annoying and least useful.
            grace_sec: 6 * 60 * 60,
            batch_max: 4,
        }
    }
}

impl Config {
    /// Config with the env overrides applied.
    pub fn from_env() -> Self {
        let base = Config::default();
        Config {
            disabled: std::env::var("CONDUIT_SESSION_REAP_DISABLED").as_deref() == Ok("1"),
            min_available_mb: env_num("CONDUIT_SESSION_REAP_MIN_MB")
                .unwrap_or(base.min_available_mb),
            max_detached: env_num("CONDUIT_SESSION_REAP_MAX_DETACHED")
                .map(|v| v as usize)
                .unwrap_or(base.max_detached),
            ..base
        }
    }
}

fn env_num(key: &str) -> Option<u64> {
    std::env::var(key).ok()?.trim().parse().ok()
}

/// Which sessions to reap this sweep, most-stale first. Pure.
///
/// Returns empty unless something is actually wrong: under the memory watermark, or more
/// detached sessions than the cap allows. When only the COUNT trigger fires, just the excess
/// is taken — a host with memory to spare has no reason to go below its own cap.
pub fn plan_reap(
    sessions: &[SessionInfo],
    mem: Option<MemInfo>,
    cfg: &Config,
    now_sec: i64,
) -> Vec<String> {
    if cfg.disabled {
        return Vec::new();
    }

    // Attached = someone is looking at it. Never a candidate, at any pressure.
    let detached: Vec<&SessionInfo> = sessions.iter().filter(|s| !s.attached).collect();

    // An unreadable memory figure must not be read as pressure. Only the count backstop
    // applies then, which needs no memory reading at all.
    let under_pressure = mem.is_some_and(|m| m.available_mb < cfg.min_available_mb);
    let over_cap = detached.len().saturating_sub(cfg.max_detached);
    if !under_pressure && over_cap == 0 {
        return Vec::new();
    }

    // Recently active is protected even under pressure: the session someone was using ten
    // minutes ago is the one they are about to come back to.
    let mut eligible: Vec<&SessionInfo> = detached
        .into_iter()
        .filter(|s| now_sec.saturating_sub(s.activity_sec) > cfg.grace_sec)
        .collect();

    // Least-recently-active first — the same choice an LRU cache makes, for the same reason.
    eligible.sort_by_key(|s| s.activity_sec);

    let want = if under_pressure {
        cfg.batch_max
    } else {
        over_cap.min(cfg.batch_max)
    };
    eligible
        .into_iter()
        .take(want)
        .map(|s| s.name.clone())
        .collect()
}

/// Conduit-owned tmux sessions with their attach state and last activity.
pub fn list_sessions(tmux: &Path) -> Vec<SessionInfo> {
    let out = Command::new(tmux)
        .args([
            "-L",
            &crate::tmux::socket(),
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_attached}\t#{session_activity}",
        ])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new(); // "no server running" is the normal cold case
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_session_line)
        .collect()
}

/// One `list-sessions` line into a `SessionInfo`. Pure; tolerant of anything unexpected.
pub fn parse_session_line(line: &str) -> Option<SessionInfo> {
    let mut parts = line.trim().splitn(3, '\t');
    let name = parts.next()?.trim().to_string();
    if !name.starts_with(crate::tmux::PREFIX) {
        return None; // someone else's session on a shared socket — not ours to reap
    }
    let attached = parts.next()?.trim() != "0";
    let activity_sec = parts.next()?.trim().parse().ok()?;
    Some(SessionInfo {
        name,
        attached,
        activity_sec,
    })
}

/// Available host memory in MB, or `None` when it cannot be read.
pub fn mem_info() -> Option<MemInfo> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        // MemAvailable is the kernel's own estimate of what a new workload could get —
        // strictly better than free+cached arithmetic, and it has been there since 3.14.
        let kb: u64 = text
            .lines()
            .find_map(|l| l.strip_prefix("MemAvailable:"))?
            .split_whitespace()
            .next()?
            .parse()
            .ok()?;
        Some(MemInfo {
            available_mb: kb / 1024,
        })
    }
    #[cfg(target_os = "macos")]
    {
        // macOS has no MemAvailable. `vm_stat` reports page counts; free + inactive +
        // speculative is the conventional stand-in for "could be handed to a new process".
        let out = Command::new("/usr/bin/vm_stat").output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let page_size = parse_vm_stat_page_size(&text).unwrap_or(4096);
        let pages = parse_vm_stat_pages(&text)?;
        Some(MemInfo {
            available_mb: pages.saturating_mul(page_size) / (1024 * 1024),
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

/// `vm_stat`'s page size from its header line. Pure.
pub fn parse_vm_stat_page_size(text: &str) -> Option<u64> {
    let line = text.lines().next()?;
    let after = line.split("page size of ").nth(1)?;
    after.split_whitespace().next()?.parse().ok()
}

/// Free + inactive + speculative pages from `vm_stat`. Pure.
pub fn parse_vm_stat_pages(text: &str) -> Option<u64> {
    let field = |label: &str| -> Option<u64> {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(label))?
            .trim()
            .trim_start_matches(':')
            .trim()
            .trim_end_matches('.')
            .parse()
            .ok()
    };
    let free = field("Pages free")?;
    // Inactive pages are reclaimable; speculative are read-ahead nobody has asked for.
    let inactive = field("Pages inactive").unwrap_or(0);
    let speculative = field("Pages speculative").unwrap_or(0);
    Some(free + inactive + speculative)
}

/// One sweep: plan, then kill. Returns the names reaped.
///
/// Kills the tmux session and nothing else — see the module note. `sessions` is passed in
/// so the caller can exclude anything it knows better about.
pub fn sweep(tmux: &Path, cfg: &Config, now_sec: i64) -> Vec<String> {
    let doomed = plan_reap(&list_sessions(tmux), mem_info(), cfg, now_sec);
    for name in &doomed {
        let _ = Command::new(tmux)
            .args(["-L", &crate::tmux::socket(), "kill-session", "-t", name])
            .output();
    }
    doomed
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3600;
    const NOW: i64 = 1_800_000_000;

    fn s(name: &str, attached: bool, age_hours: i64) -> SessionInfo {
        SessionInfo {
            name: format!("cdt-{name}"),
            attached,
            activity_sec: NOW - age_hours * HOUR,
        }
    }

    fn tight() -> Option<MemInfo> {
        Some(MemInfo { available_mb: 400 })
    }
    fn roomy() -> Option<MemInfo> {
        Some(MemInfo {
            available_mb: 16_000,
        })
    }

    #[test]
    fn a_healthy_host_reaps_nothing_however_old_the_sessions_are() {
        // The whole point of a budget rather than an expiry: age alone is not a reason.
        let list = vec![s("a", false, 500), s("b", false, 900)];
        assert!(plan_reap(&list, roomy(), &Config::default(), NOW).is_empty());
    }

    #[test]
    fn an_attached_session_is_never_reaped_at_any_pressure() {
        let list = vec![s("watching", true, 9_000)];
        assert!(plan_reap(&list, tight(), &Config::default(), NOW).is_empty());
    }

    #[test]
    fn a_recently_active_session_is_protected_by_the_grace_window() {
        // Someone switched projects an hour ago; they are coming back.
        let list = vec![s("recent", false, 1)];
        assert!(plan_reap(&list, tight(), &Config::default(), NOW).is_empty());
    }

    #[test]
    fn under_pressure_the_least_recently_active_go_first() {
        let list = vec![
            s("newest", false, 7),
            s("oldest", false, 400),
            s("middle", false, 40),
        ];
        let cfg = Config {
            batch_max: 2,
            ..Config::default()
        };
        assert_eq!(
            plan_reap(&list, tight(), &cfg, NOW),
            vec!["cdt-oldest".to_string(), "cdt-middle".to_string()]
        );
    }

    #[test]
    fn a_sweep_never_kills_more_than_its_batch() {
        let list: Vec<SessionInfo> = (0..50)
            .map(|i| s(&format!("s{i}"), false, 100 + i))
            .collect();
        let out = plan_reap(&list, tight(), &Config::default(), NOW);
        assert_eq!(out.len(), Config::default().batch_max);
    }

    #[test]
    fn the_count_backstop_takes_only_the_excess_when_memory_is_fine() {
        let cfg = Config {
            max_detached: 3,
            batch_max: 10,
            ..Config::default()
        };
        let list: Vec<SessionInfo> = (0..5)
            .map(|i| s(&format!("s{i}"), false, 100 + i))
            .collect();
        let out = plan_reap(&list, roomy(), &cfg, NOW);
        assert_eq!(
            out.len(),
            2,
            "5 detached, cap 3 — take the 2 stalest, no more"
        );
        assert_eq!(out[0], "cdt-s4", "and they are the least recently active");
    }

    #[test]
    fn unreadable_memory_is_not_treated_as_pressure() {
        // `None` means "could not measure", which must not become "must be low".
        let list = vec![s("a", false, 500)];
        assert!(plan_reap(&list, None, &Config::default(), NOW).is_empty());
        // The count backstop still works without any memory reading at all.
        let cfg = Config {
            max_detached: 0,
            ..Config::default()
        };
        assert_eq!(plan_reap(&list, None, &cfg, NOW), vec!["cdt-a".to_string()]);
    }

    #[test]
    fn the_kill_switch_stops_everything() {
        let cfg = Config {
            disabled: true,
            max_detached: 0,
            ..Config::default()
        };
        let list = vec![s("a", false, 9_000)];
        assert!(plan_reap(&list, tight(), &cfg, NOW).is_empty());
    }

    #[test]
    fn session_lines_parse_and_foreign_sessions_are_ignored() {
        assert_eq!(
            parse_session_line("cdt-abc\t0\t1700000000"),
            Some(SessionInfo {
                name: "cdt-abc".into(),
                attached: false,
                activity_sec: 1_700_000_000,
            })
        );
        assert!(
            parse_session_line("cdt-abc\t1\t1700000000")
                .unwrap()
                .attached
        );
        // Not ours: a session on the socket that Conduit did not create.
        assert!(parse_session_line("someone-else\t0\t1700000000").is_none());
        // Junk of every shape is skipped rather than panicking.
        for junk in ["", "cdt-abc", "cdt-abc\t0", "cdt-abc\t0\tnotanumber"] {
            assert!(parse_session_line(junk).is_none(), "for {junk:?}");
        }
    }

    #[test]
    fn vm_stat_output_parses() {
        let text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
                    Pages free:                              100.\n\
                    Pages active:                            900.\n\
                    Pages inactive:                          200.\n\
                    Pages speculative:                        50.\n";
        assert_eq!(parse_vm_stat_page_size(text), Some(16384));
        assert_eq!(parse_vm_stat_pages(text), Some(350));
    }

    #[test]
    fn vm_stat_missing_fields_degrade_instead_of_failing() {
        let text = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n\
                    Pages free:                              10.\n";
        assert_eq!(parse_vm_stat_pages(text), Some(10));
        // No page-size header at all: the caller falls back to 4096 rather than dividing by
        // nothing, and an output with no "Pages free" is simply unreadable.
        assert_eq!(parse_vm_stat_page_size("garbage"), None);
        assert_eq!(parse_vm_stat_pages("garbage"), None);
    }
}
