import { useEffect, useMemo } from "react";
import { useStore } from "../store";
import { type CanvasState, emptyCanvas, pruneCanvas } from "../canvas";

/**
 * The canvas for one project: stored state pruned against the sessions that exist right
 * now, plus a setter.
 *
 * Shared by the two halves of the canvas view — the underlay that draws card frames and
 * the workspace that positions the live terminals — so both read exactly the same node
 * coordinates. Two independent prunes would drift by one frame whenever a session is
 * removed, and a terminal one frame out of its frame is very visible.
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
    () => pruneCanvas(stored ?? emptyCanvas(), new Set(sessionIds)),
    [stored, sessionIds],
  );

  // Persist the prune (dropping nodes whose session is gone) so a removal survives a
  // reload. pruneCanvas returns the SAME object when nothing changed, so an identity
  // check would work here too; this guard predates that guarantee and compares node
  // count instead, left as it is since this hook is throwaway (Task 11 replaces it with
  // useCanvas).
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
