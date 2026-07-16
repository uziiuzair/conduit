import type { BoardCard as Card, Stage } from "../store";
import { useStore } from "../store";
import { GateAction } from "./GateAction";

const HUMAN_GATES: Stage[] = ["business_clarification", "blocked", "verification"];

export function BoardCard({
  card, projectId, onDragStart, onOpen,
}: {
  card: Card;
  projectId: string;
  onDragStart: (id: string) => void;
  onOpen?: (cardId: string) => void;
}) {
  const claim = card.claim;
  const who = claim ? (claim.by === "human" ? "you" : claim.by) : null;
  const wf = card.workflow;
  const atGate = wf ? HUMAN_GATES.includes(wf.stage) : false;
  const view = useStore((s) => s.continuity[projectId]);
  const presence = view?.presence.find((p) => p.sessionId === card.claim?.by) ?? null;
  const hasHandoff = !!view?.handoffs.some((h) => h.cardId === card.id);
  return (
    <div
      className="board-card"
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(card.id); }}
      onClick={() => onOpen?.(card.id)}
    >
      <div className="board-card-title">{card.title}</div>
      {card.labels.length > 0 && (
        <div className="board-card-labels">
          {card.labels.map((l) => <span key={l} className="board-label">{l}</span>)}
        </div>
      )}
      {wf && <span className="board-stage">{wf.stage.replace(/_/g, " ")}</span>}
      {atGate && <span className="board-gate">needs you</span>}
      {hasHandoff && <span className="board-handoff-badge" title="Handoff waiting — click to read">↪</span>}
      {who && (
        <span className={`board-claim ${claim!.by === "human" ? "human" : "ai"}`}>{who}</span>
      )}
      {claim && (
        <span
          className={`board-presence ${presence?.status ?? "gone"}`}
          title={presence ? `live: ${presence.status}` : "not live"}
        />
      )}
      {atGate && wf && <GateAction projectId={projectId} cardId={card.id} stage={wf.stage} />}
    </div>
  );
}
