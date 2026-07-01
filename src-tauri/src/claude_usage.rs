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
    /// 0.0..=1.0 (normalized fraction)
    pub pct_used: f64,
    /// RFC3339 timestamp string (the endpoint's format). None if absent.
    pub resets_at: Option<String>,
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

// ---- Plan limits (best-effort) ----
//
// Endpoint + payload shape were derived from the claude-code 2.1.186 binary
// (see docs/superpowers/plans/2026-06-26-claude-status-usage.md, Task 1):
//   GET https://api.anthropic.com/api/oauth/usage  ("fetchUtilization")
//   body: { five_hour, seven_day, seven_day_opus, ... } each {utilization 0..1, resets_at <epoch>}

const USAGE_ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";

/// Parse the /api/oauth/usage body into ordered windows. Defensive against the
/// undocumented shape: tolerates `utilization` as a fraction (0..1) OR a
/// percentage (0..100), and `resets_at` as an RFC3339 string OR a numeric epoch.
/// Returns None on shape mismatch (caller degrades to local-only / "unavailable").
pub fn parse_plan(body: &str) -> Option<Vec<PlanWindow>> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let obj = v.as_object()?;
    let mut out = Vec::new();
    for (key, label) in [
        ("five_hour", "5-hour window"),
        ("seven_day", "Weekly (all)"),
        ("seven_day_opus", "Weekly (Opus)"),
    ] {
        let Some(w) = obj.get(key) else { continue };
        let Some(util) = w.get("utilization").and_then(|u| u.as_f64()) else { continue };
        // utilization may be a 0..1 fraction or a 0..100 percentage.
        let pct = if util > 1.0 { util / 100.0 } else { util };
        let resets_at = w.get("resets_at").and_then(|r| {
            r.as_str()
                .map(|s| s.to_string())
                .or_else(|| r.as_f64().map(|n| n.to_string()))
        });
        out.push(PlanWindow {
            label: label.into(),
            pct_used: pct.clamp(0.0, 1.0),
            resets_at,
        });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Call the usage endpoint with the cached token. Returns (windows, planSource).
fn fetch_plan(token: Option<String>) -> (Option<Vec<PlanWindow>>, String) {
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => return (None, "disconnected".into()),
    };
    use crate::NoWindow;
    let out = Command::new("curl")
        .args([
            "-s",
            "--max-time",
            "8",
            "-H",
            &format!("Authorization: Bearer {token}"),
            USAGE_ENDPOINT,
        ])
        .no_window()
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let body = String::from_utf8_lossy(&o.stdout);
            match parse_plan(&body) {
                Some(windows) => (Some(windows), "live".into()),
                None => (None, "unavailable".into()),
            }
        }
        _ => (None, "unavailable".into()),
    }
}

/// Read the Claude Code OAuth access token from the macOS login Keychain.
/// `-w` prints only the secret (a JSON blob). This triggers the macOS allow
/// prompt; it runs only on explicit user action (the "Connect plan usage" button).
fn read_keychain_token() -> Option<String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let trimmed = raw.trim();
    // The blob is JSON like {"claudeAiOauth":{"accessToken":"...", ...}}.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(tok) = v
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|t| t.as_str())
        {
            return Some(tok.to_string());
        }
    }
    // Fallback: some versions may store the bare token string.
    if trimmed.starts_with("sk-") || trimmed.starts_with("eyJ") {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Tauri command: connect plan usage. Reads the Keychain token (macOS prompt),
/// caches it in memory, and returns whether a live plan fetch then succeeded.
#[tauri::command]
pub async fn connect_claude_plan_usage(
    auth: tauri::State<'_, std::sync::Arc<ClaudeAuth>>,
) -> Result<bool, String> {
    let auth = auth.inner().clone();
    let ok = tauri::async_runtime::spawn_blocking(move || {
        let token = match read_keychain_token() {
            Some(t) => t,
            None => return false,
        };
        *auth.token.lock().unwrap_or_else(|e| e.into_inner()) = Some(token.clone());
        let (plan, _src) = fetch_plan(Some(token));
        plan.is_some()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(ok)
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

    #[test]
    fn parses_plan_windows_real_shape() {
        // Real /api/oauth/usage shape: resets_at is an RFC3339 STRING and
        // utilization is a PERCENTAGE (captured live, 2026-06-26).
        let body = r#"{
          "five_hour": {"utilization": 2.0, "resets_at": "2026-06-26T14:40:00.997918+00:00",
                        "limit_dollars": null, "used_dollars": null, "remaining_dollars": null},
          "seven_day": {"utilization": 41.0, "resets_at": "2026-06-30T00:00:00+00:00"},
          "seven_day_opus": {"utilization": 79.0, "resets_at": "2026-06-30T00:00:00+00:00"},
          "overage": {"allowed": true}
        }"#;
        let w = super::parse_plan(body).expect("windows");
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].label, "5-hour window");
        assert!((w[0].pct_used - 0.02).abs() < 1e-9, "got {}", w[0].pct_used);
        assert_eq!(w[0].resets_at.as_deref(), Some("2026-06-26T14:40:00.997918+00:00"));
        assert_eq!(w[2].label, "Weekly (Opus)");
        assert!((w[2].pct_used - 0.79).abs() < 1e-9);
    }

    #[test]
    fn plan_normalizes_scale_and_handles_missing() {
        // Fraction scale (<=1.0) passes through unchanged.
        let frac = super::parse_plan(r#"{"five_hour": {"utilization": 0.68, "resets_at": "x"}}"#)
            .expect("one");
        assert_eq!(frac.len(), 1);
        assert!((frac[0].pct_used - 0.68).abs() < 1e-9);
        // Percentage over 100 clamps to 1.0; missing resets_at → None.
        let over = super::parse_plan(r#"{"five_hour": {"utilization": 150.0}}"#).expect("over");
        assert_eq!(over[0].pct_used, 1.0);
        assert_eq!(over[0].resets_at, None);
        // No recognizable windows → None.
        assert!(super::parse_plan(r#"{"unrelated": 1}"#).is_none());
    }
}
