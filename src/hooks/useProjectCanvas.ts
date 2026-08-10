import { useEffect, useMemo } from "react";
import { useStore } from "../store";
import { type CanvasState, emptyCanvas, reconcile } from "../canvas";

/**
 * The canvas for one project: stored state reconciled against the sessions that exist
 * right now, plus a setter.
 *
 * Shared by the two halves of the canvas view — the underlay that draws card frames and
 * the workspace that positions the live terminals — so both read exactly the same node
 * coordinates. Two independent reconciliations would drift by one frame whenever a
 * session is added, and a terminal one frame out of its frame is very visible.
 */
export function useProjectCanvas(projectId: string | null): {
  canvas: CanvasState;
  setCanvas: (next: CanvasState) => void;
} {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const stored = useStore((s) => (projectId ? s.canvases[projectId] : undefined));
  const write = useStore((s) => s.setCanvas);

  const sessionIds = useMemo(() => (project?.sessions ?? []).map((s) => s.id), [project]);

  const canvas = useMemo(
    () => reconcile(stored ?? emptyCanvas(), sessionIds),
    [stored, sessionIds],
  );

  // Persist the reconciliation (placements for new sessions, pruning for gone ones) so
  // positions survive a reload. Guarded on a real change: reconcile always returns a new
  // object, so writing unconditionally would loop forever.
  useEffect(() => {
    if (!projectId) return;
    if (!stored || stored.nodes.length !== canvas.nodes.length) write(projectId, canvas);
  }, [canvas, stored, projectId, write]);

  const setCanvas = useMemo(
    () => (next: CanvasState) => {
      if (projectId) write(projectId, next);
    },
    [projectId, write],
  );

  return { canvas, setCanvas };
}
