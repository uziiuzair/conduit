import { useEffect, useMemo } from "react";
import { useStore } from "../store";
import { type CanvasState, pruneCanvas } from "../canvas";

/**
 * The global board: stored state pruned against the sessions that exist right now, plus a
 * setter.
 *
 * Shared by the two halves of the board — the underlay that draws frames and sections, and
 * the workspace that positions the live terminals — so both read exactly the same
 * coordinates. Two independent prunings would drift by one frame whenever a session went
 * away, and a terminal one frame out of its frame is very visible.
 */
export function useCanvas(): {
  canvas: CanvasState;
  setCanvas: (next: CanvasState) => void;
} {
  const stored = useStore((s) => s.canvas);
  const write = useStore((s) => s.setGlobalCanvas);
  const projects = useStore((s) => s.projects);

  const liveIds = useMemo(
    () => new Set(projects.flatMap((p) => p.sessions.map((s) => s.id))),
    [projects],
  );

  const canvas = useMemo(() => pruneCanvas(stored, liveIds), [stored, liveIds]);

  // Persist a pruning so a removed session does not reappear on reload. Guarded on identity:
  // `pruneCanvas` returns the SAME object when nothing changed, so an unguarded write would
  // loop forever.
  useEffect(() => {
    if (canvas !== stored) write(canvas);
  }, [canvas, stored, write]);

  return { canvas, setCanvas: write };
}
