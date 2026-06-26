//! Claude usage: local consumption (always, from ~/.claude/stats-cache.json) plus
//! best-effort subscription plan limits (see plan-limit section). Fail-open throughout.

use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// ---- Outgoing types (camelCase) ----

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub local: LocalUsage,
    /// Present only when plan limits were fetched successfully.
    pub plan: Option<Vec<PlanWindow>>,
    /// "live" | "unavailable" | "disconnected"
    pub plan_source: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsage {
    pub date: String,
    pub tokens_by_model: Vec<ModelTokens>,
    pub total_tokens: i64,
    pub sessions: i64,
    pub messages: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelTokens {
    pub model: String,
    pub tokens: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanWindow {
    pub label: String,
    /// 0.0..=1.0
    pub pct_used: f64,
    /// Epoch (seconds or ms — the frontend detects scale). None if absent.
    pub resets_at: Option<f64>,
}

// ---- Incoming stats-cache.json mirror ----

#[derive(Deserialize, Default)]
struct StatsCache {
    #[serde(default, rename = "dailyModelTokens")]
    daily_model_tokens: Vec<DailyModelTokens>,
    #[serde(default, rename = "dailyActivity")]
    daily_activity: Vec<DailyActivity>,
}

#[derive(Deserialize)]
struct DailyModelTokens {
    #[serde(default)]
    date: String,
    #[serde(default, rename = "tokensByModel")]
    tokens_by_model: HashMap<String, i64>,
}

#[derive(Deserialize)]
struct DailyActivity {
    #[serde(default)]
    date: String,
    #[serde(default, rename = "messageCount")]
    message_count: i64,
    #[serde(default, rename = "sessionCount")]
    session_count: i64,
}

/// Parse stats-cache.json into the latest day's local usage. Uses the LAST entry
/// of each array (most recent) so we never need the current date. Empty on error.
pub fn parse_stats_cache(body: &str) -> LocalUsage {
    let cache: StatsCache = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return LocalUsage::default(),
    };

    let mut out = LocalUsage::default();

    if let Some(day) = cache.daily_model_tokens.last() {
        out.date = day.date.clone();
        let mut models: Vec<ModelTokens> = day
            .tokens_by_model
            .iter()
            .map(|(m, t)| ModelTokens { model: m.clone(), tokens: *t })
            .collect();
        models.sort_by(|a, b| b.tokens.cmp(&a.tokens));
        out.total_tokens = models.iter().map(|m| m.tokens).sum();
        out.tokens_by_model = models;
    }

    if let Some(act) = cache.daily_activity.last() {
        if out.date.is_empty() {
            out.date = act.date.clone();
        }
        out.messages = act.message_count;
        out.sessions = act.session_count;
    }

    out
}

fn stats_cache_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("stats-cache.json"))
}

fn read_local_usage() -> LocalUsage {
    stats_cache_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|body| parse_stats_cache(&body))
        .unwrap_or_default()
}

// ---- Plan-limit token cache (populated by connect; see plan-limit section) ----

#[derive(Default)]
pub struct ClaudeAuth {
    pub token: Mutex<Option<String>>,
}

/// Tauri command: local usage always; plan limits when a token is cached.
#[tauri::command]
pub async fn fetch_claude_usage(
    auth: tauri::State<'_, std::sync::Arc<ClaudeAuth>>,
) -> Result<ClaudeUsage, String> {
    let token = auth.token.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let usage = tauri::async_runtime::spawn_blocking(move || {
        let local = read_local_usage();
        let (plan, plan_source) = fetch_plan(token);
        ClaudeUsage { local, plan, plan_source }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(usage)
}

/// Placeholder until the plan-limit section lands: no token → "disconnected".
fn fetch_plan(_token: Option<String>) -> (Option<Vec<PlanWindow>>, String) {
    (None, "disconnected".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "version": 1,
      "dailyModelTokens": [
        {"date": "2026-06-25", "tokensByModel": {"claude-opus-4-8": 10}},
        {"date": "2026-06-26", "tokensByModel": {"claude-opus-4-8": 820000, "claude-sonnet-4-6": 410000}}
      ],
      "dailyActivity": [
        {"date": "2026-06-25", "messageCount": 5, "sessionCount": 1, "toolCallCount": 9},
        {"date": "2026-06-26", "messageCount": 320, "sessionCount": 14, "toolCallCount": 900}
      ]
    }"#;

    #[test]
    fn parses_latest_day_tokens_sorted_desc() {
        let u = parse_stats_cache(FIXTURE);
        assert_eq!(u.date, "2026-06-26");
        assert_eq!(u.tokens_by_model.len(), 2);
        assert_eq!(u.tokens_by_model[0].model, "claude-opus-4-8");
        assert_eq!(u.tokens_by_model[0].tokens, 820000);
        assert_eq!(u.total_tokens, 1_230_000);
        assert_eq!(u.messages, 320);
        assert_eq!(u.sessions, 14);
    }

    #[test]
    fn bad_json_yields_empty_not_panic() {
        let u = parse_stats_cache("nope");
        assert_eq!(u.total_tokens, 0);
        assert!(u.tokens_by_model.is_empty());
    }
}
