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
}

export interface CanvasState {
  nodes: CanvasNode[];
  pan: { x: number; y: number };
  zoom: number;
}

/** Card footprint in canvas units. A node is a real terminal, so this is sized to be
 *  usable at 100% zoom rather than to be a thumbnail. */
export const CARD_W = 560;
export const CARD_H = 340;
/** Title bar height. The live terminal occupies the card BELOW this strip, which is what
 *  leaves the header clickable for dragging while the body takes keystrokes. */
export const HEADER_H = 30;
const GAP = 36;
/** Cards per row when auto-placing. Keeps a fresh project readable rather than a long line. */
const COLS = 3;

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
  if (state.nodes.length === 0 || viewportW <= 0 || viewportH <= 0) {
    return { ...state, pan: { x: padding, y: padding }, zoom: 1 };
  }
  const minX = Math.min(...state.nodes.map((n) => n.x));
  const minY = Math.min(...state.nodes.map((n) => n.y));
  const maxX = Math.max(...state.nodes.map((n) => n.x + CARD_W));
  const maxY = Math.max(...state.nodes.map((n) => n.y + CARD_H));
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
