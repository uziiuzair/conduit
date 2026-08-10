//! Per-session context-window fill, read from the session's own Claude transcript.
//!
//! Conduit already shows a context meter for agy, because agy volunteers the number in its
//! status line. Claude volunteers nothing, but it writes every assistant message's token
//! usage into the transcript we already know how to find -- so the fill is a read away.
//!
//! Everything here is read-only and local: tail the `.jsonl`, take the LATEST assistant
//! message's `usage`, and divide by the model's window. If Claude changes the format we
//! simply report nothing; there is no failure mode worse than an absent meter.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

/// The window every model has unless we know better.
pub const DEFAULT_WINDOW: u64 = 200_000;
/// The window the large-context families run in.
pub const LARGE_WINDOW: u64 = 1_000_000;

/// How much of the transcript's tail to read.
///
/// A resumed session's transcript is routinely many megabytes, and only the latest usage
/// matters. Reading the whole file to learn one number would stall the caller for no gain;
/// the partial first line the cut leaves behind is dropped by the parse guard.
pub const READ_CAP: u64 = 1024 * 1024;

/// One session's context-window fill.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    /// Input tokens in play for the next turn: fresh input plus everything cached.
    pub used: u64,
    /// The model's context window -- the denominator.
    pub window: u64,
    /// `used / window`, clamped to 0..=1 so a caller can render it without checking.
    pub fraction: f64,
    /// The model the latest usage line named, when it named one.
    pub model: Option<String>,
}

/// The context window for a model id.
///
/// Resolved by model FAMILY, never by the id itself: Claude Code runs opus/sonnet sessions
/// in a 1M window while the transcript's model id stays bare (`claude-opus-4-8`), so the
/// window genuinely is not derivable from the string. An explicit `1m` marker also forces
/// the large window, and anything unrecognized takes the conservative 200k -- a meter that
/// reads a little full is a smaller lie than one that reads nearly empty.
pub fn window_for(model: Option<&str>) -> u64 {
    let Some(m) = model else {
        return DEFAULT_WINDOW;
    };
    let m = m.to_ascii_lowercase();
    if m.contains("haiku") {
        return DEFAULT_WINDOW;
    }
    if m.contains("opus") || m.contains("sonnet") || m.contains("fable") || m.contains("mythos") {
        return LARGE_WINDOW;
    }
    // A bare "1m" token (not part of a longer word), e.g. "claude-sonnet-4-5-1m".
    if m.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| part == "1m")
    {
        return LARGE_WINDOW;
    }
    DEFAULT_WINDOW
}

/// The latest assistant message's input-token total and model, scanned from transcript text.
///
/// Scans BACKWARDS and stops as soon as both values are settled. The direction is a
/// performance decision, not a style one: a forward scan `serde_json`-parses every line of
/// the chunk, and a single tool-result line can be 100 KB+ of JSON. The substring
/// pre-filter skips those lines without parsing them at all -- a JSON-encoded assistant
/// usage line always contains both quoted keys.
///
/// The model is resolved from the nearest usage line at or before the latest one that names
/// it, because a usage line may omit the model while the fill it reports is still current.
pub fn parse_latest_usage(text: &str) -> Option<(u64, Option<String>)> {
    let mut used: Option<u64> = None;
    let mut model: Option<String> = None;

    for line in text.lines().rev() {
        let s = line.trim();
        if s.is_empty() || !s.contains("\"usage\"") || !s.contains("\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(s) else {
            continue; // torn first line from the tail cut, or a format we don't know
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(u) = v.pointer("/message/usage") else {
            continue;
        };
        let field = |k: &str| u.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        // What the next turn actually has to carry: fresh input plus every cached block.
        // Output tokens are not part of the window's input side.
        let total = field("input_tokens")
            + field("cache_read_input_tokens")
            + field("cache_creation_input_tokens");
        if total == 0 {
            continue;
        }
        if used.is_none() {
            used = Some(total); // the LATEST usage; earlier lines only resolve the model
        }
        if let Some(m) = v.pointer("/message/model").and_then(|m| m.as_str()) {
            model = Some(m.to_string());
            break;
        }
    }

    used.map(|u| (u, model))
}

/// Build a `ContextUsage` from raw transcript text.
pub fn usage_from_text(text: &str) -> Option<ContextUsage> {
    let (used, model) = parse_latest_usage(text)?;
    let window = window_for(model.as_deref());
    Some(ContextUsage {
        used,
        window,
        // A session can exceed its window between a compaction firing and finishing, so the
        // clamp is real rather than defensive.
        fraction: (used as f64 / window as f64).clamp(0.0, 1.0),
        model,
    })
}

/// Read the trailing `READ_CAP` bytes of a file as lossy UTF-8.
///
/// Lossy because the cap can land mid-codepoint; the damage is confined to the first line,
/// which `parse_latest_usage` discards when it fails to parse.
fn read_tail(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let from = len.saturating_sub(READ_CAP);
    if from > 0 {
        f.seek(SeekFrom::Start(from)).ok()?;
    }
    let mut buf = Vec::with_capacity(len.saturating_sub(from) as usize);
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// A session's context fill, or `None` when the transcript is missing or says nothing yet.
pub fn for_transcript(path: &Path) -> Option<ContextUsage> {
    usage_from_text(&read_tail(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(input: u64, cache_read: u64, cache_create: u64, model: Option<&str>) -> String {
        let m = model
            .map(|m| format!("\"model\":\"{m}\","))
            .unwrap_or_default();
        format!(
            "{{\"type\":\"assistant\",\"message\":{{{m}\"usage\":{{\"input_tokens\":{input},\
             \"cache_read_input_tokens\":{cache_read},\"cache_creation_input_tokens\":{cache_create},\
             \"output_tokens\":99}}}}}}"
        )
    }

    #[test]
    fn the_window_comes_from_the_family_not_the_id() {
        // The id stays bare even when Claude Code runs the session at 1M, which is exactly
        // why this maps families instead of parsing version numbers.
        assert_eq!(window_for(Some("claude-opus-4-8")), LARGE_WINDOW);
        assert_eq!(window_for(Some("claude-sonnet-4-5-20250929")), LARGE_WINDOW);
        assert_eq!(
            window_for(Some("claude-haiku-4-5-20251001")),
            DEFAULT_WINDOW
        );
        assert_eq!(window_for(Some("claude-sonnet-4-5-1m")), LARGE_WINDOW);
        // Unknown and absent both take the conservative denominator.
        assert_eq!(window_for(Some("some-future-model")), DEFAULT_WINDOW);
        assert_eq!(window_for(None), DEFAULT_WINDOW);
    }

    #[test]
    fn haiku_wins_over_a_stray_1m_in_the_same_id() {
        // Order matters: the haiku check runs first so a "1m" suffix can't inflate it.
        assert_eq!(window_for(Some("claude-haiku-4-5-1m")), DEFAULT_WINDOW);
    }

    #[test]
    fn a_word_ending_in_1m_is_not_a_1m_marker() {
        assert_eq!(window_for(Some("weird-model-11m")), DEFAULT_WINDOW);
    }

    #[test]
    fn usage_sums_fresh_input_and_every_cached_block() {
        let text = assistant(1_000, 40_000, 5_000, Some("claude-opus-4-8"));
        let u = usage_from_text(&text).unwrap();
        assert_eq!(u.used, 46_000);
        assert_eq!(u.window, LARGE_WINDOW);
        assert_eq!(u.model.as_deref(), Some("claude-opus-4-8"));
        assert!((u.fraction - 0.046).abs() < 1e-9);
    }

    #[test]
    fn the_latest_usage_wins_not_the_largest_or_the_first() {
        let text = [
            assistant(90_000, 0, 0, Some("claude-opus-4-8")),
            assistant(10_000, 0, 0, Some("claude-opus-4-8")),
        ]
        .join("\n");
        assert_eq!(usage_from_text(&text).unwrap().used, 10_000);
    }

    #[test]
    fn a_usage_line_with_no_model_inherits_the_nearest_earlier_one() {
        // Claude omits the model on some usage lines; the fill they report is still current,
        // so the denominator has to come from the nearest line that named it.
        let text = [
            assistant(1_000, 0, 0, Some("claude-opus-4-8")),
            assistant(7_000, 0, 0, None),
        ]
        .join("\n");
        let u = usage_from_text(&text).unwrap();
        assert_eq!(u.used, 7_000);
        assert_eq!(
            u.window, LARGE_WINDOW,
            "the earlier line's model still governs"
        );
    }

    #[test]
    fn user_and_tool_lines_are_skipped_without_being_parsed() {
        let text = [
            "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}".to_string(),
            // A tool result big enough that parsing it would be the whole cost of the scan.
            format!(
                "{{\"type\":\"user\",\"toolUseResult\":\"{}\"}}",
                "x".repeat(5000)
            ),
            assistant(2_000, 0, 0, Some("claude-opus-4-8")),
        ]
        .join("\n");
        assert_eq!(usage_from_text(&text).unwrap().used, 2_000);
    }

    #[test]
    fn a_torn_first_line_from_the_tail_cut_is_survivable() {
        let text = [
            "sage\":{\"input_tokens\":5}}} <- half a line the byte cap sliced".to_string(),
            assistant(3_000, 0, 0, Some("claude-opus-4-8")),
        ]
        .join("\n");
        assert_eq!(usage_from_text(&text).unwrap().used, 3_000);
    }

    #[test]
    fn a_transcript_with_no_assistant_usage_yet_reports_nothing() {
        assert!(usage_from_text("").is_none());
        assert!(usage_from_text("{\"type\":\"user\",\"message\":{}}").is_none());
        // A zero-token usage line is not a real turn -- it must not read as 0% full.
        assert!(usage_from_text(&assistant(0, 0, 0, Some("claude-opus-4-8"))).is_none());
    }

    #[test]
    fn the_fraction_is_clamped_when_a_session_runs_past_its_window() {
        let text = assistant(400_000, 0, 0, Some("claude-haiku-4-5"));
        let u = usage_from_text(&text).unwrap();
        assert_eq!(u.used, 400_000);
        assert_eq!(u.fraction, 1.0);
    }

    #[test]
    fn for_transcript_reads_only_the_tail_of_a_large_file() {
        let dir = std::env::temp_dir().join(format!("conduit-ctx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        // Padding well past the cap, so anything found must have come from the tail.
        let filler = format!("{{\"type\":\"user\",\"pad\":\"{}\"}}\n", "y".repeat(4096));
        let mut body = filler.repeat(400);
        assert!(body.len() as u64 > READ_CAP);
        body.push_str(&assistant(12_345, 0, 0, Some("claude-opus-4-8")));
        body.push('\n');
        std::fs::write(&path, &body).unwrap();

        let u = for_transcript(&path).unwrap();
        assert_eq!(u.used, 12_345);
        assert!(for_transcript(&dir.join("missing.jsonl")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
