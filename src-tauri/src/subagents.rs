//! What a session's subagents are doing.
//!
//! When a session fans out into Task subagents, Conduit shows one busy dot for what may be
//! five agents working in parallel — and nothing at all about any of them. Claude writes
//! each one's transcript next to the parent's:
//!
//! ```text
//! <projects>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl
//! <projects>/<slug>/<sessionId>/subagents/agent-<agentId>.meta.json   (spawning tool_use_id)
//! ```
//!
//! Read-only, and forgiving by construction: if Claude changes the format we render fewer
//! lines. Nothing here can fail in a way that matters.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// Lines of formatted activity kept per subagent — a readable tail, not a transcript.
pub const MAX_LINES: usize = 40;

/// How much of each subagent's file to read. Same reasoning as `context_window::READ_CAP`:
/// only the tail is ever displayed, and a long-running subagent's file is not small.
const READ_CAP: u64 = 512 * 1024;

/// One subagent of a session.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    /// The `agent-<id>` portion of the filename — stable for the subagent's life.
    pub id: String,
    /// The parent's `tool_use_id` for the Task call that spawned it, when the meta file
    /// says. This is what ties a row here to a tool call in the parent's transcript.
    pub tool_use_id: Option<String>,
    /// Recent activity, already formatted for display.
    pub lines: Vec<String>,
    /// File mtime in epoch ms — used to order the list newest-first.
    pub updated_at: u64,
}

/// A short, human-readable argument for a tool call — never raw JSON.
///
/// `Read → store.ts`, `Bash → pnpm test`, `Grep → "notification_type"`. The point is a line
/// someone can scan in a list, so a path is shown by basename and everything is truncated.
pub fn tool_arg(input: &Value) -> String {
    let base = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();
    let s = |k: &str| input.get(k).and_then(|v| v.as_str());
    if let Some(p) = s("file_path")
        .or_else(|| s("path"))
        .or_else(|| s("notebook_path"))
    {
        return base(p);
    }
    if let Some(c) = s("command") {
        return truncate(&normalize_ws(c), 80);
    }
    if let Some(p) = s("pattern") {
        return format!("\"{}\"", truncate(p, 60));
    }
    if let Some(u) = s("url") {
        return truncate(u, 80);
    }
    if let Some(q) = s("query") {
        return truncate(q, 60);
    }
    if let Some(t) = s("description").or_else(|| s("prompt")) {
        return truncate(&normalize_ws(t), 80);
    }
    String::new()
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Truncate on a char boundary (a byte slice would panic mid-codepoint).
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// Collapse a tool result to one line.
///
/// A tool result is often thousands of line-numbered characters. Dumping it turns the panel
/// into a second terminal; the first non-empty line plus a count is what makes it an
/// activity log instead.
pub fn summarize_result(content: &Value) -> String {
    let text = text_of(content);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = trimmed.lines().collect();
    let first = lines.iter().find(|l| !l.trim().is_empty()).unwrap_or(&"");
    let extra = if lines.len() > 1 {
        format!(" … (+{} lines)", lines.len() - 1)
    } else {
        String::new()
    };
    format!("  ↳ {}{}", truncate(first.trim(), 100), extra)
}

/// Text out of Claude's several content shapes: a bare string, or a content-block array.
fn text_of(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    arr.iter()
        .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One transcript line as a display line, or `None` for lines with nothing to show.
///
/// Assistant prose verbatim, tool calls as `$ Read store.ts`, tool results as a one-line
/// summary. Metadata is skipped rather than rendered as noise.
pub fn format_line(line: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    match v.get("type").and_then(|t| t.as_str())? {
        "assistant" => {
            let content = v.pointer("/message/content")?;
            let mut out: Vec<String> = Vec::new();
            for block in content.as_array()? {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        let t = block
                            .get("text")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .trim();
                        if !t.is_empty() {
                            out.push(t.to_string());
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                        let arg = block
                            .get("input")
                            .map(tool_arg)
                            .filter(|a| !a.is_empty())
                            .map(|a| format!(" {a}"))
                            .unwrap_or_default();
                        out.push(format!("$ {name}{arg}"));
                    }
                    _ => {}
                }
            }
            (!out.is_empty()).then(|| out.join("\n"))
        }
        "user" => {
            // A tool result comes back as a user-role line; the user's own prose in a
            // subagent transcript is the task prompt, which the parent already shows.
            let content = v.pointer("/message/content")?.as_array()?;
            let result = content
                .iter()
                .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))?;
            let summary = summarize_result(result.get("content").unwrap_or(&Value::Null));
            (!summary.is_empty()).then_some(summary)
        }
        _ => None,
    }
}

/// The `subagents` directory for a session, if Claude has created one.
fn subagent_dir(projects_dir: &Path, session_id: &str) -> Option<PathBuf> {
    // Same trick as `pty::transcript_path`: find the project-slug dir that holds this
    // session rather than reproducing Claude's cwd-slug algorithm.
    std::fs::read_dir(projects_dir)
        .ok()?
        .flatten()
        .find_map(|e| {
            let d = e.path().join(session_id).join("subagents");
            d.is_dir().then_some(d)
        })
}

/// Read the spawning `tool_use_id` out of an `agent-<id>.meta.json`.
pub fn parse_meta(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    // Accept either spelling; the file is Claude's, not ours, and it costs nothing to be
    // tolerant of a rename.
    v.get("toolUseId")
        .or_else(|| v.get("tool_use_id"))
        .and_then(|t| t.as_str())
        .map(str::to_string)
}

/// Read the tail of a file as lossy UTF-8, capped.
fn read_tail(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let from = len.saturating_sub(READ_CAP);
    if from > 0 {
        f.seek(SeekFrom::Start(from)).ok()?;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Every subagent of a session, newest activity first.
pub fn for_session(projects_dir: &Path, session_id: &str) -> Vec<Subagent> {
    let Some(dir) = subagent_dir(projects_dir, session_id) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out: Vec<Subagent> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(text) = read_tail(&path) else {
            continue;
        };

        let mut lines: Vec<String> = text.lines().filter_map(format_line).collect();
        if lines.len() > MAX_LINES {
            lines.drain(..lines.len() - MAX_LINES);
        }

        let tool_use_id = std::fs::read_to_string(dir.join(format!("{stem}.meta.json")))
            .ok()
            .as_deref()
            .and_then(parse_meta);

        let updated_at = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        out.push(Subagent {
            id: stem.trim_start_matches("agent-").to_string(),
            tool_use_id,
            lines,
            updated_at,
        });
    }

    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn assistant_prose_comes_through_verbatim() {
        let line = json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "  Looking at the store.  " }] }
        })
        .to_string();
        assert_eq!(format_line(&line).as_deref(), Some("Looking at the store."));
    }

    #[test]
    fn a_tool_call_becomes_a_command_line_with_a_readable_argument() {
        let line = json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": { "file_path": "/a/b/store.ts" } }
            ]}
        })
        .to_string();
        assert_eq!(format_line(&line).as_deref(), Some("$ Read store.ts"));
    }

    #[test]
    fn tool_arguments_pick_the_field_that_says_what_happened() {
        assert_eq!(
            tool_arg(&json!({ "command": "pnpm   test  -w" })),
            "pnpm test -w"
        );
        assert_eq!(
            tool_arg(&json!({ "pattern": "notification_type" })),
            "\"notification_type\""
        );
        assert_eq!(
            tool_arg(&json!({ "url": "https://example.com" })),
            "https://example.com"
        );
        assert_eq!(
            tool_arg(&json!({ "description": "find the bug" })),
            "find the bug"
        );
        // Nothing recognizable is better said with silence than with raw JSON.
        assert_eq!(tool_arg(&json!({ "mystery": 1 })), "");
    }

    #[test]
    fn a_long_argument_is_truncated_without_splitting_a_character() {
        // Byte-slicing a multi-byte character would panic; this is the guard for it.
        let long: String = "☃".repeat(200);
        let out = tool_arg(&json!({ "pattern": long }));
        assert!(out.chars().count() <= 62, "60 chars plus the quotes");
    }

    #[test]
    fn a_tool_result_collapses_to_one_line_with_a_count() {
        let line = json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "content": "first line\nsecond\nthird" }
            ]}
        })
        .to_string();
        assert_eq!(
            format_line(&line).as_deref(),
            Some("  ↳ first line … (+2 lines)")
        );
    }

    #[test]
    fn a_single_line_result_gets_no_count() {
        let content = json!("only this");
        assert_eq!(summarize_result(&content), "  ↳ only this");
        // An empty result is nothing to show at all.
        assert_eq!(summarize_result(&json!("   ")), "");
    }

    #[test]
    fn result_content_blocks_are_understood_as_well_as_bare_strings() {
        let blocks = json!([{ "type": "text", "text": "from a block" }]);
        assert_eq!(summarize_result(&blocks), "  ↳ from a block");
    }

    #[test]
    fn metadata_and_junk_produce_nothing_rather_than_noise() {
        for line in [
            "",
            "not json",
            &json!({ "type": "system", "subtype": "init" }).to_string(),
            &json!({ "type": "assistant", "message": { "content": [] } }).to_string(),
            // A user's own prose in a subagent transcript is the task prompt, which the
            // parent already displays.
            &json!({ "type": "user", "message": { "content": [
                { "type": "text", "text": "do the thing" }
            ]}})
            .to_string(),
        ] {
            assert_eq!(format_line(line), None, "for {line:?}");
        }
    }

    #[test]
    fn the_meta_file_yields_the_spawning_tool_use_id_in_either_spelling() {
        assert_eq!(
            parse_meta(&json!({ "toolUseId": "toolu_01" }).to_string()).as_deref(),
            Some("toolu_01")
        );
        assert_eq!(
            parse_meta(&json!({ "tool_use_id": "toolu_02" }).to_string()).as_deref(),
            Some("toolu_02")
        );
        assert_eq!(parse_meta("{}"), None);
        assert_eq!(parse_meta("garbage"), None);
    }

    #[test]
    fn a_session_with_no_subagents_reads_as_an_empty_list() {
        let dir = std::env::temp_dir().join(format!("conduit-sub-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(for_session(&dir, "nope").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagents_are_read_from_disk_newest_first() {
        let root = std::env::temp_dir().join(format!("conduit-sub-{}", std::process::id()));
        let subs = root.join("slug").join("sess-1").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();

        let body = format!(
            "{}\n{}\n",
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "name": "Grep", "input": { "pattern": "todo" } }
            ]}}),
            json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "content": "3 matches" }
            ]}})
        );
        std::fs::write(subs.join("agent-aaa.jsonl"), &body).unwrap();
        std::fs::write(
            subs.join("agent-aaa.meta.json"),
            json!({ "toolUseId": "toolu_9" }).to_string(),
        )
        .unwrap();

        let found = for_session(&root, "sess-1");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "aaa");
        assert_eq!(found[0].tool_use_id.as_deref(), Some("toolu_9"));
        assert_eq!(found[0].lines, vec!["$ Grep \"todo\"", "  ↳ 3 matches"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_the_last_lines_are_kept() {
        let root = std::env::temp_dir().join(format!("conduit-sub-cap-{}", std::process::id()));
        let subs = root.join("slug").join("sess-2").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        let mut body = String::new();
        for i in 0..(MAX_LINES + 30) {
            body.push_str(
                &json!({ "type": "assistant", "message": { "content": [
                    { "type": "text", "text": format!("line {i}") }
                ]}})
                .to_string(),
            );
            body.push('\n');
        }
        std::fs::write(subs.join("agent-bbb.jsonl"), &body).unwrap();

        let found = for_session(&root, "sess-2");
        assert_eq!(found[0].lines.len(), MAX_LINES);
        // The TAIL is what was kept — the recent work, not the opening moves.
        assert_eq!(
            found[0].lines.last().unwrap(),
            &format!("line {}", MAX_LINES + 29)
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
