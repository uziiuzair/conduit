import { useCallback, useEffect, useMemo } from "react";
import { useStore } from "../store";
import { type CanvasState, pruneCanvas } from "../canvas";
import { emptyHistory, pushHistory, redo as redoHistory, undo as undoHistory } from "../canvasHistory";

/**
 * One board, one undo/redo timeline — module-scoped rather than component state (or a
 * ref owned by one component) because TWO components edit the same board through this
 * hook (`CanvasUnderlay` and `CanvasControls`), and each calls `useCanvas()`
 * independently. A history living in either one would only see that component's own
 * edits: a note added from `CanvasControls`' toolbar would be invisible to a history kept
 * in `CanvasUnderlay`, so Cmd+Z after it would skip straight past it to undo whatever
 * came before instead — an undo that misses one route to creating something is a broken
 * undo, not a partial one. One module-scoped timeline is what makes every consumer share
 * the same one without knowing about each other.
 */
let boardHistory = emptyHistory<CanvasState>();

/**
 * The global board: stored state pruned against the sessions that exist right now, plus a
 * setter and the undo/redo/snapshot trio that share one timeline (see `boardHistory`
 * above).
 *
 * Shared by the two halves of the board — the underlay that draws frames and sections, and
 * the workspace that positions the live terminals — so both read exactly the same
 * coordinates. Two independent prunings would drift by one frame whenever a session went
 * away, and a terminal one frame out of its frame is very visible.
 */
export function useCanvas(): {
  canvas: CanvasState;
  setCanvas: (next: CanvasState) => void;
  /** Record the state as it was BEFORE a gesture or a discrete edit. A discrete,
   *  non-drag action (adding a note, deleting the selection, linking a note) calls this
   *  once, immediately before its own `setCanvas`. A pointer-drag gesture (move/resize)
   *  must call it LAZILY instead — once, on the first pointermove that crosses the
   *  click/drag threshold, never at pointerdown — because pointerdown also fires on a
   *  plain selection click, and `pushHistory` only dedupes a snapshot against the entry
   *  immediately BEFORE it: a snapshot taken at every pointerdown left one dead undo
   *  entry behind the first click after any real edit (whose `canvas` differs from what
   *  came before it), not merely repeated no-op clicks in a row. See CanvasUnderlay's
   *  onPointerMove for where the drag path calls this today. */
  snapshot: () => void;
  /** Step back one edit. No-op when there is nothing to undo. */
  undo: () => void;
  /** Step forward one edit. No-op when there is nothing to redo. */
  redo: () => void;
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

  const snapshot = useCallback(() => {
    boardHistory = pushHistory(boardHistory, canvas);
  }, [canvas]);

  // Undo/redo restore CONTENT only — pan and zoom are camera state, not an edit, and are
  // deliberately carried forward from the CURRENT canvas rather than taken from the
  // restored snapshot. This looks like two dropped fields, but it is not an oversight:
  // pan/zoom live on CanvasState because that is what gets persisted, not because a camera
  // move is a fact undo should ever revert. Teleporting the view as a side effect of
  // fixing a content mistake is disorienting — you would lose your place as the price of
  // undoing — and no canvas tool restores the camera on undo. One accepted consequence:
  // a Fit or a zoom-reset, which change only the camera, are therefore not undoable by
  // this mechanism — correctly, since they are navigation, not an edit, and the camera's
  // own controls are what undo them.
  const undo = useCallback(() => {
    const step = undoHistory(boardHistory, canvas);
    if (!step) return;
    boardHistory = step.history;
    write({ ...step.state, pan: canvas.pan, zoom: canvas.zoom });
  }, [canvas, write]);

  const redo = useCallback(() => {
    const step = redoHistory(boardHistory, canvas);
    if (!step) return;
    boardHistory = step.history;
    write({ ...step.state, pan: canvas.pan, zoom: canvas.zoom });
  }, [canvas, write]);

  return { canvas, setCanvas: write, snapshot, undo, redo };
}
