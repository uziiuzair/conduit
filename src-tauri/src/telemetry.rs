//! Anonymous GA4 telemetry via the Measurement Protocol, POSTed with `curl`
//! (no HTTP-client dependency). Fire-and-forget + fail-open: any error is
//! swallowed and never affects the app. Strict field allowlist — only the event
//! name, session_id, engagement_time_msec, app_version, and os ever leave the
//! device. `client_id` is a random UUIDv4, never derived from PII.

// ---- Hardcoded GA4 credentials (empty => telemetry is a no-op) ----
const GA4_MEASUREMENT_ID: &str = ""; // TODO(user): "G-XXXXXXXXXX"
const GA4_API_SECRET: &str = ""; // TODO(user): GA4 Admin → Data Streams → Measurement Protocol API secret

fn creds_present() -> bool {
    !GA4_MEASUREMENT_ID.is_empty() && !GA4_API_SECRET.is_empty()
}

/// Pure send-policy. Telemetry is sent only in a release build, with creds, when
/// not opted out and not disabled by env. All inputs are explicit so every
/// branch is testable (tests run in debug, where the real gate is always off).
fn should_send_policy(opt_out: bool, is_debug: bool, env_disabled: bool, creds: bool) -> bool {
    !opt_out && !is_debug && !env_disabled && creds
}

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

    #[test]
    fn payload_never_leaks_forbidden_substrings() {
        let body = build_payload(&sample("user_engagement"));
        for forbidden in [
            "/Users/", "project", "branch", "prompt", "transcript", "hostname", "password",
            "secret", "token",
        ] {
            assert!(!body.contains(forbidden), "payload leaked: {forbidden}");
        }
    }
}
