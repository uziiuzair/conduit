//! Finding the conversation a Claude session actually moved on to.
//!
//! Conduit pins a Claude session's first conversation to its own session id and, until the
//! `SessionStart` capture in `hooks.rs`, never learned about any later one. A `/clear` starts
//! a new conversation under a new id, so a restart resumed the conversation from BEFORE the
//! clear, and everything since looked lost. It is still on disk, just unclaimed.
//!
//! The link from the old conversation to its successor is exact, not a guess. Claude writes
//! every prompt to `<config>/history.jsonl` with the id of the conversation it was typed in,
//! `/clear` included. The conversation it starts opens with a `SessionStart:clear` hook
//! record, timestamped within a moment of that history entry. So `/clear` typed in X at T,
//! plus an unclaimed transcript in X's folder that began with a clear at T, means X moved to
//! it. Following that repeatedly walks several clears to the conversation the user was really
//! on.
//!
//! Everything here is read-only. Adopting a candidate is a separate, explicit step
//! (`adopt_claude_conversation` in lib.rs).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// How far apart the `/clear` history entry and the new conversation's first record may be.
/// Measured on real data they are milliseconds apart; the slack absorbs a slow disk and
/// clock skew between Claude's two writers without admitting a neighbouring session's clear.
const LINK_WINDOW_MS: i64 = 10_000;

/// How much of a transcript's head to read when looking for the clear marker. It sits within
/// the first handful of records; the cap keeps a scan over hundreds of files cheap.
const HEAD_BYTES: u64 = 64 * 1024;

/// A `/clear` typed into conversation `from` at `at_ms`, from Claude's prompt history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clear {
    pub from: String,
    pub at_ms: i64,
}

/// A session whose tracked conversation has a newer successor on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftCandidate {
    pub project_id: String,
    pub project_name: String,
    pub session_id: String,
    pub session_name: String,
    /// The conversation Conduit would resume today.
    pub current_conversation: String,
    /// The conversation the session actually ended up on.
    pub latest_conversation: String,
    /// How many clears separate the two.
    pub clears: usize,
    /// Last write to the latest conversation's transcript, epoch ms.
    pub latest_updated_at: u64,
    /// What the human first said in it, so the offer is recognisable (may be empty).
    pub latest_title: String,
    /// Transcript size -- a two-line conversation and a day's work read very differently.
    pub latest_bytes: u64,
    /// Other conversations this session's clears led to, besides `latest_conversation`.
    /// A conversation resumed after its clear (every pre-fix restart did exactly that) and
    /// then cleared AGAIN forks: the newest branch is where the user is now, but an older
    /// branch can hold the work the restart appeared to lose. Most recently active first.
    pub other_branches: Vec<Branch>,
}

/// One end of a fork in a session's clear history.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub conversation: String,
    pub clears: usize,
    pub updated_at: u64,
    pub title: String,
    pub bytes: u64,
}

/// Every `/clear` in a `history.jsonl` body. Lines that are not a clear, or that predate
/// Claude recording the conversation id, are skipped.
pub fn parse_clears(history: &str) -> Vec<Clear> {
    history
        .lines()
        .filter(|l| l.contains("/clear"))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("display").and_then(Value::as_str).map(str::trim) == Some("/clear"))
        .filter_map(|v| {
            let from = v.get("sessionId")?.as_str()?.trim();
            let at_ms = v.get("timestamp")?.as_i64()?;
            (!from.is_empty()).then(|| Clear {
                from: from.to_string(),
                at_ms,
            })
        })
        .collect()
}

/// If this transcript head is a conversation that STARTED with a clear, when it started
/// (the earliest timestamp in the head, epoch ms). `None` for any other conversation.
pub fn continuation_start(head: &str) -> Option<i64> {
    if !head.contains("SessionStart:clear") {
        return None;
    }
    head.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v.get("timestamp")?.as_str().and_then(iso_to_ms))
        .min()
}

/// Walk `start`'s clears forward to the newest conversation. `continuations` maps each
/// unclaimed transcript in the same folder that began with a clear to its start time.
/// Returns the chain in order (empty when the session never moved).
pub fn follow_chain(
    start: &str,
    clears: &[Clear],
    continuations: &HashMap<String, i64>,
) -> Vec<String> {
    let mut chain: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::from([start.to_string()]);
    let mut cur = start.to_string();
    // A conversation resumed after its clear can be cleared again later, so it may have
    // more than one successor: the LATEST clear is where the user went last.
    while let Some(next) = successors(&cur, clears, continuations, &seen)
        .into_iter()
        .next()
    {
        seen.insert(next.clone());
        chain.push(next.clone());
        cur = next;
    }
    chain
}

/// The conversation each of `from`'s clears led to, newest clear first. A continuation is
/// linked to the clear it started within [`LINK_WINDOW_MS`] of, the closest one winning.
fn successors(
    from: &str,
    clears: &[Clear],
    continuations: &HashMap<String, i64>,
    seen: &HashSet<String>,
) -> Vec<String> {
    let mut from_here: Vec<&Clear> = clears.iter().filter(|c| c.from == from).collect();
    from_here.sort_by_key(|c| std::cmp::Reverse(c.at_ms));
    let mut out: Vec<String> = Vec::new();
    for c in from_here {
        let next = continuations
            .iter()
            .filter(|(id, started)| {
                !seen.contains(*id)
                    && !out.contains(id)
                    && (**started - c.at_ms).abs() <= LINK_WINDOW_MS
            })
            .min_by_key(|(_, started)| (**started - c.at_ms).abs())
            .map(|(id, _)| id.clone());
        out.extend(next);
    }
    out
}

/// Every conversation `start`'s clears eventually lead to that was not itself cleared
/// onward, with how many clears away it is. Includes the [`follow_chain`] end.
pub fn branch_ends(
    start: &str,
    clears: &[Clear],
    continuations: &HashMap<String, i64>,
) -> Vec<(String, usize)> {
    let mut seen: HashSet<String> = HashSet::from([start.to_string()]);
    let mut ends: Vec<(String, usize)> = Vec::new();
    let mut stack: Vec<(String, usize)> = vec![(start.to_string(), 0)];
    while let Some((cur, depth)) = stack.pop() {
        let next = successors(&cur, clears, continuations, &seen);
        if next.is_empty() {
            if depth > 0 {
                ends.push((cur, depth));
            }
            continue;
        }
        for n in next {
            seen.insert(n.clone());
            stack.push((n, depth + 1));
        }
    }
    ends
}

/// `2026-09-18T08:26:30.713Z` -> epoch ms. Only the UTC `Z` form Claude writes is accepted.
pub fn iso_to_ms(s: &str) -> Option<i64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let digits: String = frac.chars().take(3).collect();
    let ms = format!("{digits:0<3}").parse::<i64>().ok()?;
    // Days from the civil calendar (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 + ms)
}

fn read_head(path: &Path) -> Option<String> {
    let mut buf = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(HEAD_BYTES)
        .read_to_end(&mut buf)
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// `(last write epoch ms, size in bytes)`; zeros when unreadable.
fn stat(path: &Path) -> (u64, u64) {
    let Ok(meta) = fs::metadata(path) else {
        return (0, 0);
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (mtime, meta.len())
}

fn title(path: &Path) -> String {
    read_head(path)
        .map(|h| crate::transcript_index::title_of(&h))
        .unwrap_or_default()
}

/// Unclaimed transcripts in `dir` that began with a clear, by id -> start time.
fn continuations_in(dir: &Path, claimed: &HashSet<String>) -> HashMap<String, i64> {
    let Ok(entries) = fs::read_dir(dir) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let id = p.file_stem()?.to_str()?.to_string();
            if claimed.contains(&id) {
                return None;
            }
            let started = continuation_start(&read_head(&p)?)?;
            Some((id, started))
        })
        .collect()
}

/// Every Claude session whose tracked conversation has a newer successor on disk.
pub fn scan(store: &crate::store::Store) -> Vec<DriftCandidate> {
    let projects = store.list();
    let claimed: HashSet<String> = projects
        .iter()
        .flat_map(|p| &p.sessions)
        .flat_map(|s| std::iter::once(s.id.clone()).chain(s.agent_conversation_id.clone()))
        .collect();

    // One history per transcript store (a store is `<config>/projects`, its history lives
    // at `<config>/history.jsonl`), one continuation index per project folder.
    let mut clears_by_store: HashMap<PathBuf, Vec<Clear>> = HashMap::new();
    let mut conts_by_dir: HashMap<PathBuf, HashMap<String, i64>> = HashMap::new();
    let mut out: Vec<DriftCandidate> = Vec::new();

    for project in &projects {
        for session in &project.sessions {
            if session.agent != crate::agent::AgentId::Claude {
                continue;
            }
            let Some(store_dir) = crate::pty::session_projects_dir(store, &session.id) else {
                continue;
            };
            let current = store.claude_conversation_id(&session.id);
            let Some(dir) = crate::pty::transcript_path(&current, &store_dir)
                .and_then(|p| p.parent().map(Path::to_path_buf))
            else {
                continue;
            };
            let clears = clears_by_store.entry(store_dir.clone()).or_insert_with(|| {
                store_dir
                    .parent()
                    .and_then(|cfg| fs::read_to_string(cfg.join("history.jsonl")).ok())
                    .map(|h| parse_clears(&h))
                    .unwrap_or_default()
            });
            if !clears.iter().any(|c| c.from == current) {
                continue; // never cleared: skip the folder scan entirely
            }
            let conts = conts_by_dir
                .entry(dir.clone())
                .or_insert_with(|| continuations_in(&dir, &claimed));
            let chain = follow_chain(&current, clears, conts);
            let Some(latest) = chain.last() else { continue };
            let transcript = |id: &str| dir.join(format!("{id}.jsonl"));
            let mut other_branches: Vec<Branch> = branch_ends(&current, clears, conts)
                .into_iter()
                .filter(|(id, _)| id != latest)
                .map(|(id, depth)| {
                    let path = transcript(&id);
                    let (updated_at, bytes) = stat(&path);
                    Branch {
                        title: title(&path),
                        conversation: id,
                        clears: depth,
                        updated_at,
                        bytes,
                    }
                })
                .collect();
            other_branches.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
            let (latest_updated_at, latest_bytes) = stat(&transcript(latest));
            out.push(DriftCandidate {
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                session_id: session.id.clone(),
                session_name: session.name.clone(),
                current_conversation: current.clone(),
                latest_conversation: latest.clone(),
                clears: chain.len(),
                latest_updated_at,
                latest_title: title(&transcript(latest)),
                latest_bytes,
                other_branches,
            });
        }
    }

    // Two sessions must never be offered the same conversation. The exact link makes this
    // unreachable in practice; if it ever happens, offering neither is the safe answer.
    let mut counts: HashMap<String, usize> = HashMap::new();
    for c in &out {
        *counts.entry(c.latest_conversation.clone()).or_default() += 1;
    }
    out.retain(|c| counts[&c.latest_conversation] == 1);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clear(from: &str, at_ms: i64) -> Clear {
        Clear {
            from: from.into(),
            at_ms,
        }
    }

    #[test]
    fn history_yields_only_clears_with_a_conversation_id() {
        let history = [
            r#"{"display":"/clear","project":"/r","sessionId":"a","timestamp":100}"#,
            r#"{"display":"fix the /clear button","sessionId":"a","timestamp":200}"#,
            r#"{"display":"/clear ","project":"/r","sessionId":"b","timestamp":300}"#,
            r#"{"display":"/clear","project":"/r","timestamp":400}"#,
            r#"not json /clear"#,
        ]
        .join("\n");
        assert_eq!(
            parse_clears(&history),
            vec![clear("a", 100), clear("b", 300)]
        );
    }

    #[test]
    fn only_a_conversation_that_began_with_a_clear_is_a_continuation() {
        let head = [
            r#"{"type":"mode","sessionId":"n"}"#,
            r#"{"type":"user","timestamp":"2026-09-18T08:26:30.713Z"}"#,
            r#"{"type":"user","timestamp":"2026-09-18T08:26:30.628Z"}"#,
            r#"{"type":"attachment","attachment":{"hookName":"SessionStart:clear"}}"#,
        ]
        .join("\n");
        assert_eq!(
            continuation_start(&head),
            iso_to_ms("2026-09-18T08:26:30.628Z")
        );
        let fresh = r#"{"type":"attachment","attachment":{"hookName":"SessionStart:startup"}}"#;
        assert_eq!(continuation_start(fresh), None);
    }

    #[test]
    fn iso_timestamps_convert_to_epoch_ms() {
        assert_eq!(iso_to_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_to_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(
            iso_to_ms("2026-09-18T08:26:30.713Z"),
            Some(1_789_719_990_713)
        );
        assert_eq!(iso_to_ms("2000-02-29T12:00:00.5Z"), Some(951_825_600_500));
        assert_eq!(iso_to_ms("2026-09-18T08:26:30"), None, "no zone");
        assert_eq!(iso_to_ms("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn the_chain_follows_every_clear_to_the_newest_conversation() {
        let clears = [
            clear("pin", 1_000),
            clear("c1", 50_000),
            clear("other", 90_000),
        ];
        let conts = HashMap::from([
            ("c1".to_string(), 1_004),
            ("c2".to_string(), 50_002),
            ("unrelated".to_string(), 90_001),
        ]);
        assert_eq!(follow_chain("pin", &clears, &conts), vec!["c1", "c2"]);
        // A session that was never cleared has nowhere to go.
        assert!(follow_chain("quiet", &clears, &conts).is_empty());
    }

    #[test]
    fn a_neighbouring_clear_outside_the_window_is_not_linked() {
        let clears = [clear("pin", 1_000)];
        let conts = HashMap::from([("far".to_string(), 1_000 + LINK_WINDOW_MS + 1)]);
        assert!(follow_chain("pin", &clears, &conts).is_empty());
    }

    #[test]
    fn a_conversation_cleared_twice_follows_its_latest_clear() {
        // Resumed after its first clear (the pre-fix restart), then cleared again: the
        // second successor is where the user actually went last.
        let clears = [clear("pin", 1_000), clear("pin", 500_000)];
        let conts = HashMap::from([("early".to_string(), 1_001), ("late".to_string(), 500_001)]);
        assert_eq!(follow_chain("pin", &clears, &conts), vec!["late"]);
    }

    #[test]
    fn a_fork_reports_every_branch_end() {
        // pin -> early -> deep (the pre-crash work), and pin resumed after a restart and
        // cleared again -> late (where the user is now).
        let clears = [
            clear("pin", 1_000),
            clear("early", 2_000),
            clear("pin", 500_000),
        ];
        let conts = HashMap::from([
            ("early".to_string(), 1_001),
            ("deep".to_string(), 2_001),
            ("late".to_string(), 500_001),
        ]);
        assert_eq!(follow_chain("pin", &clears, &conts), vec!["late"]);
        let mut ends = branch_ends("pin", &clears, &conts);
        ends.sort();
        assert_eq!(ends, vec![("deep".to_string(), 2), ("late".to_string(), 1)]);
        assert!(branch_ends("quiet", &clears, &conts).is_empty());
    }

    #[test]
    fn a_cycle_in_the_links_terminates() {
        let clears = [clear("a", 1_000), clear("b", 2_000)];
        let conts = HashMap::from([("b".to_string(), 1_000), ("a".to_string(), 2_000)]);
        assert_eq!(follow_chain("a", &clears, &conts), vec!["b"]);
    }
}
