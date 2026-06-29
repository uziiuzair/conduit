//! Anthropic service status from status.claude.com (Atlassian Statuspage v2 API).
//! Public, no auth. Fetched via `curl`; parsing is pure + unit-tested. Fail-open:
//! any network/parse error yields a non-crashing "unknown" status.

use std::process::Command;

use serde::{Deserialize, Serialize};

const SUMMARY_URL: &str = "https://status.claude.com/api/v2/summary.json";

// ---- Outgoing types (camelCase for the frontend) ----

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    /// "none" | "minor" | "major" | "critical" | "unknown"
    pub indicator: String,
    pub description: String,
    pub components: Vec<StatusComponent>,
    pub incidents: Vec<StatusIncident>,
    /// false when the fetch or parse failed (indicator == "unknown").
    pub ok: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusComponent {
    pub name: String,
    pub status: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusIncident {
    pub name: String,
    pub status: String,
    pub impact: String,
    pub shortlink: String,
}

// ---- Incoming Statuspage mirror (snake_case keys match the API) ----

#[derive(Deserialize)]
struct SpSummary {
    #[serde(default)]
    status: SpStatus,
    #[serde(default)]
    components: Vec<SpComponent>,
    #[serde(default)]
    incidents: Vec<SpIncident>,
}

#[derive(Deserialize, Default)]
struct SpStatus {
    #[serde(default)]
    indicator: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct SpComponent {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
}

#[derive(Deserialize)]
struct SpIncident {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    impact: String,
    #[serde(default)]
    shortlink: String,
}

fn unknown() -> ClaudeStatus {
    ClaudeStatus {
        indicator: "unknown".into(),
        description: "Status unavailable".into(),
        components: Vec::new(),
        incidents: Vec::new(),
        ok: false,
    }
}

/// Parse a Statuspage `summary.json` body. Returns an "unknown" status on any
/// error so callers never see a hard failure.
pub fn parse_summary(body: &str) -> ClaudeStatus {
    let raw: SpSummary = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return unknown(),
    };
    // `incidents` from summary.json are the *unresolved* ones; keep all returned.
    ClaudeStatus {
        indicator: if raw.status.indicator.is_empty() {
            "none".into()
        } else {
            raw.status.indicator
        },
        description: raw.status.description,
        components: raw
            .components
            .into_iter()
            .map(|c| StatusComponent { name: c.name, status: c.status })
            .collect(),
        incidents: raw
            .incidents
            .into_iter()
            .map(|i| StatusIncident {
                name: i.name,
                status: i.status,
                impact: i.impact,
                shortlink: i.shortlink,
            })
            .collect(),
        ok: true,
    }
}

fn curl(url: &str) -> Option<String> {
    let out = Command::new("curl")
        .args(["-s", "--max-time", "8", url])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Tauri command: fetch + parse current Anthropic service status. Never errors.
#[tauri::command]
pub async fn fetch_claude_status() -> ClaudeStatus {
    match tauri::async_runtime::spawn_blocking(|| curl(SUMMARY_URL)).await {
        Ok(Some(body)) => parse_summary(&body),
        _ => unknown(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "page": {"id": "abc"},
      "status": {"indicator": "minor", "description": "Partial Degradation"},
      "components": [
        {"name": "Claude API", "status": "operational"},
        {"name": "Claude Code", "status": "degraded_performance"}
      ],
      "incidents": [
        {"name": "Elevated errors", "status": "investigating", "impact": "minor",
         "shortlink": "https://stspg.io/x"}
      ],
      "scheduled_maintenances": []
    }"#;

    #[test]
    fn parses_indicator_components_and_incidents() {
        let s = parse_summary(FIXTURE);
        assert!(s.ok);
        assert_eq!(s.indicator, "minor");
        assert_eq!(s.description, "Partial Degradation");
        assert_eq!(s.components.len(), 2);
        assert_eq!(s.components[1].name, "Claude Code");
        assert_eq!(s.components[1].status, "degraded_performance");
        assert_eq!(s.incidents.len(), 1);
        assert_eq!(s.incidents[0].impact, "minor");
        assert_eq!(s.incidents[0].shortlink, "https://stspg.io/x");
    }

    #[test]
    fn bad_json_yields_unknown_not_panic() {
        let s = parse_summary("not json");
        assert!(!s.ok);
        assert_eq!(s.indicator, "unknown");
    }

    #[test]
    fn empty_indicator_defaults_to_none() {
        let s = parse_summary(r#"{"status":{"description":"All Systems Operational"}}"#);
        assert!(s.ok);
        assert_eq!(s.indicator, "none");
    }
}
