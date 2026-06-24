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
    Attach { session_id: String },
    Input { session_id: String, data: String },
    Resize { session_id: String, cols: u16, rows: u16 },
}

/// Parse one client text frame. None on malformed JSON or an unknown `type`.
pub fn parse_client_msg(text: &str) -> Option<ClientMsg> {
    serde_json::from_str(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list() {
        assert_eq!(parse_client_msg(r#"{"type":"list"}"#), Some(ClientMsg::List));
    }

    #[test]
    fn parses_attach() {
        assert_eq!(
            parse_client_msg(r#"{"type":"attach","session_id":"s1"}"#),
            Some(ClientMsg::Attach { session_id: "s1".into() })
        );
    }

    #[test]
    fn parses_input_raw_string() {
        assert_eq!(
            parse_client_msg(r#"{"type":"input","session_id":"s1","data":"ls\r"}"#),
            Some(ClientMsg::Input { session_id: "s1".into(), data: "ls\r".into() })
        );
    }

    #[test]
    fn parses_resize() {
        assert_eq!(
            parse_client_msg(r#"{"type":"resize","session_id":"s1","cols":80,"rows":24}"#),
            Some(ClientMsg::Resize { session_id: "s1".into(), cols: 80, rows: 24 })
        );
    }

    #[test]
    fn rejects_garbage_and_unknown_type() {
        assert!(parse_client_msg("not json").is_none());
        assert!(parse_client_msg(r#"{"type":"explode"}"#).is_none());
    }
}
