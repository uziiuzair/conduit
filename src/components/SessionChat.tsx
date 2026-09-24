import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { findSession, useStore, type TranscriptItem } from "../store";
import { AGENTS } from "../agents";
import { modeLabel, nextMode } from "../permissionMode";
import { renderMarkdown, splitInsights } from "../markdown";
import { pasteAndSubmit } from "../terminalInput";
import { ArrowUpIcon } from "./Icons";

/**
 * The rich session view: an agent's conversation rendered as UI instead of read out of a
 * terminal. Styled in the HQ root chat's visual language (same `--hq-*` palette, bubbles,
 * tool lines, and composer classes) so the app has ONE chat look, condensed into a
 * centered column rather than running the pane's full width.
 *
 * **It never replaces the terminal, it covers it.** The xterm and its PTY are load-bearing
 * and keep-alive (see CLAUDE.md): unmounting or reparenting one kills the running `claude`.
 * So this is an absolutely-positioned sibling INSIDE `.term-host` — the terminal underneath
 * stays mounted, attached, and receiving output the entire time this is on screen. Closing
 * the pane reveals it exactly as it was, mid-run.
 *
 * The content is read from the transcript Claude already writes, so nothing here costs a
 * token: no model generates this UI, and no model is asked to summarize anything. It is a
 * renderer over a file.
 *
 * Claude only for now, and that is enforced in Rust (`session_transcript`) rather than
 * assumed here: `parse_line` reads Claude's JSONL schema, and rendering another agent's
 * unverified file would produce a confidently wrong conversation.
 */

/** Verb per tool-event kind — matches the HQ tool-line language ("read x", "searched y").
 *  Text, not icons: these are inline in a dense list, and an icon set would be a second
 *  vocabulary to learn for no extra meaning. */
const EVENT_MARK: Record<string, string> = {
  read: "read",
  bash: "ran",
  edit: "edited",
  search: "searched",
  web: "browsed",
  subagent: "subagent",
  generic: "tool",
};

/** Shift+Tab as the terminal sends it (CSI Z) — what Claude Code binds its
 *  permission-mode cycle to (auto-accept → plan → normal). */
const SHIFT_TAB = "\x1b[Z";

function Item({ item }: { item: TranscriptItem }) {
  // Assistant prose is split around `★ Insight` blocks so each renders as a styled
  // callout instead of showing the output style's raw dash-rule chrome.
  const segments = useMemo(
    () =>
      item.kind === "bubble" && item.role !== "user"
        ? splitInsights(item.text ?? "").map((seg) => ({
            kind: seg.kind,
            html: renderMarkdown(seg.text),
          }))
        : [],
    [item],
  );
  if (item.kind === "bubble") {
    // A typed prompt is literal text (pre-wrap in CSS) — rendering it as markdown would
    // silently eat backticks and underscores out of the thing the person actually wrote.
    if (item.role === "user") return <div className="hq-bubble-user">{item.text}</div>;
    return (
      <>
        {segments.map((seg, i) =>
          seg.kind === "insight" ? (
            <aside key={i} className="hq-insight">
              <span className="hq-insight-label">★ Insight</span>
              <div className="hq-assistant" dangerouslySetInnerHTML={{ __html: seg.html }} />
            </aside>
          ) : (
            <div key={i} className="hq-assistant" dangerouslySetInnerHTML={{ __html: seg.html }} />
          ),
        )}
      </>
    );
  }
  if (item.kind === "event") {
    const mark = EVENT_MARK[item.event ?? "generic"] ?? "tool";
    return (
      <div className="hq-tool-line" title={item.mono ?? undefined}>
        <span className="hq-tool-verb">{mark}</span>
        {item.mono && <code>{item.mono}</code>}
      </div>
    );
  }
  // `usage` and anything a later Rust version adds render as nothing, not a broken row.
  return null;
}

export function SessionChat({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const items = useStore((s) => s.transcripts[sessionId]);
  const loadTranscript = useStore((s) => s.loadTranscript);
  const agentId = useStore((s) => findSession(s.projects, sessionId)?.session.agent ?? "claude");
  const live = useStore((s) => s.live[sessionId]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const agentLabel = AGENTS.find((a) => a.id === agentId)?.label ?? agentId;

  // Load once on open, then refresh when this session's hooks fire. Hook-driven rather
  // than a fast timer: the transcript only changes when the agent does something, and
  // that is exactly what a hook event announces. The slow interval underneath is a
  // backstop for agents mid-turn between hooks.
  useEffect(() => {
    void loadTranscript(sessionId);
    const timer = setInterval(() => void loadTranscript(sessionId), 5000);
    const un = listen<{ session?: string }>("hook", (e) => {
      if (e.payload?.session === sessionId) void loadTranscript(sessionId);
    });
    return () => {
      clearInterval(timer);
      void un.then((f) => f());
    };
  }, [sessionId, loadTranscript]);

  // Working indicator: driven by the hook-derived session status, because Claude's own
  // rotating spinner words ("Scheming…", "Baking…") are terminal-TUI-only — they reach
  // neither the transcript nor any hook. `activity` is the next best truth: the tool the
  // agent is actually in right now, from PreToolUse.
  const working = live?.status === "running";
  const workingLabel = live?.compacting ? "Compacting…" : (live?.activity ?? "Working…");

  // Follow the tail only while the reader is already at the bottom, so scrolling back to
  // read something does not get yanked away every time the agent speaks (or the working
  // indicator appears).
  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ block: "end" });
  }, [items, pinned, working]);

  // Auto-grow with the draft, capped so the composer never eats the pane (same
  // behavior as the HQ composer).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    // Straight to the PTY, exactly as if it were typed: the agent is a real CLI and this
    // pane is a nicer keyboard, not a different protocol. It goes as a bracketed paste
    // with the Enter outside it -- a bare `${text}\r` is read as ONE paste and leaves the
    // message sitting in the composer (see `pasteAndSubmit`).
    void invoke("pty_write", { sessionId, data: pasteAndSubmit(text) }).catch(() => {});
    setDraft("");
    setPinned(true);
  };

  // The permission-mode chip: forwards Shift+Tab to the PTY, which is exactly the
  // keystroke that cycles Claude's auto-accept / plan / normal modes in the terminal.
  // The label is the hook-reported `permission_mode` (newer CLIs send it on every hook);
  // a click also bumps it optimistically along Claude's own cycle so the chip answers
  // immediately, and the next hook's report overwrites the guess if it was wrong. On a
  // CLI too old to report the mode, the chip names the action instead of a state.
  const mode = live?.permissionMode;
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const cycleMode = () => {
    void invoke("pty_write", { sessionId, data: SHIFT_TAB }).catch(() => {});
    if (mode) setPermissionMode(sessionId, nextMode(mode));
  };

  return (
    <div className="chat-pane">
      <div className="chat-head">
        <span className="chat-title">Conversation</span>
        <button className="chat-close" onClick={onClose} title="Back to the terminal">
          Terminal
        </button>
      </div>

      <div
        className="hq-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        <div className="hq-column">
          {items === undefined ? (
            <p className="chat-empty">Reading the transcript…</p>
          ) : items.length === 0 ? (
            <p className="chat-empty">
              Nothing to show yet. This view reads Claude’s transcript, so it fills in once
              the session has said something — the terminal underneath is still live either
              way.
            </p>
          ) : (
            items.map((item, i) => <Item key={i} item={item} />)
          )}
          {working && (
            <div className="hq-working">
              <span className="hq-pulse" aria-hidden />
              <span className="hq-working-label">{workingLabel}</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="hq-thread-composer">
        <div className="hq-column">
          <div className="hq-composer">
            <textarea
              ref={inputRef}
              rows={1}
              placeholder="Message this session…"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter makes a newline — the convention every chat
                // input uses. Everything else (Ctrl+C, Escape) belongs to the terminal
                // underneath and is deliberately not intercepted here.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="hq-composer-foot">
              <div className="hq-composer-meta">
                <span className="hq-chip">{agentLabel.toLowerCase()}</span>
                <button
                  className="hq-chip hq-chip-btn"
                  onClick={cycleMode}
                  title="Cycle this session's permission mode (normal → auto-accept → plan) — the same Shift+Tab the terminal takes"
                >
                  {modeLabel(mode) ?? "mode"} ⇧⇥
                </button>
                <span className="hq-hint">Enter to send · Shift+Enter for newline</span>
              </div>
              <button
                className="hq-send"
                disabled={!draft.trim()}
                onClick={send}
                aria-label="Send"
              >
                <ArrowUpIcon size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
