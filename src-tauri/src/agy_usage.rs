//! Antigravity (`agy`) usage: subscription quota + context window, sourced from agy's
//! own **status-line command hook** -- the officially-sanctioned extension surface
//! (`antigravity.google/docs/cli/statusline`). Conduit installs a helper into agy's
//! `settings.json` `statusLine.command`; agy pipes a JSON payload to it on each agent
//! state change; the helper POSTs that payload to the hook server (`event=agyusage`),
//! and the server responds with a formatted status-line string agy then displays.
//!
//! We deliberately do NOT call Antigravity's servers (nor its local language server)
//! directly: Google's ToS forbids third-party tools accessing Antigravity, but reading
//! the payload agy hands to a user-configured status-line script is inside the product's
//! own documented extension mechanism. Same shape as Conduit's Codex result reporting:
//! a helper that curls the local hook server. Fail-open throughout.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

// ---- Outgoing types (camelCase, mirrored by the TS store) ----

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgyUsage {
    /// "Pro" | "Ultra" | "Standard" | ... (from `plan_tier`). None if absent.
    pub plan_tier: Option<String>,
    pub email: Option<String>,
    /// Quota groups (e.g. "Gemini Models", "Claude and GPT models"), each with its
    /// weekly + 5-hour buckets. Empty when the payload carried no `quota` map.
    pub groups: Vec<AgyGroup>,
    /// Per-conversation context-window usage, when present.
    pub context: Option<AgyContext>,
    /// "idle" | "working" | "thinking" | ... (cosmetic).
    pub agent_state: Option<String>,
    /// Epoch millis when this snapshot was received (client renders "updated Ns ago").
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgyGroup {
    pub display_name: String,
    pub buckets: Vec<AgyBucket>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgyBucket {
    /// Raw id from agy, e.g. "gemini-weekly" | "gemini-5h" | "3p-weekly" | "3p-5h".
    pub bucket_id: String,
    /// Human window label derived from the id: "Weekly" | "5-hour".
    pub label: String,
    /// 0.0..=1.0 remaining (agy reports `remaining_fraction`).
    pub remaining_fraction: f64,
    /// RFC3339 reset timestamp, if provided.
    pub resets_at: Option<String>,
    /// True when this window is inert (e.g. weekly exhausted disables the 5-hour bucket).
    pub disabled: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgyContext {
    pub used_percentage: f64,
    pub context_window_size: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
}

/// Latest snapshot, replaced on every `agyusage` POST. Account-global (agy quota is
/// per Google account, not per session), matching the global Claude usage panel.
#[derive(Default)]
pub struct AgyUsageState(pub Mutex<Option<AgyUsage>>);

impl AgyUsageState {
    pub fn set(&self, u: AgyUsage) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(u);
    }
    pub fn get(&self) -> Option<AgyUsage> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl AgyUsage {
    /// True when this snapshot actually carried quota meters. agy emits quota-less
    /// status ticks (startup, idle pings, a truncated body); persisting one would
    /// overwrite a good snapshot with empty groups and flip the panel back to "waiting"
    /// on every such tick — so the hook handler only stores snapshots with data.
    pub fn has_data(&self) -> bool {
        !self.groups.is_empty()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The display group a raw bucket id belongs to. agy prefixes Gemini-pool buckets
/// `gemini-*` and the (Ultra-only) Claude/GPT pool `3p-*` ("third-party"). Unknown
/// prefixes fall back to a title-cased first segment so a schema change degrades to a
/// still-labelled group rather than vanishing.
fn group_name(bucket_id: &str) -> String {
    if bucket_id.starts_with("gemini") {
        "Gemini Models".to_string()
    } else if bucket_id.starts_with("3p") || bucket_id.starts_with("claude") {
        "Claude & GPT Models".to_string()
    } else {
        let head = bucket_id.split(['-', '_']).next().unwrap_or(bucket_id);
        let mut c = head.chars();
        match c.next() {
            Some(f) => format!("{}{} Models", f.to_ascii_uppercase(), c.as_str()),
            None => "Models".to_string(),
        }
    }
}

/// The window label for a raw bucket id (`*-weekly` -> "Weekly", `*-5h` -> "5-hour").
fn window_label(bucket_id: &str) -> String {
    let lower = bucket_id.to_ascii_lowercase();
    if lower.contains("weekly") {
        "Weekly".to_string()
    } else if lower.contains("5h") || lower.contains("five") || lower.contains("hour") {
        "5-hour".to_string()
    } else {
        "Limit".to_string()
    }
}

/// Sort key so Weekly renders above the 5-hour bucket within a group.
fn window_order(label: &str) -> u8 {
    match label {
        "Weekly" => 0,
        "5-hour" => 1,
        _ => 2,
    }
}

/// Sort key so the Gemini pool renders above the Claude/GPT pool.
fn group_order(display_name: &str) -> u8 {
    if display_name.starts_with("Gemini") {
        0
    } else if display_name.starts_with("Claude") {
        1
    } else {
        2
    }
}

/// Parse agy's status-line JSON payload into an `AgyUsage`. Tolerant: any missing field
/// degrades to a default rather than failing, and the `quota` map is enumerated
/// dynamically (bucket-id set is under-documented and drifts) rather than hard-keyed.
pub fn parse_statusline_payload(v: &Value) -> AgyUsage {
    let mut usage = AgyUsage {
        updated_at: now_ms(),
        ..Default::default()
    };
    usage.plan_tier = v
        .get("plan_tier")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    usage.email = v.get("email").and_then(|x| x.as_str()).map(String::from);
    usage.agent_state = v
        .get("agent_state")
        .and_then(|x| x.as_str())
        .map(String::from);

    if let Some(q) = v.get("quota").and_then(|x| x.as_object()) {
        let mut groups: Vec<AgyGroup> = Vec::new();
        for (bucket_id, status) in q {
            let label = window_label(bucket_id);
            let bucket = AgyBucket {
                bucket_id: bucket_id.clone(),
                remaining_fraction: status
                    .get("remaining_fraction")
                    .and_then(|x| x.as_f64())
                    .unwrap_or(1.0)
                    .clamp(0.0, 1.0),
                resets_at: status
                    .get("reset_time")
                    .and_then(|x| x.as_str())
                    .map(String::from),
                disabled: status
                    .get("disabled")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                label,
            };
            let gname = group_name(bucket_id);
            match groups.iter_mut().find(|g| g.display_name == gname) {
                Some(g) => g.buckets.push(bucket),
                None => groups.push(AgyGroup {
                    display_name: gname,
                    buckets: vec![bucket],
                }),
            }
        }
        for g in &mut groups {
            g.buckets
                .sort_by_key(|b| (window_order(&b.label), b.bucket_id.clone()));
        }
        groups.sort_by_key(|g| (group_order(&g.display_name), g.display_name.clone()));
        usage.groups = groups;
    }

    if let Some(c) = v.get("context_window").and_then(|x| x.as_object()) {
        usage.context = Some(AgyContext {
            used_percentage: c
                .get("used_percentage")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.0),
            context_window_size: c
                .get("context_window_size")
                .and_then(|x| x.as_i64())
                .unwrap_or(0),
            total_input_tokens: c
                .get("total_input_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0),
            total_output_tokens: c
                .get("total_output_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0),
        });
    }

    usage
}

/// Build the one-line string agy shows in its status line (returned as the HTTP body of
/// the `agyusage` hook POST, which the helper echoes to stdout). Compact so it fits a
/// terminal row: e.g. `Conduit · Gemini W 98% 5h 100% · Claude/GPT W 0% · Pro`.
pub fn format_status_line(u: &AgyUsage) -> String {
    let mut parts: Vec<String> = Vec::new();
    for g in &u.groups {
        let short = if g.display_name.starts_with("Gemini") {
            "Gemini"
        } else if g.display_name.starts_with("Claude") {
            "Claude/GPT"
        } else {
            g.display_name.split_whitespace().next().unwrap_or("")
        };
        let inner: Vec<String> = g
            .buckets
            .iter()
            .map(|b| {
                let w = if b.label == "Weekly" { "W" } else { "5h" };
                if b.disabled {
                    format!("{w} off")
                } else {
                    format!("{w} {}%", (b.remaining_fraction * 100.0).round() as i64)
                }
            })
            .collect();
        parts.push(format!("{short} {}", inner.join(" ")));
    }
    if let Some(t) = &u.plan_tier {
        parts.push(t.clone());
    }
    if parts.is_empty() {
        "Conduit".to_string()
    } else {
        format!("Conduit · {}", parts.join(" · "))
    }
}

// ---- Status-line helper installer (the onboarding "enable usage tracking" action) ----

/// agy's CLI settings file under a given home root: `<home>/.gemini/antigravity-cli/settings.json`.
fn agy_settings_path_in(home: &Path) -> PathBuf {
    home.join(".gemini")
        .join("antigravity-cli")
        .join("settings.json")
}

fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// The home directory the spawned `agy` process actually uses, given a session's
/// `account_config_dir`. Mirrors the HOME/USERPROFILE redirect in `pty.rs`: a `.claude`
/// account dir redirects HOME to its parent (so agy reads `<parent>/.gemini/...`);
/// anything else (or no account) leaves agy on Conduit's own home. THIS is why the
/// global toggle and the per-session agy can disagree under the two-account split — the
/// config must be written to the home agy will read, not Conduit's.
pub fn resolve_agy_home(account_config_dir: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = account_config_dir {
        let p = Path::new(dir);
        if p.exists() && p.file_name().and_then(|f| f.to_str()) == Some(".claude") {
            if let Some(parent) = p.parent() {
                return Some(parent.to_path_buf());
            }
        }
    }
    dirs_home()
}

/// Filename of the helper script Conduit writes beside agy's settings.json.
#[cfg(windows)]
const HELPER_NAME: &str = "conduit-usage.bat";
#[cfg(not(windows))]
const HELPER_NAME: &str = "conduit-usage.sh";

/// The helper script body. IMPORTANT (verified live 2026-07-11): agy runs a status-line
/// command by tokenizing it into program + args and exec'ing DIRECTLY — there is NO shell,
/// so an inline one-liner using `&`, `>`, `%VAR%`, `if`, or `||` fails (it exec's `if`/etc.
/// as a program → exit 3, nothing happens). So we ship a real script and invoke it via a
/// shell (`cmd`/`sh` is the program agy exec's; it then runs the script WITH shell
/// semantics: env expansion, the stdin the JSON payload rides on, and stdout back to agy as
/// the status line). The guard makes a standalone agy (no `CONDUIT_HOOK_PORT`) a no-op.
fn helper_script() -> &'static str {
    #[cfg(windows)]
    {
        "@echo off\r\n\
if not defined CONDUIT_HOOK_PORT exit /b 0\r\n\
curl -s -m 2 --data-binary @- \
\"http://127.0.0.1:%CONDUIT_HOOK_PORT%/hook?session=%CONDUIT_SESSION_ID%&event=agyusage\"\r\n"
    }
    #[cfg(not(windows))]
    {
        "#!/bin/sh\n\
[ -n \"$CONDUIT_HOOK_PORT\" ] || exit 0\n\
curl -s -m 2 --data-binary @- \
\"http://127.0.0.1:$CONDUIT_HOOK_PORT/hook?session=$CONDUIT_SESSION_ID&event=agyusage\"\n"
    }
}

/// The `statusLine.command` that runs the helper through a shell. Caveat: an unquoted path
/// is used (matches the exact form verified working through agy's tokenizer); a home path
/// containing spaces is not supported here.
fn statusline_command(helper_path: &Path) -> String {
    let p = helper_path.to_string_lossy();
    #[cfg(windows)]
    {
        format!("cmd /c {p}")
    }
    #[cfg(not(windows))]
    {
        format!("sh {p}")
    }
}

/// True if a `statusLine.command` currently installed looks like ours (so we only ever
/// remove/replace our own, never clobber a user's custom status line). Recognizes both the
/// current helper form and the legacy inline form so old installs get cleaned up.
fn is_conduit_command(cmd: &str) -> bool {
    cmd.contains("conduit-usage") || cmd.contains("event=agyusage")
}

/// Enable or disable Conduit's agy usage tracking by writing/removing the `statusLine`
/// entry in the agy settings.json under `home`. Preserves every other key. Returns
/// Ok(true) when a change was written. Fail-closed on unexpected shapes: never overwrite
/// a user's own non-Conduit `statusLine`.
pub fn configure_in_home(home: &Path, enabled: bool) -> Result<bool, String> {
    let path = agy_settings_path_in(home);
    let mut root: Value = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => {
            serde_json::from_str(&s).map_err(|e| format!("settings.json is not valid JSON: {e}"))?
        }
        // Missing/empty file: only meaningful to create when enabling.
        _ => Value::Object(Default::default()),
    };
    let obj = root
        .as_object_mut()
        .ok_or("settings.json is not a JSON object")?;

    let existing_is_ours = obj
        .get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(|c| c.as_str())
        .map(is_conduit_command)
        .unwrap_or(false);
    let has_foreign_statusline = obj.contains_key("statusLine") && !existing_is_ours;

    if enabled {
        if has_foreign_statusline {
            return Err(
                "agy already has a custom statusLine; leaving it untouched. Remove it first to let Conduit manage usage tracking.".into(),
            );
        }
        let dir = path.parent().ok_or("could not resolve agy config dir")?;
        let helper = dir.join(HELPER_NAME);
        let desired_cmd = statusline_command(&helper);
        // Short-circuit the steady state (already installed, helper up to date) so an agy
        // spawn doesn't rewrite the user's live config on every launch (the per-spawn sync
        // in lib.rs calls this) -- avoids needless I/O and shrinks the write-race window.
        let cmd_current = obj
            .get("statusLine")
            .and_then(|s| s.get("command"))
            .and_then(|c| c.as_str())
            == Some(desired_cmd.as_str());
        let helper_current =
            std::fs::read_to_string(&helper).ok().as_deref() == Some(helper_script());
        if cmd_current && helper_current {
            return Ok(false);
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        atomic_write(&helper, helper_script().as_bytes())
            .map_err(|e| format!("write {}: {e}", helper.display()))?;
        obj.insert(
            "statusLine".into(),
            serde_json::json!({ "type": "command", "command": desired_cmd }),
        );
    } else {
        // Only remove OUR command; never touch a user's custom one.
        if !existing_is_ours {
            return Ok(false);
        }
        obj.remove("statusLine");
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let serialized =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize settings: {e}"))?;
    atomic_write(&path, serialized.as_bytes()).map_err(|e| format!("write settings.json: {e}"))?;
    Ok(true)
}

/// Write `contents` to `path` atomically: fill a sibling temp file, then rename it over the
/// target (rename replaces atomically on the same volume). Protects agy's live settings.json
/// from a half-written/truncated state on a crash or two agy spawns racing the same file.
fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let name = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("conduit");
    let tmp = path.with_file_name(format!(".{name}.conduit-tmp"));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

/// Whether Conduit's usage tracking is currently installed in the agy settings.json
/// under `home`.
pub fn is_installed_in_home(home: &Path) -> bool {
    std::fs::read_to_string(agy_settings_path_in(home))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.get("statusLine")
                .and_then(|s| s.get("command"))
                .and_then(|c| c.as_str())
                .map(is_conduit_command)
        })
        .unwrap_or(false)
}

/// The home used by the GLOBAL toggle / panel: the default account's agy home (so it
/// matches the home agy sessions run under the two-account split), falling back to
/// Conduit's own home when no default account is set.
fn toggle_home(store: &crate::store::Store) -> Option<PathBuf> {
    resolve_agy_home(store.default_account_config_dir().as_deref())
}

/// Whether the user has enabled agy usage tracking (source of truth: our statusLine
/// installed in the toggle home). Read at spawn time to sync each session's own home.
pub fn tracking_enabled(store: &crate::store::Store) -> bool {
    toggle_home(store)
        .map(|h| is_installed_in_home(&h))
        .unwrap_or(false)
}

// ---- Tauri commands ----

#[tauri::command]
pub fn fetch_agy_usage(state: tauri::State<'_, std::sync::Arc<AgyUsageState>>) -> Option<AgyUsage> {
    state.get()
}

#[tauri::command]
pub fn agy_usage_tracking_enabled(
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> bool {
    tracking_enabled(&store)
}

#[tauri::command]
pub fn set_agy_usage_tracking(
    enabled: bool,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<bool, String> {
    let home = toggle_home(&store).ok_or("could not resolve agy home directory")?;
    configure_in_home(&home, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A representative agy status-line payload (fields from the official statusline docs
    /// + the bucket-id conventions confirmed live from RetrieveUserQuotaSummary).
    fn sample() -> Value {
        json!({
            "plan_tier": "Pro",
            "email": "dev@example.com",
            "agent_state": "idle",
            "context_window": {
                "total_input_tokens": 88244,
                "total_output_tokens": 61074,
                "context_window_size": 1048576,
                "used_percentage": 14.24
            },
            "quota": {
                "gemini-weekly": { "remaining_fraction": 0.9767319, "reset_time": "2026-07-15T17:38:21Z" },
                "gemini-5h": { "remaining_fraction": 1.0, "reset_time": "2026-07-11T15:35:32Z" },
                "3p-weekly": { "remaining_fraction": 0.0, "reset_time": "2026-07-16T09:41:12Z" },
                "3p-5h": { "remaining_fraction": 1.0, "disabled": true, "reset_time": "2026-07-11T15:35:32Z" }
            }
        })
    }

    #[test]
    fn parses_tier_email_and_context() {
        let u = parse_statusline_payload(&sample());
        assert_eq!(u.plan_tier.as_deref(), Some("Pro"));
        assert_eq!(u.email.as_deref(), Some("dev@example.com"));
        let ctx = u.context.expect("context present");
        assert_eq!(ctx.context_window_size, 1048576);
        assert!((ctx.used_percentage - 14.24).abs() < 1e-6);
    }

    #[test]
    fn groups_and_orders_buckets() {
        let u = parse_statusline_payload(&sample());
        assert_eq!(u.groups.len(), 2, "gemini + 3p groups");
        assert_eq!(u.groups[0].display_name, "Gemini Models");
        assert_eq!(u.groups[1].display_name, "Claude & GPT Models");
        // Weekly before 5-hour within a group.
        assert_eq!(u.groups[0].buckets[0].label, "Weekly");
        assert_eq!(u.groups[0].buckets[1].label, "5-hour");
        assert!((u.groups[0].buckets[0].remaining_fraction - 0.9767319).abs() < 1e-6);
    }

    #[test]
    fn carries_disabled_and_exhausted_states() {
        let u = parse_statusline_payload(&sample());
        let claude = &u.groups[1];
        assert_eq!(claude.buckets[0].remaining_fraction, 0.0); // weekly hit
        assert!(
            claude.buckets[1].disabled,
            "5-hour disabled when weekly is out"
        );
    }

    #[test]
    fn empty_payload_yields_empty_groups_not_panic() {
        let u = parse_statusline_payload(&json!({}));
        assert!(u.groups.is_empty());
        assert!(u.plan_tier.is_none());
        assert!(u.context.is_none());
    }

    #[test]
    fn has_data_gates_out_quota_less_ticks() {
        // A quota-less tick (empty, or context-only startup ping) must NOT be persisted,
        // else it clobbers a good snapshot and flips the panel back to "waiting".
        assert!(!parse_statusline_payload(&json!({})).has_data());
        assert!(!parse_statusline_payload(&json!({
            "context_window": { "context_window_size": 1048576, "used_percentage": 0 }
        }))
        .has_data());
        assert!(parse_statusline_payload(&sample()).has_data());
    }

    #[test]
    fn configure_in_home_short_circuits_when_already_current() {
        let home = tmp("shortcircuit");
        assert!(
            configure_in_home(&home, true).unwrap(),
            "first install writes"
        );
        assert!(
            !configure_in_home(&home, true).unwrap(),
            "re-running with the same state is a no-op (no rewrite)"
        );
        // No stray temp file is left behind by the atomic write.
        let dir = agy_settings_path_in(&home).parent().unwrap().to_path_buf();
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("conduit-tmp"))
            .collect();
        assert!(
            strays.is_empty(),
            "atomic write leaves no .conduit-tmp file"
        );
    }

    #[test]
    fn status_line_is_compact_and_labelled() {
        let s = format_status_line(&parse_statusline_payload(&sample()));
        assert!(s.starts_with("Conduit · "));
        assert!(s.contains("Gemini W 98%"));
        assert!(s.contains("5h 100%"));
        assert!(s.contains("Claude/GPT W 0%"));
        assert!(s.contains("Pro"));
    }

    #[test]
    fn unknown_bucket_prefix_still_grouped() {
        let u = parse_statusline_payload(&json!({
            "quota": { "gpt-weekly": { "remaining_fraction": 0.5 } }
        }));
        assert_eq!(u.groups.len(), 1);
        assert_eq!(u.groups[0].display_name, "Gpt Models");
        assert_eq!(u.groups[0].buckets[0].label, "Weekly");
    }

    #[test]
    fn conduit_command_is_recognized_for_cleanup() {
        let cmd = statusline_command(Path::new("/x/.gemini/antigravity-cli/conduit-usage.sh"));
        assert!(is_conduit_command(&cmd));
        // Legacy inline form still recognized so old installs get cleaned up.
        assert!(is_conduit_command("curl … event=agyusage"));
        assert!(!is_conduit_command("my-custom-statusline.sh"));
    }

    #[test]
    fn configure_in_home_writes_helper_script_and_points_at_it() {
        let home = tmp("helper");
        configure_in_home(&home, true).unwrap();
        let helper = agy_settings_path_in(&home)
            .parent()
            .unwrap()
            .join(HELPER_NAME);
        assert!(
            helper.exists(),
            "helper script written next to settings.json"
        );
        let body = std::fs::read_to_string(&helper).unwrap();
        assert!(
            body.contains("event=agyusage"),
            "helper posts to the hook server"
        );
        // The status-line command invokes the helper through a shell, not inline.
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(agy_settings_path_in(&home)).unwrap())
                .unwrap();
        let cmd = v["statusLine"]["command"].as_str().unwrap();
        assert!(cmd.contains(HELPER_NAME));
        assert!(cmd.starts_with(if cfg!(windows) { "cmd /c" } else { "sh " }));
    }

    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmp(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("conduit_agy_{tag}_{}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn resolve_agy_home_redirects_a_dot_claude_account_to_its_parent() {
        // A `.claude` account dir → agy home is its PARENT (matches pty.rs HOME redirect).
        let root = tmp("acct");
        let claude = root.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let home = resolve_agy_home(Some(claude.to_str().unwrap())).unwrap();
        assert_eq!(home, root);
    }

    #[test]
    fn resolve_agy_home_ignores_non_dot_claude_and_missing_dirs() {
        // A non-`.claude` dir (custom CLAUDE_CONFIG_DIR) does NOT redirect HOME → falls back.
        let root = tmp("custom");
        let cfg = root.join("my-config");
        std::fs::create_dir_all(&cfg).unwrap();
        let home = resolve_agy_home(Some(cfg.to_str().unwrap()));
        assert_ne!(home.as_deref(), Some(root.as_path())); // not the parent
                                                           // A nonexistent `.claude` path must not redirect either.
        let ghost = resolve_agy_home(Some(r"/nope/conduit-missing/.claude"));
        assert_eq!(ghost, dirs_home());
    }

    #[test]
    fn configure_in_home_installs_then_removes_only_ours() {
        let home = tmp("install");
        assert!(!is_installed_in_home(&home));
        assert!(configure_in_home(&home, true).unwrap());
        assert!(is_installed_in_home(&home));
        // Idempotent enable, then disable removes it.
        configure_in_home(&home, false).unwrap();
        assert!(!is_installed_in_home(&home));
    }

    #[test]
    fn configure_in_home_refuses_to_clobber_a_foreign_statusline() {
        let home = tmp("foreign");
        let path = agy_settings_path_in(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"statusLine":{"type":"command","command":"my-own.sh"}}"#,
        )
        .unwrap();
        assert!(
            configure_in_home(&home, true).is_err(),
            "must not overwrite"
        );
        // The user's command survives untouched.
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("my-own.sh"));
    }

    #[test]
    fn configure_in_home_preserves_other_settings_keys() {
        let home = tmp("preserve");
        let path = agy_settings_path_in(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"colorScheme":"dark","enableTelemetry":false}"#).unwrap();
        configure_in_home(&home, true).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v.get("colorScheme").and_then(|x| x.as_str()), Some("dark"));
        assert!(v.get("statusLine").is_some());
    }
}
