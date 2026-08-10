// src/canvas.ts — pure canvas geometry and placement. NO Tauri / Zustand / React imports,
// so vitest exercises all of it in a node env.
//
// The canvas is a second CSS expression of the SAME mounted session set, not a second
// component tree — see docs/superpowers/specs/2026-08-10-project-canvas-view-viability.md.
// Nothing here may reorder nodes: the renderer keys them by session id and must keep list
// order stable, because React reorders DOM to match list order and a reorder is a reparent,
// which kills the PTY.

export interface CanvasNode {
  /** Session id. Also the React key — stable for the node's whole life. */
  ref: string;
  x: number;
  y: number;
  /** Per-node size. Absent = the default card size, which is what every node created
   *  before resizing existed will have — so this stays optional rather than migrating. */
  w?: number;
  h?: number;
}

/**
 * A free-text sticky note on the canvas.
 *
 * Deliberately a SEPARATE array from `nodes` rather than a node with a kind. Nodes are
 * reconciled against the project's live sessions — a node whose session is gone is dropped —
 * and a note has no session to be reconciled against. Folding the two together would mean
 * every reconcile had to remember which nodes are exempt from its own rule, which is exactly
 * the kind of special case that eventually deletes someone's notes.
 */
export interface CanvasNote {
  /** Generated at creation; stable for the note's life and its React key. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface CanvasState {
  nodes: CanvasNode[];
  pan: { x: number; y: number };
  zoom: number;
  /** Optional so every canvas persisted before notes existed still loads. */
  notes?: CanvasNote[];
}

/** Card footprint in canvas units. A node is a real terminal, so this is sized to be
 *  usable at 100% zoom rather than to be a thumbnail. */
export const CARD_W = 560;
export const CARD_H = 340;
/** Title bar height. The live terminal occupies the card BELOW this strip, which is what
 *  leaves the header clickable for dragging while the body takes keystrokes. */
export const HEADER_H = 30;
/** Footer strip height. The terminal stops short of it for the same reason it starts below
 *  the header: the terminal paints ABOVE the card frame, so any affordance that has to stay
 *  clickable — here the resize grip — needs a band the terminal does not cover. */
export const FOOTER_H = 18;
const GAP = 36;
/** Cards per row when auto-placing. Keeps a fresh project readable rather than a long line. */
const COLS = 3;

/** Floor on a resize. Small enough to tuck a node away, large enough that the terminal
 *  inside still has usable columns rather than becoming a one-word-per-line ribbon. */
export const MIN_CARD_W = 320;
export const MIN_CARD_H = 160;

/** A node's effective size, defaulting to the card size when it has never been resized. */
export const nodeW = (n: CanvasNode): number => n.w ?? CARD_W;
export const nodeH = (n: CanvasNode): number => n.h ?? CARD_H;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

/**
 * Below this zoom the live terminals are hidden and cards render as compact summaries.
 *
 * Two independent reasons, either of which alone would justify it. Legibility: a
 * scaled terminal is a resampled bitmap, and 13px type below ~0.55 is mush no matter how
 * it is rendered. Cost: every visible node is a live xterm with a WebGL/canvas surface,
 * and a zoomed-out project is exactly when there are most of them on screen.
 *
 * This is the line that lets Conduit skip the custom glyph renderer nodeterm needed
 * (~11,900 lines) to keep terminals legible at arbitrary zoom.
 */
export const LIVE_ZOOM_MIN = 0.55;

export const emptyCanvas = (): CanvasState => ({ nodes: [], pan: { x: 0, y: 0 }, zoom: 1 });

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * Reconcile a stored canvas against the project's live sessions: drop nodes whose session
 * is gone, and place any session that has no node yet.
 *
 * New nodes are appended, never inserted, and existing nodes keep their array position.
 * That ordering guarantee is load-bearing for the same reason as the note at the top of
 * this file.
 *
 * Auto-placement fills the first free grid slot rather than the slot at the node's index,
 * so deleting a session in the middle does not shuffle everything after it on top of a
 * card the user placed by hand.
 */
export function reconcile(state: CanvasState, sessionIds: string[]): CanvasState {
  const live = new Set(sessionIds);
  const kept = state.nodes.filter((n) => live.has(n.ref));
  const known = new Set(kept.map((n) => n.ref));
  const taken = new Set(kept.map((n) => slotKey(n)));

  const added: CanvasNode[] = [];
  for (const ref of sessionIds) {
    if (known.has(ref)) continue;
    const { x, y } = firstFreeSlot(taken);
    taken.add(`${x},${y}`);
    added.push({ ref, x, y });
  }
  return { ...state, nodes: [...kept, ...added] };
}

/** The grid slot a hand-placed node happens to occupy, so auto-placement avoids it. */
function slotKey(n: CanvasNode): string {
  const col = Math.round(n.x / (CARD_W + GAP));
  const row = Math.round(n.y / (CARD_H + GAP));
  return `${col * (CARD_W + GAP)},${row * (CARD_H + GAP)}`;
}

function firstFreeSlot(taken: Set<string>): { x: number; y: number } {
  for (let i = 0; ; i++) {
    const x = (i % COLS) * (CARD_W + GAP);
    const y = Math.floor(i / COLS) * (CARD_H + GAP);
    if (!taken.has(`${x},${y}`)) return { x, y };
  }
}

/** Move one node. Returns the same object when nothing changed, so React can skip. */
export function moveNode(state: CanvasState, ref: string, x: number, y: number): CanvasState {
  const i = state.nodes.findIndex((n) => n.ref === ref);
  if (i === -1) return state;
  const cur = state.nodes[i];
  if (cur.x === x && cur.y === y) return state;
  const nodes = [...state.nodes];
  nodes[i] = { ...cur, x, y }; // index preserved — see the file header
  return { ...state, nodes };
}

/**
 * Resize one node from its bottom-right corner. Position is untouched, so the node grows
 * away from its top-left and a resize never also looks like a move.
 *
 * Unlike zoom, this DOES change the terminal host's box, so its ResizeObserver fires and
 * xterm refits — the agent's output reflows to the new column count, which is what a
 * resize should do and what a zoom should not.
 */
export function resizeNode(state: CanvasState, ref: string, w: number, h: number): CanvasState {
  const i = state.nodes.findIndex((n) => n.ref === ref);
  if (i === -1) return state;
  const next = { w: Math.max(MIN_CARD_W, w), h: Math.max(MIN_CARD_H, h) };
  const cur = state.nodes[i];
  if (nodeW(cur) === next.w && nodeH(cur) === next.h) return state;
  const nodes = [...state.nodes];
  nodes[i] = { ...cur, ...next }; // index preserved — see the file header
  return { ...state, nodes };
}

/**
 * Zoom about a screen point, so the canvas position under the cursor stays under it.
 * Zooming about the origin instead is the thing that makes a canvas feel broken.
 */
export function zoomAt(
  state: CanvasState,
  factor: number,
  screenX: number,
  screenY: number,
): CanvasState {
  const zoom = clampZoom(state.zoom * factor);
  if (zoom === state.zoom) return state;
  // The canvas point under the cursor before the zoom must map to the same screen point
  // after it: screen = canvas * zoom + pan, solved for the new pan.
  const cx = (screenX - state.pan.x) / state.zoom;
  const cy = (screenY - state.pan.y) / state.zoom;
  return { ...state, zoom, pan: { x: screenX - cx * zoom, y: screenY - cy * zoom } };
}

/** Pan and zoom that fit every node inside a viewport, with padding. */
export function fit(
  state: CanvasState,
  viewportW: number,
  viewportH: number,
  padding = 48,
): CanvasState {
  // Notes count as content: a note placed off to one side is something the user put there
  // on purpose, and a Fit that leaves it outside the viewport has not fitted anything.
  const boxes = [
    ...state.nodes.map((n) => ({ x: n.x, y: n.y, w: nodeW(n), h: nodeH(n) })),
    ...notesOf(state).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
  ];
  if (boxes.length === 0 || viewportW <= 0 || viewportH <= 0) {
    return { ...state, pan: { x: padding, y: padding }, zoom: 1 };
  }
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const zoom = clampZoom(
    Math.min((viewportW - padding * 2) / (maxX - minX), (viewportH - padding * 2) / (maxY - minY)),
  );
  // Centre the content box in the viewport at the chosen zoom.
  return {
    ...state,
    zoom,
    pan: {
      x: (viewportW - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: (viewportH - (maxY - minY) * zoom) / 2 - minY * zoom,
    },
  };
}

/** Screen delta to canvas delta. Dragging must track the cursor at every zoom. */
export const toCanvasDelta = (dx: number, dy: number, zoom: number) => ({
  dx: dx / zoom,
  dy: dy / zoom,
});

/**
 * A point in the viewport to a point on the plane — the inverse of `screen = canvas * zoom
 * + pan`. What "put the new thing where I right-clicked" needs.
 */
export const toCanvasPoint = (state: CanvasState, screenX: number, screenY: number) => ({
  x: (screenX - state.pan.x) / state.zoom,
  y: (screenY - state.pan.y) / state.zoom,
});

// ---- sticky notes ----

/** Default note footprint. Smaller than a card: a note is a sentence, not a terminal. */
export const NOTE_W = 240;
export const NOTE_H = 160;
/** Floor on a note resize — below this the textarea has no usable line. */
export const MIN_NOTE_W = 120;
export const MIN_NOTE_H = 80;
/** Drag strip along a note's top, so the body stays available for selecting text. */
export const NOTE_HEAD_H = 20;

/** A canvas's notes, defaulting to none for state saved before notes existed. */
export const notesOf = (state: CanvasState): CanvasNote[] => state.notes ?? [];

/**
 * Add a note whose TOP-LEFT is at (x, y).
 *
 * The id is supplied rather than generated so this stays pure — the caller owns the only
 * nondeterministic part, and tests get to name their notes.
 */
export function addNote(state: CanvasState, id: string, x: number, y: number): CanvasState {
  const note: CanvasNote = { id, x, y, w: NOTE_W, h: NOTE_H, text: "" };
  return { ...state, notes: [...notesOf(state), note] };
}

/** Update one note in place, preserving array order. Same object back when nothing changed. */
function patchNote(
  state: CanvasState,
  id: string,
  patch: (n: CanvasNote) => CanvasNote,
): CanvasState {
  const notes = notesOf(state);
  const i = notes.findIndex((n) => n.id === id);
  if (i === -1) return state;
  const next = patch(notes[i]);
  if (
    next.x === notes[i].x &&
    next.y === notes[i].y &&
    next.w === notes[i].w &&
    next.h === notes[i].h &&
    next.text === notes[i].text
  ) {
    return state;
  }
  const copy = [...notes];
  copy[i] = next;
  return { ...state, notes: copy };
}

export const moveNote = (state: CanvasState, id: string, x: number, y: number): CanvasState =>
  patchNote(state, id, (n) => ({ ...n, x, y }));

export const resizeNote = (state: CanvasState, id: string, w: number, h: number): CanvasState =>
  patchNote(state, id, (n) => ({
    ...n,
    w: Math.max(MIN_NOTE_W, w),
    h: Math.max(MIN_NOTE_H, h),
  }));

export const setNoteText = (state: CanvasState, id: string, text: string): CanvasState =>
  patchNote(state, id, (n) => ({ ...n, text }));

export function removeNote(state: CanvasState, id: string): CanvasState {
  const notes = notesOf(state);
  const kept = notes.filter((n) => n.id !== id);
  return kept.length === notes.length ? state : { ...state, notes: kept };
}
