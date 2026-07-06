//! SPEC-G: per-adapter token usage, honest by construction. The meter mixes three
//! different units (a subscription window %, real token counts, and "no local source
//! exists") and must never fabricate a number for an adapter that doesn't have one.
//! Shares `claude_usage.rs`'s "fail-open, never fabricate" philosophy but lives
//! separately since every adapter's parser needs this shape, not just Claude's.
//!
//! **Unverified adapters, honestly:** `codex`/`gemini` are not installed on this dev
//! machine (2026-07-05), so `parse_codex_rollout`/`parse_gemini_session_summary` are
//! implemented verbatim per the design doc's own fixture shapes and tested against
//! synthetic fixtures, NOT a real rollout/session-summary file. `opencode` IS installed
//! (see the real MCP spike in `agent.rs`), but exercising its real
//! `storage/message/{sessionID}/msg_*.json` shape end-to-end would need a live session
//! history to inspect, which this pass didn't do -- `parse_opencode_session_messages` is
//! implemented per spec and fixture-tested like the other two, not live-verified either.
//!
//! **Not wired to a live caller yet, deliberately, not by oversight.** All three parsers
//! take file CONTENT, not a session id -- the missing piece is per-adapter file
//! DISCOVERY, and two of the three have a genuinely unresolved join key: (a) Codex's
//! rollout file is named by timestamp, not session id, and which rollout belongs to which
//! Conduit session was exactly the thing the (unrun) Phase 3 spike was supposed to
//! confirm; (b) OpenCode manages its OWN internal session ids (`build_invocation` never
//! passes it Conduit's `session_id` -- "opencode generates its own session ids, so there
//! is no caller-pinned resume"), so mapping a Conduit session to its
//! `storage/message/{sessionID}/` directory needs a cross-reference this pass didn't
//! build. Guessing either join key risked silently tallying the WRONG session's tokens,
//! worse than the honest "unmetered" these fail-open on today. `#[allow(dead_code)]`
//! below is scoped to this file rather than left as a bare warning, so it reads as an
//! explicit decision.
#![allow(dead_code)]

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TallySource {
    /// Real counts, successfully parsed from the adapter's own local usage log.
    Parsed,
    /// This session is routed to a local/self-hosted model -- render "$0", never a
    /// fabricated token count (the local-model path doesn't produce comparable numbers).
    LocalModelFree,
    /// No local usage source exists for this adapter/session at all (or parsing failed)
    /// -- render "unmetered", never a fabricated zero.
    #[default]
    Unmetered,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenTally {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_input_tokens: i64,
    pub total_tokens: i64,
    pub source: TallySource,
}

/// Sum `token_count` events across a Codex rollout JSONL, returning the LAST (most
/// recent) cumulative snapshot -- these are cumulative-to-date per the design's research,
/// NOT per-turn deltas, so summing them would double count; take the last one, mirroring
/// how `claude_usage::parse_stats_cache` takes `.last()` of Claude's daily arrays.
/// `None` on a rollout with zero `token_count` events (e.g. an old Codex build) -- the
/// caller renders "unmetered" for that session, never a fabricated zero.
pub fn parse_codex_rollout(body: &str) -> Option<TokenTally> {
    let mut last: Option<TokenTally> = None;
    for line in body.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.pointer("/payload/type").and_then(|t| t.as_str()) != Some("token_count") {
            continue;
        }
        let Some(p) = v.get("payload") else { continue };
        let (Some(input), Some(output), Some(total)) = (
            p.get("input_tokens").and_then(|x| x.as_i64()),
            p.get("output_tokens").and_then(|x| x.as_i64()),
            p.get("total_tokens").and_then(|x| x.as_i64()),
        ) else {
            continue;
        };
        last = Some(TokenTally {
            input_tokens: input,
            output_tokens: output,
            cached_input_tokens: p
                .get("cached_input_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0),
            total_tokens: total,
            source: TallySource::Parsed,
        });
    }
    last
}

/// Sum `models.<model>.tokens` across a Gemini `--session-summary` JSON file (written at
/// process exit, so this is "as of last completed turn", not live). `None` on any parse
/// failure or missing `models` key.
pub fn parse_gemini_session_summary(body: &str) -> Option<TokenTally> {
    let v: Value = serde_json::from_str(body).ok()?;
    let models = v.get("models")?.as_object()?;
    let mut tally = TokenTally {
        source: TallySource::Parsed,
        ..Default::default()
    };
    for m in models.values() {
        let Some(t) = m.get("tokens") else { continue };
        tally.input_tokens += t.get("prompt").and_then(|x| x.as_i64()).unwrap_or(0);
        tally.output_tokens += t.get("candidates").and_then(|x| x.as_i64()).unwrap_or(0);
        tally.cached_input_tokens += t.get("cached").and_then(|x| x.as_i64()).unwrap_or(0);
        tally.total_tokens += t.get("total").and_then(|x| x.as_i64()).unwrap_or(0);
    }
    Some(tally)
}

/// Sum per-message token fields across `storage/message/{sessionID}/msg_*.json` under
/// `OPENCODE_DATA_DIR`. `None` if the directory doesn't exist or has no readable message
/// files -- the caller renders "unmetered", never a fabricated zero. Skip calling this
/// entirely (render `TallySource::LocalModelFree`, "$0") when the session is known to be
/// routed to a local model -- no need to parse tokens for a session that costs nothing.
pub fn parse_opencode_session_messages(msg_dir: &Path) -> Option<TokenTally> {
    let mut tally = TokenTally {
        source: TallySource::Parsed,
        ..Default::default()
    };
    let mut found_any = false;
    for entry in std::fs::read_dir(msg_dir).ok()? {
        let Ok(entry) = entry else { continue };
        let Ok(body) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&body) else {
            continue;
        };
        found_any = true;
        tally.input_tokens += v
            .pointer("/tokens/input")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
        tally.output_tokens += v
            .pointer("/tokens/output")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
        tally.total_tokens += v
            .pointer("/tokens/total")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
    }
    found_any.then_some(tally)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn parse_codex_rollout_takes_last_cumulative_snapshot() {
        let body = [
            json!({"payload": {"type": "token_count", "input_tokens": 100, "output_tokens": 50, "total_tokens": 150}}).to_string(),
            json!({"payload": {"type": "other"}}).to_string(),
            json!({"payload": {"type": "token_count", "input_tokens": 200, "output_tokens": 90, "cached_input_tokens": 20, "total_tokens": 290}}).to_string(),
        ]
        .join("\n");
        let tally = parse_codex_rollout(&body).expect("should parse");
        assert_eq!(
            tally.input_tokens, 200,
            "must take the LAST snapshot, not sum"
        );
        assert_eq!(tally.output_tokens, 90);
        assert_eq!(tally.cached_input_tokens, 20);
        assert_eq!(tally.total_tokens, 290);
        assert_eq!(tally.source, TallySource::Parsed);
    }

    #[test]
    fn parse_codex_rollout_returns_none_when_no_token_count_events() {
        let body = json!({"payload": {"type": "session_meta"}}).to_string();
        assert!(parse_codex_rollout(&body).is_none());
        assert!(parse_codex_rollout("").is_none());
        assert!(parse_codex_rollout("not json at all").is_none());
    }

    #[test]
    fn parse_gemini_session_summary_sums_across_models() {
        let body = json!({
            "models": {
                "gemini-3-flash": {"tokens": {"prompt": 100, "candidates": 40, "cached": 10, "total": 150}},
                "gemini-3.1-pro": {"tokens": {"prompt": 20, "candidates": 5, "total": 25}}
            }
        })
        .to_string();
        let tally = parse_gemini_session_summary(&body).expect("should parse");
        assert_eq!(tally.input_tokens, 120);
        assert_eq!(tally.output_tokens, 45);
        assert_eq!(tally.cached_input_tokens, 10);
        assert_eq!(tally.total_tokens, 175);
        assert_eq!(tally.source, TallySource::Parsed);
    }

    #[test]
    fn parse_gemini_session_summary_returns_none_on_bad_shape() {
        assert!(parse_gemini_session_summary("{}").is_none());
        assert!(parse_gemini_session_summary("not json").is_none());
    }

    fn fresh_dir(tag: &str) -> std::path::PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "conduit_usage_tally_{tag}_{}_{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_opencode_session_messages_sums_per_message_tokens() {
        let dir = fresh_dir("sum");
        std::fs::write(
            dir.join("msg_1.json"),
            json!({"tokens": {"input": 10, "output": 5, "total": 15}}).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("msg_2.json"),
            json!({"tokens": {"input": 20, "output": 8, "total": 28}}).to_string(),
        )
        .unwrap();
        let tally = parse_opencode_session_messages(&dir).expect("should parse");
        assert_eq!(tally.input_tokens, 30);
        assert_eq!(tally.output_tokens, 13);
        assert_eq!(tally.total_tokens, 43);
        assert_eq!(tally.source, TallySource::Parsed);
    }

    #[test]
    fn parse_opencode_session_messages_returns_none_on_empty_dir() {
        let dir = fresh_dir("empty");
        assert!(parse_opencode_session_messages(&dir).is_none());
    }

    #[test]
    fn parse_opencode_session_messages_returns_none_on_missing_dir() {
        let missing = std::env::temp_dir().join("conduit_usage_tally_does_not_exist");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(parse_opencode_session_messages(&missing).is_none());
    }
}
