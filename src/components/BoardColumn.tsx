import type { BoardColumn as Col, BoardCard as Card } from "../store";
import { BoardCard } from "./BoardCard";

export function BoardColumn({
  column, cards, onDragStart, onDropCard,
}: {
  column: Col;
  cards: Card[];
  onDragStart: (id: string) => void;
  onDropCard: (columnId: string, beforeCardId: string | null) => void;
}) {
  return (
    <div
      className="board-column"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onDropCard(column.id, null); }}
    >
      <div className="board-column-head">{column.name}<span className="board-count">{cards.length}</span></div>
      <div className="board-column-body">
        {cards.map((c) => (
          <div
            key={c.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.stopPropagation(); e.preventDefault(); onDropCard(column.id, c.id); }}
          >
            <BoardCard card={c} onDragStart={onDragStart} />
          </div>
        ))}
      </div>
    </div>
  );
}
