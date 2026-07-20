import type { BoardCard as Card, CardHandoff, Presence } from "../store";

/** Read-only continuity detail panel for a board card: claim/presence, body, incoming
 *  handoff context, labels, comments. Conduit never writes continuity (the agent's own
 *  tools accept a handoff), so there is deliberately no "Accept" action here. */
export function BoardCardDetail({
  card, handoff, presence, onClose,
}: {
  card: Card;
  handoff: CardHandoff | null;
  presence: Presence | null;
  onClose: () => void;
}) {
  const claimWho = card.claim ? (card.claim.by === "human" ? "you" : card.claim.by) : null;
  return (
    <div className="board-detail">
      <div className="board-detail-head">
        <span className="board-detail-title">{card.title}</span>
        <button className="board-detail-close" onClick={onClose} title="Close">✕</button>
      </div>
      {card.workflow && (
        <div className="board-detail-stage">{card.workflow.stage.replace(/_/g, " ")}</div>
      )}
      {claimWho && (
        <div className="board-detail-row">
          <span className="label">Claimed</span>
          <span className={`board-presence ${presence?.status ?? "gone"}`} />
          {claimWho} {presence ? `· ${presence.status}` : "· not live"}
        </div>
      )}
      {card.body && <div className="board-detail-body">{card.body}</div>}
      {handoff && (
        <div className="board-detail-handoff">
          <div className="board-detail-section">
            Incoming handoff{handoff.fromLabel ? ` · from ${handoff.fromLabel}` : ""}
          </div>
          <div className="board-detail-context">{handoff.context}</div>
          {handoff.suggestedNextActions && (
            <>
              <div className="board-detail-section">Suggested next</div>
              <div className="board-detail-context">{handoff.suggestedNextActions}</div>
            </>
          )}
          {handoff.state && (
            <>
              <div className="board-detail-section">State</div>
              <pre className="board-detail-pre">{handoff.state}</pre>
            </>
          )}
          <div className="board-detail-hint">
            Assign this card to a session; it accepts the handoff with its own tools.
          </div>
        </div>
      )}
      {card.labels.length > 0 && (
        <div className="board-detail-labels">
          {card.labels.map((l) => <span key={l} className="board-label">{l}</span>)}
        </div>
      )}
      {card.comments.length > 0 && (
        <div className="board-detail-comments">
          <div className="board-detail-section">Comments</div>
          {card.comments.map((c, i) => (
            <div key={i} className="board-detail-comment"><b>{c.by}</b> {c.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}
