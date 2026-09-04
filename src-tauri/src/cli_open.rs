//! The `conduit` CLI launcher's HTTP entry point.
//!
//! `hooks.rs` documents its own trust model for hook bodies explicitly: untrusted,
//! unauthenticated, localhost display-data on which no security decision keys, so a
//! spoofed post at worst shows wrong numbers. `/open` is the opposite -- it adds an
//! arbitrary directory as a project and can start an agent inside it, so a spoofed post
//! is an agent process running against a directory of the caller's choosing. Hence
//! three independent layers here: a per-boot token, an `Origin` refusal, and (in
//! `hooks.rs`) never answering a CORS preflight.
//!
//! Nothing in this module touches Tauri. `handle_open` takes a SINK, which is what lets
//! `tests/cli_open.rs` drive the real handler with a real shim process over a real
//! socket. Keep it that way.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tiny_http::{Request, Response};

/// The header carrying the CLI token. Deliberately not a CORS-safelisted name: a
/// browser must send an `OPTIONS` preflight before it can use this, and the hook
/// server never answers a preflight.
pub const TOKEN_HEADER: &str = "x-conduit-token";

/// Cap the body so a runaway or hostile POST cannot exhaust memory -- same reasoning as
/// the hook loop's 1 MB cap, tighter because an open request is a path and a word.
const MAX_BODY: u64 = 64 * 1024;

/// One `conduit <path> [--agent <id>]` invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenRequest {
    pub path: String,
    #[serde(default)]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    BadToken,
    BrowserOrigin,
    BadBody,
}

impl Reject {
    /// The wire status. `BadToken` and `BrowserOrigin` both answer 403 with an empty
    /// body, so a caller learns nothing about which layer refused it.
    pub fn status(self) -> u16 {
        match self {
            Reject::BadToken | Reject::BrowserOrigin => 403,
            Reject::BadBody => 400,
        }
    }
}

pub fn token_file_path_in(dir: &Path) -> PathBuf {
    dir.join("cli-token")
}

pub fn token_file_path() -> PathBuf {
    token_file_path_in(&crate::store::data_dir())
}

/// Write a fresh 256-bit token into `dir`, owner-only, and return it.
///
/// Two v4 UUIDs rather than a `rand` dependency -- `uuid` is already in the tree and v4
/// is CSPRNG-backed, so this respects the lean-dependency rule. Regenerated on every
/// boot, so a token captured from a backup or an old shell's scrollback is already dead.
pub fn write_token_file_in(dir: &Path) -> String {
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let path = token_file_path_in(dir);
    if let Err(e) = fs::write(&path, format!("{token}\n")) {
        eprintln!("conduit: could not write cli token: {e}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    token
}

pub fn write_token_file() -> String {
    write_token_file_in(&crate::store::data_dir())
}

/// Constant-time-ish equality: no early return on the first differing byte.
fn secret_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Authenticate and parse one `/open` request. Pure -- no IO, no Tauri.
pub fn parse_open(
    headers: &[(String, String)],
    body: &str,
    expected: &str,
) -> Result<OpenRequest, Reject> {
    // Origin FIRST: a page must not be able to use this route as a token oracle.
    if headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("origin")) {
        return Err(Reject::BrowserOrigin);
    }
    let supplied = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(TOKEN_HEADER))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    // An empty expected token means the boot-time write failed. Fail shut, not open.
    if expected.is_empty() || !secret_eq(supplied, expected) {
        return Err(Reject::BadToken);
    }
    let req: OpenRequest = serde_json::from_str(body).map_err(|_| Reject::BadBody)?;
    if req.path.trim().is_empty() {
        return Err(Reject::BadBody);
    }
    Ok(req)
}

/// Handle one `/open`. On success the sink runs BEFORE the response is written, so a
/// shim that waits for 200 knows the app has already acted.
pub fn handle_open<F: FnOnce(OpenRequest)>(mut request: Request, expected: &str, sink: F) {
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|h| {
            (
                h.field.as_str().as_str().to_string(),
                h.value.as_str().to_string(),
            )
        })
        .collect();

    let mut body = String::new();
    let _ = request.as_reader().take(MAX_BODY).read_to_string(&mut body);

    match parse_open(&headers, &body, expected) {
        Ok(open) => {
            sink(open);
            let _ = request.respond(Response::from_string("ok"));
        }
        Err(reject) => {
            let _ = request.respond(Response::empty(reject.status()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdrs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    const TOK: &str = "abc123";

    #[test]
    fn accepts_a_well_formed_request() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        let got = parse_open(&h, r#"{"path":"/tmp/p","agent":"claude"}"#, TOK).unwrap();
        assert_eq!(
            got,
            OpenRequest {
                path: "/tmp/p".into(),
                agent: Some("claude".into())
            }
        );
    }

    #[test]
    fn agent_is_optional() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        let got = parse_open(&h, r#"{"path":"/tmp/p"}"#, TOK).unwrap();
        assert_eq!(got.agent, None);
    }

    #[test]
    fn header_name_is_case_insensitive() {
        let h = hdrs(&[("x-conduit-token", TOK)]);
        assert!(parse_open(&h, r#"{"path":"/tmp/p"}"#, TOK).is_ok());
    }

    #[test]
    fn rejects_a_missing_or_wrong_token() {
        assert_eq!(
            parse_open(&hdrs(&[]), r#"{"path":"/p"}"#, TOK),
            Err(Reject::BadToken)
        );
        let h = hdrs(&[("X-Conduit-Token", "nope")]);
        assert_eq!(parse_open(&h, r#"{"path":"/p"}"#, TOK), Err(Reject::BadToken));
    }

    /// A browser cannot suppress Origin on a cross-origin request, and a shell client
    /// never sends one. Checked BEFORE the token so a page cannot probe token validity.
    #[test]
    fn rejects_anything_carrying_origin() {
        let h = hdrs(&[("X-Conduit-Token", TOK), ("Origin", "https://evil.example")]);
        assert_eq!(
            parse_open(&h, r#"{"path":"/p"}"#, TOK),
            Err(Reject::BrowserOrigin)
        );
        let h = hdrs(&[("origin", "null"), ("X-Conduit-Token", TOK)]);
        assert_eq!(
            parse_open(&h, r#"{"path":"/p"}"#, TOK),
            Err(Reject::BrowserOrigin)
        );
    }

    #[test]
    fn rejects_a_bad_body() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        assert_eq!(parse_open(&h, "not json", TOK), Err(Reject::BadBody));
        assert_eq!(parse_open(&h, r#"{"path":""}"#, TOK), Err(Reject::BadBody));
        assert_eq!(
            parse_open(&h, r#"{"agent":"claude"}"#, TOK),
            Err(Reject::BadBody)
        );
    }

    #[test]
    fn an_empty_expected_token_accepts_nothing() {
        // Defensive: if the boot-time write ever failed, the route must be shut, not open.
        let h = hdrs(&[("X-Conduit-Token", "")]);
        assert_eq!(parse_open(&h, r#"{"path":"/p"}"#, ""), Err(Reject::BadToken));
    }

    #[test]
    fn token_file_round_trips_and_is_not_guessable() {
        let dir = std::env::temp_dir().join(format!("conduit-tok-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let a = write_token_file_in(&dir);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            fs::read_to_string(token_file_path_in(&dir)).unwrap().trim(),
            a
        );
        // Regenerated per boot: a token read from a backup is worthless.
        assert_ne!(a, write_token_file_in(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("conduit-tok-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        write_token_file_in(&dir);
        let mode = fs::metadata(token_file_path_in(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "token file must not be group/world readable"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// Serve exactly one request against a real socket, and report what the sink saw.
    fn serve_one(port_out: &std::sync::mpsc::Sender<u16>, token: String) -> std::sync::mpsc::Receiver<OpenRequest> {
        let (tx, rx) = std::sync::mpsc::channel();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        port_out
            .send(server.server_addr().to_ip().unwrap().port())
            .unwrap();
        std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                handle_open(req, &token, move |o| {
                    let _ = tx.send(o);
                });
            }
        });
        rx
    }

    #[test]
    fn handle_open_feeds_the_sink_and_answers_200() {
        let (ptx, prx) = std::sync::mpsc::channel();
        let rx = serve_one(&ptx, TOK.to_string());
        let port = prx.recv().unwrap();

        let out = std::process::Command::new("curl")
            .args([
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "-X",
                "POST",
                "-H",
                &format!("X-Conduit-Token: {TOK}"),
                "--data",
                r#"{"path":"/tmp/p","agent":"claude"}"#,
                &format!("http://127.0.0.1:{port}/open"),
            ])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "200");
        let got = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(got.path, "/tmp/p");
        assert_eq!(got.agent.as_deref(), Some("claude"));
    }

    #[test]
    fn handle_open_answers_403_and_never_fires_the_sink_without_a_token() {
        let (ptx, prx) = std::sync::mpsc::channel();
        let rx = serve_one(&ptx, TOK.to_string());
        let port = prx.recv().unwrap();

        let out = std::process::Command::new("curl")
            .args([
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "-X",
                "POST",
                "--data",
                r#"{"path":"/tmp/p"}"#,
                &format!("http://127.0.0.1:{port}/open"),
            ])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "403");
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err());
    }
}
