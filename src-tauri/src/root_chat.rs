//! Root chat: headless spawn-per-message `claude -p` conversations above all projects.
//! Read-only by CLI flag policy; one unified item stream shared with transcript replay.
//! Design: docs/superpowers/specs/2026-08-26-root-chat-design.md

use serde_json::{json, Value};

/// What one stream-json stdout line means to the chat.
pub enum LineOut {
    /// Renderable chat items (bubbles / tool events), via `transcript::parse_line` —
    /// stream-json assistant lines and transcript JSONL lines share the same shape.
    Items(Vec<Value>),
    /// The terminal `result` line: turn finished (cost, turn count, error flag).
    Done(Value),
    Nothing,
}

pub fn classify_line(line: &str) -> LineOut {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return LineOut::Nothing;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("result") => LineOut::Done(json!({
            "isError": v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
            "result": v.get("result").and_then(|r| r.as_str()).unwrap_or(""),
            "costUsd": v.get("total_cost_usd").and_then(|c| c.as_f64()),
            "numTurns": v.get("num_turns").and_then(|n| n.as_i64()),
        })),
        Some("system") => LineOut::Nothing,
        _ => {
            let items = crate::transcript::parse_line(line);
            if items.is_empty() {
                LineOut::Nothing
            } else {
                LineOut::Items(items)
            }
        }
    }
}

/// The per-spawn system prompt: role, workspace root, and the registered-project roster
/// (name, path) — rebuilt every message, so the roster is never stale.
pub fn build_charter(workspace_root: &str, projects: &[(String, String)]) -> String {
    let roster = if projects.is_empty() {
        "(none registered yet)".to_string()
    } else {
        projects
            .iter()
            .map(|(name, path)| format!("- {name}: {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "You are Conduit's root chat: a project-management and ideation partner for the \
         user's whole workspace. You are not a code agent. You never write, edit, or \
         create files, never run shell commands, and never make code changes of any kind \
         — your tools are read-only by policy and you do not attempt to work around \
         that. When a conversation lands on something that should be built, produce a \
         concise implementation brief the user can hand to a coding session in the \
         relevant project; in the future you'll be able to dispatch such work directly.\n\n\
         Workspace root: {workspace_root}\n\n\
         Registered Conduit projects:\n{roster}"
    )
}

/// The full shell command for one message. `resume` = a transcript for this chat id
/// already exists (decided by the caller via `pty::transcript_exists`).
pub fn build_command(chat_id: &str, resume: bool, charter: &str) -> String {
    let id = crate::pty::quote_arg(chat_id);
    let sys = crate::pty::quote_arg(charter);
    let mode = if resume {
        format!("--resume {id}")
    } else {
        format!("--session-id {id}")
    };
    format!(
        "claude -p --output-format stream-json --verbose \
         --allowedTools Read,Glob,Grep,WebSearch,WebFetch \
         --disallowedTools Bash,Write,Edit,NotebookEdit \
         --strict-mcp-config \
         --append-system-prompt {sys} {mode}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_result_line_as_done() {
        let line = json!({
            "type": "result", "subtype": "success", "is_error": false,
            "result": "Here's the brief.", "total_cost_usd": 0.042, "num_turns": 3
        })
        .to_string();
        match classify_line(&line) {
            LineOut::Done(v) => {
                assert_eq!(v["isError"], false);
                assert_eq!(v["costUsd"], 0.042);
                assert_eq!(v["numTurns"], 3);
            }
            _ => panic!("result line must classify as Done"),
        }
    }

    #[test]
    fn classify_assistant_line_as_items_via_transcript_parser() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"Thinking about your roadmap."},
            {"type":"tool_use","name":"Read","input":{"file_path":"/w/app/README.md"}}
        ]}})
        .to_string();
        match classify_line(&line) {
            LineOut::Items(items) => {
                assert_eq!(items[0]["kind"], "bubble");
                assert_eq!(items[1]["kind"], "event");
                assert_eq!(items[1]["event"], "read");
            }
            _ => panic!("assistant line must classify as Items"),
        }
    }

    #[test]
    fn classify_init_junk_and_empty_as_nothing() {
        let init = json!({"type":"system","subtype":"init","session_id":"abc"}).to_string();
        assert!(matches!(classify_line(&init), LineOut::Nothing));
        assert!(matches!(classify_line("not json"), LineOut::Nothing));
        // A user line carrying only tool_results parses to zero items -> Nothing.
        let tr =
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}})
                .to_string();
        assert!(matches!(classify_line(&tr), LineOut::Nothing));
    }

    #[test]
    fn charter_carries_root_roster_and_no_code_rule() {
        let c = build_charter(
            "/Users/u/ooozzy",
            &[("conduit".into(), "/Users/u/ooozzy/conduit".into())],
        );
        assert!(c.contains("/Users/u/ooozzy"));
        assert!(c.contains("- conduit: /Users/u/ooozzy/conduit"));
        assert!(
            c.contains("never write"),
            "charter must state the no-code rule: {c}"
        );
        let empty = build_charter("/Users/u", &[]);
        assert!(empty.contains("(none registered yet)"));
    }

    #[test]
    fn command_pins_session_id_first_then_resumes() {
        let fresh = build_command("abc-123", false, "charter text");
        assert!(fresh.contains("--session-id"), "{fresh}");
        assert!(fresh.contains("--output-format stream-json"));
        assert!(fresh.contains("--allowedTools Read,Glob,Grep,WebSearch,WebFetch"));
        assert!(fresh.contains("--disallowedTools Bash,Write,Edit,NotebookEdit"));
        assert!(fresh.contains("--strict-mcp-config"));
        assert!(fresh.contains("--append-system-prompt"));
        let resumed = build_command("abc-123", true, "charter text");
        assert!(resumed.contains("--resume"));
        assert!(!resumed.contains("--session-id"));
    }
}
