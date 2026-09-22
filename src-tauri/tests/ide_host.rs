//! Integration: a REAL tungstenite client against the REAL per-session IDE server
//! over a REAL socket — auth header, `mcp` subprotocol echo, MCP handshake, and the
//! deferred openDiff answered from another thread, exactly the claude 2.1.267 flow
//! the 2026-09-23 spec pins.

use std::sync::Arc;

use conduit_tauri_lib::ide_host::{IdeEvents, IdeHost};

#[derive(Default)]
struct RecEvents(std::sync::Mutex<Vec<(String, String, serde_json::Value)>>);
impl IdeEvents for RecEvents {
    fn open_diff(&self, session_id: &str, diff_id: &str, args: &serde_json::Value) {
        self.0
            .lock()
            .unwrap()
            .push((session_id.into(), diff_id.into(), args.clone()));
    }
    fn open_file(&self, _session_id: &str, _path: &str) {}
    fn diff_closed(&self, _session_id: &str, _tab_name: Option<&str>) {}
}

fn read_json(ws: &mut tungstenite::WebSocket<std::net::TcpStream>) -> serde_json::Value {
    loop {
        match ws.read().unwrap() {
            tungstenite::Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            tungstenite::Message::Ping(_) => continue,
            m => panic!("unexpected frame: {m:?}"),
        }
    }
}

#[test]
fn full_session_handshake_tools_and_deferred_diff() {
    let tmp = std::env::temp_dir().join(format!("ide-int-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let host = IdeHost::new();
    let events = Arc::new(RecEvents::default());
    let port = host
        .start_for_session("s1", "/w", &tmp, None, events.clone())
        .expect("server started");

    // The token comes from the lock file exactly as claude reads it.
    let lock: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(tmp.join(format!("{port}.lock"))).unwrap())
            .unwrap();
    let token = lock["authToken"].as_str().unwrap().to_string();
    assert_eq!(lock["ideName"], "Conduit");
    assert_eq!(lock["workspaceFolders"], serde_json::json!(["/w"]));

    // No auth header → refused during the HTTP upgrade.
    assert!(
        tungstenite::connect(format!("ws://127.0.0.1:{port}")).is_err(),
        "unauthenticated connect must fail"
    );

    // Proper connect: auth header + `mcp` subprotocol, like claude sends.
    let req = tungstenite::handshake::client::Request::builder()
        .uri(format!("ws://127.0.0.1:{port}"))
        .header("Host", format!("127.0.0.1:{port}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        )
        .header("Sec-WebSocket-Protocol", "mcp")
        .header("X-Claude-Code-Ide-Authorization", &token)
        .body(())
        .unwrap();
    let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let (mut ws, resp) = tungstenite::client(req, stream).unwrap();
    assert_eq!(
        resp.headers()
            .get("Sec-WebSocket-Protocol")
            .map(|v| v.to_str().unwrap()),
        Some("mcp"),
        "server must echo the mcp subprotocol"
    );

    ws.send(tungstenite::Message::Text(
        r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#.into(),
    ))
    .unwrap();
    let r = read_json(&mut ws);
    assert_eq!(r["result"]["serverInfo"]["name"], "Conduit");
    assert_eq!(r["result"]["protocolVersion"], "2025-11-25");

    ws.send(tungstenite::Message::Text(
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.into(),
    ))
    .unwrap();
    let r = read_json(&mut ws);
    assert!(r["result"]["tools"].as_array().unwrap().len() >= 10);

    // openDiff parks; the event fires; resolve_diff(keep) answers two items.
    ws.send(tungstenite::Message::Text(
        r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"openDiff","arguments":{"old_file_path":"/w/x","new_file_path":"/w/x","new_file_contents":"NEW","tab_name":"T"}}}"#.into(),
    ))
    .unwrap();
    let mut waited = 0;
    while events.0.lock().unwrap().is_empty() && waited < 100 {
        std::thread::sleep(std::time::Duration::from_millis(20));
        waited += 1;
    }
    let (sid, diff_id, args) = events.0.lock().unwrap()[0].clone();
    assert_eq!(sid, "s1");
    assert_eq!(args["new_file_contents"], "NEW");
    assert!(host.resolve_diff("s1", &diff_id, true, Some("NEW-EDITED")));
    let r = read_json(&mut ws);
    assert_eq!(r["id"], 7);
    assert_eq!(r["result"]["content"][0]["text"], "FILE_SAVED");
    assert_eq!(r["result"]["content"][1]["text"], "NEW-EDITED");

    // A queued notification reaches the client on the same socket.
    host.at_mention("s1", "/w/lib.rs", 3, 9);
    let n = read_json(&mut ws);
    assert_eq!(n["method"], "at_mentioned");
    assert_eq!(n["params"]["filePath"], "/w/lib.rs");
    assert_eq!(n["params"]["lineStart"], 3);

    // Idempotent restart: same session keeps its port, lock rewritten.
    let again = host
        .start_for_session("s1", "/w2", &tmp, None, events.clone())
        .unwrap();
    assert_eq!(again, port, "live session keeps its port");

    host.stop_for_session("s1");
    assert!(
        !tmp.join(format!("{port}.lock")).exists(),
        "lock removed on stop"
    );
    std::fs::remove_dir_all(&tmp).unwrap();
}

#[test]
fn teardown_rejects_pending_diffs() {
    let tmp = std::env::temp_dir().join(format!("ide-int2-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let host = IdeHost::new();
    let events = Arc::new(RecEvents::default());
    let port = host
        .start_for_session("s2", "/w", &tmp, None, events.clone())
        .unwrap();
    let lock: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(tmp.join(format!("{port}.lock"))).unwrap())
            .unwrap();
    let token = lock["authToken"].as_str().unwrap().to_string();
    let req = tungstenite::handshake::client::Request::builder()
        .uri(format!("ws://127.0.0.1:{port}"))
        .header("Host", format!("127.0.0.1:{port}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        )
        .header("X-Claude-Code-Ide-Authorization", &token)
        .body(())
        .unwrap();
    let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let (mut ws, _) = tungstenite::client(req, stream).unwrap();
    ws.send(tungstenite::Message::Text(
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"openDiff","arguments":{"old_file_path":"/w/y","new_file_path":"/w/y","new_file_contents":"Z","tab_name":"T2"}}}"#.into(),
    ))
    .unwrap();
    let mut waited = 0;
    while events.0.lock().unwrap().is_empty() && waited < 100 {
        std::thread::sleep(std::time::Duration::from_millis(20));
        waited += 1;
    }
    host.reject_all("s2");
    let r = read_json(&mut ws);
    assert_eq!(r["id"], 3);
    assert_eq!(r["result"]["content"][0]["text"], "DIFF_REJECTED");
    host.stop_for_session("s2");
    std::fs::remove_dir_all(&tmp).unwrap();
}
