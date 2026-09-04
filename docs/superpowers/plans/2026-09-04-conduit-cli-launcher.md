# Conduit CLI Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `conduit .` opens the current directory as a project in the running Conduit, and `conduit . --agent claude` also starts one new session — installed from Settings, authenticated, and covered end-to-end.

**Architecture:** One new HTTP route (`/open`) on the hook server that already runs and already publishes its port; one new Tauri event (`cli-open`) consumed by a listener in `App.tsx` beside the five that exist; one shim script whose text is a Rust constant, written to disk by a Settings action. The route's handler takes a *sink* rather than an `AppHandle`, which is what lets a test drive the real handler with a real shim process over a real socket.

**Tech Stack:** Rust (`tiny_http`, `serde_json`, `uuid`), React 19 + Zustand, POSIX `sh` and `cmd.exe` for the shim, vitest, `@wdio/tauri-service` for the GUI layer.

**Spec:** `docs/superpowers/specs/2026-09-04-conduit-cli-launcher-design.md`

## Global Constraints

- **No new HTTP client dependency.** The lean-dependency rule stands; the shim uses `curl` (built into macOS and into Windows since 1803), and the server side is the `tiny_http` instance already running.
- **No new random-number crate.** The token is two `uuid::Uuid::new_v4()` simple-hex values concatenated — 256 bits from a dependency already in the tree.
- **`/open` is not `/hook`.** Three independent layers: `X-Conduit-Token` header, rejection of any request carrying `Origin`, and no answer to CORS preflight. All three, or the task is not done.
- **Every path-taking function used by tests takes its directory as a parameter.** `data_dir()` reads the real home; a test that writes there is not hermetic. Thin wrappers supply `store::data_dir()` in production.
- **`cargo clippy --all-targets -- -D warnings` must pass**, and it lints `src-tauri/tests/` too.
- **Both CI legs compile different programs.** Every `#[cfg(windows)]` arm is only ever checked by the Windows leg.
- **Never add an AI attribution trailer to a commit.**
- Ship as **0.35.0** across `package.json`, `src-tauri/Cargo.toml` (line 3), `src-tauri/tauri.conf.json`, with a `CHANGELOG.md` entry.

## File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/src/cli_open.rs` (new) | The `/open` route: token file, request parsing, auth rejection, `handle_open` with a sink. Knows nothing about Tauri. |
| `src-tauri/src/cli_shim.rs` (new) | The shim's text for both platforms, and install / remove / status on disk. |
| `src-tauri/src/hooks.rs` | Registers the route on the existing server; writes the token beside the endpoint file. |
| `src-tauri/src/lib.rs` | `pub mod` the two new modules; three new commands; plugin registration behind the `wdio` feature. |
| `src-tauri/tests/cli_open.rs` (new) | End-to-end: real shim process → real socket → real handler. |
| `src/cliOpen.ts` (new) | `matchProjectByPath` — pure, so it is testable without `store.ts`. |
| `src/cliOpen.test.ts` (new) | Its tests. |
| `src/App.tsx` | The `cli-open` listener. |
| `src/components/GeneralSettings.tsx` | The install / remove row. |
| `e2e/` (new) | WebdriverIO specs driving the built app. |
| `.github/workflows/e2e.yml` (new) | The GUI layer, on `workflow_dispatch` + pushes to `main`. |

---

### Task 1: The `/open` route's pure core

**Files:**
- Create: `src-tauri/src/cli_open.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod cli_open;` beside the other `mod` lines)

**Interfaces:**
- Produces: `OpenRequest { path: String, agent: Option<String> }`; `Reject` enum; `parse_open(headers: &[(String, String)], body: &str, expected: &str) -> Result<OpenRequest, Reject>`; `token_file_path_in(dir: &Path) -> PathBuf`; `write_token_file_in(dir: &Path) -> String`; `write_token_file() -> String`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn hdrs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    const TOK: &str = "abc123";

    #[test]
    fn accepts_a_well_formed_request() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        let got = parse_open(&h, r#"{"path":"/tmp/p","agent":"claude"}"#, TOK).unwrap();
        assert_eq!(got, OpenRequest { path: "/tmp/p".into(), agent: Some("claude".into()) });
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
        assert_eq!(parse_open(&hdrs(&[]), r#"{"path":"/p"}"#, TOK), Err(Reject::BadToken));
        let h = hdrs(&[("X-Conduit-Token", "nope")]);
        assert_eq!(parse_open(&h, r#"{"path":"/p"}"#, TOK), Err(Reject::BadToken));
    }

    /// A browser cannot suppress Origin on a cross-origin request, and a shell client
    /// never sends one. Checked BEFORE the token so a page cannot probe token validity.
    #[test]
    fn rejects_anything_carrying_origin() {
        let h = hdrs(&[("X-Conduit-Token", TOK), ("Origin", "https://evil.example")]);
        assert_eq!(parse_open(&h, r#"{"path":"/p"}"#, TOK), Err(Reject::BrowserOrigin));
        let h = hdrs(&[("origin", "null"), ("X-Conduit-Token", TOK)]);
        assert_eq!(parse_open(&h, r#"{"path":"/p"}"#, TOK), Err(Reject::BrowserOrigin));
    }

    #[test]
    fn rejects_a_bad_body() {
        let h = hdrs(&[("X-Conduit-Token", TOK)]);
        assert_eq!(parse_open(&h, "not json", TOK), Err(Reject::BadBody));
        assert_eq!(parse_open(&h, r#"{"path":""}"#, TOK), Err(Reject::BadBody));
        assert_eq!(parse_open(&h, r#"{"agent":"claude"}"#, TOK), Err(Reject::BadBody));
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
        std::fs::create_dir_all(&dir).unwrap();
        let a = write_token_file_in(&dir);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(std::fs::read_to_string(token_file_path_in(&dir)).unwrap().trim(), a);
        // Regenerated per boot: a token read from a backup is worthless.
        assert_ne!(a, write_token_file_in(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("conduit-tok-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        write_token_file_in(&dir);
        let mode = std::fs::metadata(token_file_path_in(&dir)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "token file must not be group/world readable");
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_open`
Expected: FAIL — `cannot find function parse_open`.

- [ ] **Step 3: Write the implementation**

```rust
//! The `conduit` CLI launcher's HTTP entry point.
//!
//! `hooks.rs` documents its own bodies as untrusted, unauthenticated localhost
//! display-data on which no security decision keys. `/open` is the opposite: it adds
//! an arbitrary directory as a project and can start an agent inside it, so a spoofed
//! post is an agent running against a directory of the caller's choosing. Hence three
//! independent layers here — a per-boot token, an `Origin` refusal, and (in
//! `hooks.rs`) never answering a CORS preflight.
//!
//! Nothing in this module touches Tauri. `handle_open` takes a sink, which is what
//! lets `tests/cli_open.rs` drive the real handler with a real shim process.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tiny_http::{Request, Response};

/// The header carrying the CLI token. Not a CORS-safelisted name, deliberately: a
/// browser must preflight before it can send this, and we never answer a preflight.
pub const TOKEN_HEADER: &str = "x-conduit-token";

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
/// Two v4 UUIDs rather than a `rand` dependency — `uuid` is already in the tree and
/// v4 is CSPRNG-backed. Regenerated on every boot, so a token captured from a backup
/// or an old shell's scrollback is already dead.
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

/// Authenticate and parse one `/open` request. Pure — no IO, no Tauri.
pub fn parse_open(
    headers: &[(String, String)],
    body: &str,
    expected: &str,
) -> Result<OpenRequest, Reject> {
    // Origin first: a page must not be able to use this route as a token oracle.
    if headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("origin")) {
        return Err(Reject::BrowserOrigin);
    }
    let supplied = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(TOKEN_HEADER))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    // An empty expected token means the boot-time write failed. Shut, not open.
    if expected.is_empty() || !secret_eq(supplied, expected) {
        return Err(Reject::BadToken);
    }
    let req: OpenRequest = serde_json::from_str(body).map_err(|_| Reject::BadBody)?;
    if req.path.trim().is_empty() {
        return Err(Reject::BadBody);
    }
    Ok(req)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_open`
Expected: PASS, 9 tests (8 on Windows — the permissions test is `#[cfg(unix)]`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli_open.rs src-tauri/src/lib.rs
git commit -m "feat(cli): parse and authenticate /open requests

Three layers, all required, because unlike /hook this route can start an
agent against an arbitrary directory: a per-boot 256-bit token in a
non-safelisted header, refusal of anything carrying Origin (checked first,
so the route is not a token oracle), and an empty expected token failing
shut rather than open."
```

---

### Task 2: `handle_open` and the sink

**Files:**
- Modify: `src-tauri/src/cli_open.rs`

**Interfaces:**
- Consumes: `parse_open`, `OpenRequest`, `Reject` (Task 1).
- Produces: `pub fn handle_open<F: FnOnce(OpenRequest)>(request: Request, expected: &str, sink: F)`.

- [ ] **Step 1: Write the failing test**

Append to `mod tests`:

```rust
/// Serve exactly one request against a real socket, and report what the sink saw.
fn serve_one(port_out: &std::sync::mpsc::Sender<u16>, token: String)
    -> std::sync::mpsc::Receiver<OpenRequest>
{
    let (tx, rx) = std::sync::mpsc::channel();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    port_out.send(server.server_addr().to_ip().unwrap().port()).unwrap();
    std::thread::spawn(move || {
        if let Ok(req) = server.recv() {
            let tx = tx.clone();
            handle_open(req, &token, move |o| { let _ = tx.send(o); });
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
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
               "-H", &format!("X-Conduit-Token: {TOK}"),
               "--data", r#"{"path":"/tmp/p","agent":"claude"}"#,
               &format!("http://127.0.0.1:{port}/open")])
        .output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "200");
    let got = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(got.path, "/tmp/p");
    assert_eq!(got.agent.as_deref(), Some("claude"));
}

#[test]
fn handle_open_answers_403_and_never_fires_the_sink_without_a_token() {
    let (ptx, prx) = std::sync::mpsc::channel();
    let rx = serve_one(&ptx, TOK.to_string());
    let port = prx.recv().unwrap();

    let out = std::process::Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
               "--data", r#"{"path":"/tmp/p"}"#,
               &format!("http://127.0.0.1:{port}/open")])
        .output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "403");
    assert!(rx.recv_timeout(std::time::Duration::from_millis(300)).is_err());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_open::tests::handle_open`
Expected: FAIL — `cannot find function handle_open`.

- [ ] **Step 3: Write the implementation**

```rust
/// Cap the body so a runaway or hostile POST cannot exhaust memory — same reasoning
/// as the hook loop's 1 MB cap, tighter because an open request is a path and a word.
const MAX_BODY: u64 = 64 * 1024;

/// Handle one `/open`. On success the sink runs BEFORE the response is written, so a
/// shim that waits for 200 knows the app has already acted.
pub fn handle_open<F: FnOnce(OpenRequest)>(mut request: Request, expected: &str, sink: F) {
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|h| (h.field.as_str().as_str().to_string(), h.value.as_str().to_string()))
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_open`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli_open.rs
git commit -m "feat(cli): serve /open through a sink

The handler takes a sink rather than an AppHandle so the real handler can be
driven over a real socket in a test. The sink runs before the response is
written, so a shim that waits for 200 knows the app has already acted."
```

---

### Task 3: The shim's text

**Files:**
- Create: `src-tauri/src/cli_shim.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod cli_shim;`)

**Interfaces:**
- Produces: `SHIM_MARKER: &str`; `shim_sh() -> String`; `shim_cmd() -> String`; `shim_text() -> String` (platform-appropriate); `shim_file_name() -> &'static str`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shim_carries_the_marker_so_remove_never_deletes_a_strangers_binary() {
        assert!(shim_sh().contains(SHIM_MARKER));
        assert!(shim_cmd().contains(SHIM_MARKER));
    }

    #[test]
    fn sh_shim_resolves_the_data_dir_exactly_as_store_data_dir_does() {
        let s = shim_sh();
        assert!(s.contains("${CONDUIT_DATA_DIR_NAME:-ConduitTauri}"));
        assert!(s.contains("Library/Application Support"), "macOS base missing");
        assert!(s.contains("XDG_DATA_HOME"), "Linux base missing");
    }

    #[test]
    fn cmd_shim_uses_appdata_because_dirs_data_dir_is_roaming_on_windows() {
        let s = shim_cmd();
        assert!(s.contains("%APPDATA%"));
        assert!(!s.contains("%LOCALAPPDATA%\\ConduitTauri"), "wrong roaming/local root");
    }

    #[test]
    fn shims_read_the_published_port_and_the_token() {
        for s in [shim_sh(), shim_cmd()] {
            assert!(s.contains("hook-endpoint.sh"), "port discovery missing");
            assert!(s.contains("cli-token"), "token read missing");
            assert!(s.contains("X-Conduit-Token"), "token header missing");
            assert!(s.contains("/open"), "route missing");
        }
    }

    /// A dev build is started from a terminal by `pnpm tauri dev`; there is no bundle
    /// to launch. Cold-launching the INSTALLED app there is the state.json clobber
    /// CLAUDE.md warns about, so an explicit data dir must fail instead.
    #[test]
    fn sh_shim_refuses_to_cold_launch_when_a_dev_data_dir_is_named() {
        let s = shim_sh();
        let cold = s.split("cold_start()").nth(1).expect("cold_start missing");
        let guard = cold.find("CONDUIT_DATA_DIR_NAME").expect("dev guard missing");
        let launch = cold.find("open -b").expect("bundle launch missing");
        assert!(guard < launch, "the dev guard must precede the bundle launch");
    }

    #[test]
    fn sh_shim_escapes_the_path_into_json() {
        // A directory may legitimately contain a quote or a backslash.
        assert!(shim_sh().contains(r#"s/\\/\\\\/g"#), "backslash escape missing");
    }

    #[test]
    fn shim_text_matches_the_platform() {
        #[cfg(windows)]
        {
            assert_eq!(shim_file_name(), "conduit.cmd");
            assert!(shim_text().contains("%APPDATA%"));
        }
        #[cfg(not(windows))]
        {
            assert_eq!(shim_file_name(), "conduit");
            assert!(shim_text().starts_with("#!/bin/sh"));
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_shim`
Expected: FAIL — `cannot find function shim_sh`.

- [ ] **Step 3: Write the implementation**

```rust
//! The `conduit` command's text, and putting it on disk.
//!
//! The shim is GENERATED, not bundled. Tauri's resource bundler does not reliably
//! preserve the executable bit, and Windows needs different content anyway; writing it
//! from Rust gives one code path that knows both the text and the mode. It keeps the
//! property bundling was for — the installed app is what wrote it, so it cannot drift
//! from the app version — and it matches how `hooks.rs` already generates its scripts.

use std::fs;
use std::path::{Path, PathBuf};

/// Present in every generated shim. `remove` refuses to delete a file without it, so
/// it can never destroy an unrelated `conduit` the user put on PATH themselves.
pub const SHIM_MARKER: &str = "conduit-cli-shim-v1";

pub fn shim_file_name() -> &'static str {
    if cfg!(windows) {
        "conduit.cmd"
    } else {
        "conduit"
    }
}

pub fn shim_text() -> String {
    if cfg!(windows) {
        shim_cmd()
    } else {
        shim_sh()
    }
}

pub fn shim_sh() -> String {
    format!(
        r##"#!/bin/sh
# {SHIM_MARKER} — generated by Conduit. Do not edit; reinstall from Settings.
set -eu

usage() {{ echo "usage: conduit <path> [--agent <id>]" >&2; exit 2; }}

target=""
agent=""
while [ $# -gt 0 ]; do
  case "$1" in
    -a|--agent) [ $# -ge 2 ] || usage; agent="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "conduit: unknown option $1" >&2; usage ;;
    *) [ -z "$target" ] || usage; target="$1"; shift ;;
  esac
done
[ -n "$target" ] || target="."
[ -d "$target" ] || {{ echo "conduit: not a directory: $target" >&2; exit 1; }}
# Resolve symlinks so a checkout reached through a link is not added twice.
path=$(cd "$target" && pwd -P)

name="${{CONDUIT_DATA_DIR_NAME:-ConduitTauri}}"
case "$(uname -s)" in
  Darwin) base="$HOME/Library/Application Support" ;;
  *) base="${{XDG_DATA_HOME:-$HOME/.local/share}}" ;;
esac
dir="$base/$name"

esc=$(printf '%s' "$path" | sed 's/\\/\\\\/g; s/"/\\"/g')
if [ -n "$agent" ]; then
  body="{{\"path\":\"$esc\",\"agent\":\"$agent\"}}"
else
  body="{{\"path\":\"$esc\"}}"
fi

post() {{
  [ -f "$dir/hook-endpoint.sh" ] || return 1
  [ -f "$dir/cli-token" ] || return 1
  # One KEY=value line, sourced not executed — same contract hooks.rs writes it under.
  . "$dir/hook-endpoint.sh"
  [ -n "${{CONDUIT_HOOK_PORT:-}}" ] || return 1
  token=$(cat "$dir/cli-token")
  curl -sf -m 5 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Conduit-Token: $token" \
    --data "$body" \
    "http://127.0.0.1:$CONDUIT_HOOK_PORT/open" >/dev/null 2>&1
}}

cold_start() {{
  if [ -n "${{CONDUIT_DATA_DIR_NAME:-}}" ]; then
    echo "conduit: no Conduit answering for CONDUIT_DATA_DIR_NAME=$CONDUIT_DATA_DIR_NAME." >&2
    echo "conduit: start it with 'CONDUIT_DATA_DIR_NAME=$CONDUIT_DATA_DIR_NAME pnpm tauri dev'." >&2
    exit 1
  fi
  case "$(uname -s)" in
    Darwin) open -b com.conduit.tauri >/dev/null 2>&1 || {{
              echo "conduit: could not launch Conduit." >&2; exit 1; }} ;;
    *) echo "conduit: Conduit is not running, and this platform has no bundle to launch." >&2
       exit 1 ;;
  esac
  n=0
  while [ $n -lt 30 ]; do
    # Re-read every attempt: the port is only published once the server binds.
    if post; then return 0; fi
    n=$((n + 1))
    sleep 0.5
  done
  echo "conduit: Conduit did not come up in time." >&2
  exit 1
}}

post || cold_start
"##
    )
}

pub fn shim_cmd() -> String {
    format!(
        r##"@echo off
rem {SHIM_MARKER} — generated by Conduit. Do not edit; reinstall from Settings.
setlocal enabledelayedexpansion

set "target="
set "agent="
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="-a" (set "agent=%~2" & shift & shift & goto parse)
if /i "%~1"=="--agent" (set "agent=%~2" & shift & shift & goto parse)
set "target=%~1"
shift
goto parse
:parsed
if "%target%"=="" set "target=."
if not exist "%target%\" (echo conduit: not a directory: %target% 1>&2 & exit /b 1)
for %%I in ("%target%") do set "path_abs=%%~fI"

rem dirs::data_dir() is the ROAMING app data folder on Windows, not Local.
set "name=%CONDUIT_DATA_DIR_NAME%"
if "%name%"=="" set "name=ConduitTauri"
set "dir=%APPDATA%\%name%"

set "port="
if exist "%dir%\hook-endpoint.sh" (
  for /f "usebackq tokens=2 delims==" %%a in ("%dir%\hook-endpoint.sh") do set "port=%%a"
)
set "token="
if exist "%dir%\cli-token" (
  for /f "usebackq delims=" %%a in ("%dir%\cli-token") do set "token=%%a"
)

set "esc=%path_abs:\=\\%"
if "%agent%"=="" (
  set "body={{\"path\":\"!esc!\"}}"
) else (
  set "body={{\"path\":\"!esc!\",\"agent\":\"%agent%\"}}"
)

if not "%port%"=="" if not "%token%"=="" (
  curl.exe -sf -m 5 -X POST -H "Content-Type: application/json" ^
    -H "X-Conduit-Token: %token%" --data "!body!" ^
    "http://127.0.0.1:%port%/open" >nul 2>&1
  if not errorlevel 1 exit /b 0
)

if not "%CONDUIT_DATA_DIR_NAME%"=="" (
  echo conduit: no Conduit answering for CONDUIT_DATA_DIR_NAME=%CONDUIT_DATA_DIR_NAME%. 1>&2
  exit /b 1
)
echo conduit: Conduit is not running. Start it and try again. 1>&2
exit /b 1
"##
    )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_shim`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli_shim.rs src-tauri/src/lib.rs
git commit -m "feat(cli): generate the conduit shim for both platforms

Generated rather than bundled: the resource bundler does not reliably keep
the executable bit and Windows needs different text anyway. Resolves its
data dir exactly as store::data_dir does, and refuses to cold-launch the
installed app when CONDUIT_DATA_DIR_NAME names a dev build."
```

---

### Task 4: Installing and removing the shim

**Files:**
- Modify: `src-tauri/src/cli_shim.rs`

**Interfaces:**
- Produces: `ShimStatus { installed: bool, path: Option<String>, dir: Option<String>, on_path: bool }`; `install_in(bin_dir: &Path) -> Result<(), String>`; `install() -> Result<ShimStatus, String>`; `remove() -> Result<ShimStatus, String>`; `status() -> ShimStatus`.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests`:

```rust
fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("conduit-shim-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn install_writes_the_shim_and_reports_it() {
    let dir = tmp();
    install_in(&dir).unwrap();
    let file = dir.join(shim_file_name());
    assert!(fs::read_to_string(&file).unwrap().contains(SHIM_MARKER));
    assert!(status_in(&dir).installed);
    fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn installed_shim_is_executable() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tmp();
    install_in(&dir).unwrap();
    let mode = fs::metadata(dir.join(shim_file_name())).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o755);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn install_is_idempotent_and_rewrites_stale_text() {
    let dir = tmp();
    fs::write(dir.join(shim_file_name()), format!("#!/bin/sh\n# {SHIM_MARKER}\nexit 9\n")).unwrap();
    install_in(&dir).unwrap();
    assert!(fs::read_to_string(dir.join(shim_file_name())).unwrap().contains("/open"));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn remove_deletes_our_shim() {
    let dir = tmp();
    install_in(&dir).unwrap();
    remove_in(&dir).unwrap();
    assert!(!status_in(&dir).installed);
    fs::remove_dir_all(&dir).ok();
}

/// The whole reason the marker exists.
#[test]
fn remove_refuses_a_file_we_did_not_write() {
    let dir = tmp();
    let file = dir.join(shim_file_name());
    fs::write(&file, "#!/bin/sh\necho someone elses conduit\n").unwrap();
    assert!(remove_in(&dir).is_err());
    assert!(file.exists(), "must not delete a stranger's binary");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn status_reports_absent_cleanly() {
    let dir = tmp();
    let s = status_in(&dir);
    assert!(!s.installed);
    assert_eq!(s.path, None);
    fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_shim`
Expected: FAIL — `cannot find function install_in`.

- [ ] **Step 3: Write the implementation**

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShimStatus {
    pub installed: bool,
    /// Absolute path of the installed shim, when installed.
    pub path: Option<String>,
    /// The directory it went into — shown so the user can add it to PATH if needed.
    pub dir: Option<String>,
    /// Whether `dir` is already on this process's PATH.
    pub on_path: bool,
}

/// Where the shim goes. `/usr/local/bin` when it exists and is writable, else
/// `~/.local/bin`. `/usr/local/bin` does NOT exist on a clean macOS, and assuming it
/// does fails on exactly the machines least able to debug it.
pub fn install_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::data_local_dir().unwrap_or_else(std::env::temp_dir));
        base.join("Conduit").join("bin")
    }
    #[cfg(not(windows))]
    {
        let usr = PathBuf::from("/usr/local/bin");
        let writable = usr.is_dir()
            && fs::OpenOptions::new()
                .append(true)
                .open(usr.join(".conduit-write-probe"))
                .map(|_| true)
                .unwrap_or_else(|_| {
                    // The probe file does not exist; a create attempt is the real test.
                    match fs::File::create(usr.join(".conduit-write-probe")) {
                        Ok(_) => {
                            let _ = fs::remove_file(usr.join(".conduit-write-probe"));
                            true
                        }
                        Err(_) => false,
                    }
                });
        if writable {
            usr
        } else {
            dirs::home_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join(".local")
                .join("bin")
        }
    }
}

fn dir_on_path(dir: &Path) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|e| e == dir))
        .unwrap_or(false)
}

pub fn status_in(dir: &Path) -> ShimStatus {
    let file = dir.join(shim_file_name());
    let ours = fs::read_to_string(&file)
        .map(|t| t.contains(SHIM_MARKER))
        .unwrap_or(false);
    ShimStatus {
        installed: ours,
        path: ours.then(|| file.to_string_lossy().into_owned()),
        dir: Some(dir.to_string_lossy().into_owned()),
        on_path: dir_on_path(dir),
    }
}

pub fn status() -> ShimStatus {
    status_in(&install_dir())
}

pub fn install_in(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let file = dir.join(shim_file_name());
    // Refuse to clobber something we did not write — same rule as remove.
    if let Ok(existing) = fs::read_to_string(&file) {
        if !existing.contains(SHIM_MARKER) {
            return Err(format!("{} already exists and was not written by Conduit", file.display()));
        }
    }
    fs::write(&file, shim_text()).map_err(|e| format!("could not write {}: {e}", file.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("could not make {} executable: {e}", file.display()))?;
    }
    Ok(())
}

pub fn remove_in(dir: &Path) -> Result<(), String> {
    let file = dir.join(shim_file_name());
    match fs::read_to_string(&file) {
        Ok(t) if t.contains(SHIM_MARKER) => {
            fs::remove_file(&file).map_err(|e| format!("could not remove {}: {e}", file.display()))
        }
        Ok(_) => Err(format!("{} was not written by Conduit; leaving it alone", file.display())),
        Err(_) => Ok(()),
    }
}

pub fn install() -> Result<ShimStatus, String> {
    let dir = install_dir();
    install_in(&dir)?;
    Ok(status_in(&dir))
}

pub fn remove() -> Result<ShimStatus, String> {
    let dir = install_dir();
    remove_in(&dir)?;
    Ok(status_in(&dir))
}
```

Note on Windows PATH: the installer writes the file and reports `on_path`; it does
**not** edit the user's PATH. `setx` truncates any PATH longer than 1024 characters,
which silently destroys entries — an unacceptable trade for saving one instruction.
The UI tells the user the directory to add.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_shim && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli_shim.rs
git commit -m "feat(cli): install and remove the conduit shim

Falls back from /usr/local/bin (absent on a clean macOS) to ~/.local/bin,
and refuses to write over or delete a conduit that lacks our marker. Does
not edit PATH on Windows: setx truncates a PATH over 1024 chars."
```

---

### Task 5: Wire the route into the running server

**Files:**
- Modify: `src-tauri/src/hooks.rs` (the `start` loop, around `hooks.rs:70`–`105`)
- Modify: `src-tauri/src/lib.rs` (three commands + registration)

**Interfaces:**
- Consumes: `cli_open::{handle_open, write_token_file, OpenRequest}`, `cli_shim::{install, remove, status, ShimStatus}`.
- Produces: the Tauri event `cli-open` with payload `{ path, agent }`; commands `cli_shim_status`, `install_cli_shim`, `remove_cli_shim`.

- [ ] **Step 1: Write the failing test**

In `hooks.rs`'s `mod tests`:

```rust
/// The token must be minted in the same place the port is published, or a session can
/// see a port with no matching token and the CLI is dead until the next boot.
#[test]
fn boot_publishes_the_port_and_the_token_together() {
    let src = include_str!("hooks.rs");
    let start = src.find("write_endpoint_file(state.port").expect("endpoint publish missing");
    let token = src.find("cli_open::write_token_file").expect("token publish missing");
    let loop_at = src.find("for mut request in server.incoming_requests()").unwrap();
    assert!(token < loop_at, "the token must exist before the first request is served");
    assert!(start < loop_at);
}

/// /open must be dispatched before the generic hook parsing, like /approve.
#[test]
fn open_route_is_dispatched_before_hook_parsing() {
    let src = include_str!("hooks.rs");
    let open = src.find(r#"url.starts_with("/open")"#).expect("/open route missing");
    let parse = src.find("let (session, event) = parse_query(&url);").unwrap();
    assert!(open < parse);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks::tests::open_route`
Expected: FAIL — `/open route missing`.

- [ ] **Step 3: Write the implementation**

In `hooks.rs`, after the existing `write_endpoint_file(...)` call:

```rust
        // Mint the CLI token in the same breath as publishing the port: a shim that can
        // read one and not the other is a dead CLI until the next boot.
        let cli_token = Arc::new(crate::cli_open::write_token_file());
```

Inside the request loop, immediately after `let url = request.url().to_string();` and
before the `/approve` block:

```rust
            // The CLI launcher. Unlike every other route here this one ACTS, so it is
            // authenticated (cli_open::parse_open) rather than trusted. Note that the
            // non-POST early return above answers OPTIONS with a bare 200 and no CORS
            // headers — which is exactly the preflight refusal the design relies on.
            if url.starts_with("/open") {
                let app = app.clone();
                let token = cli_token.clone();
                crate::cli_open::handle_open(request, &token, move |open| {
                    // Show AND unminimize AND focus: on macOS an app whose window was
                    // closed is still running, and emitting into a hidden window would
                    // "succeed" while the user saw nothing happen.
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                    let _ = app.emit("cli-open", &open);
                });
                continue;
            }
```

Add `Manager` to the `tauri` import: `use tauri::{AppHandle, Emitter, Manager};`

In `lib.rs`, beside the other commands:

```rust
// ---- CLI launcher --------------------------------------------------------------

#[tauri::command]
fn cli_shim_status() -> cli_shim::ShimStatus {
    cli_shim::status()
}

#[tauri::command]
fn install_cli_shim() -> Result<cli_shim::ShimStatus, String> {
    cli_shim::install()
}

#[tauri::command]
fn remove_cli_shim() -> Result<cli_shim::ShimStatus, String> {
    cli_shim::remove()
}
```

and add `cli_shim_status, install_cli_shim, remove_cli_shim,` to `generate_handler!`.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hooks.rs src-tauri/src/lib.rs
git commit -m "feat(cli): serve /open from the hook server

The token is minted where the port is published, so a shim can never see one
without the other. The route dispatches ahead of hook parsing like /approve,
and the sink shows, unminimizes and focuses the window before emitting —
an app whose window was closed on macOS is still running."
```

---

### Task 6: The frontend listener

**Files:**
- Create: `src/cliOpen.ts`, `src/cliOpen.test.ts`
- Modify: `src/App.tsx`, `src/components/GeneralSettings.tsx`

**Interfaces:**
- Consumes: the `cli-open` event; commands from Task 5.
- Produces: `matchProjectByPath(projects: { id: string; path: string }[], path: string): string | null`.

- [ ] **Step 1: Write the failing test**

`src/cliOpen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchProjectByPath } from "./cliOpen";

const projects = [
  { id: "a", path: "/Users/u/code/alpha" },
  { id: "b", path: "/Users/u/code/beta/" },
];

describe("matchProjectByPath", () => {
  it("finds an exact match", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha")).toBe("a");
  });

  it("ignores a trailing slash on either side", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha/")).toBe("a");
    expect(matchProjectByPath(projects, "/Users/u/code/beta")).toBe("b");
  });

  it("returns null when nothing matches, so the caller adds the project", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/gamma")).toBeNull();
  });

  it("does not treat a prefix as a match", () => {
    expect(matchProjectByPath(projects, "/Users/u/code/alpha-2")).toBeNull();
    expect(matchProjectByPath(projects, "/Users/u/code")).toBeNull();
  });

  it("never matches an empty path", () => {
    expect(matchProjectByPath(projects, "")).toBeNull();
    expect(matchProjectByPath(projects, "/")).toBeNull();
  });

  it("compares Windows paths case-insensitively and normalizes separators", () => {
    const win = [{ id: "w", path: "C:\\Users\\u\\Code\\Alpha" }];
    expect(matchProjectByPath(win, "c:/users/u/code/alpha")).toBe("w");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- cliOpen`
Expected: FAIL — cannot resolve `./cliOpen`.

- [ ] **Step 3: Write the implementation**

`src/cliOpen.ts`:

```ts
/**
 * Matching a CLI-supplied directory against the open projects.
 *
 * Pure and standalone because `store.ts` cannot be imported under the node-env
 * vitest — it touches `localStorage` at module scope. Same reason `startup.ts` exists.
 *
 * `Store::add_project` does NOT dedupe by path, so without this every `conduit .` on
 * an already-open project would add a second copy of it.
 */

/** Windows paths are case-insensitive and may use either separator. */
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;

function normalize(path: string): string {
  let p = path.trim();
  if (!p) return "";
  if (WINDOWS_PATH.test(p)) p = p.replace(/\\/g, "/").toLowerCase();
  // Strip trailing separators, but never reduce a root to the empty string.
  while (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) p = p.slice(0, -1);
  return p;
}

export function matchProjectByPath(
  projects: { id: string; path: string }[],
  path: string,
): string | null {
  const want = normalize(path);
  if (!want || want === "/") return null;
  return projects.find((p) => normalize(p.path) === want)?.id ?? null;
}
```

In `App.tsx`, beside the existing `bridge-open-session` listener:

```tsx
  // The `conduit` CLI launcher. The Rust side has already focused the window; this
  // owns what the app then shows.
  useEffect(() => {
    const un = listen<{ path: string; agent?: string | null }>("cli-open", ({ payload }) => {
      void (async () => {
        const st = useStore.getState();
        let projectId = matchProjectByPath(st.projects, payload.path);
        if (!projectId) {
          await st.addProject(payload.path);
          projectId = useStore.getState().selectedProjectId;
        } else {
          st.selectProject(projectId);
        }
        // `--agent` creates a session unconditionally; it never resumes an existing
        // one, so its effect never depends on `restoreSessionsOnOpen`.
        if (projectId && payload.agent) {
          await useStore.getState().addSession(projectId, { agent: payload.agent as AgentId });
        }
      })();
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);
```

Import `matchProjectByPath` from `./cliOpen`, and `AgentId` from wherever `App.tsx`
already sources its store types.

In `GeneralSettings.tsx`, add state and a row (place it after the workspace-root
field):

```tsx
  const [shim, setShim] = useState<ShimStatus | null>(null);
  const [shimError, setShimError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<ShimStatus>("cli_shim_status").then(setShim).catch(() => {});
  }, []);

  const runShim = async (cmd: "install_cli_shim" | "remove_cli_shim") => {
    setShimError(null);
    try {
      setShim(await invoke<ShimStatus>(cmd));
    } catch (e) {
      setShimError(String(e));
    }
  };
```

```tsx
      <label className="dialog-toggle">
        <span>
          The <code>conduit</code> command — open a project from your terminal the way{" "}
          <code>code .</code> does. <code>conduit .</code> opens the current folder;{" "}
          <code>conduit . --agent claude</code> also starts one new session in it.
          {shim?.installed && <em className="dialog-hint"> Installed at {shim.path}.</em>}
          {shim?.installed && !shim.onPath && (
            <em className="dialog-hint">
              {" "}
              Add {shim.dir} to your PATH to use it.
            </em>
          )}
          {shimError && <em className="dialog-hint"> {shimError}</em>}
        </span>
        <button onClick={() => void runShim(shim?.installed ? "remove_cli_shim" : "install_cli_shim")}>
          {shim?.installed ? "Remove" : "Install"}
        </button>
      </label>
```

with `type ShimStatus = { installed: boolean; path: string | null; dir: string | null; onPath: boolean };`
declared beside the component, and `invoke` imported from `@tauri-apps/api/core`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- cliOpen && pnpm exec tsc --noEmit && pnpm build`
Expected: PASS, clean typecheck, successful build.

- [ ] **Step 5: Commit**

```bash
git add src/cliOpen.ts src/cliOpen.test.ts src/App.tsx src/components/GeneralSettings.tsx
git commit -m "feat(cli): open the project the CLI names, and install the shim from Settings

Store::add_project does not dedupe by path, so matchProjectByPath is what stops
`conduit .` adding a second copy of an already-open project. It is pure and
standalone because store.ts cannot be imported under the node-env vitest."
```

---

### Task 7: End-to-end — a real shim process against a real handler

**Files:**
- Create: `src-tauri/tests/cli_open.rs`

**Interfaces:**
- Consumes: `conduit_tauri_lib::{cli_open, cli_shim}` — both must be `pub mod` in `lib.rs` (done in Tasks 1 and 3).

- [ ] **Step 1: Write the failing test**

```rust
//! End-to-end for the CLI launcher's own half: the REAL generated shim, executed as a
//! process, against the REAL handler over a REAL socket. Only the sink is a channel
//! instead of a Tauri emit — everything the shim touches is production code.
//!
//! Hermetic: the child gets HOME/APPDATA pointed at a temp tree and its own
//! CONDUIT_DATA_DIR_NAME, so nothing is read from or written to the developer's
//! actual Conduit data directory.

use std::path::{Path, PathBuf};
use std::process::Command;
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
        home.join("Library").join("Application Support").join("ConduitTauri-e2e")
    } else {
        home.join(".local").join("share").join("ConduitTauri-e2e")
    };
    std::fs::create_dir_all(&data_dir).unwrap();
    let bin = home.join("bin");
    cli_shim::install_in(&bin).unwrap();
    let token = cli_open::write_token_file_in(&data_dir);
    Fixture { home, data_dir, bin, token }
}

impl Fixture {
    fn publish_port(&self, port: u16) {
        std::fs::write(
            self.data_dir.join("hook-endpoint.sh"),
            format!("CONDUIT_HOOK_PORT={port}\n"),
        )
        .unwrap();
    }

    fn run(&self, args: &[&str]) -> std::process::Output {
        let mut c = Command::new(self.bin.join(cli_shim::shim_file_name()));
        c.args(args)
            .env("HOME", &self.home)
            .env("APPDATA", self.home.join("Roaming"))
            .env("XDG_DATA_HOME", self.home.join(".local").join("share"))
            .env("CONDUIT_DATA_DIR_NAME", "ConduitTauri-e2e");
        c.output().unwrap()
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
    rx.recv_timeout(Duration::from_secs(10)).expect("no request reached the handler")
}

#[test]
fn opens_the_current_directory() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let project = f.home.join("myproject");
    std::fs::create_dir_all(&project).unwrap();
    let out = Command::new(f.bin.join(cli_shim::shim_file_name()))
        .current_dir(&project)
        .arg(".")
        .env("HOME", &f.home)
        .env("APPDATA", f.home.join("Roaming"))
        .env("XDG_DATA_HOME", f.home.join(".local").join("share"))
        .env("CONDUIT_DATA_DIR_NAME", "ConduitTauri-e2e")
        .output()
        .unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));

    let got = recv(&rx);
    assert!(Path::new(&got.path).ends_with("myproject"), "got {}", got.path);
    assert_eq!(got.agent, None);
}

#[test]
fn passes_the_agent_through() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);
    let project = f.home.join("withagent");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap(), "--agent", "claude"]);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(recv(&rx).agent.as_deref(), Some("claude"));

    let out = f.run(&[project.to_str().unwrap(), "-a", "agy"]);
    assert!(out.status.success());
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
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn a_browser_style_request_is_refused_even_with_the_right_token() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let out = Command::new("curl")
        .args([
            "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
            "-H", &format!("X-Conduit-Token: {}", f.token),
            "-H", "Origin: https://evil.example",
            "--data", r#"{"path":"/tmp/p"}"#,
            &format!("http://127.0.0.1:{port}/open"),
        ])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "403");
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn a_missing_directory_fails_before_any_request() {
    let f = fixture();
    let (port, rx) = serve(f.token.clone());
    f.publish_port(port);

    let out = f.run(&[f.home.join("does-not-exist").to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("not a directory"));
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
}

/// The cold-start guard: with an explicit data dir and nothing listening, the shim
/// must NOT launch the installed app — that is the state.json clobber.
#[test]
fn an_explicit_data_dir_with_no_server_fails_instead_of_launching() {
    let f = fixture();
    // No publish_port, so nothing is listening.
    let project = f.home.join("p");
    std::fs::create_dir_all(&project).unwrap();

    let out = f.run(&[project.to_str().unwrap()]);
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("ConduitTauri-e2e"), "stderr: {err}");
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
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(recv(&rx).path.ends_with(r#"we"ird\dir"#));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test cli_open`
Expected: FAIL — unresolved `conduit_tauri_lib::cli_open` until both modules are `pub mod`.

- [ ] **Step 3: Make it pass**

Confirm `lib.rs` has `pub mod cli_open;` and `pub mod cli_shim;`, and add `uuid` and
`tiny_http` to `[dev-dependencies]` only if they are not already resolvable from the
lib's `[dependencies]` (they are, so no change is expected).

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test cli_open -- --test-threads=4`
Expected: PASS, 7 tests on Unix (6 on Windows).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/cli_open.rs
git commit -m "test(cli): end-to-end from a real shim process to the real handler

Executes the generated shim as a process against a real socket and the real
/open handler; only the sink is a channel. Hermetic — HOME/APPDATA and
CONDUIT_DATA_DIR_NAME point at a temp tree, so it never touches the
developer's own Conduit data directory."
```

---

### Task 8: The GUI end-to-end harness

**Files:**
- Modify: `src-tauri/Cargo.toml` (a `[features]` section and an optional dependency)
- Modify: `src-tauri/src/lib.rs` (feature-gated plugin registration)
- Modify: `src-tauri/capabilities/default.json`
- Modify: `package.json` (devDependency + `test:e2e` script)
- Create: `wdio.conf.ts`, `e2e/cli-launcher.e2e.ts`
- Create: `.github/workflows/e2e.yml`

**Interfaces:**
- Consumes: everything above, through the built app.

- [ ] **Step 1: Write the failing guard test**

In `src-tauri/src/cli_shim.rs`'s `mod tests` (it is the module that already reasons
about what ships):

```rust
/// The embedded WebDriver provider works by running a WebDriver server INSIDE the
/// app. That must never exist in a shipped binary, and "we simply won't pass the
/// flag" is a convention — a convention guarding a remote-control surface should be
/// a check.
#[test]
fn the_release_workflow_never_enables_the_wdio_feature() {
    let release = include_str!("../../.github/workflows/release.yml");
    assert!(
        !release.contains("--features"),
        "release.yml must not pass any cargo feature; the wdio plugin would ship"
    );
    assert!(!release.contains("wdio"), "release.yml must not mention wdio");
}

/// And the gate must be the feature, not `debug_assertions`: the harness launches a
/// BUNDLED app, and bundling goes through a release profile, where debug_assertions
/// is off — the plugin would be absent from the very binary under test.
#[test]
fn the_wdio_plugin_is_gated_on_the_feature() {
    let lib = include_str!("lib.rs");
    assert!(lib.contains(r#"#[cfg(feature = "wdio")]"#), "feature gate missing");
    assert!(
        !lib.contains("debug_assertions)]\n    let builder = builder.plugin(tauri_plugin_wdio"),
        "debug_assertions is the wrong gate here"
    );
    let cargo = include_str!("../Cargo.toml");
    assert!(cargo.contains("[features]"), "features section missing");
    assert!(cargo.contains("wdio = [\"dep:tauri-plugin-wdio-webdriver\"]"));
    assert!(
        cargo.contains("tauri-plugin-wdio-webdriver = { version"),
        "the plugin must be an optional dependency"
    );
    assert!(cargo.contains("optional = true"));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cli_shim::tests::the_`
Expected: FAIL — `features section missing`.

- [ ] **Step 3: Wire the harness**

`src-tauri/Cargo.toml` — add the optional dependency beside the other plugins and a
features section after `[dependencies]`:

```toml
# E2E only, and never in a shipped build: the embedded WebDriver provider runs a
# WebDriver server inside the app, which is a full remote-control surface. Enabled
# solely by `--features wdio` for the e2e workflow; release.yml passes no features,
# and a test in cli_shim.rs asserts that.
tauri-plugin-wdio-webdriver = { version = "0.1", optional = true }

[features]
default = []
wdio = ["dep:tauri-plugin-wdio-webdriver"]
```

`src-tauri/src/lib.rs` — restructure the builder chain so the plugin can be added
conditionally:

```rust
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    #[cfg(feature = "wdio")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        // …the rest of the existing chain, unchanged…
```

`src-tauri/capabilities/default.json` — add `"wdio-webdriver:default"` to
`permissions`. (Tauri ignores a permission whose plugin is absent, so this is safe in
a release build; if the build rejects it, move the permission into a second
capability file gated by the same feature.)

`package.json`:

```json
    "test:e2e": "wdio run wdio.conf.ts"
```

and `"@wdio/tauri-service": "^1"` plus `"@wdio/cli": "^9"` in `devDependencies`.

`wdio.conf.ts`:

```ts
import { platform } from "node:os";

/** Where `pnpm tauri build --debug --features wdio` leaves the binary. */
const binary =
  platform() === "win32"
    ? "./src-tauri/target/debug/conduit-tauri.exe"
    : platform() === "darwin"
      ? "./src-tauri/target/debug/bundle/macos/Conduit.app"
      : "./src-tauri/target/debug/conduit-tauri";

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/**/*.e2e.ts"],
  maxInstances: 1,
  services: ["@wdio/tauri-service"],
  capabilities: [{ browserName: "tauri", "tauri:options": { application: binary } }],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120_000 },
};
```

`e2e/cli-launcher.e2e.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives the REAL app: install the shim through the same command Settings calls,
 * run it, and assert on what the user would see in the sidebar.
 */
describe("the conduit CLI launcher", () => {
  let shim: string;
  let project: string;

  before(async () => {
    const status = await browser.execute(() =>
      // @ts-expect-error — the Tauri bridge is injected into the page.
      window.__TAURI__.core.invoke("install_cli_shim"),
    );
    shim = (status as { path: string }).path;
    project = join(mkdtempSync(join(tmpdir(), "conduit-e2e-")), "demo-project");
    mkdirSync(project, { recursive: true });
  });

  it("adds and selects the project it is pointed at", async () => {
    execFileSync(shim, [project]);
    const row = await $(`aria/demo-project`);
    await expect(row).toBeDisplayed();
  });

  it("does not add the project twice", async () => {
    execFileSync(shim, [project]);
    await browser.waitUntil(async () => (await $$("aria/demo-project")).length === 1, {
      timeout: 10_000,
      timeoutMsg: "the project was added a second time",
    });
  });

  it("--agent starts exactly one session", async () => {
    const before = (await $$(".session-row")).length;
    execFileSync(shim, [project, "--agent", "claude"]);
    await browser.waitUntil(async () => (await $$(".session-row")).length === before + 1, {
      timeout: 30_000,
      timeoutMsg: "no session appeared",
    });
  });

  after(async () => {
    await browser.execute(() =>
      // @ts-expect-error — the Tauri bridge is injected into the page.
      window.__TAURI__.core.invoke("remove_cli_shim"),
    );
  });
});
```

Adjust the two CSS/aria selectors to whatever `Sidebar.tsx` actually renders — read it
before writing them, do not guess.

`.github/workflows/e2e.yml`:

```yaml
name: e2e

# The GUI layer needs a full app build per run — minutes on the macOS universal
# target — so it is a backstop, not a PR gate. The gate that must never regress is
# `cargo test` in ci.yml, which covers the shim-to-handler chain on both platforms.
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  gui:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
      - run: pnpm install --frozen-lockfile
      - run: pnpm tauri build --debug --features wdio
      - run: pnpm test:e2e
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && pnpm exec tsc --noEmit && pnpm tauri build --debug --features wdio && pnpm test:e2e`
Expected: guard tests PASS; the three GUI specs PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/cli_shim.rs \
        src-tauri/capabilities/default.json package.json pnpm-lock.yaml \
        wdio.conf.ts e2e .github/workflows/e2e.yml
git commit -m "test(cli): drive the real app with WebdriverIO

The embedded provider is the only one that works on macOS, and it works by
running a WebDriver server inside the app — so the plugin sits behind an
off-by-default cargo feature rather than debug_assertions, which is off in
the release profile the harness's bundled app is built with. A test asserts
release.yml never passes a feature flag."
```

---

### Task 9: Docs, version, changelog

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add the CLAUDE.md section**

After "Where the terminal's mouse ownership lives", add:

```markdown
## Where the `conduit` CLI lives

`conduit .` opens a project the way `code .` does; `--agent <id>` also starts one new
session. Three parts: `cli_open.rs` (the `/open` route), `cli_shim.rs` (the shim's text
plus install/remove), and one listener in `App.tsx`.

- **`/open` is the one route on the hook server that ACTS**, so it is authenticated
  where `/hook` is explicitly trusted-as-display-data. Three layers: a per-boot 256-bit
  token in `<dataDir>/cli-token` (0600), refusal of any request carrying `Origin`
  (checked FIRST, so the route is not a token oracle), and never answering a CORS
  preflight — which falls out of the loop's non-POST early return. Do not add a route
  next to it that skips these.
- **The handler takes a SINK, not an `AppHandle`.** That is the only reason
  `tests/cli_open.rs` can run the real shim as a process against the real handler.
  Keep it that way.
- **The shim is generated, not bundled** — the resource bundler does not reliably keep
  the executable bit, and Windows needs different text. It resolves its data dir exactly
  as `store::data_dir` does, and **refuses to cold-launch when `CONDUIT_DATA_DIR_NAME`
  is set**: a dev build has no bundle, and launching the installed app there is the
  `state.json` clobber.
- **`Store::add_project` does not dedupe by path**, so `matchProjectByPath`
  (`src/cliOpen.ts`) is load-bearing — without it every `conduit .` on an open project
  adds a duplicate.
- **The `wdio` cargo feature must never be enabled in a release build.** It registers a
  WebDriver server inside the app. `cli_shim.rs` has a test asserting `release.yml`
  passes no `--features`.
```

- [ ] **Step 2: Add the README line**

In the README's feature list, add: *"**`conduit .`** — open a project from your
terminal, like `code .`. Install the command from Settings → General."*

- [ ] **Step 3: Bump the version in all three files**

`package.json`, `src-tauri/tauri.conf.json`, and line 3 of `src-tauri/Cargo.toml` to
`0.35.0`, then `cargo build --manifest-path src-tauri/Cargo.toml` so `Cargo.lock`
updates.

Verify: `grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml`

- [ ] **Step 4: Add the changelog entry**

```markdown
## 0.35.0 — 2026-09-04

- **Added — the `conduit` command.** Open a project from your terminal the way `code .`
  does: `conduit .` opens the current folder, and `conduit . --agent claude` also starts
  one new session in it. If Conduit is not running it launches first. Install the command
  from Settings → General.
```

- [ ] **Step 5: Run the full pre-PR gate and commit**

```bash
pnpm exec tsc --noEmit && pnpm test && pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
git add -A
git commit -m "chore(release): 0.35.0"
```

---

## Self-Review

**Spec coverage.** Command surface → Task 3 (parsing) + Task 6 (semantics). Three-layer
auth → Tasks 1, 2, 5. Generated shim → Task 3. Install ladder → Task 4. Data-dir
targeting and the dev asymmetry → Task 3 (`sh_shim_refuses_to_cold_launch…`) and Task 7
(`an_explicit_data_dir_with_no_server_fails…`). Cold start → Task 3. App side, window
focus, dedupe → Tasks 5 and 6. Windows arm → Task 3, exercised by Task 7 on the Windows
leg. Tier A → Task 7. GUI E2E and the feature gate → Task 8. Manual checklist → lives in
the spec; run before release. Release → Task 9.

**One deliberate deviation from the spec**, recorded here rather than silently: the spec
says the Windows install appends its directory to the user PATH. Task 4 writes the file
and *reports* whether the directory is on PATH instead, because `setx` truncates any PATH
over 1024 characters and silently destroys entries. The spec's Windows paragraph should
be amended to match before this ships.

**Type consistency.** `OpenRequest { path, agent }` is the same shape in `cli_open.rs`,
the `cli-open` event payload, and `App.tsx`. `ShimStatus` fields (`installed`, `path`,
`dir`, `on_path`) are identical in the Rust `Serialize` (camelCase renamed, so `on_path`
crosses as `onPath`, which the TS type in Task 6 uses) and the TS declaration. `shim_file_name`, `install_in`, `remove_in`, `status_in` are used
with the same signatures in Tasks 4 and 7.
