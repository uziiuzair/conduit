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
  /**
   * The project owning this session.
   *
   * REQUIRED, which is the opposite of `WsTab.projectId` for borrowed tabs — and correctly
   * so. A tab lives in a project's layout, so absence can mean "the host"; a global board
   * has no host for absence to mean, and a session id alone does not locate its project
   * without scanning every one of them.
   */
  projectId: string;
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
  /**
   * Session this note is ABOUT, if any.
   *
   * Purely an association for the reader — it draws a tether on the canvas and names the
   * session on the note. It is deliberately not context: nothing in it reaches the agent,
   * the spawn path, or any prompt. "Which note goes with what" is a filing question, and
   * answering it by quietly injecting text into a session would be a different feature
   * with a different set of risks.
   */
  linkedRef?: string;
}

export interface CanvasState {
  nodes: CanvasNode[];
  pan: { x: number; y: number };
  zoom: number;
  /** Optional so every canvas persisted before notes existed still loads. */
  notes?: CanvasNote[];
  /** Optional so every canvas persisted before sections existed still loads. */
  sections?: CanvasSection[];
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
 * Drop nodes whose session no longer exists, and strip links to sessions that are gone.
 *
 * The pruning half of what `reconcile` used to do. The PLACING half is deliberately absent:
 * membership on this board is curated, and a session existing is not a reason for it to be
 * on screen — that is what makes a position mean something.
 *
 * Returns the SAME object when nothing changed, which the store's write-back guard relies
 * on to avoid an infinite render loop.
 */
export function pruneCanvas(state: CanvasState, liveSessionIds: Set<string>): CanvasState {
  const kept = state.nodes.filter((n) => liveSessionIds.has(n.ref));
  const notes = notesOf(state);
  // A note whose linked session is gone keeps the note and loses only the link. The note is
  // the user's writing and is never ours to delete; the link points at nothing, and leaving
  // it would draw a tether to nowhere.
  const dangling = notes.some((n) => n.linkedRef !== undefined && !liveSessionIds.has(n.linkedRef));
  if (kept.length === state.nodes.length && !dangling) return state;
  const nextNotes = dangling
    ? notes.map((n) =>
        n.linkedRef !== undefined && !liveSessionIds.has(n.linkedRef) ? stripLink(n) : n,
      )
    : notes;
  return {
    ...state,
    nodes: kept,
    ...(state.notes === undefined && !dangling ? {} : { notes: nextNotes }),
  };
}

/**
 * Put a session on the board at (x, y).
 *
 * Idempotent: a session already present keeps its existing position, so a second drop is
 * harmless rather than a teleport. New nodes are APPENDED and existing ones keep their
 * array index — see the file header for why that ordering is load-bearing.
 */
export function addNodeAt(
  state: CanvasState,
  ref: string,
  projectId: string,
  x: number,
  y: number,
): CanvasState {
  if (state.nodes.some((n) => n.ref === ref)) return state;
  return { ...state, nodes: [...state.nodes, { ref, projectId, x, y }] };
}

/** Take a session off the board. The session itself is untouched and keeps running. */
export function removeNode(state: CanvasState, ref: string): CanvasState {
  const kept = state.nodes.filter((n) => n.ref !== ref);
  return kept.length === state.nodes.length ? state : { ...state, nodes: kept };
}

/** A copy of `note` with no link. Written as a delete so the field is absent, not
 *  `undefined` — persisted state round-trips through JSON, which drops one and keeps the
 *  other, and an absent field is what every note that never had a link looks like. */
function stripLink(note: CanvasNote): CanvasNote {
  const { linkedRef: _drop, ...rest } = note;
  return rest;
}

/** Vertical spacing between one project's migrated notes and the next project's. */
const MIGRATE_ROW_H = 1000;

/**
 * Fold the old per-project canvases into the one global board.
 *
 * Only NOTES cross. The node placements were produced by the auto-placer this design
 * removes, and stacking several projects' coordinate spaces onto one plane would pile cards
 * on top of each other — whereas a note is the user's writing, and `stripLink`'s comment
 * already records that it is never ours to delete.
 *
 * Links are dropped: the linked session may not be on the new board at all, and a tether to
 * nothing is worse than no tether.
 */
export function migrateNotes(old: Record<string, CanvasState>): CanvasState {
  const notes: CanvasNote[] = [];
  const seen = new Set<string>();
  Object.keys(old)
    .sort()
    .forEach((projectId, row) => {
      for (const n of notesOf(old[projectId])) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        notes.push({ ...stripLink(n), y: n.y + row * MIGRATE_ROW_H });
      }
    });
  return { ...emptyCanvas(), ...(notes.length ? { notes } : {}) };
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
  // Notes and sections count as content too: something the user placed or drew on purpose,
  // and a Fit that leaves it outside the viewport has not fitted anything.
  const boxes = [
    ...state.nodes.map((n) => ({ x: n.x, y: n.y, w: nodeW(n), h: nodeH(n) })),
    ...notesOf(state).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
    ...sectionsOf(state).map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h })),
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

/**
 * Point a note at a session, or at nothing (`null`).
 *
 * Association only — see `CanvasNote.linkedRef`. Linking never reads, writes, or sends
 * anything to the session itself.
 */
export function linkNote(state: CanvasState, id: string, ref: string | null): CanvasState {
  const notes = notesOf(state);
  const i = notes.findIndex((n) => n.id === id);
  if (i === -1) return state;
  const cur = notes[i];
  if ((cur.linkedRef ?? null) === ref) return state;
  const copy = [...notes];
  copy[i] = ref === null ? stripLink(cur) : { ...cur, linkedRef: ref };
  return { ...state, notes: copy };
}

/**
 * The tether between a note and the card it is linked to: centre to centre.
 *
 * Centres rather than nearest edges, because the boxes are drawn OVER the line — whatever
 * of it falls inside either box is hidden, so the visible segment is already exactly the
 * gap between them, and edge maths would buy a worse result for more code.
 */
export function linkEndpoints(
  note: CanvasNote,
  node: CanvasNode,
): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: note.x + note.w / 2,
    y1: note.y + note.h / 2,
    x2: node.x + nodeW(node) / 2,
    y2: node.y + nodeH(node) / 2,
  };
}

export function removeNote(state: CanvasState, id: string): CanvasState {
  const notes = notesOf(state);
  const kept = notes.filter((n) => n.id !== id);
  return kept.length === notes.length ? state : { ...state, notes: kept };
}

// ---- sections ----

/**
 * A titled container drawn behind its contents.
 *
 * Purely visual: it groups, and it moves what it holds. It does not broadcast, stop, spawn,
 * or otherwise act on the sessions inside it — those would be a different feature with a
 * different set of risks, and the whole point of this one is organising by hand.
 *
 * Membership is GEOMETRIC and computed on demand (`membersOf`), never stored. There is
 * therefore no list to drift out of sync with position, and nesting is free.
 */
export interface CanvasSection {
  /** Generated at creation; stable for the section's life and its React key. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** Index into `SECTION_PALETTE`. Absent = neutral, which is what a fresh section is. */
  color?: number;
}

export const SECTION_MIN_W = 240;
export const SECTION_MIN_H = 180;

/**
 * Section tints. Deliberately its own short list rather than the project palette: a section
 * is the user's own grouping, and borrowing project colours would make two unrelated
 * meanings share a hue.
 */
export const SECTION_PALETTE: readonly string[] = [
  "#6b7cff",
  "#e0723f",
  "#3fa66b",
  "#c04f8a",
  "#c9a227",
  "#5aa9c9",
];

/** A canvas's sections, defaulting to none for state saved before sections existed. */
export const sectionsOf = (state: CanvasState): CanvasSection[] => state.sections ?? [];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const boxOfNode = (n: CanvasNode): Box => ({ x: n.x, y: n.y, w: nodeW(n), h: nodeH(n) });
export const boxOfNote = (n: CanvasNote): Box => ({ x: n.x, y: n.y, w: n.w, h: n.h });
export const boxOfSection = (s: CanvasSection): Box => ({ x: s.x, y: s.y, w: s.w, h: s.h });

/** True when `inner` sits FULLY inside `outer`. Overlap is not membership: a card half in
 *  and half out belongs to neither, which is the only reading that keeps a drag honest. */
export function containsBox(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export interface Members {
  nodes: string[];
  notes: string[];
  sections: string[];
}

/** Everything geometrically inside a section. The section itself is never a member. */
export function membersOf(state: CanvasState, sectionId: string): Members {
  const self = sectionsOf(state).find((s) => s.id === sectionId);
  if (!self) return { nodes: [], notes: [], sections: [] };
  const outer = boxOfSection(self);
  return {
    nodes: state.nodes.filter((n) => containsBox(outer, boxOfNode(n))).map((n) => n.ref),
    notes: notesOf(state)
      .filter((n) => containsBox(outer, boxOfNote(n)))
      .map((n) => n.id),
    sections: sectionsOf(state)
      .filter((s) => s.id !== sectionId && containsBox(outer, boxOfSection(s)))
      .map((s) => s.id),
  };
}

export function addSection(
  state: CanvasState,
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
): CanvasState {
  const section: CanvasSection = {
    id,
    x,
    y,
    w: Math.max(SECTION_MIN_W, w),
    h: Math.max(SECTION_MIN_H, h),
    title,
  };
  return { ...state, sections: [...sectionsOf(state), section] };
}

/** Update one section in place, preserving array order. Same object back when unchanged. */
function patchSection(
  state: CanvasState,
  id: string,
  patch: (s: CanvasSection) => CanvasSection,
): CanvasState {
  const sections = sectionsOf(state);
  const i = sections.findIndex((s) => s.id === id);
  if (i === -1) return state;
  const next = patch(sections[i]);
  const cur = sections[i];
  if (
    next.x === cur.x &&
    next.y === cur.y &&
    next.w === cur.w &&
    next.h === cur.h &&
    next.title === cur.title &&
    next.color === cur.color
  ) {
    return state;
  }
  const copy = [...sections];
  copy[i] = next;
  return { ...state, sections: copy };
}

/**
 * Resize from the bottom-right. Contents are NOT moved — a resize changes what the section
 * CONTAINS, which is what makes "draw a box around those three" work.
 */
export const resizeSection = (state: CanvasState, id: string, w: number, h: number): CanvasState =>
  patchSection(state, id, (s) => ({
    ...s,
    w: Math.max(SECTION_MIN_W, w),
    h: Math.max(SECTION_MIN_H, h),
  }));

export const setSectionTitle = (state: CanvasState, id: string, title: string): CanvasState =>
  patchSection(state, id, (s) => ({ ...s, title }));

/** `null` clears the colour back to neutral. Written as a delete so the field is absent
 *  rather than `undefined` — persisted state round-trips through JSON, which keeps one and
 *  drops the other, and absent is what a never-coloured section looks like. */
export function setSectionColor(state: CanvasState, id: string, color: number | null): CanvasState {
  return patchSection(state, id, (s) => {
    if (color === null) {
      const { color: _drop, ...rest } = s;
      return rest;
    }
    return { ...s, color };
  });
}

/** Remove the section. What was inside it stays on the plane — deleting a container must
 *  never delete a running session. */
export function removeSection(state: CanvasState, id: string): CanvasState {
  const sections = sectionsOf(state);
  const kept = sections.filter((s) => s.id !== id);
  return kept.length === sections.length ? state : { ...state, sections: kept };
}

/**
 * Translate an explicit set of things by the same delta — how a section drag moves its
 * contents.
 *
 * The membership is passed IN rather than recomputed, because a drag must use the set
 * captured when the gesture started: recomputing mid-drag would let items join and leave as
 * the box swept over them, which reads as the section eating the board.
 */
export function translateMany(
  state: CanvasState,
  members: Members,
  dx: number,
  dy: number,
): CanvasState {
  if (dx === 0 && dy === 0) return state;
  const nodeIds = new Set(members.nodes);
  const noteIds = new Set(members.notes);
  const sectionIds = new Set(members.sections);
  return {
    ...state,
    // Index preserved throughout — see the file header.
    nodes: state.nodes.map((n) => (nodeIds.has(n.ref) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
    ...(state.notes === undefined
      ? {}
      : {
          notes: notesOf(state).map((n) =>
            noteIds.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
          ),
        }),
    ...(state.sections === undefined
      ? {}
      : {
          sections: sectionsOf(state).map((s) =>
            sectionIds.has(s.id) ? { ...s, x: s.x + dx, y: s.y + dy } : s,
          ),
        }),
  };
}

/**
 * Sections back to front: largest first, so a nested section paints over its parent.
 *
 * Derived, never stored. A stored z would mean either an order field to maintain or an
 * array reorder — and reordering is forbidden here, because React reorders DOM to match
 * list order and a reorder is a reparent, which kills a PTY.
 */
export const sectionsByZ = (state: CanvasState): CanvasSection[] =>
  [...sectionsOf(state)].sort((a, b) => b.w * b.h - a.w * a.h);
