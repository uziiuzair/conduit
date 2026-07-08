# Anonymous PostHog Telemetry (DAU/MAU) — Design

**Date:** 2026-06-29  
**Updated:** 2026-07-08  
**Status:** Implemented with PostHog anonymous capture

## Context

Conduit is an open-source Tauri v2 desktop app. We want basic product health
signals while keeping telemetry anonymous:

- active users,
- sessions,
- new vs. returning anonymous installs,
- app version and operating system distribution.

Telemetry is intentionally limited to app lifecycle events. We do not capture
feature usage, project metadata, file paths, prompts, transcripts, branch names,
hostnames, usernames, or machine identifiers.

The Rust side sends events with `curl`, matching the rest of the codebase's
networking style and avoiding an HTTP-client dependency.

## Architecture

```
src/hooks/useTelemetry.ts   (focus/visibility lifecycle, cadence, session_id)
        │  invoke('telemetry_ping', { kind, sessionId, engagementMs })
        ▼
src-tauri/src/telemetry.rs  (anonymous ID, payload allowlist, PostHog capture)
```

The frontend owns lifecycle timing only. Rust owns the anonymous identifier,
project token, payload shape, gating, and transport.

## PostHog Capture Details

Endpoint:

```text
POST https://us.i.posthog.com/i/v0/e/
```

Body shape:

```json
{
  "api_key": "<posthog_project_token>",
  "event": "app_heartbeat",
  "distinct_id": "<persistent random uuid v4>",
  "properties": {
    "$process_person_profile": false,
    "session_id": "<per-session uuid>",
    "engagement_time_msec": 300000,
    "app_version": "0.6.0",
    "os": "macos"
  }
}
```

`$process_person_profile: false` keeps these as anonymous events in PostHog.
The `distinct_id` is a random UUIDv4 generated once and persisted locally; it is
never derived from PII or device identity.

## Events

- `app_open` — sent when a telemetry session starts.
- `app_heartbeat` — sent every five minutes while the app is focused, and when
  focus returns.

A new telemetry session starts after 30 minutes of inactivity.

## Gating

Telemetry is a no-op when any of these hold:

- the user has opted out,
- the app is running in a debug build without `CONDUIT_TELEMETRY_IN_DEV`,
- `CONDUIT_DISABLE_TELEMETRY` is set,
- the PostHog project token or host is empty.

Errors are swallowed. Telemetry must never affect app behavior.

## Anonymity Contract

The only event fields that leave the device are:

- event name,
- anonymous distinct ID,
- session ID,
- engagement time,
- app version,
- operating system,
- PostHog's `$process_person_profile: false` privacy control.

No project, prompt, transcript, branch, path, username, hostname, password,
secret, or user auth token content is captured.
