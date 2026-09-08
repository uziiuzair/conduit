// src/canvasHistory.ts — undo/redo as a snapshot stack. NO Tauri / Zustand / React imports.
//
// Generic over the snapshot type so it stays testable without the canvas, but it exists for
// `CanvasState`, and it is cheap precisely because that type is already a pure immutable
// value: every transition returns a new object built by spreading the old one, so a
// snapshot shares almost all of its structure with its neighbours and costs a few pointers.
//
// Entries are pushed at GESTURE START, not per pointer-move, so one drag is one undo step.

export interface History<T> {
  /** Oldest first. The last entry is what an undo returns to. */
  past: T[];
  /** Newest first. The head is what a redo returns to. */
  future: T[];
}

/** How far back undo reaches. Snapshots are cheap, but not free, and a board is not a
 *  document anyone edits for hours without a reload. */
export const HISTORY_CAP = 50;

export const emptyHistory = <T>(): History<T> => ({ past: [], future: [] });

/**
 * Record the state as it was BEFORE an edit.
 *
 * A new edit forks the timeline, so the redo stack is discarded — the alternative is a tree,
 * and nobody has ever wanted one in a canvas.
 */
export function pushHistory<T>(h: History<T>, snapshot: T): History<T> {
  if (h.past.length > 0 && h.past[h.past.length - 1] === snapshot) return h;
  const past = [...h.past, snapshot];
  return { past: past.length > HISTORY_CAP ? past.slice(past.length - HISTORY_CAP) : past, future: [] };
}

/** Step back. `current` is what redo will return to. Null when there is nothing to undo. */
export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.past.length === 0) return null;
  const state = h.past[h.past.length - 1];
  return {
    history: { past: h.past.slice(0, -1), future: [current, ...h.future] },
    state,
  };
}

/** Step forward. `current` becomes the newest past entry. Null when there is nothing to redo. */
export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.future.length === 0) return null;
  const [state, ...rest] = h.future;
  return { history: { past: [...h.past, current], future: rest }, state };
}
