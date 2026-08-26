import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { canSend, greeting, isRenderable, relativeTime, type ChatItem } from "../rootChat";
import { inProfile } from "../profiles";
import { renderMarkdown } from "../markdown";
import { ArrowUpIcon, ChatBubbleIcon } from "./Icons";

/** The root-level chat surface, styled after Arlo's vault chat: a fresh chat opens
 *  as a centered home (greeting, hero composer, recent chats), and becomes a thread
 *  the moment the first exchange exists. Purely data-driven — no terminal, no PTY;
 *  mounted as a layer while the terminal workspace stays mounted (display:none). */
export function RootChatView() {
  const chatId = useStore((s) => s.selectedRootChatId);
  const chat = useStore((s) => s.rootChats.find((c) => c.id === s.selectedRootChatId));
  const items = useStore((s) =>
    s.selectedRootChatId ? s.rootChatItems[s.selectedRootChatId] : undefined,
  );
  const running = useStore((s) =>
    s.selectedRootChatId ? !!s.rootChatRunning[s.selectedRootChatId] : false,
  );

  if (!chatId || !chat) return null;
  const shown = (items ?? []).filter(isRenderable);
  const home = shown.length === 0 && !running;

  return (
    <div className={`root-chat ${home ? "home" : "thread"}`}>
      <div className="hq-grid" aria-hidden />
      {home ? <HqHome chatId={chatId} /> : <HqThread chatId={chatId} title={chat.title} items={shown} running={running} />}
    </div>
  );
}

/** Fresh-chat home: vertically centered greeting + hero composer, recents below. */
function HqHome({ chatId }: { chatId: string }) {
  const rootChats = useStore((s) => s.rootChats);
  const openRootChat = useStore((s) => s.openRootChat);
  const profiles = useStore((s) => s.profiles);
  const activeProfileId = useStore((s) => s.activeProfileId);
  // Same profile filter as the sidebar: this list is on screen while streaming.
  const knownProfileIds = new Set(profiles.map((p) => p.id));
  const recents = rootChats
    .filter((c) => c.id !== chatId && inProfile(c.profileId, activeProfileId, knownProfileIds))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6);

  return (
    <div className="hq-home">
      <div className="hq-hero">
        <h1 className="hq-greeting">{greeting(new Date().getHours())}.</h1>
        <p className="hq-tagline">
          Draft, plan, or think out loud — across every project. Reads everything,
          changes nothing.
        </p>
      </div>
      <Composer chatId={chatId} hero />
      {recents.length > 0 && (
        <section className="hq-recents">
          <h2 className="hq-recents-label">Recent</h2>
          <ul>
            {recents.map((c) => (
              <li key={c.id}>
                <button className="hq-recent-row" onClick={() => void openRootChat(c.id)}>
                  <ChatBubbleIcon size={13} className="hq-recent-icon" />
                  <span className="hq-recent-title">{c.title}</span>
                  <span className="hq-recent-time">
                    {relativeTime(c.createdAt, Date.now())}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Live conversation: top-down thread, composer pinned at the bottom. */
function HqThread({
  chatId,
  title,
  items,
  running,
}: {
  chatId: string;
  title: string;
  items: ChatItem[];
  running: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Pin to the bottom as items stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, chatId]);

  return (
    <div className="hq-thread">
      <div className="hq-thread-title">{title}</div>
      <div className="hq-scroll" ref={scrollRef}>
        <div className="hq-column">
          {items.map((item, i) =>
            item.kind === "bubble" ? (
              item.role === "user" ? (
                <div key={i} className="hq-bubble-user">
                  {item.text}
                </div>
              ) : (
                <div
                  key={i}
                  className="hq-assistant"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
                />
              )
            ) : item.kind === "event" ? (
              <div key={i} className="hq-tool-line" title={item.mono ?? undefined}>
                <span className="hq-tool-verb">{item.label}</span>
                {item.mono && <code>{item.mono}</code>}
              </div>
            ) : null,
          )}
          {running && <span className="hq-pulse" aria-label="thinking" />}
        </div>
      </div>
      <div className="hq-thread-composer">
        <div className="hq-column">
          <Composer chatId={chatId} />
        </div>
      </div>
    </div>
  );
}

/** The vault-style composer card: auto-growing textarea, read-only chip, round send.
 *  `hero` widens it for the home state; behavior is identical in both. */
function Composer({ chatId, hero = false }: { chatId: string; hero?: boolean }) {
  const running = useStore((s) => !!s.rootChatRunning[chatId]);
  const send = useStore((s) => s.sendRootChat);
  const stop = useStore((s) => s.stopRootChat);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow with the draft, capped so the card never eats the screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [draft]);

  const submit = () => {
    if (!canSend(draft, running)) return;
    void send(chatId, draft.trim());
    setDraft("");
  };

  return (
    <div className={`hq-composer ${hero ? "hero" : ""}`}>
      <textarea
        ref={ref}
        rows={1}
        autoFocus
        value={draft}
        placeholder={hero ? "What's on your mind?" : "Reply…"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="hq-composer-foot">
        <div className="hq-composer-meta">
          <span className="hq-chip">read-only · claude</span>
          <span className="hq-hint">Enter to send · Shift+Enter for newline</span>
        </div>
        {running ? (
          <button className="hq-stop" onClick={() => void stop(chatId)}>
            Stop
          </button>
        ) : (
          <button
            className="hq-send"
            disabled={!canSend(draft, running)}
            onClick={submit}
            aria-label="Send"
          >
            <ArrowUpIcon size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
