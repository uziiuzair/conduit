import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { canSend, isRenderable } from "../rootChat";
import { renderMarkdown } from "../markdown";

/** The root-level chat surface: markdown bubbles + read-only tool chips + composer.
 *  Purely data-driven — no terminal, no PTY; mounted as a layer while the terminal
 *  workspace stays mounted (display:none) underneath. */
export function RootChatView() {
  const chatId = useStore((s) => s.selectedRootChatId);
  const chat = useStore((s) => s.rootChats.find((c) => c.id === s.selectedRootChatId));
  const items = useStore((s) => (s.selectedRootChatId ? s.rootChatItems[s.selectedRootChatId] : undefined));
  const running = useStore((s) =>
    s.selectedRootChatId ? !!s.rootChatRunning[s.selectedRootChatId] : false,
  );
  const send = useStore((s) => s.sendRootChat);
  const stop = useStore((s) => s.stopRootChat);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shown = items ?? [];

  // Pin to the bottom as items stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, chatId]);

  if (!chatId || !chat) return null;

  const submit = () => {
    if (!canSend(draft, running)) return;
    void send(chatId, draft.trim());
    setDraft("");
  };

  return (
    <div className="root-chat">
      <div className="root-chat-header">{chat.title}</div>
      <div className="root-chat-scroll" ref={scrollRef}>
        <div className="root-chat-column">
        {shown.length === 0 && (
          <div className="root-chat-empty">
            What are we thinking about today? Ideas, roadmaps, cross-project questions —
            this chat reads your workspace but never changes it.
          </div>
        )}
        {shown.filter(isRenderable).map((item, i) =>
          item.kind === "bubble" ? (
            <div key={i} className={`root-chat-bubble ${item.role}`}>
              {item.role === "assistant" ? (
                <div
                  className="root-chat-md"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
                />
              ) : (
                item.text
              )}
            </div>
          ) : (
            <div
              key={i}
              className="root-chat-chip"
              title={item.kind === "event" ? (item.mono ?? undefined) : undefined}
            >
              {item.kind === "event" ? item.label : ""}
              {item.kind === "event" && item.mono ? <code>{item.mono}</code> : null}
            </div>
          ),
        )}
        {running && <div className="root-chat-chip working">thinking…</div>}
        </div>
      </div>
      <div className="root-chat-composer">
        <div className="root-chat-column composer-row">
        <textarea
          value={draft}
          placeholder="Message the root chat…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {running ? (
          <button className="root-chat-stop" onClick={() => void stop(chatId)}>
            Stop
          </button>
        ) : (
          <button
            className="root-chat-send"
            disabled={!canSend(draft, running)}
            onClick={submit}
          >
            Send
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
