import type { BoardCard as Card } from "../store";

export function BoardCard({ card, onDragStart }: { card: Card; onDragStart: (id: string) => void }) {
  const claim = card.claim;
  const who = claim ? (claim.by === "human" ? "you" : claim.by) : null;
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
      {who && <span className={`board-claim ${claim!.by === "human" ? "human" : "ai"}`}>{who}</span>}
    </div>
  );
}
