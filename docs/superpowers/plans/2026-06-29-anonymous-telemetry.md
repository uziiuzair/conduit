# Anonymous GA4 Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send anonymous GA4 engagement events (launch + periodic heartbeat while focused) so GA4 reports accurate DAU/MAU, Sessions, new-vs-returning, and Realtime users for a long-lived desktop app.

**Architecture:** A Rust `telemetry.rs` module owns identity (anonymous UUID `client_id`), hardcoded GA4 credentials, a pure payload builder, gating policy, and a fail-open `curl` POST to the GA4 Measurement Protocol — exposed as a `telemetry_ping` Tauri command. A frontend `useTelemetry` hook owns lifecycle only: it manages `session_id`, fires `session_start` on launch and `user_engagement` every 5 min while the window is focused, and starts a new session after 30 min idle.

**Tech Stack:** Rust (Tauri v2, `serde_json`, `uuid`, `dirs`, `std::process::Command`/curl), React 19 + TypeScript (`@tauri-apps/api`).

**Parked seams (safe defaults; see spec):** `is_opted_out()` returns `false` and `client_id` persists in its own file until the settings/onboarding work lands. Dev-build suppression means nothing is sent during development regardless.

---

### Task 1: Pure payload builder

**Files:**
- Create: `src-tauri/src/telemetry.rs`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/telemetry.rs` with only the input type, the function signature, and tests:

```rust
//! Anonymous GA4 telemetry via the Measurement Protocol, POSTed with `curl`
//! (no HTTP-client dependency). Fire-and-forget + fail-open: any error is
//! swallowed and never affects the app. Strict field allowlist — only the event
//! name, session_id, engagement_time_msec, app_version, and os ever leave the
//! device. `client_id` is a random UUIDv4, never derived from PII.

/// Everything needed to build one Measurement Protocol request. Pure data.
pub struct PingInput {
    pub client_id: String,
    /// "session_start" | "user_engagement"
    pub event_name: String,
    pub session_id: String,
    pub engagement_msec: u64,
    pub app_version: String,
    pub os: String,
}

/// Build the GA4 MP JSON body. Pure: same input → same output, no I/O.
fn build_payload(input: &PingInput) -> String {
    let _ = input;
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(event_name: &str) -> PingInput {
        PingInput {
            client_id: "uuid-123".into(),
            event_name: event_name.into(),
            session_id: "sess-1".into(),
            engagement_msec: 300_000,
            app_version: "1.2.3".into(),
            os: "macos".into(),
        }
    }

    #[test]
    fn build_payload_has_exact_shape_and_params() {
        let body = build_payload(&sample("user_engagement"));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["client_id"], "uuid-123");
        assert_eq!(v["events"][0]["name"], "user_engagement");
        let params = &v["events"][0]["params"];
        assert_eq!(params["session_id"], "sess-1");
        assert_eq!(params["engagement_time_msec"], "300000");
        assert_eq!(params["app_version"], "1.2.3");
        assert_eq!(params["os"], "macos");
        // Allowlist: exactly these four params, nothing more.
        assert_eq!(params.as_object().unwrap().len(), 4);
    }

    #[test]
    fn build_payload_honors_event_name() {
        let body = build_payload(&sample("session_start"));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["events"][0]["name"], "session_start");
    }

    #[test]
    fn payload_never_leaks_forbidden_substrings() {
        let body = build_payload(&sample("user_engagement"));
        for forbidden in [
            "/Users/", "project", "branch", "prompt", "transcript",
            "hostname", "password", "secret", "token",
        ] {
            assert!(!body.contains(forbidden), "payload leaked: {forbidden}");
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml telemetry::`
Expected: FAIL — the three tests fail (empty/invalid JSON body).

> Note: `telemetry.rs` isn't wired into the crate yet, so add `mod telemetry;` temporarily? No — Task 4 adds the `mod` line. To run these tests now, add `mod telemetry;` to `lib.rs` line 17 first (it's needed permanently anyway): insert `mod telemetry;` between `mod store;` and `mod worktree;`.

- [ ] **Step 3: Implement `build_payload`**

Replace the stub body:

```rust
fn build_payload(input: &PingInput) -> String {
    serde_json::json!({
        "client_id": input.client_id,
        "events": [{
            "name": input.event_name,
            "params": {
                "session_id": input.session_id,
                "engagement_time_msec": input.engagement_msec.to_string(),
                "app_version": input.app_version,
                "os": input.os,
            }
        }]
    })
    .to_string()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml telemetry::`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/telemetry.rs src-tauri/src/lib.rs
git commit -m "feat(telemetry): pure GA4 MP payload builder with anonymity allowlist test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Gating policy

**Files:**
- Modify: `src-tauri/src/telemetry.rs`

- [ ] **Step 1: Write the failing tests**

Add the constants near the top of `telemetry.rs` (below the doc comment) and the pure policy fn + tests. Add to the existing `tests` module:

```rust
// Add at top of file (module level), below the doc comment:
const GA4_MEASUREMENT_ID: &str = ""; // TODO(user): "G-XXXXXXXXXX"
const GA4_API_SECRET: &str = "";     // TODO(user): GA4 Admin → Data Streams → Measurement Protocol API secret

fn creds_present() -> bool {
    !GA4_MEASUREMENT_ID.is_empty() && !GA4_API_SECRET.is_empty()
}

/// Pure send-policy. Telemetry is sent only in a release build, with creds, when
/// not opted out and not disabled by env. All inputs are explicit so every
/// branch is testable (tests run in debug, where the real gate is always off).
fn should_send_policy(opt_out: bool, is_debug: bool, env_disabled: bool, creds: bool) -> bool {
    !opt_out && !is_debug && !env_disabled && creds
}
```

Add these tests inside `mod tests`:

```rust
    #[test]
    fn policy_allows_only_in_release_with_creds_and_consent() {
        assert!(should_send_policy(false, false, false, true));
    }
    #[test]
    fn policy_blocks_when_opted_out() {
        assert!(!should_send_policy(true, false, false, true));
    }
    #[test]
    fn policy_blocks_in_debug_build() {
        assert!(!should_send_policy(false, true, false, true));
    }
    #[test]
    fn policy_blocks_when_env_disabled() {
        assert!(!should_send_policy(false, false, true, true));
    }
    #[test]
    fn policy_blocks_without_creds() {
        assert!(!should_send_policy(false, false, false, false));
    }
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml telemetry::`
Expected: PASS (8 passed). These pass immediately because `should_send_policy` is already implemented — this task locks the policy contract with tests.

> If `cargo` warns `creds_present`/`GA4_*` are unused, that is expected until Task 3/4 use them. Do not delete them.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/telemetry.rs
git commit -m "feat(telemetry): pure send-gating policy (release+creds+consent) with tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Anonymous client_id persistence

**Files:**
- Modify: `src-tauri/src/telemetry.rs`

- [ ] **Step 1: Write the failing test**

Add this function (module level):

```rust
use std::path::{Path, PathBuf};

fn data_dir() -> PathBuf {
    // Mirror store.rs: honor CONDUIT_DATA_DIR_NAME so dev builds stay isolated.
    let dir_name =
        std::env::var("CONDUIT_DATA_DIR_NAME").unwrap_or_else(|_| "ConduitTauri".to_string());
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(dir_name)
}

fn client_id_path() -> PathBuf {
    data_dir().join("telemetry_client_id")
}

/// Read the persisted anonymous client_id at `path`, creating a random UUIDv4 on
/// first run. Pure w.r.t. the path argument so it can be tested without env vars.
fn read_or_create_client_id_at(path: &Path) -> String {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, &id);
    id
}

fn get_or_create_client_id() -> String {
    read_or_create_client_id_at(&client_id_path())
}
```

Add this test inside `mod tests`:

```rust
    #[test]
    fn client_id_is_stable_uuid_across_calls() {
        let dir = std::env::temp_dir().join(format!("conduit-tel-{}", uuid::Uuid::new_v4()));
        let path = dir.join("telemetry_client_id");

        let first = read_or_create_client_id_at(&path);
        assert_eq!(first.len(), 36, "expected a UUIDv4 string");
        assert!(uuid::Uuid::parse_str(&first).is_ok());

        let second = read_or_create_client_id_at(&path);
        assert_eq!(first, second, "client_id must persist across calls");

        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml telemetry::`
Expected: PASS (9 passed). (Implementation is included in Step 1; this task adds I/O that's verified end-to-end against a temp path.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/telemetry.rs
git commit -m "feat(telemetry): persist anonymous client_id (interim seam) with test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Transport, opt-out seam, and the Tauri command

**Files:**
- Modify: `src-tauri/src/telemetry.rs`
- Modify: `src-tauri/src/lib.rs` (register command; `mod telemetry;` added in Task 1)

- [ ] **Step 1: Add the transport, seam, real gate, and command**

Add to `telemetry.rs` (module level):

```rust
use std::process::Command;
use tauri::Manager;

const MP_ENDPOINT: &str = "https://www.google-analytics.com/mp/collect";

/// PARKED (spec, parked decisions #1 & #2): the real opt-out source is owned by
/// the settings/onboarding work. Until that lands, return the safe default. The
/// dev-build gate guarantees nothing is sent during development regardless.
fn is_opted_out() -> bool {
    false
}

fn should_send(opt_out: bool) -> bool {
    should_send_policy(
        opt_out,
        cfg!(debug_assertions),
        std::env::var_os("CONDUIT_DISABLE_TELEMETRY").is_some(),
        creds_present(),
    )
}

/// Fire-and-forget POST. Mirrors claude_status.rs: `-s`, time-boxed, all output
/// and errors ignored. GA4 MP returns 204 with no body on success.
fn send(body: &str) {
    let url =
        format!("{MP_ENDPOINT}?measurement_id={GA4_MEASUREMENT_ID}&api_secret={GA4_API_SECRET}");
    let _ = Command::new("curl")
        .args([
            "-s",
            "--max-time",
            "8",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-d",
            body,
            &url,
        ])
        .output();
}

/// Tauri command: record one anonymous engagement event. Never errors, never
/// blocks — gating + curl happen off the async runtime. `kind` is
/// "session_start" for the first event of a session, anything else maps to
/// "user_engagement".
#[tauri::command]
pub async fn telemetry_ping(
    app: tauri::AppHandle,
    kind: String,
    session_id: String,
    engagement_msec: u64,
) {
    if !should_send(is_opted_out()) {
        return;
    }
    let event_name = if kind == "session_start" {
        "session_start"
    } else {
        "user_engagement"
    }
    .to_string();

    let input = PingInput {
        client_id: get_or_create_client_id(),
        event_name,
        session_id,
        engagement_msec,
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
    };
    let body = build_payload(&input);
    tauri::async_runtime::spawn_blocking(move || send(&body));
}
```

- [ ] **Step 2: Register the command in `lib.rs`**

In `src-tauri/src/lib.rs`, inside the `tauri::generate_handler![ ... ]` list (ends at the `claude_usage::connect_claude_plan_usage,` line ~423), add a line:

```rust
            telemetry::telemetry_ping,
```

- [ ] **Step 3: Verify it compiles and all tests pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — whole crate compiles; telemetry tests (9) pass; no `unused` errors now that `creds_present`/constants/`send` are used.

- [ ] **Step 4: Lint + format**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml && cargo fmt --manifest-path src-tauri/Cargo.toml`
Expected: no clippy warnings; fmt makes no/clean changes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/telemetry.rs src-tauri/src/lib.rs
git commit -m "feat(telemetry): curl transport + opt-out seam + telemetry_ping command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Frontend heartbeat hook

**Files:**
- Create: `src/hooks/useTelemetry.ts`

- [ ] **Step 1: Write the hook**

```ts
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";

const HEARTBEAT_MS = 5 * 60 * 1000; // ping every 5 min while focused
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // new GA4 session after 30 min idle

function send(kind: "session_start" | "user_engagement", sessionId: string, engagementMsec: number) {
  // Fire-and-forget; Rust gates + swallows. Never let telemetry surface errors.
  void invoke("telemetry_ping", { kind, sessionId, engagementMsec }).catch(() => {});
}

/**
 * Drives the anonymous engagement heartbeat. Lifecycle only — identity,
 * credentials, payload, and gating all live in Rust (telemetry_ping).
 *
 * @param optedOut when true, the hook does nothing. The real source of this
 *   value is parked (settings/onboarding); callers pass `false` for now.
 */
export function useTelemetry(optedOut: boolean = false): void {
  const sessionId = useRef("");
  const lastActivity = useRef(0);
  const lastPing = useRef(0);

  useEffect(() => {
    if (optedOut) return;
    let disposed = false;

    const startSession = () => {
      sessionId.current = crypto.randomUUID();
      const now = Date.now();
      lastActivity.current = now;
      lastPing.current = now;
      send("session_start", sessionId.current, 1);
    };

    const engage = () => {
      const now = Date.now();
      if (now - lastActivity.current >= SESSION_TIMEOUT_MS) {
        startSession();
        return;
      }
      const delta = now - lastPing.current;
      lastPing.current = now;
      lastActivity.current = now;
      send("user_engagement", sessionId.current, delta);
    };

    const tick = () => {
      if (disposed) return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        engage();
      }
    };

    const onFocus = () => {
      if (disposed) return;
      engage();
    };

    startSession();
    const timer = window.setInterval(tick, HEARTBEAT_MS);
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [optedOut]);
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useTelemetry.ts
git commit -m "feat(telemetry): frontend focus-driven engagement heartbeat hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Mount the hook + full verification

**Files:**
- Modify: `src/App.tsx` (add import + call inside `App()`)

- [ ] **Step 1: Mount the hook in `App()`**

Add the import alongside the other hook imports near the top of `src/App.tsx`:

```ts
import { useTelemetry } from "./hooks/useTelemetry";
```

Inside `export default function App()` (line 22), near the other top-level hook calls (e.g. where `useClaudeAmbient` is invoked), add:

```ts
  // Parked: opt-out source is owned by settings/onboarding; pass false for now.
  useTelemetry(false);
```

- [ ] **Step 2: Typecheck + production build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: PASS — tsc clean, vite build succeeds.

- [ ] **Step 3: Full Rust gate**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml && cargo fmt --manifest-path src-tauri/Cargo.toml --check`
Expected: tests PASS, clippy clean, fmt reports no diff.

- [ ] **Step 4: Manual launch check (per CLAUDE.md — UI changes must be launched)**

Run (isolated dev data dir):
`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`
Expected: app launches normally; **no telemetry network traffic** (dev build is gated off by `cfg!(debug_assertions)`), no console errors from the hook. This confirms the hook mounts without affecting the app. (Real GA4 DebugView verification happens later, only after creds are added and a release build is cut.)

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(telemetry): mount engagement heartbeat at app root

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-implementation notes (for the user)

- **Add credentials:** set `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` in `telemetry.rs`. Until then the engine is a safe no-op (empty-creds gate). Even after, **dev builds never send** — verify with a release build via GA4 DebugView.
- **Unpark when ready:** wire `is_opted_out()` (Rust) and `useTelemetry(optedOut)` (App) to the settings store, and surface the choice in onboarding.

## Self-review

- **Spec coverage:** payload+allowlist (T1) ✓; gating incl. dev/env/opt-out/creds (T2,T4) ✓; anonymous persistent client_id (T3) ✓; curl fail-open transport (T4) ✓; command + registration (T4) ✓; two events session_start/user_engagement (T1,T4,T5) ✓; cadence 5-min focused + 30-min session reset + pause-on-blur (T5) ✓; mount (T6) ✓; parked seams as safe defaults (T4,T5,T6) ✓; tests + manual launch (T1–T3,T6) ✓; hardcoded-creds-empty no-op (T2,T4) ✓.
- **Placeholders:** none — every code step shows complete code; `TODO(user)` markers are intentional credential slots, not plan gaps.
- **Type consistency:** `PingInput` fields, `build_payload`, `should_send_policy`/`should_send`, `read_or_create_client_id_at`/`get_or_create_client_id`, `telemetry_ping(kind, session_id, engagement_msec)` ↔ JS `{ kind, sessionId, engagementMsec }` all consistent across tasks.
