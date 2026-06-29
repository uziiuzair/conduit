//! Mobile bridge — a loopback WebSocket server that mirrors a session's PTY to a
//! remote client and forwards its keystrokes back. M1 binds to 127.0.0.1 only (no
//! pairing, no tunnel) to de-risk live streaming before any mobile/pairing code.
//!
//! WebSocket (not tiny_http like hooks.rs) because terminal I/O is bidirectional and
//! latency-sensitive. Thread-per-connection, matching the hooks server's style.

use std::net::TcpStream;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tungstenite::{accept, Message};

use crate::pty::PtyManager;

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

/// Start the loopback bridge on the first free port in 8455..=8475 (distinct from the
/// hook server's 8423..=8443). Stores the chosen port and logs the ws:// URL.
pub fn start(pty: Arc<PtyManager>, port_out: Arc<AtomicU16>) {
    thread::spawn(move || {
        let mut listener = None;
        for candidate in 8455u16..=8475 {
            if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", candidate)) {
                port_out.store(candidate, Ordering::SeqCst);
                eprintln!("conduit: mobile bridge on ws://127.0.0.1:{candidate}");
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
            let pty = pty.clone();
            thread::spawn(move || handle_conn(stream, pty));
        }
    });
}

fn handle_conn(stream: TcpStream, pty: Arc<PtyManager>) {
    // Handshake blocking, THEN switch to a short read timeout for the poll loop.
    let Ok(mut ws) = accept(stream) else { return };
    if ws.get_ref().set_read_timeout(Some(READ_POLL)).is_err() {
        return;
    }

    // (session_id, subscription id, frame receiver) once attached.
    let mut attached: Option<(String, u64, std::sync::mpsc::Receiver<String>)> = None;

    loop {
        // 1. Read a control message if one is ready (times out quickly otherwise).
        match ws.read() {
            Ok(Message::Text(text)) => match parse_client_msg(&text) {
                Some(ClientMsg::List) => {
                    let ids = pty.session_ids();
                    let _ = ws.send(Message::Text(
                        json!({ "type": "sessions", "sessions": ids }).to_string(),
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
                            detach(&pty, &attached);
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

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
}
