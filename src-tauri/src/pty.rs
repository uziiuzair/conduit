//! PTY manager — ports TerminalLauncher.swift.
//!
//! This is the load-bearing subsystem. In the Swift app, SwiftTerm's
//! LocalProcessTerminalView is a single native control that owns the PTY *and*
//! renders it. Tauri splits that in two: Rust owns the PTY (here), the webview's
//! xterm.js owns rendering. Bytes cross the IPC boundary as base64 over a Channel.
//!
//! Keep-alive: each session's PTY (master/writer/child + reader thread) lives in a
//! DashMap and is never torn down on a tab switch — only on explicit `pty_kill`.
//!
//! Re-attach: the reader streams to a *swappable* sink. When the frontend reloads
//! (or a terminal re-mounts), `spawn` for an existing session points the live reader
//! at the new Channel and nudges the winsize to force a full repaint — so reloading
//! the window reconnects to the running `claude` instead of orphaning it.

use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine;
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

type Sink = Arc<Mutex<Channel<String>>>;
type Subscribers = Arc<Mutex<Vec<(u64, SyncSender<String>)>>>;

/// Bounded buffer (frames) per remote subscriber before frames start dropping.
const SUBSCRIBER_BUFFER: usize = 1024;

/// How many recent output bytes to retain per session for `fleet_peek`.
const OUTPUT_RING_BYTES: usize = 64 * 1024;

/// A bounded byte ring buffer of recent PTY output, shared with the reader thread.
/// Backs the Conductor's `fleet_peek` (xterm keeps scrollback in the frontend, so
/// Rust needs its own small tail buffer).
pub struct RingBuffer {
    cap: usize,
    inner: Mutex<VecDeque<u8>>,
}

impl RingBuffer {
    pub fn new(cap: usize) -> Self {
        RingBuffer {
            cap,
            inner: Mutex::new(VecDeque::with_capacity(cap)),
        }
    }

    pub fn push(&self, bytes: &[u8]) {
        let mut q = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        q.extend(bytes.iter().copied());
        while q.len() > self.cap {
            q.pop_front();
        }
    }

    /// Last `max_bytes` of buffered output, lossy-UTF8 and ANSI-stripped.
    pub fn tail_string(&self, max_bytes: usize) -> String {
        let q = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let start = q.len().saturating_sub(max_bytes);
        let bytes: Vec<u8> = q.iter().skip(start).copied().collect();
        strip_ansi(&String::from_utf8_lossy(&bytes))
    }
}

/// Remove ANSI CSI/OSC escape sequences so peeked output is human/agent-readable.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek() {
                Some('[') => {
                    // CSI: ESC [ ... <final byte 0x40-0x7E>
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: ESC ] ... terminated by BEL or ESC \
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if n == '\u{07}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    sink: Sink,
    subscribers: Subscribers,
    next_sub_id: Arc<AtomicU64>,
    /// Current (cols, rows). Desktop-authoritative: updated on every resize, read by a
    /// newly-attached remote viewer so it matches the desktop instead of resizing the
    /// shared PTY out from under it.
    size: Arc<(AtomicU16, AtomicU16)>,
    /// Recent raw output, for the Conductor's `fleet_peek`.
    output: Arc<RingBuffer>,
    /// Feature 4 silo: when true (a siloed session under private mode), output is NOT fanned
    /// out to remote (mobile-bridge) subscribers and new subscriptions are refused. Kept as an
    /// atomic so marking a *running* session sensitive can cut its remote stream immediately.
    suppress_remote: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyManager {
    // Arc so the per-session reader thread can hold a clone and remove its own entry
    // when the child exits on its own (otherwise the dead session leaks forever).
    sessions: Arc<DashMap<String, Mutex<PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
        }
    }

    pub fn has(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        session_id: String,
        working_directory: String,
        cols: u16,
        rows: u16,
        hook_port: u16,
        shell_only: bool,
        worktree_name: Option<String>,
        settings_path: Option<String>,
        mcp_config_path: Option<String>,
        // Continuity (Node-gated): the bundled continuity plugin dir, passed to
        // `claude --plugin-dir <dir>` when Some. Additive only -- None changes nothing.
        plugin_dir: Option<String>,
        system_prompt_file: Option<String>,
        initial_prompt: Option<String>,
        account_config_dir: Option<String>,
        agent: crate::agent::AgentId,
        suppress_remote: bool,
        opencode: Option<crate::agent::OpenCodeSpawnConfig>,
        is_conductor: bool,
        model: Option<String>,
        effort: Option<String>,
        resume_token: Option<String>,
        on_event: Channel<String>,
    ) -> Result<(), String> {
        // Already running → re-attach the live reader to the new channel and force
        // a repaint via a winsize nudge, rather than spawning a second process.
        // Single atomic lookup (no contains_key/get gap that could race kill()).
        if let Some(existing) = self.sessions.get(&session_id) {
            if let Ok(s) = existing.lock() {
                if let Ok(mut sink) = s.sink.lock() {
                    *sink = on_event;
                }
            }
            drop(existing); // release the shard guard before resize re-locks it
            let _ = self.resize(&session_id, cols, rows.saturating_add(1));
            let _ = self.resize(&session_id, cols, rows);
            return Ok(());
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let adapter = crate::agent::adapter_for(agent);

        // Resolve --resume / transcript_exists against the SELECTED account's transcript
        // store (Feature 2 lever), not Conduit's own default env. Falls back to the
        // process-env CLAUDE_CONFIG_DIR / ~/.claude when no account is pinned.
        let projects_dir = account_config_dir
            .as_ref()
            .map(|d| PathBuf::from(d).join("projects"))
            .or_else(claude_projects_dir);

        // Cold spawn only: the re-attach fast-path above returns before reaching here, so
        // a live session is never "resumed" out from under itself. The agent command
        // resumes/pins the session AND applies worktree/settings.
        //
        // Windows: route through cmd.exe -- it resolves the agents' `.cmd` shims via
        // PATHEXT, and `/K` runs our command then keeps the shell interactive (the
        // analogue of the POSIX `exec zsh -i -l` keep-alive). cwd and env are applied
        // natively by CommandBuilder below, so the inner command is just the agent
        // invocation (no `cd`, no `export`), which sidesteps cmd's command-line quoting.
        #[cfg(windows)]
        let mut cmd = {
            let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
            let mut cmd = CommandBuilder::new(shell);
            if !shell_only {
                let inner = build_script_win(
                    adapter.as_ref(),
                    &session_id,
                    worktree_name.as_deref(),
                    settings_path.as_deref(),
                    mcp_config_path.as_deref(),
                    plugin_dir.as_deref(),
                    system_prompt_file.as_deref(),
                    initial_prompt.as_deref(),
                    projects_dir.as_deref(),
                    model.as_deref(),
                    effort.as_deref(),
                    resume_token.as_deref(),
                );
                cmd.args(["/K", inner.as_str()]);
            }
            // shell_only: a bare `cmd.exe` in the cwd is already an interactive shell.
            cmd
        };

        #[cfg(not(windows))]
        let mut cmd = {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let inner = if shell_only {
                format!(
                    "cd {dir} 2>/dev/null; exec {shell} -i -l",
                    dir = shell_quote(&working_directory),
                    shell = shell,
                )
            } else {
                build_script(
                    adapter.as_ref(),
                    &session_id,
                    hook_port,
                    &working_directory,
                    &shell,
                    worktree_name.as_deref(),
                    settings_path.as_deref(),
                    mcp_config_path.as_deref(),
                    plugin_dir.as_deref(),
                    system_prompt_file.as_deref(),
                    initial_prompt.as_deref(),
                    projects_dir.as_deref(),
                    model.as_deref(),
                    effort.as_deref(),
                    resume_token.as_deref(),
                )
            };
            let mut cmd = CommandBuilder::new(&shell);
            cmd.args(["-i", "-l", "-c", inner.as_str()]);
            cmd
        };

        cmd.cwd(&working_directory);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Launching Conduit via a package manager (e.g. `pnpm tauri dev`) leaks
        // `npm_config_prefix` into our env; nvm then refuses to initialize in the
        // login shell ("not compatible with the npm_config_prefix environment
        // variable") and `claude` falls off PATH. Strip it from the child env so the
        // shell's nvm works regardless of how Conduit itself was launched.
        cmd.env_remove("npm_config_prefix");
        // §7.3 research lever: route the CONDUCTOR's native Task subagents (the
        // §3-preferred path over fleet_spawn for homogeneous Claude parallelism) to Haiku
        // -- a documented 40-70% saving on multi-agent workflows. Scoped to the Conductor
        // only; a worker that is itself a specialist may need a stronger subagent model.
        if let Some((k, v)) = subagent_model_env(is_conductor) {
            cmd.env(k, v);
        }
        if !shell_only {
            cmd.env("CONDUIT_SESSION_ID", &session_id);
            cmd.env("CONDUIT_HOOK_PORT", hook_port.to_string());
            // Continuity identity env: only set when a plugin dir was actually resolved
            // (i.e. continuity is on for this spawn -- see `continuity::continuity_enabled`).
            // SESSION_ID gives continuity a distinct identity per Conduit session; AGENT_ID
            // becomes continuity's presence label so the board can join presence to a card.
            if plugin_dir.is_some() {
                cmd.env("CONTINUITY_SESSION_ID", &session_id);
                cmd.env("CONTINUITY_AGENT_ID", &session_id);
            }
            for (k, v) in adapter.env_overrides() {
                cmd.env(k, v);
            }
            // Route OpenCode to the configured local/self-hosted provider:
            // an inline config env var that outranks the user's opencode.json files, plus
            // the endpoint key in its own env var (referenced from the config as
            // {env:CONDUIT_OC_APIKEY}). Env-only by design — never written to disk.
            if let Some(oc) = &opencode {
                cmd.env("OPENCODE_CONFIG_CONTENT", &oc.config_json);
                if let Some(key) = &oc.api_key {
                    cmd.env("CONDUIT_OC_APIKEY", key);
                }
            }
            // Select the pinned account (Feature 1/2) without disturbing the user's default
            // agent. The account->env mapping now lives behind `ProviderAdapter::account_env`
            // (the multi-account extension seam): Claude and Antigravity redirect
            // HOME/USERPROFILE to the profile root (see `agent::claude_profile_env` for why),
            // every other adapter returns nothing. Behavior is byte-identical to the block
            // this replaced. Values are path-derived account identifiers -- never logged.
            if let Some(dir) = account_config_dir.as_deref() {
                for (k, v) in adapter.account_env(dir) {
                    cmd.env(k, v);
                }
            }
        }

        // Take the reader/writer from the master BEFORE spawning the child, so a failure
        // here can't orphan an already-spawned process tree.
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {e}"))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {e}"))?;

        drop(pair.slave); // so the reader gets EOF when the child exits

        let subscribers: Subscribers = Arc::new(Mutex::new(Vec::new()));
        let subs_for_reader = subscribers.clone();
        let sink: Sink = Arc::new(Mutex::new(on_event));
        let output = Arc::new(RingBuffer::new(OUTPUT_RING_BYTES));
        let output_for_reader = output.clone();
        let suppress_flag = Arc::new(AtomicBool::new(suppress_remote));
        let suppress_for_reader = suppress_flag.clone();

        self.sessions.insert(
            session_id.clone(),
            Mutex::new(PtySession {
                writer,
                master: pair.master,
                child,
                sink: sink.clone(),
                subscribers: subscribers.clone(),
                next_sub_id: Arc::new(AtomicU64::new(0)),
                size: Arc::new((AtomicU16::new(cols), AtomicU16::new(rows))),
                output,
                suppress_remote: suppress_flag,
            }),
        );

        // The reader self-reaps its map entry when the child exits on its own (below), so
        // hand it a clone of the session map and this id. Windows-only: macOS keeps its
        // current behavior so active native development is not disturbed.
        #[cfg(windows)]
        let sessions_for_reader = self.sessions.clone();
        #[cfg(windows)]
        let sid_for_reader = session_id.clone();

        // Reader thread: blocking reads → base64 → current sink. Send errors are
        // ignored (the channel may be briefly absent during a reload); only a read
        // EOF/error ends the thread.
        thread::spawn(move || {
            let engine = base64::engine::general_purpose::STANDARD;
            let mut buf = [0u8; 16 * 1024];
            // Exit if the sink stays dead for a long run of reads (orphaned, never
            // re-attached, never killed) — a safety net against a forever-looping
            // thread. Resets on any successful send, so reload gaps don't trip it.
            let mut consecutive_fails: u32 = 0;
            // Whether the loop ended because the child actually exited (EOF/error) vs the
            // orphaned-sink safety break (process may still be alive — must NOT reap then).
            let mut child_exited = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        child_exited = true;
                        break;
                    }
                    Ok(n) => {
                        output_for_reader.push(&buf[..n]);
                        let encoded = engine.encode(&buf[..n]);
                        // Remote (bridge) fan-out is suppressed for a siloed session so its
                        // output never leaves the machine via a paired phone; the desktop sink
                        // below still receives everything (the human reads the silo directly).
                        if !suppress_for_reader.load(Ordering::Relaxed) {
                            if let Ok(mut subs) = subs_for_reader.lock() {
                                broadcast(&mut subs, &encoded);
                            }
                        }
                        let ok = sink
                            .lock()
                            .map(|s| s.send(encoded).is_ok())
                            .unwrap_or(false);
                        if ok {
                            consecutive_fails = 0;
                        } else {
                            consecutive_fails += 1;
                            if consecutive_fails > 2000 {
                                break;
                            }
                        }
                    }
                    Err(_) => {
                        child_exited = true;
                        break;
                    }
                }
            }
            let notice = "\r\n\u{1b}[90m[process exited]\u{1b}[0m\r\n";
            let enc_notice = engine.encode(notice);
            if !suppress_for_reader.load(Ordering::Relaxed) {
                if let Ok(mut subs) = subs_for_reader.lock() {
                    broadcast(&mut subs, &enc_notice);
                }
            }
            if let Ok(s) = sink.lock() {
                let _ = s.send(enc_notice);
            }
            // Free the dead session's handles/buffers and let a re-spawn of this id
            // cold-start instead of re-attaching a dead PTY. Only on a real child exit
            // (not the orphaned-sink safety break, where the process may still be alive).
            // Windows-only so macOS behavior is untouched (see the clones above).
            #[cfg(windows)]
            if child_exited {
                if let Some((_, m)) = sessions_for_reader.remove(&sid_for_reader) {
                    if let Ok(mut s) = m.lock() {
                        let _ = s.child.wait();
                    }
                }
            }
            #[cfg(not(windows))]
            let _ = child_exited; // reap is Windows-only; consume here to avoid a warning
        });

        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| "no such session".to_string())?;
        let mut session = entry.lock().map_err(|_| "lock poisoned".to_string())?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("write: {e}"))?;
        session.writer.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }

    /// Recent (ANSI-stripped) terminal output for a session, for `fleet_peek`.
    /// None if the session isn't running.
    pub fn recent_output(&self, session_id: &str, max_bytes: usize) -> Option<String> {
        let entry = self.sessions.get(session_id)?;
        let session = entry.lock().ok()?;
        Some(session.output.tail_string(max_bytes))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| "no such session".to_string())?;
        let session = entry.lock().map_err(|_| "lock poisoned".to_string())?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize: {e}"))?;
        session.size.0.store(cols, Ordering::SeqCst);
        session.size.1.store(rows, Ordering::SeqCst);
        Ok(())
    }

    /// Attach an extra output consumer (a bridge connection) to a live session.
    /// Returns a receiver of base64 frames plus an id to detach with, or None if the
    /// session isn't running. Buffer is bounded — see `broadcast` for drop semantics.
    pub fn subscribe(&self, session_id: &str) -> Option<(u64, Receiver<String>)> {
        let entry = self.sessions.get(session_id)?;
        let session = entry.lock().ok()?;
        // A siloed session is never streamed to a remote (mobile-bridge) viewer.
        if session.suppress_remote.load(Ordering::Relaxed) {
            return None;
        }
        let id = session.next_sub_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = sync_channel(SUBSCRIBER_BUFFER);
        session.subscribers.lock().ok()?.push((id, tx));
        Some((id, rx))
    }

    /// Flip a running session's remote-stream suppression (Feature 4 silo). Setting it true
    /// also drops any existing bridge subscribers, so marking a *running* session sensitive
    /// immediately stops a paired phone from receiving further output. No-op if not running.
    pub fn set_remote_suppressed(&self, session_id: &str, suppress: bool) {
        if let Some(entry) = self.sessions.get(session_id) {
            if let Ok(session) = entry.lock() {
                session.suppress_remote.store(suppress, Ordering::Relaxed);
                if suppress {
                    if let Ok(mut subs) = session.subscribers.lock() {
                        subs.clear();
                    }
                }
            }
        }
    }

    /// Detach a previously-subscribed consumer. No-op if the session or id is gone.
    pub fn unsubscribe(&self, session_id: &str, sub_id: u64) {
        if let Some(entry) = self.sessions.get(session_id) {
            if let Ok(session) = entry.lock() {
                if let Ok(mut subs) = session.subscribers.lock() {
                    subs.retain(|(id, _)| *id != sub_id);
                }
            }
        }
    }

    /// Current (cols, rows) of a running session, so a freshly-attached remote viewer
    /// can match the desktop's size instead of resizing the shared PTY. None if gone.
    pub fn session_size(&self, session_id: &str) -> Option<(u16, u16)> {
        let entry = self.sessions.get(session_id)?;
        let session = entry.lock().ok()?;
        Some((
            session.size.0.load(Ordering::SeqCst),
            session.size.1.load(Ordering::SeqCst),
        ))
    }

    /// Ids of all currently-running sessions (for the bridge `list` message).
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.iter().map(|e| e.key().clone()).collect()
    }

    pub fn kill(&self, session_id: &str) {
        if let Some((_, m)) = self.sessions.remove(session_id) {
            if let Ok(mut session) = m.lock() {
                // Windows: child.kill() is TerminateProcess on cmd.exe only, which orphans
                // the real tree (cmd.exe -> node(agent) -> MCP servers / git / dev servers).
                // Kill the whole tree by PID first, while cmd.exe is still alive to be found.
                #[cfg(windows)]
                if let Some(pid) = session.child.process_id() {
                    use crate::NoWindow;
                    let _ = std::process::Command::new("taskkill")
                        .args(["/T", "/F", "/PID", &pid.to_string()])
                        .no_window()
                        .status();
                }
                let _ = session.child.kill();
                let _ = session.child.wait(); // reap so we don't leave a zombie
            }
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            self.kill(&id);
        }
    }
}

/// True if a transcript named `<session_id>.jsonl` exists under any project-slug
/// subdirectory of `projects_dir`. Matching by the globally-unique UUID filename
/// means we never reproduce Claude's cwd-slug algorithm (so worktree cwds work too).
pub(crate) fn transcript_exists(session_id: &str, projects_dir: &Path) -> bool {
    let file = format!("{session_id}.jsonl");
    let Ok(entries) = fs::read_dir(projects_dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.path().join(&file).exists())
}

/// Path to `<session_id>.jsonl` under whichever project-slug dir holds it. None if absent.
pub(crate) fn transcript_path(session_id: &str, projects_dir: &Path) -> Option<PathBuf> {
    let file = format!("{session_id}.jsonl");
    fs::read_dir(projects_dir)
        .ok()?
        .flatten()
        .find_map(|entry| {
            let p = entry.path().join(&file);
            p.exists().then_some(p)
        })
}

/// §7.3: the env var/value pair to set on a Conductor spawn (`None` for a worker or any
/// non-Conductor session). Pulled out as a pure function since `CommandBuilder` has no
/// way to read its env back afterward, so this is the only part of the wiring that's
/// actually unit-testable -- the call site just applies whatever this returns.
pub(crate) fn subagent_model_env(is_conductor: bool) -> Option<(&'static str, &'static str)> {
    is_conductor.then_some(("CLAUDE_CODE_SUBAGENT_MODEL", "claude-haiku-4-5-20251001"))
}

/// Resolve Claude's transcript store: `$CLAUDE_CONFIG_DIR/projects` if set,
/// else `~/.claude/projects`. None when no home dir is available.
pub(crate) fn claude_projects_dir() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(cfg) if !cfg.is_empty() => Some(PathBuf::from(cfg).join("projects")),
        _ => dirs::home_dir().map(|h| h.join(".claude").join("projects")),
    }
}

/// Single-quote a string for safe interpolation into a /bin/sh -c command.
/// (Windows spawns route through cmd.exe and use `win_quote`, so this is unused there.)
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Quote a single token for a cmd.exe command line. Bare when it's a "simple" token
/// (alphanumerics, path/flag punctuation -- covers UUIDs, flags, and space-free paths);
/// otherwise wrapped in double quotes (cmd's only quoting), doubling any embedded quote.
/// Note: a compound command passed as a single `cmd /K` argument that contains embedded
/// double quotes is not fully robust under cmd's re-parse; normal (quote-free) sessions
/// are the supported path -- see `build_script_win`.
///
/// cmd.exe expands `%VAR%` sequences during command-line parsing even *inside* double
/// quotes -- quoting alone does not stop it. A mission/prompt string that happens to
/// contain e.g. `%CONDUIT_OC_APIKEY%` would otherwise have that secret substituted into
/// the literal, OS-visible process command line before the target CLI ever runs.
/// `%` (and the caret used to escape it) are excluded from the "simple" bare charset
/// above, so any such string already falls into this quoted branch. `^` must be escaped
/// *before* `%` -- escaping `%` first would double the very carets meant to guard it,
/// and an even number of carets in front of a `%` cancels the escape and lets it expand
/// again (empirically verified against a real cmd.exe: `^^%FOO%` still substitutes,
/// `^%FOO^%` does not, regardless of whether the text sits inside quotes).
#[cfg(windows)]
pub(crate) fn win_quote(s: &str) -> String {
    let simple = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:@=\\".contains(c));
    if simple {
        s.to_string()
    } else {
        let escaped = s.replace('^', "^^").replace('%', "^%");
        format!("\"{}\"", escaped.replace('"', "\"\""))
    }
}

/// OS-appropriate argument quoting for the agent invocation string: POSIX single-quoting
/// under a `sh -c` login shell, cmd.exe quoting under `cmd /K`. Used by the provider
/// adapters so one `build_invocation` implementation serves both platforms.
pub(crate) fn quote_arg(s: &str) -> String {
    #[cfg(windows)]
    {
        win_quote(s)
    }
    #[cfg(not(windows))]
    {
        shell_quote(s)
    }
}

/// Per-subscriber buffered fan-out. Sends one base64 frame to every subscriber.
/// A subscriber whose bounded buffer is full has the frame DROPPED (slow consumer —
/// must never block the desktop webview); a subscriber whose receiver hung up is
/// pruned from the list. Mutates `subs` in place.
fn broadcast(subs: &mut Vec<(u64, SyncSender<String>)>, frame: &str) {
    subs.retain(|(_, tx)| match tx.try_send(frame.to_string()) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => true,
        Err(TrySendError::Disconnected(_)) => false,
    });
}

/// Build the `sh -c` script that launches one agent session. The agent invocation
/// (and its `|| <bare>` fallback) is delegated to the adapter; Conduit's own env
/// (CONDUIT_SESSION_ID/HOOK_PORT) and the worktree/settings flags are applied here.
/// `worktree`/`settings` are only set by callers when the adapter supports worktrees.
#[cfg(not(windows))]
#[allow(clippy::too_many_arguments)]
fn build_script(
    adapter: &dyn crate::agent::ProviderAdapter,
    session_id: &str,
    port: u16,
    working_directory: &str,
    shell: &str,
    worktree: Option<&str>,
    settings: Option<&str>,
    mcp_config: Option<&str>,
    plugin_dir: Option<&str>,
    system_prompt_file: Option<&str>,
    initial_prompt: Option<&str>,
    projects_dir: Option<&Path>,
    model: Option<&str>,
    effort: Option<&str>,
    resume_token: Option<&str>,
) -> String {
    let mut flags = String::new();
    if let Some(name) = worktree {
        flags.push_str(&format!(" --worktree {}", shell_quote(name)));
    }
    if let Some(path) = settings {
        flags.push_str(&format!(" --settings {}", shell_quote(path)));
    }
    if let Some(cfg) = mcp_config {
        flags.push_str(&format!(" --mcp-config {}", shell_quote(cfg)));
    }
    // Continuity (Node-gated, board-enabled Claude sessions only): the bundled plugin
    // dir, resolved by `continuity::continuity_asset_dir`. None (continuity off) leaves
    // this flag out entirely -- same additive shape as `--mcp-config` above.
    if let Some(dir) = plugin_dir {
        flags.push_str(&format!(" --plugin-dir {}", shell_quote(dir)));
    }
    // File, not inline text: see `fleet::write_persona_file` for the Windows
    // command-line-length reason. `flags` is duplicated by build_invocation's `||`
    // fallback, so keeping the persona out of it is what stays under cmd.exe's 8191 limit.
    if let Some(path) = system_prompt_file {
        flags.push_str(&format!(
            " --append-system-prompt-file {}",
            shell_quote(path)
        ));
    }
    // SPEC-B: only ever populated for Claude (the caller in lib.rs gates on
    // agent == AgentId::Claude before resolving these) -- verified real flags, not a guess
    // (`claude --help` lists both `--model <model>` and `--effort <level>`).
    if let Some(m) = model {
        flags.push_str(&format!(" --model {}", shell_quote(m)));
    }
    if let Some(e) = effort {
        flags.push_str(&format!(" --effort {}", shell_quote(e)));
    }
    let invocation = adapter.build_invocation(
        session_id,
        projects_dir,
        &flags,
        initial_prompt,
        resume_token,
    );
    format!(
        "export CONDUIT_SESSION_ID={sid} CONDUIT_HOOK_PORT={port}; cd {dir} && {invocation}; exec {shell} -i -l",
        sid = shell_quote(session_id),
        port = port,
        dir = shell_quote(working_directory),
        invocation = invocation,
        shell = shell,
    )
}

/// Windows counterpart of `build_script`: returns just the agent invocation (with its
/// worktree/settings flags) to hand to `cmd.exe /K`. The working directory and Conduit's
/// own env (CONDUIT_SESSION_ID/HOOK_PORT) are applied natively by `CommandBuilder`
/// (`cmd.cwd()` / `cmd.env()`), so -- unlike the POSIX script -- there is no `cd`,
/// `export`, or trailing `exec`, which keeps the command free of cmd-quoting hazards for
/// the common (flag-free) session. Flags are cmd-quoted via `quote_arg`.
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn build_script_win(
    adapter: &dyn crate::agent::ProviderAdapter,
    session_id: &str,
    worktree: Option<&str>,
    settings: Option<&str>,
    mcp_config: Option<&str>,
    plugin_dir: Option<&str>,
    system_prompt_file: Option<&str>,
    initial_prompt: Option<&str>,
    projects_dir: Option<&Path>,
    model: Option<&str>,
    effort: Option<&str>,
    resume_token: Option<&str>,
) -> String {
    let mut flags = String::new();
    if let Some(name) = worktree {
        flags.push_str(&format!(" --worktree {}", quote_arg(name)));
    }
    if let Some(path) = settings {
        flags.push_str(&format!(" --settings {}", quote_arg(path)));
    }
    if let Some(cfg) = mcp_config {
        flags.push_str(&format!(" --mcp-config {}", quote_arg(cfg)));
    }
    // Continuity: same additive shape as the POSIX `build_script` above, cmd-quoted.
    if let Some(dir) = plugin_dir {
        flags.push_str(&format!(" --plugin-dir {}", quote_arg(dir)));
    }
    // File, not inline text -- this is the actual fix for the Windows "command line is too
    // long" Conductor failure (see `fleet::write_persona_file`): the ~5 KB persona must not
    // ride on the cmd.exe command line, doubly so because build_invocation repeats `flags`.
    if let Some(path) = system_prompt_file {
        flags.push_str(&format!(" --append-system-prompt-file {}", quote_arg(path)));
    }
    // SPEC-B: only ever populated for Claude -- see build_script's matching comment.
    if let Some(m) = model {
        flags.push_str(&format!(" --model {}", quote_arg(m)));
    }
    if let Some(e) = effort {
        flags.push_str(&format!(" --effort {}", quote_arg(e)));
    }
    adapter.build_invocation(
        session_id,
        projects_dir,
        &flags,
        initial_prompt,
        resume_token,
    )
}

#[cfg(test)]
mod tests {
    // `super::*` brings in `fs`, `Path`, and `PathBuf` from the file's top-level
    // imports (same pattern as the hooks.rs test module).
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const ID: &str = "11111111-2222-3333-4444-555555555555";

    #[test]
    fn conductor_spawn_sets_subagent_model_env() {
        assert_eq!(
            subagent_model_env(true),
            Some(("CLAUDE_CODE_SUBAGENT_MODEL", "claude-haiku-4-5-20251001"))
        );
    }

    #[test]
    fn worker_spawn_does_not_set_subagent_model_env() {
        assert_eq!(subagent_model_env(false), None);
    }

    #[test]
    fn strip_ansi_removes_csi_and_osc_sequences() {
        let raw = "\x1b[31mhello\x1b[0m \x1b[2Kworld";
        assert_eq!(strip_ansi(raw), "hello world");
        // OSC title set, BEL-terminated, is removed too.
        assert_eq!(strip_ansi("\x1b]0;title\x07done"), "done");
    }

    #[test]
    fn ring_buffer_keeps_only_the_tail() {
        let buf = RingBuffer::new(8);
        buf.push(b"abcdef");
        buf.push(b"ghij"); // total 10 -> keep last 8
        assert_eq!(buf.tail_string(100), "cdefghij");
    }

    /// A unique, empty `.../projects` dir for one test.
    fn fresh_projects_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("conduit_pty_test_{tag}_{}_{n}", std::process::id()))
            .join("projects");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp projects dir");
        dir
    }

    /// Plant `<projects>/<slug>/<id>.jsonl` to simulate a Claude transcript.
    fn plant_transcript(projects: &Path, slug: &str, id: &str) {
        let slug_dir = projects.join(slug);
        fs::create_dir_all(&slug_dir).unwrap();
        fs::write(slug_dir.join(format!("{id}.jsonl")), b"{}\n").unwrap();
    }

    #[test]
    fn transcript_absent_in_empty_store() {
        let projects = fresh_projects_dir("absent");
        assert!(!transcript_exists(ID, &projects));
    }

    #[test]
    fn transcript_found_under_any_slug() {
        let projects = fresh_projects_dir("found");
        // Arbitrary slug incl. dots — detection must NOT depend on the cwd-slug algorithm.
        plant_transcript(&projects, "-some-weird-Slug.with.dots", ID);
        assert!(transcript_exists(ID, &projects));
    }

    #[test]
    fn transcript_other_ids_ignored() {
        let projects = fresh_projects_dir("others");
        plant_transcript(&projects, "-proj", "99999999-0000-0000-0000-000000000000");
        assert!(!transcript_exists(ID, &projects));
    }

    #[test]
    fn transcript_missing_dir_is_false() {
        let missing = std::env::temp_dir().join("conduit_pty_does_not_exist_dir/projects");
        let _ = fs::remove_dir_all(&missing);
        assert!(!transcript_exists(ID, &missing));
    }

    #[cfg(not(windows))]
    #[test]
    fn build_script_wraps_adapter_invocation_with_conduit_env() {
        let script = build_script(
            &crate::agent::ClaudeAdapter,
            "sid-1",
            7777,
            "/repo",
            "/bin/zsh",
            None,
            None,
            None,
            None, // plugin_dir
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(script.contains("export CONDUIT_SESSION_ID='sid-1' CONDUIT_HOOK_PORT=7777"));
        assert!(script.contains("claude --session-id 'sid-1' || claude"));
        assert!(script.contains("cd '/repo' &&"));
    }

    #[cfg(not(windows))]
    #[test]
    fn build_script_appends_conductor_flags_and_prompt() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::Claude);
        let script = build_script(
            &*adapter,
            "sid-1",
            8423,
            "/repo",
            "/bin/zsh",
            None,                     // worktree
            Some("/cfg/hooks.json"),  // settings
            Some("/cfg/mcp.json"),    // mcp_config
            None,                     // plugin_dir
            Some("/cfg/persona.txt"), // system_prompt_file
            None,                     // initial_prompt
            None,                     // projects_dir
            None,                     // model
            None,                     // effort
            None,
        );
        assert!(script.contains("--settings '/cfg/hooks.json'"), "{script}");
        assert!(script.contains("--mcp-config '/cfg/mcp.json'"), "{script}");
        // The persona rides as a FILE path, never inline text (see write_persona_file):
        // the bare `--append-system-prompt` (no `-file`) must not appear.
        assert!(
            script.contains("--append-system-prompt-file '/cfg/persona.txt'"),
            "{script}"
        );
        assert!(
            !script.contains("--append-system-prompt "),
            "persona must never be inlined: {script}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn build_script_passes_initial_prompt_positional() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::Claude);
        let script = build_script(
            &*adapter,
            "sid-2",
            8423,
            "/repo",
            "/bin/zsh",
            None,
            None,
            None,
            None, // plugin_dir
            None,
            Some("implement the parser"),
            None,
            None,
            None,
            None,
        );
        assert!(
            script.contains("'implement the parser'"),
            "prompt must be a quoted positional: {script}"
        );
    }

    #[test]
    fn broadcast_delivers_same_frame_to_all() {
        let (tx1, rx1) = sync_channel(8);
        let (tx2, rx2) = sync_channel(8);
        let mut subs = vec![(1u64, tx1), (2u64, tx2)];
        broadcast(&mut subs, "QUJD");
        assert_eq!(rx1.recv().unwrap(), "QUJD");
        assert_eq!(rx2.recv().unwrap(), "QUJD");
        assert_eq!(subs.len(), 2);
    }

    #[test]
    fn broadcast_prunes_disconnected() {
        let (tx1, rx1) = sync_channel(8);
        let (tx2, rx2) = sync_channel(8);
        drop(rx2);
        let mut subs = vec![(1u64, tx1), (2u64, tx2)];
        broadcast(&mut subs, "Zg==");
        assert_eq!(rx1.recv().unwrap(), "Zg==");
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].0, 1);
    }

    #[test]
    fn broadcast_slow_subscriber_drops_frame_not_others() {
        let (tx_slow, _rx_slow) = sync_channel(1);
        tx_slow.try_send("queued".into()).unwrap();
        let (tx_fast, rx_fast) = sync_channel(8);
        let mut subs = vec![(1u64, tx_slow), (2u64, tx_fast)];
        broadcast(&mut subs, "next");
        assert_eq!(rx_fast.recv().unwrap(), "next");
        assert_eq!(subs.len(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn win_quote_bare_vs_quoted() {
        // UUIDs / flags / space-free paths stay bare (cmd needs no quoting).
        assert_eq!(win_quote(ID), ID);
        assert_eq!(win_quote("--session-id"), "--session-id");
        assert_eq!(win_quote(r"C:\Users\me\.claude"), r"C:\Users\me\.claude");
        // Spaces force double-quoting; embedded quotes are doubled.
        assert_eq!(win_quote("hello world"), "\"hello world\"");
        assert_eq!(win_quote(r"C:\a b\h.json"), "\"C:\\a b\\h.json\"");
    }

    #[cfg(windows)]
    #[test]
    fn win_quote_neutralizes_percent_expansion() {
        // cmd.exe expands %VAR% even inside double quotes -- a mission/prompt string
        // containing e.g. "%CONDUIT_OC_APIKEY%" must never reach the command line
        // un-escaped. Verified empirically against a real cmd.exe (see the doc comment
        // on win_quote): '^' before '%' blocks expansion; escaping '%' alone does not.
        assert_eq!(
            win_quote("leak %CONDUIT_OC_APIKEY% here"),
            "\"leak ^%CONDUIT_OC_APIKEY^% here\""
        );
        // An attacker-supplied caret placed right before a '%' must not be able to
        // cancel the escape by pairing up with it (an even number of carets in front
        // of a '%' un-escapes it) -- caret must be escaped before percent is.
        assert_eq!(
            win_quote("leak ^%CONDUIT_OC_APIKEY% here"),
            "\"leak ^^^%CONDUIT_OC_APIKEY^% here\""
        );
        assert_eq!(
            win_quote("leak ^^%CONDUIT_OC_APIKEY% here"),
            "\"leak ^^^^^%CONDUIT_OC_APIKEY^% here\""
        );
    }

    #[cfg(windows)]
    #[test]
    fn build_script_win_is_bare_invocation_for_normal_session() {
        // No cd / export / exec: cwd + CONDUIT env are applied natively by CommandBuilder,
        // so a normal session's command line is quote-free.
        let script = build_script_win(
            &crate::agent::ClaudeAdapter,
            ID,
            None,
            None,
            None,
            None, // plugin_dir
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(script, format!("claude --session-id {ID} || claude"));
        assert!(!script.contains("cd "));
        assert!(!script.contains("export "));
    }

    #[cfg(windows)]
    #[test]
    fn build_script_win_quotes_spaced_flags() {
        let script = build_script_win(
            &*crate::agent::adapter_for(crate::agent::AgentId::Claude),
            "sid-1",
            None,
            Some(r"C:\cfg dir\hooks.json"),
            None,
            None, // plugin_dir
            Some(r"C:\cfg dir\persona.txt"),
            None,
            None,
            None,
            None,
            None,
        );
        assert!(
            script.contains("--settings \"C:\\cfg dir\\hooks.json\""),
            "{script}"
        );
        // Persona rides as a (double-quoted, spaced) FILE path -- never inline text. This
        // is the guard for the Windows "command line is too long" Conductor-spawn fix.
        assert!(
            script.contains("--append-system-prompt-file \"C:\\cfg dir\\persona.txt\""),
            "{script}"
        );
        assert!(
            !script.contains("--append-system-prompt \""),
            "persona must never be inlined: {script}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn build_script_win_conductor_stays_under_cmd_line_limit() {
        // The actual regression guard for "The command line is too long." The persona
        // rides as a FILE path, so the doubled (`||` fallback) invocation stays far under
        // cmd.exe's hard 8191-char ceiling even though the persona itself is ~5 KB.
        let persona_path = r"C:\Users\u\AppData\Roaming\ConduitTauri\conductor-persona-11111111-2222-3333-4444-555555555555.txt";
        let script = build_script_win(
            &*crate::agent::adapter_for(crate::agent::AgentId::Claude),
            ID,
            None,
            None,
            Some(r"C:\Users\u\AppData\Roaming\ConduitTauri\conductor-mcp-x.json"),
            None, // plugin_dir
            Some(persona_path),
            None,
            None,
            None,
            None,
            None,
        );
        assert!(script.len() < 8000, "len={}: {script}", script.len());
        // Sanity: inlining the real persona twice (the OLD behavior) WOULD have overflowed
        // the limit -- i.e. this test would be meaningless if the persona were tiny.
        assert!(crate::fleet::CONDUCTOR_PERSONA.len() * 2 > 8191);
    }

    #[cfg(not(windows))]
    #[test]
    fn build_script_appends_model_and_effort_flags() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::Claude);
        let script = build_script(
            &*adapter,
            "sid-1",
            8423,
            "/repo",
            "/bin/zsh",
            None,
            None,
            None,
            None, // plugin_dir
            None,
            None,
            None,
            Some("claude-opus-4-8"),
            Some("high"),
            None,
        );
        assert!(script.contains("--model 'claude-opus-4-8'"), "{script}");
        assert!(script.contains("--effort 'high'"), "{script}");
    }

    #[cfg(windows)]
    #[test]
    fn build_script_win_appends_model_and_effort_flags() {
        let script = build_script_win(
            &*crate::agent::adapter_for(crate::agent::AgentId::Claude),
            "sid-1",
            None,
            None,
            None,
            None, // plugin_dir
            None,
            None,
            None,
            Some("claude-opus-4-8"),
            Some("high"),
            None,
        );
        assert!(script.contains("--model claude-opus-4-8"), "{script}");
        assert!(script.contains("--effort high"), "{script}");
    }

    #[cfg(not(windows))]
    #[test]
    fn build_script_appends_plugin_dir_when_present() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::Claude);
        let with_plugin = build_script(
            &*adapter,
            "sid-1",
            8423,
            "/repo",
            "/bin/zsh",
            None,
            None,
            None,
            Some("/opt/continuity-plugin"), // plugin_dir
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(
            with_plugin.contains("--plugin-dir '/opt/continuity-plugin'"),
            "{with_plugin}"
        );

        // None (continuity off) must add nothing -- purely additive.
        let without_plugin = build_script(
            &*adapter, "sid-1", 8423, "/repo", "/bin/zsh", None, None, None, None, None, None,
            None, None, None, None,
        );
        assert!(!without_plugin.contains("--plugin-dir"), "{without_plugin}");
    }

    #[cfg(windows)]
    #[test]
    fn build_script_win_appends_plugin_dir_when_present() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::Claude);
        let with_plugin = build_script_win(
            &*adapter,
            "sid-1",
            None,
            None,
            None,
            Some(r"C:\continuity-plugin"), // plugin_dir
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(
            with_plugin.contains("--plugin-dir C:\\continuity-plugin"),
            "{with_plugin}"
        );

        // None (continuity off) must add nothing -- purely additive.
        let without_plugin = build_script_win(
            &*adapter, "sid-1", None, None, None, None, None, None, None, None, None, None,
        );
        assert!(!without_plugin.contains("--plugin-dir"), "{without_plugin}");
    }
}
