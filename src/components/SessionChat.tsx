import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore, type TranscriptItem } from "../store";
import { renderMarkdown } from "../markdown";

/**
 * The rich session view: an agent's conversation rendered as UI instead of read out of a
 * terminal.
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

/** Glyph per tool-event kind. Text, not icons: these are inline in a dense list, and an
 *  icon set would be a second vocabulary to learn for no extra meaning. */
const EVENT_MARK: Record<string, string> = {
  read: "read",
  bash: "ran",
  edit: "edited",
  search: "searched",
  web: "browsed",
  subagent: "subagent",
  generic: "tool",
};

function Bubble({ item }: { item: TranscriptItem }) {
  const html = useMemo(() => renderMarkdown(item.text ?? ""), [item.text]);
  const mine = item.role === "user";
  return (
    <div className={`chat-bubble ${mine ? "user" : "assistant"}`}>
      {mine ? (
        // A typed prompt is literal text. Rendering it as markdown would silently eat
        // backticks and underscores out of the thing the person actually wrote.
        <pre className="chat-user-text">{item.text}</pre>
      ) : (
        <div className="chat-md" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function EventRow({ item }: { item: TranscriptItem }) {
  const mark = EVENT_MARK[item.event ?? "generic"] ?? "tool";
  return (
    <div className="chat-event" title={item.mono ?? undefined}>
      <span className={`chat-event-kind ${item.event ?? "generic"}`}>{mark}</span>
      {item.mono && <span className="chat-event-arg">{item.mono}</span>}
    </div>
  );
}

export function SessionChat({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const items = useStore((s) => s.transcripts[sessionId]);
  const loadTranscript = useStore((s) => s.loadTranscript);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

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

  // Follow the tail only while the reader is already at the bottom, so scrolling back to
  // read something does not get yanked away every time the agent speaks.
  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ block: "end" });
  }, [items, pinned]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    // Straight to the PTY, exactly as if it were typed: the agent is a real CLI and this
    // pane is a nicer keyboard, not a different protocol. `\r` is the Enter the TUI waits
    // for.
    void invoke("pty_write", { sessionId, data: `${text}\r` }).catch(() => {});
    setDraft("");
    setPinned(true);
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
        className="chat-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {items === undefined ? (
          <p className="chat-empty">Reading the transcript…</p>
        ) : items.length === 0 ? (
          <p className="chat-empty">
            Nothing to show yet. This view reads Claude’s transcript, so it fills in once the
            session has said something — the terminal underneath is still live either way.
          </p>
        ) : (
          items.map((item, i) => {
            if (item.kind === "bubble") return <Bubble key={i} item={item} />;
            if (item.kind === "event") return <EventRow key={i} item={item} />;
            // `usage` and anything a later Rust version adds render as nothing rather
            // than as a broken row.
            return null;
          })
        )}
        <div ref={endRef} />
      </div>

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={2}
          placeholder="Message this session…"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter makes a newline — the convention every chat input
            // uses. Everything else (Ctrl+C, Escape) belongs to the terminal underneath
            // and is deliberately not intercepted here.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="chat-send" onClick={send} disabled={!draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
