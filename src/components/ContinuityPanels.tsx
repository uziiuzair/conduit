import { useStore } from "../store";
import { timeAgo, truncateLine, type FeedDecision, type FeedMessage } from "../continuityFeed";

/**
 * The right column's read-only window onto continuity's running memory.
 *
 * Rows are one line each; the prose lives in the modal. Nothing here writes — continuity
 * owns its database, and Conduit only ever reads it.
 */
export function DecisionsPanel({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (d: FeedDecision) => void;
}) {
  const decisions = useStore((s) => s.continuityFeed[projectId]?.decisions) ?? [];
  const now = Date.now();

  if (decisions.length === 0) {
    return <p className="placeholder">No decisions recorded for this project yet.</p>;
  }
  return (
    <div className="continuity-list">
      {decisions.map((d) => (
        <button
          key={d.id}
          className={`continuity-row ${d.status === "superseded" ? "muted" : ""}`}
          onClick={() => onOpen(d)}
          title={d.decisionKey}
        >
          <span className={`continuity-dot ${d.status}`} />
          <span className="continuity-key">{d.decisionKey}</span>
          <span className="continuity-body">{truncateLine(d.content)}</span>
          <span className="continuity-meta">
            {d.authorLabel ?? "unknown"} · {timeAgo(d.createdAt, now)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function MessagesPanel({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (m: FeedMessage) => void;
}) {
  const messages = useStore((s) => s.continuityFeed[projectId]?.messages) ?? [];
  const now = Date.now();

  if (messages.length === 0) {
    return <p className="placeholder">No messages between this project's sessions yet.</p>;
  }
  return (
    <div className="continuity-list">
      {messages.map((m) => {
        const unanswered = m.requiresResponse && m.status === "pending";
        return (
          <button
            key={m.id}
            className={`continuity-row ${m.status === "dismissed" ? "muted" : ""}`}
            onClick={() => onOpen(m)}
            title={`${m.fromLabel ?? "?"} → ${m.toLabel ?? "?"}`}
          >
            <span className={`continuity-badge ${m.kind}`}>{m.kind}</span>
            <span className="continuity-key">
              {m.fromLabel ?? "?"} → {m.toLabel ?? "?"}
            </span>
            <span className="continuity-body">{truncateLine(m.body)}</span>
            <span className="continuity-meta">
              {unanswered ? "needs reply · " : ""}
              {timeAgo(m.createdAt, now)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export type ContinuityRow =
  | { kind: "decision"; value: FeedDecision }
  | { kind: "message"; value: FeedMessage };

/** Full prose for one row. Reuses the app's existing .modal-backdrop / .modal shell. */
export function ContinuityDetail({
  row,
  supersededBy,
  onClose,
}: {
  row: ContinuityRow;
  supersededBy: FeedDecision | undefined;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal continuity-detail" onClick={(e) => e.stopPropagation()}>
        {row.kind === "decision" ? (
          <>
            <h2>{row.value.decisionKey}</h2>
            <p className="settings-intro">
              {row.value.decisionType} · {row.value.status} ·{" "}
              {row.value.authorLabel ?? "unknown author"} · {row.value.createdAt}
            </p>
            <pre className="continuity-prose">{row.value.content}</pre>
            {supersededBy && (
              <p className="continuity-supersede">
                Superseded by “{truncateLine(supersededBy.content, 120)}”
                {supersededBy.authorLabel ? ` (${supersededBy.authorLabel})` : ""}.
              </p>
            )}
          </>
        ) : (
          <>
            <h2>
              {row.value.fromLabel ?? "?"} → {row.value.toLabel ?? "?"}
            </h2>
            <p className="settings-intro">
              {row.value.kind} · {row.value.status}
              {row.value.requiresResponse ? " · response required" : ""} · {row.value.createdAt}
            </p>
            <pre className="continuity-prose">{row.value.body}</pre>
            {row.value.response && (
              <>
                <h2 className="continuity-response-head">Response</h2>
                <pre className="continuity-prose">{row.value.response}</pre>
              </>
            )}
          </>
        )}
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
