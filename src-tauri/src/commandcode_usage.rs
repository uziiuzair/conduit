//! Command Code plan usage: the rolling-window meters behind its `/usage` slash command.
//!
//! Command Code has no headless usage command -- `cmd status --json` answers only
//! `{"authenticated":bool,"version":string}` -- so the numbers come from the same API its
//! TUI reads:
//!
//!   GET https://api.commandcode.ai/alpha/usage/summary
//!   Authorization: Bearer <apiKey>
//!   -> { limited, fiveHour: { used, cap, resetAt }, weekly: { used, cap, resetAt } }
//!
//! The limit model is two ROLLING windows over monthly credits: a window opens on the
//! first request and closes exactly 5 hours (or 7 days) later, with no calendar boundary.
//! Pay-as-you-go credits are never capped and are spent first once a window is exhausted,
//! which is why `limited: false` is a normal state rather than an error.
//!
//! **These are `/alpha/` endpoints on a CLI at v1.32.1, and they will move.** Every field
//! is optional on the way in and an unrecognized shape degrades to "unavailable" rather
//! than to a wrong number: a usage meter that lies is worse than one that admits it does
//! not know. That is also why `parse_usage_summary` is pure and carries the tests -- it is
//! the part that can be verified without an account.
//!
//! Secrets: the api key is read from disk at poll time, held in a local, and never logged,
//! echoed into an error, or persisted. Conduit does not cache it -- unlike Claude's token,
//! reading it costs no Keychain prompt, so there is nothing to be gained by keeping it.
//!
//! Design: docs/superpowers/specs/2026-08-23-command-code-agent-design.md

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::claude_usage::PlanWindow;

/// Where the API lives. `alpha` is the vendor's own path segment, not a Conduit choice.
const USAGE_ENDPOINT: &str = "https://api.commandcode.ai/alpha/usage/summary";

/// One account's Command Code usage.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeAccountUsage {
    /// None for the ambient account (`~/.commandcode`).
    pub account_id: Option<String>,
    pub label: String,
    pub usage: CommandCodeUsage,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeUsage {
    /// The rolling windows, when they could be read. None = nothing to draw.
    pub windows: Option<Vec<PlanWindow>>,
    /// "live" -- read from the API.
    /// "disconnected" -- no api key on disk, i.e. not signed in.
    /// "unavailable" -- signed in, but the call failed or answered a shape we do not know.
    ///
    /// Three states rather than two because the fixes differ: "disconnected" means run
    /// `cmd login`, while "unavailable" means something is wrong that no action fixes.
    pub source: String,
    /// Whether Command Code says this account is currently capped. `false` is normal --
    /// extra credits bypass the windows entirely.
    pub limited: bool,
}

impl CommandCodeUsage {
    fn empty(source: &str) -> Self {
        Self {
            windows: None,
            source: source.into(),
            limited: false,
        }
    }
}

/// The `.commandcode` directory for an account, or the ambient one.
///
/// `config_dir` is what the account registry stores, which for Command Code is the
/// `.commandcode` directory itself -- that is what `command_code_profile_env` redirects
/// HOME to the parent of. None = the ambient `~/.commandcode`.
fn auth_dir(config_dir: Option<&str>) -> Option<PathBuf> {
    match config_dir {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|h| h.join(".commandcode")),
    }
}

/// Read this account's api key: the env override first, then `auth.json`.
///
/// Mirrors the CLI's own resolution order (`COMMAND_CODE_API_KEY` beats the file), so
/// Conduit reads usage for the same account a session would actually run as. The env var
/// is consulted only for the AMBIENT account: a registered account names a specific
/// profile on disk, and letting an ambient env var override it would report one account's
/// usage under another's label.
fn read_api_key(config_dir: Option<&str>) -> Option<String> {
    if config_dir.is_none() {
        if let Ok(k) = std::env::var("COMMAND_CODE_API_KEY") {
            if !k.is_empty() {
                return Some(k);
            }
        }
    }
    let path = auth_dir(config_dir)?.join("auth.json");
    let raw = std::fs::read_to_string(path).ok()?;
    parse_api_key(&raw)
}

/// Pull `apiKey` out of an `auth.json` blob. Pure, so the shape is testable without an
/// account -- and without a real key ever appearing in a test.
pub fn parse_api_key(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("apiKey")
        .and_then(|k| k.as_str())
        .filter(|k| !k.is_empty())
        .map(str::to_string)
}

/// Parse `/alpha/usage/summary` into ordered windows plus the `limited` flag.
///
/// Defensive on purpose. `used`/`cap` are accepted as any JSON number; a window missing
/// either is SKIPPED rather than drawn at zero, and a `cap` of zero yields no window
/// instead of a division by zero or a full bar. Returns None when nothing usable was
/// found, which the caller reports as "unavailable".
pub fn parse_usage_summary(body: &str) -> Option<(Vec<PlanWindow>, bool)> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let obj = v.as_object()?;
    let limited = obj
        .get("limited")
        .and_then(|l| l.as_bool())
        .unwrap_or(false);
    let mut out = Vec::new();
    for (key, label) in [("fiveHour", "5-hour window"), ("weekly", "Weekly")] {
        let Some(w) = obj.get(key) else { continue };
        let (Some(used), Some(cap)) = (
            w.get("used").and_then(|u| u.as_f64()),
            w.get("cap").and_then(|c| c.as_f64()),
        ) else {
            continue;
        };
        if cap <= 0.0 {
            continue;
        }
        // `resetAt` is epoch millis in the TUI's own arithmetic; a string is accepted too,
        // so a future format change degrades to "shown but not parsed" rather than to a
        // dropped window.
        let resets_at = w.get("resetAt").and_then(|r| {
            r.as_str()
                .map(str::to_string)
                .or_else(|| r.as_f64().map(|n| n.to_string()))
        });
        out.push(PlanWindow {
            label: label.into(),
            pct_used: (used / cap).clamp(0.0, 1.0),
            resets_at,
        });
    }
    (!out.is_empty()).then_some((out, limited))
}

/// Fetch one account's usage. Blocking: called from `spawn_blocking`.
fn fetch(config_dir: Option<&str>) -> CommandCodeUsage {
    let Some(key) = read_api_key(config_dir) else {
        return CommandCodeUsage::empty("disconnected");
    };
    use crate::NoWindow;
    // curl rather than a Rust HTTP client, per the lean-dependency rule in CLAUDE.md --
    // the same call shape as claude_usage's plan fetch.
    let out = Command::new("curl")
        .args([
            "-s",
            "--max-time",
            "8",
            "-H",
            &format!("Authorization: Bearer {key}"),
            USAGE_ENDPOINT,
        ])
        .no_window()
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let body = String::from_utf8_lossy(&o.stdout);
            match parse_usage_summary(&body) {
                // Deliberately nothing logged on the failure path either: the body is an
                // authenticated response about someone's account.
                Some((windows, limited)) => CommandCodeUsage {
                    windows: Some(windows),
                    source: "live".into(),
                    limited,
                },
                None => CommandCodeUsage::empty("unavailable"),
            }
        }
        _ => CommandCodeUsage::empty("unavailable"),
    }
}

/// Tauri command: usage for every registered Command Code account, plus the ambient one
/// when none are registered. Empty vec when Command Code is not set up at all.
#[tauri::command]
pub async fn fetch_command_code_usage(
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<Vec<CommandCodeAccountUsage>, String> {
    let targets = store.usage_targets(crate::agent::AgentId::CommandCode);
    tauri::async_runtime::spawn_blocking(move || {
        targets
            .into_iter()
            .map(|(account_id, label, config_dir)| CommandCodeAccountUsage {
                account_id,
                label,
                usage: fetch(config_dir.as_deref()),
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_comes_out_of_the_auth_blob() {
        assert_eq!(
            parse_api_key(r#"{"apiKey":"sk-test","userName":"someone"}"#).as_deref(),
            Some("sk-test")
        );
        // Not signed in, or a shape we do not know: no key, and the caller reports
        // "disconnected" rather than firing an unauthenticated request.
        assert_eq!(parse_api_key(r#"{"userName":"someone"}"#), None);
        assert_eq!(
            parse_api_key(r#"{"apiKey":""}"#),
            None,
            "empty is not a key"
        );
        assert_eq!(parse_api_key("not json"), None);
        assert_eq!(parse_api_key("[]"), None);
    }

    #[test]
    fn usage_summary_becomes_two_ordered_windows() {
        let body = r#"{
            "limited": true,
            "fiveHour": { "used": 7, "cap": 14, "resetAt": 1750000000000 },
            "weekly":   { "used": 35, "cap": 35, "resetAt": 1750500000000 }
        }"#;
        let (windows, limited) = parse_usage_summary(body).expect("parses");
        assert!(limited);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5-hour window");
        assert!((windows[0].pct_used - 0.5).abs() < f64::EPSILON);
        assert_eq!(windows[1].label, "Weekly");
        assert!((windows[1].pct_used - 1.0).abs() < f64::EPSILON);
        assert_eq!(windows[0].resets_at.as_deref(), Some("1750000000000"));
    }

    #[test]
    fn a_window_is_skipped_rather_than_drawn_wrong() {
        // Missing `cap`: drawing this at 0% would claim the account is untouched.
        let one = parse_usage_summary(r#"{"fiveHour":{"used":3},"weekly":{"used":1,"cap":4}}"#)
            .expect("the weekly window still parses");
        assert_eq!(one.0.len(), 1);
        assert_eq!(one.0[0].label, "Weekly");

        // A zero cap must not divide by zero or read as a full bar.
        assert!(parse_usage_summary(r#"{"fiveHour":{"used":0,"cap":0}}"#).is_none());

        // Nothing recognizable at all -> None, which the caller reports as "unavailable".
        assert!(parse_usage_summary(r#"{"somethingElse":1}"#).is_none());
        assert!(parse_usage_summary("{}").is_none());
        assert!(parse_usage_summary("<html>502</html>").is_none());
    }

    #[test]
    fn limited_defaults_to_false_and_over_cap_is_clamped() {
        // `limited` absent is the normal uncapped state, not an error.
        let (windows, limited) =
            parse_usage_summary(r#"{"fiveHour":{"used":1,"cap":10}}"#).expect("parses");
        assert!(!limited);
        assert_eq!(windows.len(), 1);
        // Extra credits can push usage past the cap; the meter stops at full rather than
        // rendering a bar longer than its track.
        let (over, _) =
            parse_usage_summary(r#"{"fiveHour":{"used":99,"cap":10}}"#).expect("parses");
        assert!((over[0].pct_used - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn auth_dir_prefers_the_account_over_the_ambient_home() {
        assert_eq!(
            auth_dir(Some("/profiles/work/.commandcode")),
            Some(PathBuf::from("/profiles/work/.commandcode"))
        );
        // An empty string is "no account", not a path to the filesystem root.
        assert_eq!(auth_dir(Some("")), auth_dir(None));
    }
}
