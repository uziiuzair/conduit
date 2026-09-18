import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import {
  describeConversation,
  describeOffer,
  offerKey,
  pendingOffers,
  readDismissed,
  writeDismissed,
  type DriftCandidate,
} from "../conversationRepair";

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** Let React commit one state before the next, so `Terminal`'s stopped-transition effect
 *  sees stop and start as two changes rather than a batched no-op. */
const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * "These sessions reopened an older conversation — switch them to where you left off?"
 *
 * A session cleared with `/clear` before Conduit tracked the new conversation resumes the one
 * from BEFORE the clear, so the work since looks lost. The Rust scan finds the conversation
 * each session really moved on to (an exact link through Claude's prompt history, not a
 * guess). Switching is still an explicit choice per session, because it restarts that
 * session's agent. Scanned once, when the projects first load.
 */
export function ConversationRepairNotice() {
  const loaded = useStore((s) => s.projects.length > 0);
  const [offers, setOffers] = useState<DriftCandidate[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [forks, setForks] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void invoke<DriftCandidate[]>("claude_conversation_drift")
      .then((found) => {
        if (!cancelled) setOffers(pendingOffers(found, readDismissed(storage())));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  if (offers.length === 0) return null;

  const drop = (keys: string[]) =>
    setOffers((cur) => cur.filter((o) => !keys.includes(offerKey(o))));

  const dismiss = (list: DriftCandidate[]) => {
    const dismissed = readDismissed(storage());
    list.forEach((o) => dismissed.add(offerKey(o)));
    writeDismissed(storage(), dismissed);
    drop(list.map(offerKey));
  };

  const switchOne = async (
    o: DriftCandidate,
    conversationId = o.latestConversation,
  ): Promise<boolean> => {
    try {
      await invoke("adopt_claude_conversation", {
        sessionId: o.sessionId,
        conversationId,
      });
    } catch (e) {
      useStore.getState().pushToast(`Couldn't switch "${o.sessionName}": ${String(e)}`, "error");
      return false;
    }
    // A running agent is still on the old conversation; restart it onto the new one. A
    // stopped session just picks the change up whenever it is next started.
    const st = useStore.getState();
    const session = st.projects
      .find((p) => p.id === o.projectId)
      ?.sessions.find((s) => s.id === o.sessionId);
    if (session && !session.stopped) {
      await st.stopSession(o.projectId, o.sessionId);
      await nextFrame();
      await useStore.getState().startSession(o.projectId, o.sessionId);
    }
    return true;
  };

  /** `conversationId` picks an older branch instead of the newest; only for one offer. */
  const run = async (list: DriftCandidate[], conversationId?: string) => {
    setBusy(list.length === 1 ? (conversationId ?? offerKey(list[0])) : "all");
    const done: string[] = [];
    for (const o of list) if (await switchOne(o, conversationId)) done.push(offerKey(o));
    setBusy(null);
    drop(done);
    if (done.length) {
      useStore
        .getState()
        .pushToast(
          done.length === 1
            ? `Reopened "${list.find((o) => offerKey(o) === done[0])?.sessionName}" where you left off.`
            : `Reopened ${done.length} sessions where you left off.`,
        );
    }
  };

  const now = Date.now();
  const n = offers.length;

  return (
    <div className="convo-repair" role="region" aria-label="Recovered conversations">
      <div className="convo-repair-head">
        <span className="convo-repair-text">
          {n === 1 ? "1 session" : `${n} sessions`} reopened a conversation from before a{" "}
          <code>/clear</code>. Your later work is still on disk.
        </span>
        <button className="tmux-notice-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Review"}
        </button>
        <button className="tmux-notice-btn subtle" onClick={() => dismiss(offers)}>
          Dismiss
        </button>
      </div>
      {open && (
        <>
          <ul className="convo-repair-list">
            {offers.map((o) => {
              const key = offerKey(o);
              return (
                <li key={key} className="convo-repair-item">
                  <div className="convo-repair-row">
                    <span
                      className="convo-repair-name"
                      title={`${o.projectName} · ${o.sessionName}`}
                    >
                      <span className="convo-repair-project">{o.projectName}</span>
                      {o.sessionName}
                    </span>
                    <button
                      className="tmux-notice-btn"
                      disabled={busy !== null}
                      onClick={() => void run([o])}
                    >
                      {busy === key ? "Switching…" : "Switch"}
                    </button>
                    <button
                      className="tmux-notice-btn subtle"
                      disabled={busy !== null}
                      onClick={() => dismiss([o])}
                      aria-label={`Keep ${o.sessionName} on its current conversation`}
                    >
                      Keep
                    </button>
                  </div>
                  <Conversation title={o.latestTitle} meta={describeOffer(o, now)} />
                  {o.otherBranches.length > 0 && (
                    <button
                      className="convo-repair-fork-toggle"
                      aria-expanded={forks.has(key)}
                      onClick={() =>
                        setForks((cur) => {
                          const next = new Set(cur);
                          if (!next.delete(key)) next.add(key);
                          return next;
                        })
                      }
                    >
                      {forks.has(key) ? "Hide" : "Show"} {o.otherBranches.length} earlier{" "}
                      {o.otherBranches.length === 1 ? "branch" : "branches"}
                    </button>
                  )}
                  {forks.has(key) && (
                    <ul className="convo-repair-forks">
                      {o.otherBranches.map((b) => (
                        <li key={b.conversation} className="convo-repair-row">
                          <Conversation title={b.title} meta={describeConversation(b, now)} />
                          <button
                            className="tmux-notice-btn subtle"
                            disabled={busy !== null}
                            onClick={() => void run([o], b.conversation)}
                          >
                            {busy === b.conversation ? "Switching…" : "Switch to this"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="convo-repair-foot">
            <span className="convo-repair-meta">
              Switch reopens the newest conversation and restarts that session’s agent. A restart
              that reopened an old conversation, later cleared again, leaves earlier branches — your
              pre-restart work may be in one of those.
            </span>
            {n > 1 && (
              <button
                className="tmux-notice-btn"
                disabled={busy !== null}
                onClick={() => void run(offers)}
              >
                {busy === "all" ? "Switching…" : `Switch all ${n}`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Conversation({ title, meta }: { title: string; meta: string }) {
  return (
    <span className="convo-repair-convo">
      <span className="convo-repair-title" title={title}>
        {title || "(untitled conversation)"}
      </span>
      <span className="convo-repair-meta">{meta}</span>
    </span>
  );
}
