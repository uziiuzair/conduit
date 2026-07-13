//! Parse Claude transcript JSONL (`<id>.jsonl`) into the bridge's chat items.
//! One line → zero or more items: user/assistant text → "bubble"; tool_use →
//! "event" (mapped to the same kinds the RN app renders); everything else skipped.

use serde_json::{json, Value};

/// Map a Claude tool name to the RN timeline event kind + verb (mirror of
/// mobile/src/logic/status.ts `eventKindFor` / labels).
fn tool_event(name: &str, input: &Value) -> Value {
    let (kind, label, mono) = match name {
        "Read" => (
            "read",
            "read",
            input.get("file_path").and_then(|v| v.as_str()),
        ),
        "Bash" => ("bash", "ran", input.get("command").and_then(|v| v.as_str())),
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => (
            "edit",
            "edited",
            input.get("file_path").and_then(|v| v.as_str()),
        ),
        "Grep" | "Glob" => (
            "search",
            "searched",
            input.get("pattern").and_then(|v| v.as_str()),
        ),
        "WebFetch" | "WebSearch" => ("web", "browsed", input.get("url").and_then(|v| v.as_str())),
        "Task" => ("subagent", "ran a subagent", None),
        _ => ("generic", "used a tool", None),
    };
    json!({ "kind": "event", "event": kind, "label": label, "mono": mono })
}

/// Parse one transcript line into chat items (possibly empty).
pub fn parse_line(line: &str) -> Vec<Value> {
    let Ok(v): Result<Value, _> = serde_json::from_str(line) else {
        return vec![];
    };
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let content = v.pointer("/message/content");
    let mut out = Vec::new();
    match kind {
        "user" => {
            // User content is either a plain string (a typed prompt) or an array
            // (tool_result blocks, which we skip — they're tool output, not chat).
            if let Some(text) = content.and_then(|c| c.as_str()) {
                out.push(json!({ "kind": "bubble", "role": "user", "text": text }));
            }
        }
        "assistant" => {
            // SPEC-G, §7.6: real token usage per line, including cache-read vs fresh
            // input -- the honest signal that prompt caching (90% off cache reads) is
            // actually working. `message.usage` is a standard field on Claude API
            // responses; this doesn't disturb the existing bubble/tool_use items below.
            if let Some(usage) = v.pointer("/message/usage") {
                out.push(json!({
                    "kind": "usage",
                    "model": v.pointer("/message/model").and_then(|m| m.as_str()),
                    "inputTokens": usage.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
                    "outputTokens": usage.get("output_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
                    "cacheReadTokens": usage.get("cache_read_input_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
                    "cacheCreationTokens": usage.get("cache_creation_input_tokens").and_then(|x| x.as_i64()).unwrap_or(0),
                }));
            }
            if let Some(arr) = content.and_then(|c| c.as_array()) {
                for block in arr {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                if !t.trim().is_empty() {
                                    out.push(
                                        json!({ "kind": "bubble", "role": "assistant", "text": t }),
                                    );
                                }
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let empty = json!({});
                            let input = block.get("input").unwrap_or(&empty);
                            out.push(tool_event(name, input));
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_user_text_bubble() {
        let items = parse_line(
            &json!({"type":"user","message":{"role":"user","content":"add rate limiting"}})
                .to_string(),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["text"], "add rate limiting");
    }

    #[test]
    fn parses_assistant_text_and_tool_use() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"On it."},
            {"type":"tool_use","name":"Bash","input":{"command":"npm test"}}
        ]}})
        .to_string();
        let items = parse_line(&line);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], "bubble");
        assert_eq!(items[0]["role"], "assistant");
        assert_eq!(items[0]["text"], "On it.");
        assert_eq!(items[1]["kind"], "event");
        assert_eq!(items[1]["event"], "bash");
        assert_eq!(items[1]["mono"], "npm test");
    }

    #[test]
    fn parse_line_captures_usage_kind_on_assistant_lines() {
        let line = json!({"type":"assistant","message":{
            "model": "claude-opus-4-8",
            "usage": {
                "input_tokens": 120,
                "output_tokens": 45,
                "cache_read_input_tokens": 900,
                "cache_creation_input_tokens": 30
            },
            "content":[{"type":"text","text":"On it."}]
        }})
        .to_string();
        let items = parse_line(&line);
        let usage = items
            .iter()
            .find(|i| i["kind"] == "usage")
            .expect("usage item present");
        assert_eq!(usage["model"], "claude-opus-4-8");
        assert_eq!(usage["inputTokens"], 120);
        assert_eq!(usage["outputTokens"], 45);
        assert_eq!(usage["cacheReadTokens"], 900);
        assert_eq!(usage["cacheCreationTokens"], 30);
        // The existing bubble item for the same line is unaffected (regression guard).
        let bubble = items
            .iter()
            .find(|i| i["kind"] == "bubble")
            .expect("bubble item still present");
        assert_eq!(bubble["text"], "On it.");
    }

    #[test]
    fn parse_line_has_no_usage_item_when_message_usage_is_absent() {
        let line = json!({"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}})
            .to_string();
        let items = parse_line(&line);
        assert!(!items.iter().any(|i| i["kind"] == "usage"));
    }

    #[test]
    fn skips_tool_result_and_meta_lines() {
        assert!(parse_line(
            &json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}})
                .to_string()
        )
        .is_empty());
        assert!(parse_line("not json").is_empty());
        assert!(parse_line(&json!({"type":"summary"}).to_string()).is_empty());
    }
}
