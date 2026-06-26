# Claude Status + Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a passive sidebar-footer pill + popover to Conduit that shows Anthropic service status (status.claude.com) and Claude usage (local consumption always; subscription plan limits best-effort, opt-in).

**Architecture:** Two new Rust modules (`claude_status.rs`, `claude_usage.rs`) expose Tauri commands that shell out to `curl` (status + best-effort usage endpoint) and read `~/.claude/stats-cache.json` (local usage). A frontend hook polls them every 60s while the window is visible; a Zustand slice holds the result; a footer pill + click popover render it. Zero new Cargo deps. The plan-limit path is a progressive enhancement gated behind a "Connect" button (macOS Keychain), with automatic fallback to local-only.

**Tech Stack:** Rust (Tauri commands, `serde`/`serde_json`, `std::process::Command` → `curl`/`security`), React 19 + Zustand + `@tauri-apps/api`, CSS custom properties (existing theme tokens).

**Spec:** `docs/superpowers/specs/2026-06-26-claude-status-usage-design.md`

**Branch:** `feat/claude-status-usage` (already created). Do NOT push or merge to `main` without explicit user approval.

---

## File Structure

**New (Rust):**
- `src-tauri/src/claude_status.rs` — status fetch + parse + types. One responsibility: Anthropic service status.
- `src-tauri/src/claude_usage.rs` — usage fetch + parse + types + `ClaudeAuth` token cache. One responsibility: Claude usage (local + plan).

**New (frontend):**
- `src/hooks/useClaudeAmbient.ts` — polling hook (60s, visibility-gated, plan-token rehydrate).
- `src/components/ClaudeStatusPill.tsx` — footer pill + popover host.
- `src/components/ClaudePopover.tsx` — popover body (components, incidents, usage, connect button).

**Modified:**
- `src-tauri/src/lib.rs` — `mod` declarations, `.manage(ClaudeAuth)`, register 3 commands.
- `src/store.ts` — Zustand slice (types, state, actions).
- `src/components/Sidebar.tsx:90` — mount `<ClaudeStatusPill />` in the add-bar.
- `src/theme.css` — append `.claude-*` styles (dot, pill, popover, meters).

**Verification reality:** Rust has unit tests (`#[cfg(test)]`); the frontend has **no test runner** (package.json has no `test` script). So: TDD the Rust parsers with `cargo test`; verify the frontend with `pnpm build` (tsc typecheck + vite build) plus the manual checklist in Task 9. To run the app safely beside the installed Conduit.app, always use the data-dir override: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`.

---

### Task 1: Spike — derive the usage endpoint + payload shape from the claude bundle (no credentials)

**Goal:** Determine, without reading any token, (a) the usage endpoint URL Claude Code's `/usage` calls and (b) the JSON field names it reads, so Task 4's parser is accurate. The Keychain service name is the known macOS value `Claude Code-credentials`; the live token read stays in `connect_claude_plan_usage` (user-triggered).

**Files:** none changed in this task — findings are recorded in this plan and used by Task 4.

- [ ] **Step 1: Locate the claude CLI bundle**

```bash
CLAUDE_BIN="$(command -v claude)"
# Resolve symlink chains to the real JS entry, then find the package dir.
REAL="$(readlink -f "$CLAUDE_BIN" 2>/dev/null || perl -MCwd -le 'print Cwd::abs_path(shift)' "$CLAUDE_BIN")"
echo "claude → $REAL"
PKG_DIR="$(dirname "$REAL")"
echo "pkg dir: $PKG_DIR"
ls -la "$PKG_DIR" | head
```

Expected: a path under a node install (e.g. `~/.nvm/.../node_modules/@anthropic-ai/claude-code/cli.js` or similar). Note the directory holding the large bundled JS.

- [ ] **Step 2: Grep the bundle for the usage endpoint + rate-limit field names**

```bash
# Search the package's JS for the usage endpoint and the fields the /usage UI reads.
grep -rEoh "https://api\.anthropic\.com[a-zA-Z0-9_/.-]*usage[a-zA-Z0-9_/.-]*" "$PKG_DIR" | sort -u
grep -rEoh "/api/[a-zA-Z0-9_/.-]*usage[a-zA-Z0-9_/.-]*"                     "$PKG_DIR" | sort -u
grep -rEoih "(five_hour|seven_day|7_day|5_hour|weekly|rate_limit|ratelimit|utilization|resets_at|reset_at|reset|window|opus)[a-z_]*" "$PKG_DIR" \
  | tr 'A-Z' 'a-z' | sort | uniq -c | sort -rn | head -40
```

Expected: an endpoint path (e.g. `/api/oauth/usage` or similar) and a cluster of field names (e.g. window labels + a reset timestamp + a utilization/percentage field).

- [ ] **Step 3: Record findings in this plan**

**RESOLVED (2026-06-26, claude-code 2.1.186 native binary):**

```
USAGE_ENDPOINT  = https://api.anthropic.com/api/oauth/usage   (GET, "fetchUtilization", refreshOAuth)
WINDOW FIELDS   = top-level keys: five_hour, seven_day, seven_day_opus
                  (also present: seven_day_sonnet, seven_day_oauth_apps, overage — ignored)
PCT FIELD       = <window>.utilization  (NUMBER; observed as a PERCENTAGE, e.g. 2.0 = 2%)
RESET FIELD     = <window>.resets_at    (RFC3339 STRING, e.g. "2026-06-26T14:40:00.997918+00:00")
AUTH HEADER     = Authorization: Bearer <token>
```

**Correction (verified live, 2026-06-26):** the binary's `utilization*100` / `Number(resets_at)`
I first read belonged to the response-*header* rate-limit path, NOT the `/api/oauth/usage` body. The
real body returns `resets_at` as an **RFC3339 string** and `utilization` as a **percentage**. The
first implementation guessed numeric epoch + 0..1 fraction → `parse_plan` rejected the real payload →
`planSource: "unavailable"`. Final parser is defensive: tolerates string-or-numeric `resets_at` and
fraction-or-percent `utilization`. Keychain read works silently because the item's ACL trusts
`/usr/bin/security` (claude-code writes it via the same CLI). The endpoint is live-capable; on any
future shape drift `parse_plan` returns None → degrades to status + local usage.

- [ ] **Step 4: Commit the recorded findings**

```bash
git add docs/superpowers/plans/2026-06-26-claude-status-usage.md
git commit -m "spike(usage): record claude usage endpoint + payload field names"
```

---

### Task 2: Rust `claude_status.rs` — status fetch, parse, command

**Files:**
- Create: `src-tauri/src/claude_status.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod claude_status;` near line 7-14; add `claude_status::fetch_claude_status` to `generate_handler!` near line 346)

- [ ] **Step 1: Write the module with a failing test**

Create `src-tauri/src/claude_status.rs`:

```rust
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
```

- [ ] **Step 2: Register the module + command in `lib.rs`**

Add `mod claude_status;` to the module block (lib.rs lines 7-14, keep alphabetical-ish ordering):

```rust
mod bridge;
mod claude_status;
mod fsops;
```

Add the command to `generate_handler!` (lib.rs ~line 369, before the closing `]`):

```rust
            open_in_vscode,
            claude_status::fetch_claude_status,
        ])
```

- [ ] **Step 3: Run the tests — expect PASS**

Run: `cd src-tauri && cargo test claude_status`
Expected: 3 tests pass (`parses_indicator_components_and_incidents`, `bad_json_yields_unknown_not_panic`, `empty_indicator_defaults_to_none`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/claude_status.rs src-tauri/src/lib.rs
git commit -m "feat(status): claude_status module + fetch_claude_status command"
```

---

### Task 3: Rust `claude_usage.rs` — local consumption half

**Files:**
- Create: `src-tauri/src/claude_usage.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod claude_usage;`; register `claude_usage::fetch_claude_usage`)

- [ ] **Step 1: Write the module (local half) with failing tests**

Create `src-tauri/src/claude_usage.rs`:

```rust
//! Claude usage: local consumption (always, from ~/.claude/stats-cache.json) plus
//! best-effort subscription plan limits (Task 4). Fail-open throughout.

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

// ---- Plan-limit token cache (populated by connect; see Task 4) ----

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
        let (plan, plan_source) = fetch_plan(token); // Task 4 fills this in
        ClaudeUsage { local, plan, plan_source }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(usage)
}

/// Placeholder until Task 4: with no token, plan is "disconnected".
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
```

- [ ] **Step 2: Register in `lib.rs`**

Add `mod claude_usage;` to the module block. Add `.manage(...)` in `run()`'s builder chain (after the existing `.manage(...)` calls near lib.rs:336-338):

```rust
        .manage(Arc::new(PtyManager::new()))
        .manage(Store::new())
        .manage(Arc::new(HookState::default()))
        .manage(Arc::new(claude_usage::ClaudeAuth::default()))
```

Register the command in `generate_handler!`:

```rust
            claude_status::fetch_claude_status,
            claude_usage::fetch_claude_usage,
        ])
```

- [ ] **Step 3: Run tests — expect PASS**

Run: `cd src-tauri && cargo test claude_usage`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/claude_usage.rs src-tauri/src/lib.rs
git commit -m "feat(usage): claude_usage module + local-consumption command"
```

---

### Task 4: Rust plan-limit half — connect command + parser

**Files:**
- Modify: `src-tauri/src/claude_usage.rs` (replace `fetch_plan`, add `parse_plan`, add `connect_claude_plan_usage`)
- Modify: `src-tauri/src/lib.rs` (register `claude_usage::connect_claude_plan_usage`)

Use the `USAGE_ENDPOINT` and field names recorded in Task 1. If Task 1 found `UNKNOWN`, keep `fetch_plan` returning `(None, "unavailable")` and still ship `connect_claude_plan_usage` (it will cache a token but `fetch_plan` returns unavailable — graceful).

- [ ] **Step 1: Add the plan parser with a fixture test**

In `claude_usage.rs`, add a `parse_plan` that maps the Task-1 payload shape into `Vec<PlanWindow>`. Example shape (ADJUST field names to Task 1 findings; this models `utilization` 0..1 + `resets_at`):

```rust
const USAGE_ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";

#[derive(Deserialize)]
struct PlanWindowRaw {
    #[serde(default)]
    utilization: f64,        // 0..1
    #[serde(default)]
    resets_at: Option<f64>,  // epoch number
}

#[derive(Deserialize)]
struct PlanRaw {
    #[serde(default)]
    five_hour: Option<PlanWindowRaw>,
    #[serde(default)]
    seven_day: Option<PlanWindowRaw>,
    #[serde(default)]
    seven_day_opus: Option<PlanWindowRaw>,
}

/// Parse the usage endpoint body into ordered windows. None on shape mismatch.
pub fn parse_plan(body: &str) -> Option<Vec<PlanWindow>> {
    let raw: PlanRaw = serde_json::from_str(body).ok()?;
    let mut out = Vec::new();
    let mut push = |label: &str, w: Option<PlanWindowRaw>| {
        if let Some(w) = w {
            out.push(PlanWindow {
                label: label.into(),
                pct_used: w.utilization.clamp(0.0, 1.0),
                resets_at: w.resets_at,
            });
        }
    };
    push("5-hour window", raw.five_hour);
    push("Weekly (all)", raw.seven_day);
    push("Weekly (Opus)", raw.seven_day_opus);
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}
```

Add a test (adjust field names to match Task 1):

```rust
    #[test]
    fn parses_plan_windows() {
        let body = r#"{
          "five_hour": {"utilization": 0.68, "resets_at": "2026-06-26T15:41:00Z"},
          "seven_day": {"utilization": 0.41, "resets_at": "2026-06-30T00:00:00Z"},
          "seven_day_opus": {"utilization": 0.79, "resets_at": "2026-06-30T00:00:00Z"}
        }"#;
        let w = super::parse_plan(body).expect("windows");
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].label, "5-hour window");
        assert!((w[0].pct_used - 0.68).abs() < 1e-9);
        assert_eq!(w[2].label, "Weekly (Opus)");
    }
```

- [ ] **Step 2: Replace `fetch_plan` to call the endpoint with the cached token**

```rust
fn fetch_plan(token: Option<String>) -> (Option<Vec<PlanWindow>>, String) {
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => return (None, "disconnected".into()),
    };
    if USAGE_ENDPOINT.is_empty() {
        return (None, "unavailable".into());
    }
    let out = Command::new("curl")
        .args([
            "-s",
            "--max-time",
            "8",
            "-H",
            &format!("Authorization: Bearer {token}"),
            USAGE_ENDPOINT,
        ])
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
```

- [ ] **Step 3: Add the connect command (reads Keychain, validates, caches token)**

```rust
fn read_keychain_token() -> Option<String> {
    // macOS: Claude Code stores OAuth creds in the login Keychain under this service.
    // -w prints only the secret (a JSON blob). This triggers the macOS allow prompt;
    // it runs only on explicit user action (the "Connect plan usage" button).
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    // The blob is JSON like {"claudeAiOauth":{"accessToken":"...", ...}}.
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    v.get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        // Fallback: some versions may store the bare token string.
        .or_else(|| {
            let t = raw.trim();
            if t.starts_with("sk-") || t.starts_with("eyJ") {
                Some(t.to_string())
            } else {
                None
            }
        })
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
```

- [ ] **Step 4: Register the connect command in `lib.rs`**

```rust
            claude_usage::fetch_claude_usage,
            claude_usage::connect_claude_plan_usage,
        ])
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `cd src-tauri && cargo test claude_usage`
Expected: 3 tests pass (the two from Task 3 + `parses_plan_windows`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/claude_usage.rs src-tauri/src/lib.rs
git commit -m "feat(usage): best-effort plan limits via Keychain token + usage endpoint"
```

---

### Task 5: Frontend Zustand slice — types, state, actions

**Files:**
- Modify: `src/store.ts` (add types near line 79; add state fields + actions to `AppState` and the `create` return)

- [ ] **Step 1: Add types (after `BottomTab`, ~line 80)**

```ts
// ---- Claude ambient (status + usage) — mirror Rust serde camelCase ----
export interface StatusComponent { name: string; status: string; }
export interface StatusIncident { name: string; status: string; impact: string; shortlink: string; }
export interface ClaudeStatus {
  indicator: "none" | "minor" | "major" | "critical" | "unknown";
  description: string;
  components: StatusComponent[];
  incidents: StatusIncident[];
  ok: boolean;
}
export interface ModelTokens { model: string; tokens: number; }
export interface LocalUsage {
  date: string;
  tokensByModel: ModelTokens[];
  totalTokens: number;
  sessions: number;
  messages: number;
}
export interface PlanWindow { label: string; pctUsed: number; resetsAt: string | null; }
export interface ClaudeUsage {
  local: LocalUsage;
  plan: PlanWindow[] | null;
  planSource: "live" | "unavailable" | "disconnected";
}

const PLAN_CONNECTED_KEY = "conduit.planConnected";
export function readPlanConnected(): boolean {
  try { return localStorage.getItem(PLAN_CONNECTED_KEY) === "1"; } catch { return false; }
}
function writePlanConnected(v: boolean): void {
  try { localStorage.setItem(PLAN_CONNECTED_KEY, v ? "1" : "0"); } catch { /* quota — non-fatal */ }
}
```

- [ ] **Step 2: Add state fields + action signatures to `AppState` (near line 211)**

```ts
  themePref: ThemePref;
  activeThemeId: ThemeId;

  claudeStatus: ClaudeStatus | null;
  claudeUsage: ClaudeUsage | null;
  planConnected: boolean;
```

And in the actions section of the interface (near line 248):

```ts
  setThemePref: (pref: ThemePref) => void;
  applySystemDark: (dark: boolean) => void;

  refreshClaudeStatus: () => Promise<void>;
  refreshClaudeUsage: () => Promise<void>;
  connectPlanUsage: () => Promise<boolean>;
```

- [ ] **Step 3: Add initial state + action implementations**

In the `create` return object, add initial state near the other defaults (`live: {},` ~line 279):

```ts
    claudeStatus: null,
    claudeUsage: null,
    planConnected: readPlanConnected(),
```

And add the actions just before `setThemePref` (~line 473):

```ts
    refreshClaudeStatus: async () => {
      try {
        const s = await invoke<ClaudeStatus>("fetch_claude_status");
        set({ claudeStatus: s });
      } catch { /* fail-open: keep last-known */ }
    },

    refreshClaudeUsage: async () => {
      try {
        const u = await invoke<ClaudeUsage>("fetch_claude_usage");
        set({ claudeUsage: u });
      } catch { /* fail-open: keep last-known */ }
    },

    connectPlanUsage: async () => {
      try {
        const ok = await invoke<boolean>("connect_claude_plan_usage");
        writePlanConnected(ok);
        set({ planConnected: ok });
        if (ok) await get().refreshClaudeUsage();
        return ok;
      } catch {
        writePlanConnected(false);
        set({ planConnected: false });
        return false;
      }
    },
```

- [ ] **Step 4: Typecheck — expect PASS**

Run: `pnpm build`
Expected: `tsc` passes, vite build completes (no type errors referencing the new fields).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): claude status + usage zustand slice and actions"
```

---

### Task 6: Frontend polling hook

**Files:**
- Create: `src/hooks/useClaudeAmbient.ts`

- [ ] **Step 1: Write the hook**

Create `src/hooks/useClaudeAmbient.ts`:

```ts
import { useEffect } from "react";
import { useStore } from "../store";

const POLL_MS = 60_000;

/**
 * Polls Claude status + usage every 60s, but only while the window is visible
 * (pauses on hidden, refreshes immediately on resume). On mount, if the user had
 * connected plan usage in a previous session, silently rehydrate the Rust token
 * cache via connectPlanUsage() so plan limits reappear without a button click.
 */
export function useClaudeAmbient(): void {
  const refreshStatus = useStore((s) => s.refreshClaudeStatus);
  const refreshUsage = useStore((s) => s.refreshClaudeUsage);
  const connectPlan = useStore((s) => s.connectPlanUsage);
  const planConnected = useStore((s) => s.planConnected);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      void refreshStatus();
      void refreshUsage();
    };

    const start = () => {
      if (timer != null) return;
      tick();
      timer = setInterval(tick, POLL_MS);
    };
    const stop = () => {
      if (timer != null) { clearInterval(timer); timer = null; }
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    // Rehydrate plan-usage token cache once on mount if previously connected.
    if (planConnected) void connectPlan();

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
```

- [ ] **Step 2: Typecheck — expect PASS**

Run: `pnpm build`
Expected: passes (hook compiles; not yet referenced — that's Task 7).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useClaudeAmbient.ts
git commit -m "feat(ambient): 60s visibility-gated polling hook for status + usage"
```

---

### Task 7: Footer pill component + CSS + mount

**Files:**
- Create: `src/components/ClaudeStatusPill.tsx`
- Modify: `src/components/Sidebar.tsx:90` (mount the pill in the add-bar)
- Modify: `src/theme.css` (append `.claude-*` dot + pill styles)

- [ ] **Step 1: Write the pill component**

Create `src/components/ClaudeStatusPill.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useClaudeAmbient } from "../hooks/useClaudeAmbient";
import { ClaudePopover } from "./ClaudePopover";

/** Maps a Statuspage indicator to a dot class + a short human label. */
export function indicatorMeta(indicator: string | undefined): { cls: string; label: string } {
  switch (indicator) {
    case "none": return { cls: "ok", label: "All systems operational" };
    case "minor": return { cls: "minor", label: "Minor issues" };
    case "major": return { cls: "major", label: "Major outage" };
    case "critical": return { cls: "critical", label: "Critical outage" };
    default: return { cls: "unknown", label: "Status unknown" };
  }
}

/** Compact "1.2M" / "820K" token formatter. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

export function ClaudeStatusPill() {
  useClaudeAmbient(); // pill is always mounted → drives polling

  const status = useStore((s) => s.claudeStatus);
  const usage = useStore((s) => s.claudeUsage);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const meta = indicatorMeta(status?.indicator);

  // Compact usage figure: plan 5-hour % if live, else today's local token total.
  let usageLabel = "";
  if (usage?.plan && usage.plan.length > 0) {
    usageLabel = Math.round(usage.plan[0].pctUsed * 100) + "%";
  } else if (usage?.local && usage.local.totalTokens > 0) {
    usageLabel = fmtTokens(usage.local.totalTokens);
  }

  return (
    <div className="claude-pill-wrap" ref={wrapRef}>
      {open && (
        <div className="claude-popover" onClick={(e) => e.stopPropagation()}>
          <ClaudePopover />
        </div>
      )}
      <button
        className="claude-pill"
        title={meta.label}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        <span className={`claude-dot ${meta.cls}`} />
        {usageLabel && <span className="claude-pill-usage">{usageLabel}</span>}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Mount in the sidebar add-bar (`Sidebar.tsx:90`)**

Add the import near the other component imports (Sidebar.tsx ~line 25):

```tsx
import { ThemeSwitcher } from "./ThemeSwitcher";
import { ClaudeStatusPill } from "./ClaudeStatusPill";
```

Add the pill in the add-bar, before `<ThemeSwitcher />` (line 90):

```tsx
        <ClaudeStatusPill />
        <ThemeSwitcher />
```

- [ ] **Step 3: Append CSS to `src/theme.css`**

```css
/* ---- Claude ambient pill + popover ---- */
.claude-pill-wrap { position: relative; display: inline-flex; }
.claude-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 8px; border-radius: 11px; cursor: pointer;
  background: transparent; border: 1px solid transparent; color: inherit;
  font-size: 11px; line-height: 1;
}
.claude-pill:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.claude-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.claude-dot.ok { background: var(--green); }
.claude-dot.minor { background: var(--amber); }
.claude-dot.major { background: var(--red); }
.claude-dot.critical { background: var(--red); box-shadow: 0 0 0 2px color-mix(in srgb, var(--red) 35%, transparent); }
.claude-dot.unknown { background: #7a7a7a; }
.claude-pill-usage { opacity: 0.8; font-variant-numeric: tabular-nums; }

.claude-popover {
  position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 50;
  width: 280px; padding: 10px; border-radius: 8px;
  background: var(--panel-bg); border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35); font-size: 12px;
}
.claude-pop-title { font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.claude-pop-section { margin-top: 10px; }
.claude-pop-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.claude-pop-row .name { flex: 1; opacity: 0.9; }
.claude-pop-muted { opacity: 0.6; }
.claude-incident { padding: 6px 0; border-top: 1px solid color-mix(in srgb, var(--accent) 12%, transparent); }
.claude-incident a { color: var(--accent); text-decoration: none; }
.claude-meter { margin: 6px 0; }
.claude-meter-head { display: flex; justify-content: space-between; opacity: 0.9; }
.claude-meter-bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--accent) 14%, transparent); margin-top: 3px; overflow: hidden; }
.claude-meter-fill { height: 100%; background: var(--accent); }
.claude-meter-fill.warn { background: var(--amber); }
.claude-meter-fill.hot { background: var(--red); }
.claude-connect-btn {
  margin-top: 8px; width: 100%; padding: 6px; border-radius: 6px; cursor: pointer;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); color: inherit;
}
.claude-connect-btn:hover { background: color-mix(in srgb, var(--accent) 24%, transparent); }
```

- [ ] **Step 4: Typecheck — expect PASS**

Run: `pnpm build`
Expected: passes (note: `ClaudePopover` is referenced; create a minimal stub now if needed, then complete it in Task 8 — OR do Task 8 before this build). To keep builds green, implement Task 8 immediately after Step 1 here, then run this build once both exist.

- [ ] **Step 5: Commit**

```bash
git add src/components/ClaudeStatusPill.tsx src/components/Sidebar.tsx src/theme.css
git commit -m "feat(ui): claude status pill in sidebar footer + styles"
```

---

### Task 8: Popover body component

**Files:**
- Create: `src/components/ClaudePopover.tsx`

- [ ] **Step 1: Write the popover**

Create `src/components/ClaudePopover.tsx`:

```tsx
import { useState } from "react";
import { useStore } from "../store";
import { indicatorMeta, fmtTokens } from "./ClaudeStatusPill";
import type { PlanWindow } from "../store";

const PRIORITY = ["Claude Code", "Claude API", "claude.ai"];

function componentDotClass(status: string): string {
  if (status === "operational") return "ok";
  if (status === "degraded_performance" || status === "under_maintenance") return "minor";
  if (status === "partial_outage") return "major";
  if (status === "major_outage") return "critical";
  return "unknown";
}

function Meter({ w }: { w: PlanWindow }) {
  const pct = Math.round(w.pctUsed * 100);
  const cls = pct >= 90 ? "hot" : pct >= 70 ? "warn" : "";
  return (
    <div className="claude-meter">
      <div className="claude-meter-head">
        <span>{w.label}</span>
        <span>{pct}%{w.resetsAt ? ` · resets ${shortReset(w.resetsAt)}` : ""}</span>
      </div>
      <div className="claude-meter-bar">
        <div className={`claude-meter-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** "3:41pm" if today, else "Mon" — best-effort, never throws. */
function shortReset(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { weekday: "short" });
}

export function ClaudePopover() {
  const status = useStore((s) => s.claudeStatus);
  const usage = useStore((s) => s.claudeUsage);
  const connectPlan = useStore((s) => s.connectPlanUsage);
  const [connecting, setConnecting] = useState(false);

  const meta = indicatorMeta(status?.indicator);

  const components = [...(status?.components ?? [])].sort((a, b) => {
    const ia = PRIORITY.indexOf(a.name);
    const ib = PRIORITY.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const onConnect = async () => {
    setConnecting(true);
    try { await connectPlan(); } finally { setConnecting(false); }
  };

  return (
    <div>
      {/* ---- Status ---- */}
      <div className="claude-pop-title">
        <span className={`claude-dot ${meta.cls}`} />
        <span>{status?.description || meta.label}</span>
      </div>

      {components.length > 0 && (
        <div className="claude-pop-section">
          {components.map((c) => (
            <div className="claude-pop-row" key={c.name}>
              <span className={`claude-dot ${componentDotClass(c.status)}`} />
              <span className="name">{c.name}</span>
              <span className="claude-pop-muted">{c.status.replace(/_/g, " ")}</span>
            </div>
          ))}
        </div>
      )}

      {status?.incidents && status.incidents.length > 0 && (
        <div className="claude-pop-section">
          {status.incidents.map((i) => (
            <div className="claude-incident" key={i.name}>
              <div>{i.name}</div>
              <div className="claude-pop-muted">
                {i.status}
                {i.shortlink ? <> · <a href={i.shortlink} target="_blank" rel="noreferrer">details</a></> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- Usage ---- */}
      <div className="claude-pop-section">
        <div className="claude-pop-title">Usage</div>

        {usage?.plan && usage.plan.length > 0 ? (
          usage.plan.map((w) => <Meter key={w.label} w={w} />)
        ) : (
          <>
            {usage?.local && usage.local.totalTokens > 0 ? (
              <>
                <div className="claude-pop-row">
                  <span className="name">Today</span>
                  <span>{fmtTokens(usage.local.totalTokens)} tokens</span>
                </div>
                {usage.local.tokensByModel.slice(0, 4).map((m) => (
                  <div className="claude-pop-row" key={m.model}>
                    <span className="name claude-pop-muted">{m.model}</span>
                    <span className="claude-pop-muted">{fmtTokens(m.tokens)}</span>
                  </div>
                ))}
                <div className="claude-pop-row claude-pop-muted">
                  <span className="name">Sessions {usage.local.sessions}</span>
                  <span>Messages {usage.local.messages}</span>
                </div>
              </>
            ) : (
              <div className="claude-pop-muted">No local usage data yet.</div>
            )}
            <button className="claude-connect-btn" onClick={onConnect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect plan usage"}
            </button>
            {usage?.planSource === "unavailable" && (
              <div className="claude-pop-muted" style={{ marginTop: 6 }}>
                Plan limits unavailable — showing local usage.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck — expect PASS**

Run: `pnpm build`
Expected: both `ClaudeStatusPill` and `ClaudePopover` compile; vite build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/ClaudePopover.tsx
git commit -m "feat(ui): claude popover — components, incidents, usage, connect"
```

---

### Task 9: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Full Rust test run**

Run: `cd src-tauri && cargo test`
Expected: all tests pass (existing store tests + the new `claude_status` and `claude_usage` tests). No warnings-as-errors.

- [ ] **Step 2: Full frontend build**

Run: `pnpm build`
Expected: `tsc` clean, vite build succeeds.

- [ ] **Step 3: Manual checklist (requires the user — do NOT auto-launch the GUI overnight)**

Run beside the installed app: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`

- [ ] Footer pill shows a colored dot + (token total or %) within ~1s of launch.
- [ ] Dot color matches live status.claude.com (green when operational).
- [ ] Click → popover lists components (Claude Code / Claude API / claude.ai first) and any active incidents.
- [ ] Usage section shows today's local tokens-by-model + session/message counts.
- [ ] "Connect plan usage" → macOS Keychain prompt appears; on "Always Allow", plan meters (5-hour / weekly) replace the local-only view; reset times render.
- [ ] If the endpoint is UNKNOWN/unavailable, the popover stays on local usage with the "Plan limits unavailable" note (no crash).
- [ ] Click outside / Esc closes the popover.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(ambient): verification fixes for status + usage"
```

---

## Self-Review

**Spec coverage:**
- Status pill + components + incidents → Tasks 2, 7, 8. ✅
- Local usage (always, no $) → Task 3, 8. ✅
- Plan limits best-effort + opt-in + fallback → Tasks 1, 4, 8. ✅
- Passive (no OS notifications) → no notify wiring anywhere. ✅
- Zero new Cargo deps (curl/security/serde_json) → Tasks 2-4. ✅
- Pull model, visibility-gated polling → Task 6. ✅
- Token in memory only; `planConnected` in localStorage → Tasks 4, 5. ✅ (Deviation from spec's "store.rs" persistence: localStorage instead — less invasive, matches theme/width prefs. Noted.)
- Error isolation / fail-open → unknown()/default() in Rust, try/catch keep-last-known in store. ✅
- Spike-first for the undocumented endpoint → Task 1, consumed by Task 4. ✅

**Placeholder scan:** The only deferred values are `USAGE_ENDPOINT` and the plan payload field names, which are **defined by Task 1** and consumed by Task 4 — not hand-waved. If Task 1 yields UNKNOWN, Task 4's `fetch_plan` returns `"unavailable"` and the feature still ships. No other TBDs.

**Type consistency:** Rust `ClaudeStatus`/`ClaudeUsage`/`LocalUsage`/`PlanWindow` (camelCase serde) ↔ TS interfaces in Task 5 match field-for-field (`pctUsed`, `resetsAt`, `tokensByModel`, `planSource`). Commands `fetch_claude_status` / `fetch_claude_usage` / `connect_claude_plan_usage` are referenced identically in Rust registration (Tasks 2-4) and TS `invoke` calls (Task 5). `indicatorMeta` / `fmtTokens` defined in Task 7, imported in Task 8. ✅
