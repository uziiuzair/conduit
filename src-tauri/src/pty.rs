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

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
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
}

#[derive(Default)]
pub struct PtyManager {
    sessions: DashMap<String, Mutex<PtySession>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
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
        agent: crate::agent::AgentId,
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

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        let adapter = crate::agent::adapter_for(agent);
        let inner = if shell_only {
            format!(
                "cd {dir} 2>/dev/null; exec {shell} -i -l",
                dir = shell_quote(&working_directory),
                shell = shell,
            )
        } else {
            // Cold spawn only: the re-attach fast-path above returns before reaching
            // here, so a live session is never "resumed" out from under itself. The
            // agent command resumes/pins the session AND applies worktree/settings.
            build_script(
                adapter.as_ref(),
                &session_id,
                hook_port,
                &working_directory,
                &shell,
                worktree_name.as_deref(),
                settings_path.as_deref(),
                claude_projects_dir().as_deref(),
            )
        };

        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(["-i", "-l", "-c", inner.as_str()]);
        cmd.cwd(&working_directory);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Launching Conduit via a package manager (e.g. `pnpm tauri dev`) leaks
        // `npm_config_prefix` into our env; nvm then refuses to initialize in the
        // login shell ("not compatible with the npm_config_prefix environment
        // variable") and `claude` falls off PATH. Strip it from the child env so the
        // shell's nvm works regardless of how Conduit itself was launched.
        cmd.env_remove("npm_config_prefix");
        if !shell_only {
            cmd.env("CONDUIT_SESSION_ID", &session_id);
            cmd.env("CONDUIT_HOOK_PORT", hook_port.to_string());
            for (k, v) in adapter.env_overrides() {
                cmd.env(k, v);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {e}"))?;

        drop(pair.slave); // so the reader gets EOF when the child exits

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {e}"))?;

        let subscribers: Subscribers = Arc::new(Mutex::new(Vec::new()));
        let subs_for_reader = subscribers.clone();
        let sink: Sink = Arc::new(Mutex::new(on_event));

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
            }),
        );

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
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let encoded = engine.encode(&buf[..n]);
                        if let Ok(mut subs) = subs_for_reader.lock() {
                            broadcast(&mut subs, &encoded);
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
                    Err(_) => break,
                }
            }
            let notice = "\r\n\u{1b}[90m[process exited]\u{1b}[0m\r\n";
            let enc_notice = engine.encode(notice);
            if let Ok(mut subs) = subs_for_reader.lock() {
                broadcast(&mut subs, &enc_notice);
            }
            if let Ok(s) = sink.lock() {
                let _ = s.send(enc_notice);
            }
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
        let id = session.next_sub_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = sync_channel(SUBSCRIBER_BUFFER);
        session.subscribers.lock().ok()?.push((id, tx));
        Some((id, rx))
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

/// Resolve Claude's transcript store: `$CLAUDE_CONFIG_DIR/projects` if set,
/// else `~/.claude/projects`. None when no home dir is available.
fn claude_projects_dir() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(cfg) if !cfg.is_empty() => Some(PathBuf::from(cfg).join("projects")),
        _ => dirs::home_dir().map(|h| h.join(".claude").join("projects")),
    }
}

/// Single-quote a string for safe interpolation into a /bin/sh -c command.
pub(crate) fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
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
fn build_script(
    adapter: &dyn crate::agent::ProviderAdapter,
    session_id: &str,
    port: u16,
    working_directory: &str,
    shell: &str,
    worktree: Option<&str>,
    settings: Option<&str>,
    projects_dir: Option<&Path>,
) -> String {
    let mut flags = String::new();
    if let Some(name) = worktree {
        flags.push_str(&format!(" --worktree {}", shell_quote(name)));
    }
    if let Some(path) = settings {
        flags.push_str(&format!(" --settings {}", shell_quote(path)));
    }
    let invocation = adapter.build_invocation(session_id, projects_dir, &flags);
    format!(
        "export CONDUIT_SESSION_ID={sid} CONDUIT_HOOK_PORT={port}; cd {dir} && {invocation}; exec {shell} -i -l",
        sid = shell_quote(session_id),
        port = port,
        dir = shell_quote(working_directory),
        invocation = invocation,
        shell = shell,
    )
}

#[cfg(test)]
mod tests {
    // `super::*` brings in `fs`, `Path`, and `PathBuf` from the file's top-level
    // imports (same pattern as the hooks.rs test module).
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const ID: &str = "11111111-2222-3333-4444-555555555555";

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
        );
        assert!(script.contains("export CONDUIT_SESSION_ID='sid-1' CONDUIT_HOOK_PORT=7777"));
        assert!(script.contains("claude --session-id 'sid-1' || claude"));
        assert!(script.contains("cd '/repo' &&"));
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
}
