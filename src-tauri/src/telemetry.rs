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
