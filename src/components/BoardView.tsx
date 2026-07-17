import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { BoardCard as Card } from "../store";
import { useBoard } from "../hooks/useBoard";
import { BoardColumn } from "./BoardColumn";
import { BoardCardDetail } from "./BoardCardDetail";

export function BoardView({ projectId }: { projectId: string }) {
  useBoard(projectId, true);
  const snap = useStore((s) => s.boards[projectId]);
  const continuity = useStore((s) => s.continuity[projectId]);
  const dragId = useRef<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [openCardId, setOpenCardId] = useState<string | null>(null);

  const cardsByColumn = useMemo(() => {
    const m: Record<string, Card[]> = {};
    if (snap) for (const c of snap.cards) (m[c.column] ??= []).push(c);
    return m;
  }, [snap]);

  if (!snap) return <div className="board-view board-empty">Loading board…</div>;

  const onDropCard = async (columnId: string, beforeCardId: string | null) => {
    const id = dragId.current;
    dragId.current = null;
    if (!id) return;
    const col = cardsByColumn[columnId] ?? [];
    let after: string | null = null;
    const before: string | null = beforeCardId;
    if (beforeCardId) {
      const idx = col.findIndex((c) => c.id === beforeCardId);
      after = idx > 0 ? col[idx - 1].id : null;
    } else {
      after = col.length ? col[col.length - 1].id : null;
    }
    await invoke("board_move_card", { projectId, id, column: columnId, after, before });
  };

  const addCard = async (columnId: string) => {
    const title = draft.trim();
    setAdding(null); setDraft("");
    if (!title) return;
    await invoke("board_add_card", { projectId, title, body: "", column: columnId });
  };

  return (
    <div className="board-view">
      <div className="board-body">
        <div className="board-columns">
          {snap.columns.map((col) => (
            <div key={col.id} className="board-column-wrap">
              <BoardColumn
                column={col}
                cards={cardsByColumn[col.id] ?? []}
                projectId={projectId}
                onDragStart={(id) => { dragId.current = id; }}
                onDropCard={onDropCard}
                onOpen={setOpenCardId}
                footer={
                  adding === col.id ? (
                    <input
                      className="board-add-input" autoFocus value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => addCard(col.id)}
                      onKeyDown={(e) => { if (e.key === "Enter") addCard(col.id); if (e.key === "Escape") { setAdding(null); setDraft(""); } }}
                    />
                  ) : (
                    <button className="board-add" onClick={() => setAdding(col.id)}>+ Add</button>
                  )
                }
              />
            </div>
          ))}
        </div>
        {openCardId && (() => {
          const card = snap.cards.find((c) => c.id === openCardId);
          if (!card) return null;
          const handoff = continuity?.handoffs.find((h) => h.cardId === card.id) ?? null;
          const presence = continuity?.presence.find((p) => p.sessionId === card.claim?.by) ?? null;
          return (
            <BoardCardDetail
              card={card}
              handoff={handoff}
              presence={presence}
              onClose={() => setOpenCardId(null)}
            />
          );
        })()}
      </div>
    </div>
  );
}
