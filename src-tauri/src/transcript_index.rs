//! Search across past conversations.
//!
//! Conduit could search files and file contents but never what was actually *said* — the
//! transcripts were only ever read one session at a time, by the mobile bridge. This walks
//! Claude's transcript store, pulls the human-readable text out of each `.jsonl`, and ranks
//! sessions against a query.
//!
//! Deliberately not a persistent index. The corpus is a few hundred files, the extraction
//! is capped, and a search runs on demand from a palette keystroke — an index would add a
//! staleness problem and a schema to migrate in exchange for milliseconds nobody notices.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// Most searchable text kept per transcript.
///
/// A long session's transcript is mostly tool output — file contents, diffs, command
/// results — which is not what anyone is searching for and would dominate the corpus. The
/// cap keeps the scan bounded and the matches meaningful.
pub const TEXT_CAP: usize = 200 * 1024;

/// Most bytes read per transcript file before extraction.
const READ_CAP: u64 = 2 * 1024 * 1024;

/// One matching past conversation.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptHit {
    /// The session id — the transcript's filename, and the key that ties a hit back to a
    /// session Conduit still knows about.
    pub session_id: String,
    /// First thing the human said, as a name for the conversation.
    pub title: String,
    /// The matched text with a little context either side.
    pub snippet: String,
    /// Working directory the session ran in, when the transcript says.
    pub cwd: String,
    /// File mtime in epoch ms — recency, and the tiebreak between equal matches.
    pub updated_at: u64,
}

/// Human-readable text from raw transcript JSONL: what was said, not what was run.
///
/// Tool inputs and results are skipped. They are the bulk of a transcript and the least
/// searchable part of it — someone looking for "the session where we discussed the tmux
/// socket" wants the sentence, not the 4,000-line file that was read next to it.
pub fn extract_text(raw: &str) -> String {
    let mut out = String::new();
    for line in raw.lines() {
        if out.len() >= TEXT_CAP {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let Some(content) = v.pointer("/message/content") else {
            continue;
        };
        if let Some(s) = content.as_str() {
            push_text(&mut out, s);
            continue;
        }
        let Some(blocks) = content.as_array() else {
            continue;
        };
        for b in blocks {
            // `text` blocks only: a `tool_use` or `tool_result` block is machinery.
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                    push_text(&mut out, s);
                }
            }
        }
    }
    out
}

fn push_text(out: &mut String, s: &str) {
    let s = s.trim();
    if s.is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    let room = TEXT_CAP.saturating_sub(out.len());
    if s.len() <= room {
        out.push_str(s);
    } else {
        // Truncate on a char boundary — the cap must not split a codepoint.
        let mut end = room;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&s[..end]);
    }
}

/// A name for the conversation: the first thing the human said, trimmed to one line.
pub fn title_of(raw: &str) -> String {
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let content = v.pointer("/message/content");
        let text = match content {
            Some(c) if c.is_string() => c.as_str().unwrap_or("").to_string(),
            Some(c) => c
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default(),
            None => String::new(),
        };
        let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !one_line.is_empty() {
            return one_line.chars().take(90).collect();
        }
    }
    String::new()
}

/// The session's working directory, read from the first line that carries one.
///
/// Every Claude transcript line has `cwd`, which is reliable — decoding the dashed
/// project-slug directory name back into a path is not.
pub fn cwd_of(raw: &str) -> String {
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
            if !c.is_empty() {
                return c.to_string();
            }
        }
    }
    String::new()
}

/// A window of `text` around the first case-insensitive match of `query`.
///
/// Returns an empty string when the query is not present, which is how the caller tells a
/// match from a miss — matching and snippeting are the same scan, so doing them twice would
/// be the only wasteful thing here.
pub fn snippet(text: &str, query: &str, radius: usize) -> String {
    if query.is_empty() {
        return String::new();
    }
    let hay = text.to_lowercase();
    let needle = query.to_lowercase();
    let Some(at) = hay.find(&needle) else {
        return String::new();
    };
    let mut start = at.saturating_sub(radius);
    let mut end = (at + needle.len() + radius).min(text.len());
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    let core: String = text[start..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < text.len() { "…" } else { "" };
    format!("{prefix}{core}{suffix}")
}

/// Every transcript under a projects dir, as `(session_id, path, mtime_ms)`.
fn transcript_files(projects_dir: &Path) -> Vec<(String, PathBuf, u64)> {
    let Ok(slugs) = std::fs::read_dir(projects_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for slug in slugs.flatten() {
        let Ok(files) = std::fs::read_dir(slug.path()) else {
            continue;
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Some(id) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let mtime = f
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push((id.to_string(), p, mtime));
        }
    }
    out
}

fn read_capped(path: &Path) -> Option<String> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.take(READ_CAP).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Search every transcript under `projects_dir`, most recent first among matches.
pub fn search(projects_dir: &Path, query: &str, limit: usize) -> Vec<TranscriptHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let mut files = transcript_files(projects_dir);
    // Newest first, so the scan reaches the sessions someone is most likely asking about
    // before it reaches last year's.
    files.sort_by_key(|(_, _, m)| std::cmp::Reverse(*m));

    let mut hits = Vec::new();
    for (session_id, path, updated_at) in files {
        if hits.len() >= limit {
            break;
        }
        let Some(raw) = read_capped(&path) else {
            continue;
        };
        let text = extract_text(&raw);
        let snip = snippet(&text, q, 60);
        if snip.is_empty() {
            continue;
        }
        hits.push(TranscriptHit {
            session_id,
            title: title_of(&raw),
            snippet: snip,
            cwd: cwd_of(&raw),
            updated_at,
        });
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> String {
        json!({ "type": "user", "cwd": "/tmp/proj", "message": { "content": text } }).to_string()
    }
    fn assistant(text: &str) -> String {
        json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": text }
        ]}})
        .to_string()
    }

    #[test]
    fn extraction_keeps_what_was_said_and_drops_the_machinery() {
        let raw = [
            user("how does the tmux socket work"),
            assistant("It is namespaced per data dir."),
            // Tool traffic: the bulk of a real transcript, and not what anyone searches.
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": { "file_path": "/a/tmux.rs" } }
            ]}})
            .to_string(),
            json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "content": "4000 lines of file" }
            ]}})
            .to_string(),
            json!({ "type": "system", "subtype": "init" }).to_string(),
        ]
        .join("\n");

        let text = extract_text(&raw);
        assert!(text.contains("tmux socket"));
        assert!(text.contains("namespaced per data dir"));
        assert!(
            !text.contains("4000 lines"),
            "tool results are not searchable text"
        );
        assert!(!text.contains("tmux.rs"), "nor are tool inputs");
    }

    #[test]
    fn extraction_is_capped_and_never_splits_a_character() {
        let big = "☃".repeat(TEXT_CAP);
        let raw = [user(&big), user(&big)].join("\n");
        let text = extract_text(&raw);
        assert!(
            text.len() <= TEXT_CAP + 8,
            "cap holds (allowing the joiner)"
        );
        // The cap must land on a boundary or this is not valid UTF-8 at all.
        assert!(!text.contains('\u{FFFD}'));
    }

    #[test]
    fn the_title_is_the_first_thing_the_human_said() {
        let raw = [
            assistant("I'll help with that."),
            user("  fix   the   canvas  \n bug "),
            user("and then the other thing"),
        ]
        .join("\n");
        assert_eq!(title_of(&raw), "fix the canvas bug");
    }

    #[test]
    fn a_transcript_with_no_user_line_has_no_title_rather_than_a_wrong_one() {
        assert_eq!(title_of(&assistant("hello")), "");
        assert_eq!(title_of(""), "");
    }

    #[test]
    fn the_cwd_comes_from_the_first_line_that_carries_one() {
        let raw = [assistant("no cwd here"), user("has one")].join("\n");
        assert_eq!(cwd_of(&raw), "/tmp/proj");
        assert_eq!(cwd_of("garbage"), "");
    }

    #[test]
    fn a_snippet_surrounds_the_match_and_marks_what_it_cut() {
        let text = format!("{} NEEDLE {}", "a ".repeat(200), "b ".repeat(200));
        let s = snippet(&text, "needle", 20);
        assert!(
            s.contains("NEEDLE"),
            "match is case-insensitive but shown as written"
        );
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.len() < 120);
    }

    #[test]
    fn a_short_text_needs_no_ellipsis() {
        assert_eq!(
            snippet("just a needle here", "needle", 60),
            "just a needle here"
        );
    }

    #[test]
    fn a_miss_is_an_empty_snippet() {
        assert_eq!(snippet("nothing to see", "needle", 20), "");
        assert_eq!(snippet("anything", "", 20), "");
    }

    #[test]
    fn a_snippet_boundary_inside_a_multibyte_character_is_widened_not_split() {
        let text = format!("{}NEEDLE{}", "☃".repeat(50), "☃".repeat(50));
        let s = snippet(&text, "needle", 10);
        assert!(s.contains("NEEDLE"));
        assert!(!s.contains('\u{FFFD}'));
    }

    #[test]
    fn search_finds_the_session_that_said_it() {
        let root = std::env::temp_dir().join(format!("conduit-tsearch-{}", std::process::id()));
        let slug = root.join("-tmp-proj");
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::write(
            slug.join("sess-a.jsonl"),
            [user("we talked about worktree pruning"), assistant("yes")].join("\n"),
        )
        .unwrap();
        std::fs::write(
            slug.join("sess-b.jsonl"),
            [user("unrelated chatter")].join("\n"),
        )
        .unwrap();

        let hits = search(&root, "worktree", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "sess-a");
        assert_eq!(hits[0].title, "we talked about worktree pruning");
        assert_eq!(hits[0].cwd, "/tmp/proj");
        assert!(hits[0].snippet.contains("worktree"));

        assert!(
            search(&root, "", 10).is_empty(),
            "an empty query matches nothing"
        );
        assert!(search(&root, "zzzz", 10).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_honors_its_limit() {
        let root = std::env::temp_dir().join(format!("conduit-tlimit-{}", std::process::id()));
        let slug = root.join("-tmp-proj");
        std::fs::create_dir_all(&slug).unwrap();
        for i in 0..5 {
            std::fs::write(slug.join(format!("s{i}.jsonl")), user("common word")).unwrap();
        }
        assert_eq!(search(&root, "common", 2).len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
