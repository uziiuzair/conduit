import type { BoardCard as Card, Stage } from "../store";
import { GateAction } from "./GateAction";

const HUMAN_GATES: Stage[] = ["business_clarification", "blocked", "verification"];

export function BoardCard({ card, projectId, onDragStart }: { card: Card; projectId: string; onDragStart: (id: string) => void }) {
  const claim = card.claim;
  const who = claim ? (claim.by === "human" ? "you" : claim.by) : null;
  const wf = card.workflow;
  const atGate = wf ? HUMAN_GATES.includes(wf.stage) : false;
  return (
    <div
      className="board-card"
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(card.id); }}
    >
      <div className="board-card-title">{card.title}</div>
      {card.labels.length > 0 && (
        <div className="board-card-labels">
          {card.labels.map((l) => <span key={l} className="board-label">{l}</span>)}
        </div>
      )}
      {wf && <span className="board-stage">{wf.stage.replace(/_/g, " ")}</span>}
      {atGate && <span className="board-gate">needs you</span>}
      {who && <span className={`board-claim ${claim!.by === "human" ? "human" : "ai"}`}>{who}</span>}
      {atGate && wf && <GateAction projectId={projectId} cardId={card.id} stage={wf.stage} />}
    </div>
  );
}
