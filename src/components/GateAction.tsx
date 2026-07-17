import { invoke } from "@tauri-apps/api/core";
import type { Stage } from "../store";

export function GateAction({ projectId, cardId, stage }: { projectId: string; cardId: string; stage: Stage }) {
  const approveLabel = stage === "verification" ? "Accept" : "Approve";
  const rejectLabel = stage === "verification" ? "Send back" : "Request changes";
  const resolve = (approved: boolean) =>
    invoke("board_resolve_gate", { projectId, id: cardId, approved });
  return (
    <div className="board-gate-actions">
      <button onClick={() => resolve(true)}>{approveLabel}</button>
      <button onClick={() => resolve(false)}>{rejectLabel}</button>
    </div>
  );
}
