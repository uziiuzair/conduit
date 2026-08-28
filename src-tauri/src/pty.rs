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

/// How many recent output bytes to retain per session.
///
/// Read by two consumers with different needs: `fleet_peek` wants a readable tail, and the
/// scrollback snapshot wants raw bytes covering a few screens. Sized for the larger of the
/// two (see `scrollback::MAX_BYTES`) — one buffer is cheaper than two, and `fleet_peek`
/// asks for the slice it wants anyway.
const OUTPUT_RING_BYTES: usize = crate::scrollback::MAX_BYTES;

/// Lines of scrollback tmux keeps per persistent session. With `mouse on` this is the
/// history the wheel actually scrolls (see `tmux::conf_body`), so it is the user-visible
/// scrollback depth, not an internal buffer. ~50k lines costs a few MB per session.
#[cfg(not(windows))]
const TMUX_SCROLLBACK: u32 = 50_000;

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
        strip_ansi(&String::from_utf8_lossy(&self.tail_bytes(max_bytes)))
    }

    /// Last `max_bytes` of buffered output, RAW.
    ///
    /// The escape sequences `tail_string` strips are exactly what a scrollback replay needs
    /// — colors, cursor moves, the lot. Two readers, two shapes, one buffer.
    pub fn tail_bytes(&self, max_bytes: usize) -> Vec<u8> {
        let q = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let start = q.len().saturating_sub(max_bytes);
        q.iter().skip(start).copied().collect()
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
    /// Whether new sessions are wrapped in tmux so they outlive the app. Mirrors the
    /// frontend's `persistSessions` setting, pushed down by `set_session_persistence`
    /// rather than threaded through `spawn` -- which already takes 24 arguments.
    ///
    /// Turning it OFF never kills anything: sessions already running under tmux keep
    /// working until they are destroyed. A setting toggle that silently discarded
    /// running work would be a worse bug than the one this feature fixes.
    #[cfg(not(windows))]
    persist: AtomicBool,
    /// Resolved once — probing four fixed paths plus `$PATH` on every spawn would be
    /// wasted work, and the answer cannot change without the app restarting.
    #[cfg(not(windows))]
    tmux: std::sync::OnceLock<Option<PathBuf>>,
    /// Sessions whose most recent spawn ATTACHED to a tmux session that was already running.
    ///
    /// Tracked as the exception rather than the rule, so every other path — no tmux, the
    /// setting off, Windows — is cold by default and gets its scrollback replayed. A warm
    /// reattach must not: tmux repaints the pane itself, and a replay on top of that prints
    /// the same screen twice.
    warm_spawns: DashMap<String, ()>,
}

/// Why a session's processes are being ended. The two verbs kill the same things; they
/// differ only in whether the scrollback snapshot survives, and that single bit is
/// load-bearing enough to name.
///
/// A session that is destroyed is gone — its record, its worktree, or the whole project
/// went with it, so keeping a snapshot would leak a file nothing will ever read. A session
/// that is retired still exists and will be opened again; its snapshot is the only record
/// of what was on screen once tmux is gone, and deleting it would hand the user back an
/// empty terminal after the next launch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Teardown {
    /// The session is going away for good (delete, project removal, `fleet_stop`).
    Destroy,
    /// The session is being hibernated and will come back (Stop session, stop-idle).
    Retire,
}

impl Teardown {
    /// Whether the scrollback snapshot outlives this teardown.
    pub fn keeps_snapshot(self) -> bool {
        matches!(self, Teardown::Retire)
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            #[cfg(not(windows))]
            persist: AtomicBool::new(true),
            #[cfg(not(windows))]
            tmux: std::sync::OnceLock::new(),
            warm_spawns: DashMap::new(),
        }
    }

    /// Absolute tmux path, or None when tmux is unavailable. Resolved on first use.
    #[cfg(not(windows))]
    pub fn tmux_path(&self) -> Option<&PathBuf> {
        self.tmux
            .get_or_init(|| {
                let found = crate::tmux::find_tmux();
                if let Some(p) = &found {
                    // The tmux server outlives the app and will not re-read `-f` on
                    // relaunch, so the config has to be pushed into a running server.
                    crate::tmux::ensure_conf(p, TMUX_SCROLLBACK);
                }
                found
            })
            .as_ref()
    }

    /// Mirror the frontend's `persistSessions` setting. See the field's note.
    #[cfg(not(windows))]
    pub fn set_persist(&self, on: bool) {
        self.persist.store(on, Ordering::SeqCst);
    }

    /// tmux available AND persistence enabled — the two conditions for wrapping a spawn.
    #[cfg(not(windows))]
    fn persistence_active(&self) -> Option<&PathBuf> {
        if !self.persist.load(Ordering::SeqCst) {
            return None;
        }
        self.tmux_path()
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
        // Add `--strict-mcp-config` alongside `mcp_config_path`, restricting the session to
        // exactly that file's servers. Set only when the session has its own MCP allowlist
        // (Feature C); false keeps the pre-allowlist inheritance behavior.
        strict_mcp: bool,
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
                    strict_mcp,
                );
                // Never pass `inner` itself: a quoted argument inside it does not survive
                // cmd's re-parse (see `write_spawn_script`). Route through a generated
                // batch file whose caret-escaped path is the only token on the command
                // line, so nothing here needs quoting at all. The fallback keeps a
                // quote-free invocation working if the write fails.
                let arg = match write_spawn_script(&session_id, &inner) {
                    Some(path) => cmd_caret_escape(&path),
                    None => inner,
                };
                cmd.args(["/K", arg.as_str()]);
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
                    strict_mcp,
                )
            };
            // Persistence: run `inner` inside a tmux session named after this session id,
            // so the agent survives the app quitting. `new-session -A` is attach-or-create,
            // which makes resume conditional for free -- on create tmux runs `inner` (with
            // whatever `--resume` flag the adapter built into it); on attach tmux ignores
            // the command, so a live agent is never resumed out from under itself.
            //
            // Falls through to the direct spawn when tmux is missing or the setting is off,
            // so the unpersisted path stays byte-for-byte what it is today.
            let inner = match self.persistence_active() {
                Some(tmux) => {
                    // Asked BEFORE the wrap, because `new-session -A` erases the difference:
                    // afterwards there is no way to tell an attach from a create. A warm
                    // reattach must NOT replay the scrollback snapshot -- tmux is about to
                    // repaint the same content, and replaying would print it twice.
                    if crate::tmux::has_session(tmux, &session_id) {
                        self.warm_spawns.insert(session_id.clone(), ());
                    }
                    crate::tmux::wrap_command(
                        tmux,
                        Some(&crate::tmux::conf_path()),
                        &crate::tmux::session_name(&session_id),
                        &working_directory,
                        &inner,
                    )
                }
                None => inner,
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
            // The port ABOVE is fixed for this session's lifetime; the path below is how
            // it stays correct anyway. Hook commands source this file before posting, so a
            // session that outlives an app restart onto a different port finds the live
            // one instead of posting into a closed socket. See `hooks::write_endpoint_file`.
            cmd.env(
                "CONDUIT_HOOK_ENDPOINT",
                crate::hooks::endpoint_file_path().as_os_str(),
            );
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

        // Cold restore, pushed through the SAME sink as live output and before the reader
        // thread starts — so it is the first frame the terminal receives and can never
        // interleave with what the agent prints next. Doing this from the frontend after
        // the spawn call returns would race exactly there.
        //
        // Nothing is emitted for a warm reattach: tmux repaints the pane itself, and a
        // replay on top of that would show the same screen twice.
        if let Some(snapshot) = self.take_cold_scrollback(&session_id) {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&snapshot);
            let _ = sink.lock().map(|s| s.send(encoded));
        }

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

    /// Persist every live session's recent output as a cold-restore snapshot.
    ///
    /// Called on a slow timer and once more at quit. Cheap enough to be unconditional: the
    /// buffer is already in memory, and the write is a few hundred kilobytes per session.
    pub fn save_scrollback(&self) {
        for entry in self.sessions.iter() {
            let Ok(session) = entry.value().lock() else {
                continue;
            };
            let bytes = session.output.tail_bytes(crate::scrollback::MAX_BYTES);
            if bytes.is_empty() {
                continue;
            }
            crate::scrollback::save(entry.key(), &bytes);
        }
    }

    /// The scrollback to replay for a session that has just spawned, if any.
    ///
    /// Returns `None` for a warm reattach, since tmux is about to repaint the pane itself.
    /// CONSUMES the answer: a session is cold once, and a second call within the same run
    /// (a re-attach, a remount) must not replay the snapshot again on top of live output.
    pub fn take_cold_scrollback(&self, session_id: &str) -> Option<Vec<u8>> {
        if self.warm_spawns.remove(session_id).is_some() {
            return None;
        }
        let snapshot = crate::scrollback::load(session_id)?;
        // Consumed by deleting it: the next save (seconds away, on the flush timer) rewrites
        // it from the live buffer, and in between a crash simply costs one cold restore its
        // scrollback rather than replaying stale content twice.
        crate::scrollback::remove(session_id);
        Some(snapshot)
    }

    pub fn kill(&self, session_id: &str) {
        self.tear_down(session_id, Teardown::Destroy);
    }

    /// Hibernate: end this session's processes and free their memory, while leaving
    /// everything needed to bring it back — the session record, its transcript, and its
    /// scrollback snapshot. The session comes back exactly the way one reaped by
    /// `session_budget` does, or one whose tmux server was lost to a reboot: a cold spawn
    /// that replays the snapshot and resumes the agent.
    ///
    /// The distinction from `kill` is the whole feature. `kill` means DESTROY and deletes
    /// the snapshot; using it here would free the memory but throw away the scrollback the
    /// user was promised on their next launch.
    pub fn retire(&self, session_id: &str) {
        self.tear_down(session_id, Teardown::Retire);
    }

    /// The one implementation behind `kill` and `retire`. They differ only in the two
    /// dispositions `Teardown` names, which is exactly why that decision is a tested table
    /// rather than a comment.
    fn tear_down(&self, session_id: &str, how: Teardown) {
        // Freshen the snapshot BEFORE dropping the PTY: after the entry is gone the live
        // buffer is unreachable, and a retire that saved nothing would come back to
        // whatever the slow flush timer last happened to write.
        if how.keeps_snapshot() {
            self.save_scrollback_for(session_id);
        }
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
        // Both verbs kill the tmux session. For DESTROY it prevents stranding a session
        // (and its agent) running forever with nothing able to reattach; for RETIRE it IS
        // the point — killing the PTY alone would only detach the client, and the agent
        // would keep every byte of its memory. Deliberately asymmetric with `kill_all`,
        // which leaves tmux alone because persistence is its entire purpose.
        #[cfg(not(windows))]
        if let Some(tmux) = self.tmux_path() {
            crate::tmux::kill_session(tmux, session_id);
        }
        // The next spawn must be COLD either way, so it replays rather than assuming tmux
        // will repaint a pane that no longer exists.
        self.warm_spawns.remove(session_id);
        if !how.keeps_snapshot() {
            crate::scrollback::remove(session_id);
        }
    }

    /// Snapshot one session's scrollback now. `save_scrollback` does every session on a
    /// timer; this is the single-session form a retire needs.
    fn save_scrollback_for(&self, session_id: &str) {
        let Some(entry) = self.sessions.get(session_id) else {
            return;
        };
        let Ok(session) = entry.value().lock() else {
            return;
        };
        let bytes = session.output.tail_bytes(crate::scrollback::MAX_BYTES);
        if !bytes.is_empty() {
            crate::scrollback::save(session_id, &bytes);
        }
    }

    /// App quit. Drops every PTY and -- unlike `kill` -- deliberately leaves the tmux
    /// sessions alone, which is the entire point of persistence: the agents keep working
    /// and the next launch reattaches to them.
    ///
    /// The instinct when reading this is to make it consistent with `kill`. Don't; that
    /// would silently restore the old behavior where quitting kills every agent.
    pub fn kill_all(&self) {
        // Last chance to capture what each terminal was showing. On a normal quit tmux keeps
        // the session and the next launch reattaches warm, so this snapshot is never used --
        // it is here for the launch AFTER a reboot, when there is no tmux left to reattach
        // to and the snapshot is the only record of the screen.
        self.save_scrollback();
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            if let Some((_, m)) = self.sessions.remove(&id) {
                if let Ok(mut session) = m.lock() {
                    #[cfg(windows)]
                    if let Some(pid) = session.child.process_id() {
                        use crate::NoWindow;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/T", "/F", "/PID", &pid.to_string()])
                            .no_window()
                            .status();
                    }
                    let _ = session.child.kill();
                    let _ = session.child.wait();
                }
            }
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

/// Caret-escape every character cmd.exe's parser treats specially, so a token survives
/// cmd's re-parse as a literal. Used for exactly one thing: the PATH of the generated
/// spawn script (see `write_spawn_script`), which is the only token left on the
/// `cmd /K` command line.
///
/// Why carets and not quotes. `portable_pty::CommandBuilder` builds the child command
/// line with MSVCRT/`ArgvQuote` rules, which escape an embedded `"` as `\"`. cmd.exe has
/// no such escape -- it only ever counts quotes -- so a quoted token handed to `cmd /K`
/// comes back out with literal backslash-quotes in it and the child's CRT then splits the
/// contents on spaces. `^` passes through `ArgvQuote` untouched (it escapes only `"` and
/// runs of `\`), so it is the one escape that reaches cmd intact. Verified against a real
/// cmd.exe: a batch path containing a space runs correctly as `...has^ space\spawn.cmd`.
#[cfg(windows)]
pub(crate) fn cmd_caret_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if " &()[]{}^=;!'+,`~%<>|\"".contains(c) {
            out.push('^');
        }
        out.push(c);
    }
    out
}

/// Windows: write this session's agent invocation to a `.cmd` script and return its path.
///
/// **This is the whole reason a Windows spawn is not fragile any more.** An invocation
/// containing a quoted argument -- a fleet worker's initial prompt, a `--settings` path
/// with a space in it, the Conductor's persona-file flag -- cannot survive being passed
/// as a single `cmd /K` argument: cmd strips the outer quote pair and hands the rest to
/// the child with `\"` sequences where the quotes were, so `cmdc "a b c"` reaches the
/// agent as three separate arguments. That is the "too many arguments. Expected 1
/// argument but got N" spawn failure, and it hit EVERY adapter that puts a prompt on the
/// command line, not just one. `hooks::write_codex_result_script` already worked around
/// the same re-parse locally; this generalizes the fix to the spawn itself.
///
/// Inside a batch file the ordinary cmd quoting rules apply and `win_quote` is exactly
/// right, so nothing about `build_invocation` has to change. The body is one line
/// prefixed with `@` -- which suppresses the echo of that line ONLY, rather than
/// `@echo off`, which would leave echo disabled for the interactive shell `/K` drops the
/// user into and hide their prompt.
///
/// One file per session id, overwritten on each cold spawn, so the set is bounded by the
/// session count rather than growing per launch (same convention as
/// `fleet::write_persona_file`). Returns None on any I/O failure; the caller then falls
/// back to the inline command, which is still correct for a quote-free invocation.
#[cfg(windows)]
fn write_spawn_script(session_id: &str, invocation: &str) -> Option<String> {
    let path = crate::store::data_dir().join(format!("spawn-{session_id}.cmd"));
    fs::write(&path, format!("@{invocation}\r\n")).ok()?;
    Some(path.to_string_lossy().into_owned())
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
    strict_mcp: bool,
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
        // Only ever set alongside a config generated for a session's own MCP allowlist. It
        // suppresses EVERY other MCP source -- user scope, the repo's own `.mcp.json` --
        // so it must never appear for a session that didn't opt in. The Conductor's
        // fleet-only config passes false and keeps inheriting.
        if strict_mcp {
            flags.push_str(" --strict-mcp-config");
        }
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
    strict_mcp: bool,
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
        // See build_script's matching comment: strict mode is opt-in per session and
        // suppresses every other MCP source. The flag itself needs no cmd-quoting.
        if strict_mcp {
            flags.push_str(" --strict-mcp-config");
        }
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
    fn destroying_a_session_drops_its_scrollback_but_retiring_keeps_it() {
        // The whole difference between hibernating a session and deleting one. A retired
        // session has to come back looking like it survived a reboot, and it cannot do that
        // without its snapshot -- the same contract `session_budget`'s reaper depends on.
        assert!(!Teardown::Destroy.keeps_snapshot());
        assert!(Teardown::Retire.keeps_snapshot());
    }

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
            false, // strict_mcp
        );
        assert!(script.contains("export CONDUIT_SESSION_ID='sid-1' CONDUIT_HOOK_PORT=7777"));
        assert!(script.contains("claude --session-id 'sid-1' || claude"));
        assert!(script.contains("cd '/repo' &&"));
    }

    #[cfg(not(windows))]
    #[test]
    fn build_script_appends_strict_mcp_config_when_set() {
        let script = build_script(
            &crate::agent::ClaudeAdapter,
            "sid-1",
            7777,
            "/repo",
            "/bin/zsh",
            None,
            None,
            Some("/cfg/mcp.json"),
            None, // plugin_dir
            None,
            None,
            None,
            None,
            None,
            None,
            true, // strict_mcp
        );
        assert!(script.contains("--mcp-config '/cfg/mcp.json'"));
        assert!(script.contains("--strict-mcp-config"));
    }

    #[cfg(not(windows))]
    #[test]
    fn build_script_omits_strict_mcp_config_by_default() {
        // The Conductor passes an mcp-config WITHOUT strict mode: it must keep inheriting
        // the user's own MCP servers, exactly as it did before session allowlists existed.
        let script = build_script(
            &crate::agent::ClaudeAdapter,
            "sid-1",
            7777,
            "/repo",
            "/bin/zsh",
            None,
            None,
            Some("/cfg/mcp.json"),
            None, // plugin_dir
            None,
            None,
            None,
            None,
            None,
            None,
            false, // strict_mcp
        );
        assert!(script.contains("--mcp-config '/cfg/mcp.json'"));
        assert!(!script.contains("--strict-mcp-config"));
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
            false, // strict_mcp
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

    /// The regression this whole indirection exists for. A multi-word initial prompt used
    /// to reach the agent as one argument per WORD ("too many arguments. Expected 1
    /// argument but got 16"), because cmd re-parses the `/K` argument and `ArgvQuote`'s
    /// `\"` is not an escape it understands. The command line must therefore carry no
    /// double quote at all -- only the caret-escaped script path.
    #[cfg(windows)]
    #[test]
    fn windows_spawn_arg_carries_no_quotes_and_hides_the_prompt() {
        let adapter = crate::agent::adapter_for(crate::agent::AgentId::CommandCode);
        let inner = build_script_win(
            &*adapter,
            ID,
            None,
            None,
            None,
            None,
            None,
            Some("Refactor the parser and add sixteen distinct words here right now ok"),
            None,
            None,
            None,
            None,
        );
        assert!(
            inner.contains('"'),
            "the invocation itself is quoted: {inner}"
        );

        let path = write_spawn_script(ID, &inner).expect("write spawn script");
        let arg = cmd_caret_escape(&path);
        assert!(
            !arg.contains('"'),
            "a quote on the /K command line is the bug: {arg}"
        );

        let body = fs::read_to_string(&path).unwrap();
        assert!(body.starts_with('@'), "line-local echo suppression: {body}");
        assert!(
            !body.contains("echo off"),
            "`@echo off` would disable the prompt of the shell /K leaves behind: {body}"
        );
        assert!(body.contains(&inner), "{body}");
        let _ = fs::remove_file(&path);
    }

    #[cfg(windows)]
    #[test]
    fn caret_escape_covers_cmd_metacharacters_and_spaces() {
        // A data dir under a user profile with a space is the common case, and the one
        // that silently produced a truncated path before.
        assert_eq!(
            cmd_caret_escape(r"C:\Users\A B\ConduitTauri\spawn-1.cmd"),
            r"C:\Users\A^ B\ConduitTauri\spawn-1.cmd"
        );
        // `%` must be escaped or cmd substitutes an env var into the path; `&` would end
        // the command outright.
        assert_eq!(cmd_caret_escape("a%B%c&d"), "a^%B^%c^&d");
        // Backslash and colon are NOT special to cmd and must pass through untouched,
        // or every path on Windows would be mangled.
        assert_eq!(cmd_caret_escape(r"C:\x\y"), r"C:\x\y");
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
            false, // strict_mcp
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
    fn build_script_win_appends_strict_mcp_config_when_set() {
        let script = build_script_win(
            &*crate::agent::adapter_for(crate::agent::AgentId::Claude),
            "sid-1",
            None,
            None,
            Some(r"C:\cfg\mcp.json"),
            None, // plugin_dir
            None,
            None,
            None,
            None,
            None,
            None,
            true, // strict_mcp
        );
        assert!(script.contains("--strict-mcp-config"), "{script}");
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
            false, // strict_mcp
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
            false, // strict_mcp
        );
        assert!(
            with_plugin.contains("--plugin-dir '/opt/continuity-plugin'"),
            "{with_plugin}"
        );

        // None (continuity off) must add nothing -- purely additive.
        let without_plugin = build_script(
            &*adapter, "sid-1", 8423, "/repo", "/bin/zsh", None, None, None, None, None, None,
            None, None, None, None, false,
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
