//! Conductor fleet runtime: the per-session status the Conductor reads, plus the
//! shared state (MCP port, status map, pending stop-confirmations) the fleet MCP
//! server uses. Status is derived in Rust from the same hook events the frontend
//! `live` map consumes (see App.tsx) so the Conductor and the UI agree.

use std::collections::HashMap;
use std::sync::atomic::AtomicU16;
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetStatus {
    pub status: String, // "idle" | "running" | "needsInput" | "done"
    pub activity: Option<String>,
    pub todos_total: u32,
    pub todos_done: u32,
    pub updated_at: u64, // unix millis
}

impl Default for FleetStatus {
    fn default() -> Self {
        FleetStatus {
            status: "idle".into(),
            activity: None,
            todos_total: 0,
            todos_done: 0,
            updated_at: 0,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Mirror the frontend App.tsx event->status switch. Pure; unit-tested.
pub fn apply_event(s: &mut FleetStatus, event: &str, body: &Value) {
    match event {
        "prompt" => {
            s.status = "running".into();
            s.activity = None;
        }
        "pretool" => {
            s.status = "running".into();
            s.activity = body
                .get("tool_name")
                .and_then(|v| v.as_str())
                .map(|x| x.to_string());
        }
        "todos" | "tooluse" => {
            if let Some(todos) = body
                .get("tool_input")
                .and_then(|t| t.get("todos"))
                .and_then(|t| t.as_array())
            {
                s.todos_total = todos.len() as u32;
                s.todos_done = todos
                    .iter()
                    .filter(|t| t.get("status").and_then(|x| x.as_str()) == Some("completed"))
                    .count() as u32;
            }
        }
        "stop" => {
            s.status = "done".into();
            s.activity = None;
        }
        "notification" => {
            s.status = "needsInput".into();
        }
        "sessionstart" | "sessionend" => {
            s.status = "idle".into();
            s.activity = None;
        }
        _ => {}
    }
    s.updated_at = now_ms();
}

/// Shared fleet runtime state: MCP server port, per-session status, and the
/// pending stop-confirmation channels (request id -> reply sender).
#[derive(Default)]
pub struct FleetState {
    pub mcp_port: AtomicU16,
    pub status: Mutex<HashMap<String, FleetStatus>>,
    pub pending_confirms: Mutex<HashMap<String, Sender<bool>>>,
}

impl FleetState {
    /// Record a hook event into the status map (called by the hook server).
    pub fn record(&self, session: &str, event: &str, body: &Value) {
        let mut map = self.status.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(session.to_string()).or_default();
        apply_event(entry, event, body);
    }

    /// A clone of the whole status map (for fleet_list).
    pub fn snapshot(&self) -> HashMap<String, FleetStatus> {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_event_maps_lifecycle_to_status() {
        let mut s = FleetStatus::default();
        assert_eq!(s.status, "idle");

        apply_event(&mut s, "prompt", &serde_json::json!({}));
        assert_eq!(s.status, "running");

        apply_event(&mut s, "pretool", &serde_json::json!({"tool_name":"Edit"}));
        assert_eq!(s.status, "running");
        assert_eq!(s.activity.as_deref(), Some("Edit"));

        apply_event(&mut s, "stop", &serde_json::json!({}));
        assert_eq!(s.status, "done");

        apply_event(&mut s, "notification", &serde_json::json!({}));
        assert_eq!(s.status, "needsInput");

        apply_event(&mut s, "sessionend", &serde_json::json!({}));
        assert_eq!(s.status, "idle");
    }

    #[test]
    fn apply_event_counts_todos() {
        let mut s = FleetStatus::default();
        let body = serde_json::json!({
            "tool_input": { "todos": [
                {"content":"a","status":"completed"},
                {"content":"b","status":"in_progress"},
                {"content":"c","status":"pending"}
            ]}
        });
        apply_event(&mut s, "todos", &body);
        assert_eq!(s.todos_total, 3);
        assert_eq!(s.todos_done, 1);
    }

    #[test]
    fn record_updates_the_map() {
        let fleet = FleetState::default();
        fleet.record("s1", "prompt", &serde_json::json!({}));
        let snap = fleet.snapshot();
        assert_eq!(snap.get("s1").map(|x| x.status.as_str()), Some("running"));
    }
}
