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
    #[serde(default, rename = "lastComputedDate")]
    last_computed_date: String,
    #[serde(default, rename = "firstSessionDate")]
    first_session_date: String,
    #[serde(default, rename = "modelUsage")]
    model_usage: HashMap<String, ModelUsage>,
    #[serde(default, rename = "totalMessages")]
    total_messages: i64,
    #[serde(default, rename = "totalSessions")]
    total_sessions: i64,
    #[serde(default, rename = "dailyModelTokens")]
    daily_model_tokens: Vec<DailyModelTokens>,
    #[serde(default, rename = "dailyActivity")]
    daily_activity: Vec<DailyActivity>,
}

#[derive(Deserialize, Default)]
struct ModelUsage {
    #[serde(default, rename = "inputTokens")]
    input_tokens: i64,
    #[serde(default, rename = "outputTokens")]
    output_tokens: i64,
    #[serde(default, rename = "cacheReadInputTokens")]
    cache_read_input_tokens: i64,
    #[serde(default, rename = "cacheCreationInputTokens")]
    cache_creation_input_tokens: i64,
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

/// Parse stats-cache.json into local usage. Prefer the cumulative `modelUsage` /
/// `totalMessages` fields when present; older cache shapes fall back to the latest
/// daily entry so we never need the current date. Empty on error.
pub fn parse_stats_cache(body: &str) -> LocalUsage {
    let cache: StatsCache = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return LocalUsage::default(),
    };

    let mut out = LocalUsage::default();

    if !cache.model_usage.is_empty() {
        let mut models: Vec<ModelTokens> = cache
            .model_usage
            .iter()
            .map(|(m, u)| ModelTokens {
                model: m.clone(),
                tokens: u.input_tokens
                    + u.output_tokens
                    + u.cache_read_input_tokens
                    + u.cache_creation_input_tokens,
            })
            .filter(|m| m.tokens > 0)
            .collect();
        models.sort_by(|a, b| b.tokens.cmp(&a.tokens));
        out.total_tokens = models.iter().map(|m| m.tokens).sum();
        out.tokens_by_model = models;
        out.messages = cache.total_messages;
        out.sessions = cache.total_sessions;
        out.date = if !cache.last_computed_date.is_empty() {
            cache.last_computed_date
        } else {
            cache.first_session_date
        };
        return out;
    }

    if let Some(day) = cache.daily_model_tokens.last() {
        out.date = day.date.clone();
        let mut models: Vec<ModelTokens> = day
            .tokens_by_model
            .iter()
            .map(|(m, t)| ModelTokens {
                model: m.clone(),
                tokens: *t,
            })
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

/// The Claude config dir to read usage/credentials from: the selected account's dir when
/// one is set, else `~/.claude`. `config_dir` is the global default account's `config_dir`
/// (resolved by the Tauri command from the store) -- passing it here is what makes the
/// usage panel follow the account the user actually selected instead of always reading the
/// first/only `~/.claude`. Bug: a multi-account user who selected "personal" saw "work"
/// usage because both reads below hardcoded `~/.claude`.
fn claude_config_dir(config_dir: Option<&str>) -> Option<std::path::PathBuf> {
    match config_dir {
        Some(d) if !d.trim().is_empty() => Some(std::path::PathBuf::from(d)),
        _ => dirs::home_dir().map(|h| h.join(".claude")),
    }
}

fn stats_cache_path(config_dir: Option<&str>) -> Option<std::path::PathBuf> {
    claude_config_dir(config_dir).map(|d| d.join("stats-cache.json"))
}

fn read_local_usage(config_dir: Option<&str>) -> LocalUsage {
    stats_cache_path(config_dir)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|body| parse_stats_cache(&body))
        .unwrap_or_default()
}

// ---- Plan-limit token cache (populated by connect; see plan-limit section) ----

#[derive(Default)]
pub struct ClaudeAuth {
    pub token: Mutex<Option<String>>,
}

/// Tauri command: local usage always; plan limits when a token is cached. Reads from the
/// selected (default) account's config dir, not a hardcoded `~/.claude`, so a multi-account
/// user sees the account they actually chose.
#[tauri::command]
pub async fn fetch_claude_usage(
    auth: tauri::State<'_, std::sync::Arc<ClaudeAuth>>,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<ClaudeUsage, String> {
    let token = auth.token.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let config_dir = store.default_account_config_dir();
    let usage = tauri::async_runtime::spawn_blocking(move || {
        let local = read_local_usage(config_dir.as_deref());
        let (plan, plan_source) = fetch_plan(token);
        ClaudeUsage {
            local,
            plan,
            plan_source,
        }
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
        let Some(util) = w.get("utilization").and_then(|u| u.as_f64()) else {
            continue;
        };
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

/// Extract the Claude Code OAuth access token from the credentials blob, wherever it
/// came from (macOS Keychain secret, or the Windows plain-file store below). Pure, so
/// it's testable without touching the Keychain/filesystem. The blob is JSON like
/// `{"claudeAiOauth":{"accessToken":"...", ...}}`; falls back to a bare token string for
/// older/other formats.
fn parse_oauth_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(tok) = v
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|t| t.as_str())
        {
            return Some(tok.to_string());
        }
    }
    if trimmed.starts_with("sk-") || trimmed.starts_with("eyJ") {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Read the Claude Code OAuth access token for the selected account. A non-default account
/// selected via `CLAUDE_CONFIG_DIR` stores its credentials as a plain `.credentials.json`
/// in that dir, so prefer that when `config_dir` points at one; only fall back to the login
/// Keychain (the DEFAULT account's store on macOS) when no per-dir file exists. `-w` prints
/// only the secret; it triggers the macOS allow prompt, so this runs only on explicit user
/// action (the "Connect plan usage" button).
#[cfg(target_os = "macos")]
fn read_oauth_token(config_dir: Option<&str>) -> Option<String> {
    if let Some(dir) = config_dir.filter(|d| !d.trim().is_empty()) {
        let file = std::path::Path::new(dir).join(".credentials.json");
        if let Ok(raw) = std::fs::read_to_string(&file) {
            return parse_oauth_token(&raw);
        }
    }
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_oauth_token(&String::from_utf8_lossy(&out.stdout))
}

/// Read the Claude Code OAuth access token from its plain-file store on Windows.
/// **Verified against a real file on this dev machine (2026-07-05):**
/// `~/.claude/.credentials.json` exists with exactly the same top-level shape the macOS
/// Keychain blob has (`{"claudeAiOauth": {"accessToken": ..., "refreshToken": ...,
/// "expiresAt": ..., "scopes": [...], ...}, "organizationUuid": ...}`), confirmed by
/// reading the real file's key structure (never its values). No Windows Credential
/// Manager / DPAPI involved -- Claude Code itself stores this as a plain JSON file here,
/// so `parse_oauth_token` is shared unmodified. No prompt/elevation needed to read it.
#[cfg(windows)]
fn read_oauth_token(config_dir: Option<&str>) -> Option<String> {
    let path = claude_config_dir(config_dir)?.join(".credentials.json");
    parse_oauth_token(&std::fs::read_to_string(path).ok()?)
}

/// Other platforms (Linux): Claude Code stores `.credentials.json` as a plain file in the
/// config dir, same shape as Windows -- read it from the selected account's dir.
#[cfg(not(any(target_os = "macos", windows)))]
fn read_oauth_token(config_dir: Option<&str>) -> Option<String> {
    let path = claude_config_dir(config_dir)?.join(".credentials.json");
    parse_oauth_token(&std::fs::read_to_string(path).ok()?)
}

/// Tauri command: connect plan usage. Reads the OAuth token from wherever this platform
/// stores it (macOS Keychain prompt, or the Windows plain-file store), caches it in
/// memory, and returns whether a live plan fetch then succeeded.
#[tauri::command]
pub async fn connect_claude_plan_usage(
    auth: tauri::State<'_, std::sync::Arc<ClaudeAuth>>,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<bool, String> {
    let auth = auth.inner().clone();
    let config_dir = store.default_account_config_dir();
    let ok = tauri::async_runtime::spawn_blocking(move || {
        let token = match read_oauth_token(config_dir.as_deref()) {
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

    const CUMULATIVE_FIXTURE: &str = r#"{
      "version": 1,
      "firstSessionDate": "2026-06-01",
      "lastComputedDate": "2026-06-26",
      "totalMessages": 42,
      "totalSessions": 7,
      "modelUsage": {
        "claude-opus-4-8": {
          "inputTokens": 100,
          "outputTokens": 25,
          "cacheReadInputTokens": 1000,
          "cacheCreationInputTokens": 250
        },
        "claude-sonnet-4-6": {
          "inputTokens": 50,
          "outputTokens": 10,
          "cacheReadInputTokens": 0,
          "cacheCreationInputTokens": 5
        }
      },
      "dailyModelTokens": [
        {"date": "2026-06-26", "tokensByModel": {"claude-opus-4-8": 10}}
      ],
      "dailyActivity": [
        {"date": "2026-06-26", "messageCount": 1, "sessionCount": 1, "toolCallCount": 9}
      ]
    }"#;

    #[test]
    fn config_dir_prefers_selected_account_over_home() {
        // The account-usage bug: a selected (non-default-home) account dir must win, so the
        // usage panel follows the account the user chose instead of always reading ~/.claude.
        let selected = claude_config_dir(Some(r"C:\Users\u\.claude-personal\.claude")).unwrap();
        assert_eq!(
            selected,
            std::path::Path::new(r"C:\Users\u\.claude-personal\.claude")
        );
        assert_eq!(
            stats_cache_path(Some(r"C:\Users\u\.claude-personal\.claude")).unwrap(),
            std::path::Path::new(r"C:\Users\u\.claude-personal\.claude").join("stats-cache.json")
        );
        // Empty/absent selection falls back to the home ~/.claude dir (single-account users).
        let home_fallback = stats_cache_path(None);
        let home_empty = stats_cache_path(Some("   "));
        assert_eq!(home_fallback, home_empty);
        if let Some(h) = dirs::home_dir() {
            assert_eq!(
                home_fallback.unwrap(),
                h.join(".claude").join("stats-cache.json")
            );
        }
    }

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
    fn prefers_cumulative_model_usage_when_present() {
        let u = parse_stats_cache(CUMULATIVE_FIXTURE);
        assert_eq!(u.date, "2026-06-26");
        assert_eq!(u.total_tokens, 1_440);
        assert_eq!(u.messages, 42);
        assert_eq!(u.sessions, 7);
        assert_eq!(u.tokens_by_model.len(), 2);
        assert_eq!(u.tokens_by_model[0].model, "claude-opus-4-8");
        assert_eq!(u.tokens_by_model[0].tokens, 1_375);
        assert_eq!(u.tokens_by_model[1].model, "claude-sonnet-4-6");
        assert_eq!(u.tokens_by_model[1].tokens, 65);
    }

    #[test]
    fn parse_oauth_token_extracts_from_claude_ai_oauth_shape() {
        // Shape verified against a real ~/.claude/.credentials.json on Windows
        // (2026-07-05) -- values here are synthetic, never the real token.
        let body = r#"{
          "claudeAiOauth": {
            "accessToken": "sk-ant-oat-FAKE-TOKEN-FOR-TESTS-ONLY",
            "refreshToken": "sk-ant-ort-FAKE-REFRESH-FOR-TESTS-ONLY",
            "expiresAt": 1234567890,
            "scopes": ["user:inference", "user:profile"],
            "subscriptionType": "max",
            "rateLimitTier": "default_claude_max_20x"
          },
          "organizationUuid": "00000000-0000-0000-0000-000000000000"
        }"#;
        assert_eq!(
            parse_oauth_token(body).as_deref(),
            Some("sk-ant-oat-FAKE-TOKEN-FOR-TESTS-ONLY")
        );
    }

    #[test]
    fn parse_oauth_token_falls_back_to_bare_token_string() {
        assert_eq!(
            parse_oauth_token(" sk-ant-bare-fake-token \n").as_deref(),
            Some("sk-ant-bare-fake-token")
        );
        assert_eq!(
            parse_oauth_token("eyJhbGciOiJIUzI1NiJ9.fake.jwt").as_deref(),
            Some("eyJhbGciOiJIUzI1NiJ9.fake.jwt")
        );
    }

    #[test]
    fn parse_oauth_token_none_on_unrecognized_shape() {
        assert!(parse_oauth_token("{}").is_none());
        assert!(parse_oauth_token("not json, not a token").is_none());
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
        assert_eq!(
            w[0].resets_at.as_deref(),
            Some("2026-06-26T14:40:00.997918+00:00")
        );
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
