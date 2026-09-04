//! End-to-end for the CLI launcher's own half: the REAL generated shim, executed as a
//! process, against the REAL handler over a REAL socket. Only the sink is a channel
//! instead of a Tauri emit — everything the shim touches is production code.
//!
//! Hermetic: the child gets HOME/APPDATA/XDG_DATA_HOME pointed at a temp tree and its
//! own CONDUIT_DATA_DIR_NAME, so nothing is read from or written to the developer's
//! actual Conduit data directory.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

use conduit_tauri_lib::cli_open::{self, OpenRequest};
use conduit_tauri_lib::cli_shim;

struct Fixture {
    home: PathBuf,
    data_dir: PathBuf,
    bin: PathBuf,
    token: String,
}

fn fixture() -> Fixture {
    let home = std::env::temp_dir().join(format!("conduit-e2e-{}", uuid::Uuid::new_v4()));
    let data_dir = if cfg!(windows) {
        home.join("Roaming").join("ConduitTauri-e2e")
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("ConduitTauri-e2e")
    } else {
        home.join(".local").join("share").join("ConduitTauri-e2e")
    };
    std::fs::create_dir_all(&data_dir).unwrap();
    let bin = home.join("bin");
    cli_shim::install_in(&bin).unwrap();
    let token = cli_open::write_token_file_in(&data_dir);
    Fixture {
        home,
        data_dir,
        bin,
        token,
    }
}

impl Fixture {
    /// Publish a port the way `hooks::write_endpoint_file` does — one sourced KEY=value.
    fn publish_port(&self, port: u16) {
        std::fs::write(
            self.data_dir.join("hook-endpoint.sh"),
            format!("CONDUIT_HOOK_PORT={port}\n"),
        )
        .unwrap();
    }

    fn shim(&self) -> PathBuf {
        self.bin.join(cli_shim::shim_file_name())
    }

    fn command(&self) -> Command {
        let mut c = Command::new(self.shim());
        c.env("HOME", &self.home)
            .env("APPDATA", self.home.join("Roaming"))
            .env("XDG_DATA_HOME", self.home.join(".local").join("share"))
            .env("CONDUIT_DATA_DIR_NAME", "ConduitTauri-e2e");
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command().args(args).output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.home).ok();
    }
}

/// Serve `/open` forever on an ephemeral port, reporting each accepted request.
fn serve(token: String) -> (u16, Receiver<OpenRequest>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let (tx, rx): (Sender<OpenRequest>, Receiver<OpenRequest>) = channel();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let tx = tx.clone();
            cli_open::handle_open(req, &token, move |o| {
                let _ = tx.send(o);
            });
        }
    });
    (port, rx)
}

fn recv(rx: &Receiver<OpenRequest>) -> OpenRequest {
    rx.recv_timeout(Duration::from_secs(10))
        .expect("no request reached the handler")
}

fn silent(rx: &Receiver<OpenRequest>) {
    assert!(
        rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "the handler acted on a request it should have refused"
    );
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn opens_the_current_directory() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let project = f.home.join("myproject");
    std::fs::create_dir_all(&project).unwrap();
    let out = f.command().current_dir(&project).arg(".").output().unwrap();
    assert!(out.status.success(), "stderr: {}", stderr(&out));

    let got = recv(&rx);
    assert!(
        Path::new(&got.path).ends_with("myproject"),
        "got {}",
        got.path
    );
    assert_eq!(got.agent, None);
}

#[test]
fn a_bare_invocation_defaults_to_the_current_directory() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let project = f.home.join("bare");
    std::fs::create_dir_all(&project).unwrap();
    let out = f.command().current_dir(&project).output().unwrap();
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(Path::new(&recv(&rx).path).ends_with("bare"));
}

#[test]
fn passes_the_agent_through() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("withagent");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap(), "--agent", "claude"]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(recv(&rx).agent.as_deref(), Some("claude"));

    let out = f.run(&[project.to_str().unwrap(), "-a", "agy"]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(recv(&rx).agent.as_deref(), Some("agy"));
}

#[test]
fn a_wrong_token_is_refused_and_the_shim_reports_failure() {
    let f = fixture();
    let (port, rx) = serve("a-different-token".to_string());
    f.publish_port(port);
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap()]);
    assert!(!out.status.success(), "a 403 must not look like success");
    silent(&rx);
}

#[test]
fn a_browser_style_request_is_refused_even_with_the_right_token() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let out = Command::new("curl")
        .args([
            "-s",
            "-o",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
            "-w",
            "%{http_code}",
            "-X",
            "POST",
            "-H",
            &format!("X-Conduit-Token: {}", f.token),
            "-H",
            "Origin: https://evil.example",
            "--data",
            r#"{"path":"/tmp/p"}"#,
            &format!("http://127.0.0.1:{port}/open"),
        ])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "403");
    silent(&rx);
}

#[test]
fn a_missing_directory_fails_before_any_request() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let out = f.run(&[f.home.join("does-not-exist").to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("not a directory"),
        "stderr: {}",
        stderr(&out)
    );
    silent(&rx);
}

/// The cold-start guard: with an explicit data dir and nothing listening, the shim must
/// NOT launch the installed app — that is the state.json clobber CLAUDE.md warns about.
#[test]
fn an_explicit_data_dir_with_no_server_fails_instead_of_launching() {
    let f = fixture();
    // No publish_port, so nothing is listening.
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("ConduitTauri-e2e"),
        "stderr: {}",
        stderr(&out)
    );
}

/// A path containing a quote and a backslash must survive JSON encoding intact.
#[cfg(unix)]
#[test]
fn awkward_path_characters_round_trip() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let project = f.home.join(r#"we"ird\dir"#);
    std::fs::create_dir_all(&project).unwrap();
    let out = f.run(&[project.to_str().unwrap()]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(recv(&rx).path.ends_with(r#"we"ird\dir"#));
}
