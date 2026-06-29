# Anonymous GA4 Telemetry (DAU/MAU) — Design

**Date:** 2026-06-29
**Status:** Approved (user authorized autonomous execution)
**Branch:** `feat/anonymous-telemetry`

## Context

Conduit is an open-source Tauri v2 desktop app. We want to understand real
usage — **active users (DAU/MAU), sessions, new vs. returning, and live/Realtime
users** — via **Google Analytics 4**, while keeping the data **absolutely
anonymous**. There is no telemetry today.

Two facts about the codebase shape the design:

- **All outbound network calls shell out to `curl`** (see `claude_status.rs`),
  and the Rust side intentionally has **no HTTP client dependency**
  (`reqwest`/`tokio`-for-HTTP are off-limits per `CLAUDE.md`).
- **State persistence is currently a bare `Vec<Project>`** serialized to
  `state.json` (`store.rs`) — there is no settings object yet. A settings panel
  and an onboarding panel are being built **by other agents in parallel**.

A desktop app cannot use GA4's web tag (`gtag.js`) cleanly: it would require
loosening Tauri's CSP, loading a remote third-party script, and it inherits
webview cookie/origin quirks that break the anonymity guarantee. Instead we use
the **GA4 Measurement Protocol** (a plain JSON `POST`), which fits the existing
`curl` pattern and lets us enforce a strict field allowlist.

## Goals

- Populate GA4 **Active Users (DAU/MAU)**, **Sessions**, **new vs. returning**,
  and **Realtime "live users"**.
- Reflect **real engagement**, not process lifetime. (Conduit often stays open
  for days; a single fire on launch would undercount to near-zero.)
- Keep data **absolutely anonymous** — enforced by an allowlist, not a setting.
- Stay within repo conventions: `curl`, fail-open, lean deps, pure+tested logic.

## Non-goals (YAGNI for v1)

- Feature-usage events, per-agent analytics, error/crash reporting.
- Foreground/background time accounting beyond a simple focused-time heartbeat.
- A custom analytics backend or proxy (creds are hardcoded; see Credentials).

## Locked decisions

| Decision | Choice |
| --- | --- |
| What we measure | Active users & sessions only (DAU/MAU + Realtime) |
| Transport | GA4 Measurement Protocol via `curl` POST (Rust) |
| Trigger model | Periodic **engagement heartbeat** (launch + while focused) |
| Credentials | **Hardcoded constants in source** (accepted: extractable/spoofable) |
| Anonymity | Strict allowlist; random UUIDv4 `client_id`, never PII-derived |

## ⏸️ Parked decisions (await explicit user go-ahead)

These are isolated to a single seam so the rest is fully implementable now. They
ship as **clearly-marked seams with safe defaults**; wiring the real sources in
later is a one-place change.

1. **Where `opt_out` (and the persisted `client_id`) live** — the settings-panel
   agent may own a settings store (e.g. migrate `state.json` to
   `{projects, settings}`). Until signaled, `client_id` persists in its own
   minimal file (non-committal) and `is_opted_out()` is a marked stub returning
   the safe default.
2. **Consent presentation** — onboarding copy + default ON vs OFF. Until
   signaled, the engine reads the `opt_out` flag but its UI/source is deferred.

> While parked, **dev-build suppression guarantees nothing is sent during
> development** regardless of the default, so a default-on stub is harmless until
> a release build is intentionally cut with real credentials.

## Architecture

Approach A engine (Rust-native) with a frontend trigger — a clean split:

```
src/hooks/useTelemetry.ts   (lifecycle: focus/visibility, cadence, session_id)
        │  invoke('telemetry_ping', { kind, sessionId, engagementMs })
        ▼
src-tauri/src/telemetry.rs   (identity + creds + payload + transport)
   ├─ build_payload(cfg) -> String        // PURE, unit-tested
   ├─ send(body) via curl                 // fail-open, time-boxed, fire-and-forget
   ├─ GA4 constants (MEASUREMENT_ID, API_SECRET)   // hardcoded; empty => no-op
   └─ reads client_id + opt_out from the parked seam
```

**Responsibility split (why this division):**

- **Frontend owns lifecycle only.** Only the webview knows window focus /
  document visibility, which is what makes "engagement" honest. It decides *when*
  to ping and manages `session_id` + the focused-time delta.
- **Rust owns identity, credentials, payload, and transport.** Credentials never
  enter the JS bundle. Rust fills in `app_version`/`os` and the anonymous
  `client_id`, builds the final payload (so the frontend can't widen the
  allowlist), and is the **authoritative gate** for whether anything is sent.

## GA4 Measurement Protocol details

- **Endpoint:** `POST https://www.google-analytics.com/mp/collect?measurement_id=<MID>&api_secret=<SECRET>`
- **Validation/debug endpoint (manual verification):**
  `https://www.google-analytics.com/debug/mp/collect`
- **Two GA4-idiomatic events:**
  - `session_start` — at launch and when a new session begins.
  - `user_engagement` — the heartbeat; `engagement_time_msec` = focused time
    since the last ping.
- **Body shape:**

```json
{
  "client_id": "<persistent random uuid v4>",
  "events": [{
    "name": "user_engagement",
    "params": {
      "session_id": "<per-session id>",
      "engagement_time_msec": "300000",
      "app_version": "1.2.3",
      "os": "macos"
    }
  }]
}
```

`client_id` (stable) → DAU/MAU + new-vs-returning. `session_id` +
`engagement_time_msec` → required for GA4 to count the event toward Active Users
/ Sessions / engagement. `app_version` from `app.package_info().version`; `os`
from `std::env::consts::OS`.

## Anonymity contract (explicit allowlist)

`client_id` is a random **UUIDv4 generated once** — never derived from
hardware/MAC/email/hostname.

**The ONLY fields that ever leave the device:**
`event name` (`session_start` | `user_engagement`), `session_id`,
`engagement_time_msec`, `app_version`, `os`.

**NEVER sent:** filesystem paths, project/session/branch names, prompts,
transcript content, username, hostname, machine identifiers. (We do not send IP;
GA observes it at the socket, uses it for coarse geo, and GA4 does not store it.)

The payload is a **typed struct**, so adding any field is a deliberate code edit
— and a unit test asserts the serialized body contains none of a
forbidden-substring set.

## Gating / suppression (Rust = authoritative no-op)

`telemetry_ping` is a no-op when **any** of these hold:

- `opt_out == true` (from parked seam).
- **Dev build:** `cfg!(debug_assertions)` → keeps `pnpm tauri dev` and the dev
  data-dir from polluting real DAU/MAU.
- Env `CONDUIT_DISABLE_TELEMETRY` is set → CI / privacy-minded contributors.
- GA4 constants are empty/placeholder → defensive (also the current shipping
  state until real creds are added).

The frontend hook also checks `opt_out` before starting its loop, but Rust is the
source of truth.

## Transport & error handling (fail-open, mirrors `claude_status.rs`)

```
curl -s --max-time 8 -X POST -H 'Content-Type: application/json' -d <body> <url>
```

Run in `spawn_blocking`; fire-and-forget; **all errors swallowed**; no retries.
GA4 MP returns `204` with no body on success. Telemetry must never affect app
behavior or surface errors to the UI. (No `npm_config_prefix` scrubbing needed —
that gotcha is specific to spawning `claude`, not `curl`.)

## Cadence & session semantics (defaults, tunable)

- Fire `session_start` on launch.
- Fire `user_engagement` **every 5 min while the window is focused**, plus once
  on focus-regained.
- **Pause** heartbeats when the window is blurred/hidden → idle days don't count,
  matching GA4 engagement semantics.
- Start a **new session** (`session_start`, fresh `session_id`) after ≥30 min of
  inactivity (mirrors GA4's 30-min session timeout) → accurate Sessions and
  new-vs-returning.

## Credentials

The chosen approach is hardcoded constants. Real values are **not yet available**
to this implementation, so the code ships with empty placeholder constants:

```rust
const GA4_MEASUREMENT_ID: &str = ""; // TODO(user): set "G-XXXXXXXXXX"
const GA4_API_SECRET: &str = "";     // TODO(user): set from GA4 Admin → Data Streams → Measurement Protocol API secrets
```

Empty constants make the engine a **safe no-op** until the user fills them in.
Action item for the user: create a GA4 property + a Measurement Protocol API
secret and drop the two values into `telemetry.rs`.

## Testing strategy

- **Rust unit tests (pure):**
  - `build_payload()` for both `session_start` and `user_engagement`: correct
    event name, exactly the allowlisted params, no extra fields, correct
    structure.
  - **Anonymity test:** serialized payload contains none of a forbidden-substring
    set (paths, "project", a sample home dir, hostname-like tokens, etc.).
  - Gating: `should_send()` returns false for empty creds / dev / env / opt-out.
- **Manual verification:** GA4 **DebugView** + `/debug/mp/collect` validation
  response (standard reports lag 24–48h). Confirm Realtime shows a live user,
  and new-vs-returning + Sessions behave as expected.
- **Frontend:** no test runner exists; verify by launching the app (per
  `CLAUDE.md`) and watching DebugView. The only frontend surface here is the
  heartbeat hook; the opt-out toggle UI belongs to the parked settings work.
- Repo pre-PR checks: `cargo test`, `cargo fmt`, `cargo clippy`,
  `pnpm exec tsc --noEmit`, `pnpm build`.

## File-by-file changes

| File | Change |
| --- | --- |
| `src-tauri/src/telemetry.rs` | **New.** Constants, `TelemetryConfig`, pure `build_payload`, `should_send`, `curl` `send`, `telemetry_ping` command, `client_id` persistence (interim seam), `#[cfg(test)]` tests. |
| `src-tauri/src/lib.rs` | Declare `mod telemetry;`; register `telemetry::telemetry_ping` in `invoke_handler!`. |
| `src-tauri/Cargo.toml` | No new deps expected (`uuid`, `serde`, `serde_json` already present). |
| `src/hooks/useTelemetry.ts` | **New.** Focus/visibility-driven heartbeat: session_id management, 5-min/30-min timers, `invoke('telemetry_ping', …)`, opt-out check (parked source). |
| `src/App.tsx` (or root) | Mount `useTelemetry()` once at app root. |

## Future (explicitly out of scope)

- Feature-usage events, error/crash reporting.
- Configurable cadence; richer engagement-time accounting.
- Reconciling `client_id`/`opt_out` storage with the settings agent's store
  (tracked as parked decision #1).
