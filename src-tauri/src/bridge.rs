//! Mobile bridge — a WebSocket server that mirrors a session's PTY to a remote client
//! and forwards its keystrokes back. Default: 127.0.0.1 only (no pairing, no tunnel) —
//! the M1 de-risk. Opt-in dev LAN mode: set `CONDUIT_BRIDGE_TOKEN` and the bridge binds
//! all interfaces (reachable from a phone on the same Wi-Fi) AND requires `?token=` on
//! every connection. Transport + auth flip together, so the LAN is never open
//! unauthenticated. This is a dev shortcut to the full QR/X25519 pairing (see the
//! 2026-06-25 terminal-mirror spec), not a replacement: the token rides plaintext over
//! the LAN, fine for a trusted dev network only.
//!
//! WebSocket (not tiny_http like hooks.rs) because terminal I/O is bidirectional and
//! latency-sensitive. Thread-per-connection, matching the hooks server's style.

use std::collections::HashSet;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::{accept, accept_hdr, Message, WebSocket};

use crate::hookbus::HookBus;
use crate::pty::PtyManager;
use crate::store::Store;

/// Messages the client (browser/phone) sends. `input.data` is a RAW keystroke
/// string (same contract as the `pty_write` command), NOT base64 — only PTY *output*
/// is base64 because it is arbitrary bytes.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMsg {
    List,
    Attach {
        session_id: String,
    },
    Input {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
}

/// Parse one client text frame. None on malformed JSON or an unknown `type`.
pub fn parse_client_msg(text: &str) -> Option<ClientMsg> {
    serde_json::from_str(text).ok()
}

/// How many buffered output frames to flush to the socket per poll iteration.
const DRAIN_PER_TICK: usize = 256;
/// Read timeout so the poll loop can interleave control reads with output draining.
const READ_POLL: Duration = Duration::from_millis(20);

/// Build the `projects` payload: the persisted tree with a `running` flag per session.
fn projects_payload(
    projects: &[serde_json::Value],
    running: &HashSet<String>,
) -> serde_json::Value {
    let with_flags: Vec<serde_json::Value> = projects
        .iter()
        .map(|p| {
            let sessions: Vec<serde_json::Value> = p
                .get("sessions")
                .and_then(|s| s.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|mut s| {
                    let id = s
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("")
                        .to_string();
                    if let Some(obj) = s.as_object_mut() {
                        obj.insert(
                            "running".into(),
                            serde_json::Value::Bool(running.contains(&id)),
                        );
                    }
                    s
                })
                .collect();
            let mut p = p.clone();
            if let Some(obj) = p.as_object_mut() {
                obj.insert("sessions".into(), serde_json::Value::Array(sessions));
            }
            p
        })
        .collect();
    json!({ "type": "projects", "projects": with_flags })
}

/// Build a forwarded hook-status frame.
fn status_payload(event: &str, body: &serde_json::Value) -> serde_json::Value {
    json!({ "type": "status", "event": event, "body": body })
}

/// Build the transcript backfill payload from raw jsonl lines.
fn history_payload(lines: &[String]) -> serde_json::Value {
    let items: Vec<serde_json::Value> = lines
        .iter()
        .flat_map(|l| crate::transcript::parse_line(l))
        .collect();
    json!({ "type": "history", "items": items })
}

/// Read a transcript file fully into trimmed, non-empty lines. Empty on any error.
fn read_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|s| {
            s.lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// The shared dev token gating LAN connections, from `CONDUIT_BRIDGE_TOKEN`. Unset or
/// empty → None (loopback, no gate — today's behavior). Set → Some(token): bind all
/// interfaces and require `?token=<token>` on connect.
fn bridge_token() -> Option<String> {
    std::env::var("CONDUIT_BRIDGE_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Bind address derived from the token: LAN-reachable only when a token guards it.
fn bridge_host(token: &Option<String>) -> &'static str {
    if token.is_some() {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
}

/// Pull the `token` value out of a URL query string (`a=1&token=xyz&b=2` -> `xyz`).
fn extract_query_token(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        match (it.next(), it.next()) {
            (Some("token"), Some(v)) => Some(v.to_string()),
            _ => None,
        }
    })
}

/// Does the handshake query carry the expected token? (Dev-grade `==`; the real
/// pairing milestone replaces this with an X25519-derived credential.)
fn token_ok(query: Option<&str>, expected: &str) -> bool {
    query
        .and_then(extract_query_token)
        .map(|t| t == expected)
        .unwrap_or(false)
}

/// Accept a WebSocket, enforcing the token gate during the handshake when one is set.
/// A bad/missing token is rejected with 401 before the upgrade completes.
fn accept_ws(stream: TcpStream, token: &Option<String>) -> Option<WebSocket<TcpStream>> {
    match token {
        Some(expected) => {
            let expected = expected.clone();
            let check = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                if token_ok(req.uri().query(), &expected) {
                    Ok(resp)
                } else {
                    let mut err = ErrorResponse::new(Some("invalid bridge token".to_string()));
                    *err.status_mut() = StatusCode::UNAUTHORIZED;
                    Err(err)
                }
            };
            accept_hdr(stream, check).ok()
        }
        None => accept(stream).ok(),
    }
}

/// Start the bridge on the first free port in 8455..=8475 (distinct from the hook
/// server's 8423..=8443). Loopback by default; LAN + token gate when
/// `CONDUIT_BRIDGE_TOKEN` is set. Takes the AppHandle so each connection can reach the
/// managed PtyManager / Store / HookBus (matching hooks::start's pattern).
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let token = bridge_token();
        let host = bridge_host(&token);
        let mut listener = None;
        for candidate in 8455u16..=8475 {
            if let Ok(l) = std::net::TcpListener::bind((host, candidate)) {
                if token.is_some() {
                    eprintln!(
                        "conduit: mobile bridge on ws://{host}:{candidate} (LAN; token required). \
                         Phone URL: ws://<this-mac-LAN-IP>:{candidate}  (find it: ipconfig getifaddr en0)"
                    );
                } else {
                    eprintln!("conduit: mobile bridge on ws://127.0.0.1:{candidate}");
                }
                listener = Some(l);
                break;
            }
        }
        let Some(listener) = listener else {
            eprintln!("conduit: no free bridge port in 8455..=8475");
            return;
        };
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            let token = token.clone();
            thread::spawn(move || handle_conn(stream, app, token));
        }
    });
}

fn handle_conn(stream: TcpStream, app: AppHandle, token: Option<String>) {
    // Handshake blocking (token-gated when set), THEN a short read timeout for the loop.
    let Some(mut ws) = accept_ws(stream, &token) else {
        return;
    };
    if ws.get_ref().set_read_timeout(Some(READ_POLL)).is_err() {
        return;
    }
    let pty = app.state::<Arc<PtyManager>>().inner().clone();
    let bus = app.state::<Arc<HookBus>>().inner().clone();
    let (bus_id, bus_rx) = bus.subscribe();

    // (session_id, subscription id, frame receiver) once attached.
    let mut attached: Option<(String, u64, std::sync::mpsc::Receiver<String>)> = None;
    // (transcript path, lines already sent) — set on attach, advanced while tailing.
    let mut transcript: Option<(PathBuf, usize)> = None;

    loop {
        // 1. Read a control message if one is ready (times out quickly otherwise).
        match ws.read() {
            Ok(Message::Text(text)) => match parse_client_msg(&text) {
                Some(ClientMsg::List) => {
                    // Real project tree (names + branches) with a per-session running flag.
                    let running: HashSet<String> = pty.session_ids().into_iter().collect();
                    let projects = serde_json::to_value(app.state::<Store>().list())
                        .ok()
                        .and_then(|v| v.as_array().cloned())
                        .unwrap_or_default();
                    let _ = ws.send(Message::Text(
                        projects_payload(&projects, &running).to_string(),
                    ));
                }
                Some(ClientMsg::Attach { session_id }) => {
                    if let Some((sub_id, rx)) = pty.subscribe(&session_id) {
                        // Desktop-authoritative sizing: tell the new viewer the PTY's
                        // current size so it renders at the desktop's dimensions rather
                        // than resizing the shared TTY out from under the desktop.
                        if let Some((cols, rows)) = pty.session_size(&session_id) {
                            let _ = ws.send(Message::Text(
                                json!({ "type": "size", "cols": cols, "rows": rows }).to_string(),
                            ));
                        }
                        // Transcript backfill (chat history) + start tailing for appends.
                        if let Some(dir) = crate::pty::claude_projects_dir() {
                            if let Some(path) = crate::pty::transcript_path(&session_id, &dir) {
                                let lines = read_lines(&path);
                                let _ = ws.send(Message::Text(history_payload(&lines).to_string()));
                                transcript = Some((path, lines.len()));
                            }
                        }
                        attached = Some((session_id, sub_id, rx));
                    } else {
                        let _ = ws.send(Message::Text(
                            json!({ "type": "error", "message": "no such session" }).to_string(),
                        ));
                    }
                }
                Some(ClientMsg::Input { session_id, data }) => {
                    let _ = pty.write(&session_id, &data);
                }
                Some(ClientMsg::Resize {
                    session_id,
                    cols,
                    rows,
                }) => {
                    let _ = pty.resize(&session_id, cols, rows);
                }
                None => {}
            },
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }

        // 2. Flush any buffered PTY output for the attached session.
        if let Some((_, _, rx)) = attached.as_ref() {
            for _ in 0..DRAIN_PER_TICK {
                match rx.try_recv() {
                    Ok(frame) => {
                        if ws
                            .send(Message::Text(
                                json!({ "type": "output", "data": frame }).to_string(),
                            ))
                            .is_err()
                        {
                            bus.unsubscribe(bus_id);
                            detach(&pty, &attached);
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
        }

        // 3. Forward hook status events (filtered to the attached session).
        if let Some((sid, _, _)) = attached.as_ref() {
            for _ in 0..DRAIN_PER_TICK {
                match bus_rx.try_recv() {
                    Ok(ev) if &ev.session == sid => {
                        if ws
                            .send(Message::Text(
                                status_payload(&ev.event, &ev.body).to_string(),
                            ))
                            .is_err()
                        {
                            bus.unsubscribe(bus_id);
                            detach(&pty, &attached);
                            return;
                        }
                    }
                    Ok(_) => {} // event for another session; ignore
                    Err(_) => break,
                }
            }
        } else {
            // Not attached: drain-and-discard so the bus buffer can't back up.
            while bus_rx.try_recv().is_ok() {}
        }

        // 4. Tail the transcript for appended lines -> chat items.
        if let Some((path, cursor)) = transcript.as_mut() {
            let lines = read_lines(path);
            if lines.len() > *cursor {
                for line in &lines[*cursor..] {
                    for item in crate::transcript::parse_line(line) {
                        let _ = ws.send(Message::Text(
                            json!({ "type": "chat", "item": item }).to_string(),
                        ));
                    }
                }
                *cursor = lines.len();
            }
        }
    }

    bus.unsubscribe(bus_id);
    detach(&pty, &attached);
}

fn detach(
    pty: &Arc<PtyManager>,
    attached: &Option<(String, u64, std::sync::mpsc::Receiver<String>)>,
) {
    if let Some((session_id, sub_id, _)) = attached {
        pty.unsubscribe(session_id, *sub_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_message_marks_running_sessions() {
        let projects = vec![serde_json::json!({
            "id": "p1", "name": "Conduit", "path": "/repo",
            "sessions": [ { "id": "s1", "name": "auth", "branch": "feat/x", "agent": "claude" } ]
        })];
        let running: std::collections::HashSet<String> = ["s1".to_string()].into_iter().collect();
        let msg = projects_payload(&projects, &running);
        assert_eq!(msg["type"], "projects");
        assert_eq!(msg["projects"][0]["sessions"][0]["running"], true);
    }

    #[test]
    fn status_message_shape() {
        let msg = status_payload("pretool", &serde_json::json!({ "tool_name": "Bash" }));
        assert_eq!(msg["type"], "status");
        assert_eq!(msg["event"], "pretool");
        assert_eq!(msg["body"]["tool_name"], "Bash");
    }

    #[test]
    fn history_payload_flattens_items() {
        let lines = vec![
            serde_json::json!({"type":"user","message":{"role":"user","content":"hi"}}).to_string(),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"yo"}]}})
                .to_string(),
        ];
        let msg = history_payload(&lines);
        assert_eq!(msg["type"], "history");
        assert_eq!(msg["items"].as_array().unwrap().len(), 2);
        assert_eq!(msg["items"][0]["role"], "user");
    }

    #[test]
    fn parses_list() {
        assert_eq!(
            parse_client_msg(r#"{"type":"list"}"#),
            Some(ClientMsg::List)
        );
    }

    #[test]
    fn parses_attach() {
        assert_eq!(
            parse_client_msg(r#"{"type":"attach","session_id":"s1"}"#),
            Some(ClientMsg::Attach {
                session_id: "s1".into()
            })
        );
    }

    #[test]
    fn parses_input_raw_string() {
        assert_eq!(
            parse_client_msg(r#"{"type":"input","session_id":"s1","data":"ls\r"}"#),
            Some(ClientMsg::Input {
                session_id: "s1".into(),
                data: "ls\r".into()
            })
        );
    }

    #[test]
    fn parses_resize() {
        assert_eq!(
            parse_client_msg(r#"{"type":"resize","session_id":"s1","cols":80,"rows":24}"#),
            Some(ClientMsg::Resize {
                session_id: "s1".into(),
                cols: 80,
                rows: 24
            })
        );
    }

    #[test]
    fn rejects_garbage_and_unknown_type() {
        assert!(parse_client_msg("not json").is_none());
        assert!(parse_client_msg(r#"{"type":"explode"}"#).is_none());
    }

    #[test]
    fn extracts_token_from_query() {
        assert_eq!(extract_query_token("token=abc123"), Some("abc123".into()));
        assert_eq!(
            extract_query_token("foo=1&token=xyz&bar=2"),
            Some("xyz".into())
        );
        assert_eq!(extract_query_token("foo=1&bar=2"), None);
        assert_eq!(extract_query_token(""), None);
    }

    #[test]
    fn token_ok_requires_exact_match() {
        assert!(token_ok(Some("token=secret"), "secret"));
        assert!(!token_ok(Some("token=wrong"), "secret"));
        assert!(!token_ok(Some("nottoken=secret"), "secret"));
        assert!(!token_ok(None, "secret"));
    }

    #[test]
    fn host_is_lan_only_when_token_set() {
        assert_eq!(bridge_host(&Some("t".to_string())), "0.0.0.0");
        assert_eq!(bridge_host(&None), "127.0.0.1");
    }
}
