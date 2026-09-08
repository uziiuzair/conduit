import { describe, expect, it } from "vitest";
import {
  CARD_H,
  CARD_W,
  MIN_CARD_H,
  MIN_CARD_W,
  MIN_NOTE_H,
  MIN_NOTE_W,
  NOTE_H,
  NOTE_W,
  addNodeAt,
  addNote,
  linkEndpoints,
  linkNote,
  migrateNotes,
  moveNote,
  nodeH,
  nodeW,
  notesOf,
  pruneCanvas,
  removeNode,
  removeNote,
  resizeNode,
  resizeNote,
  setNoteText,
  toCanvasPoint,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  emptyCanvas,
  fit,
  moveNode,
  toCanvasDelta,
  zoomAt,
  type CanvasState,
} from "./canvas";

const at = (ref: string, x: number, y: number) => ({ ref, projectId: "p1", x, y });
const node = (ref: string, projectId: string, x: number, y: number) => ({ ref, projectId, x, y });

describe("pruneCanvas", () => {
  it("drops nodes whose session is gone and keeps the rest in order", () => {
    const s: CanvasState = {
      ...emptyCanvas(),
      nodes: [node("a", "p1", 0, 0), node("b", "p2", 100, 0), node("c", "p1", 200, 0)],
    };
    const out = pruneCanvas(s, new Set(["a", "c"]));
    expect(out.nodes.map((n) => n.ref)).toEqual(["a", "c"]);
  });

  it("never places a session that has no node", () => {
    const out = pruneCanvas(emptyCanvas(), new Set(["a", "b"]));
    expect(out.nodes).toEqual([]);
  });

  it("returns the SAME object when nothing changed", () => {
    const s: CanvasState = { ...emptyCanvas(), nodes: [node("a", "p1", 0, 0)] };
    expect(pruneCanvas(s, new Set(["a"]))).toBe(s);
  });

  it("keeps a note whose linked session is gone, and drops only the link", () => {
    let s = addNote(emptyCanvas(), "n1", 0, 0);
    s = linkNote(s, "n1", "gone");
    const out = pruneCanvas(s, new Set<string>());
    expect(notesOf(out)).toHaveLength(1);
    expect(notesOf(out)[0].linkedRef).toBeUndefined();
  });
});

describe("addNodeAt / removeNode", () => {
  it("adds a node carrying its project", () => {
    const s = addNodeAt(emptyCanvas(), "a", "p1", 40, 60);
    expect(s.nodes).toEqual([{ ref: "a", projectId: "p1", x: 40, y: 60 }]);
  });

  it("is idempotent — a session already on the board is not duplicated", () => {
    const s = addNodeAt(addNodeAt(emptyCanvas(), "a", "p1", 0, 0), "a", "p1", 500, 500);
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0].x).toBe(0);
  });

  it("removes a node without touching notes", () => {
    let s = addNodeAt(emptyCanvas(), "a", "p1", 0, 0);
    s = addNote(s, "n1", 10, 10);
    const out = removeNode(s, "a");
    expect(out.nodes).toEqual([]);
    expect(notesOf(out)).toHaveLength(1);
  });

  it("returns the SAME object when removing something absent", () => {
    const s = emptyCanvas();
    expect(removeNode(s, "nope")).toBe(s);
  });
});

describe("migrateNotes", () => {
  it("carries every project's notes onto one plane, offset so they do not overlap", () => {
    const p1: CanvasState = { ...addNote(emptyCanvas(), "n1", 0, 0), nodes: [] };
    const p2: CanvasState = { ...addNote(emptyCanvas(), "n2", 0, 0), nodes: [] };
    const out = migrateNotes({ alpha: p1, beta: p2 });
    expect(notesOf(out).map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    const ys = notesOf(out).map((n) => n.y);
    expect(new Set(ys).size).toBe(2);
  });

  it("carries no nodes — their placements were auto-generated", () => {
    const p1: CanvasState = { ...emptyCanvas(), nodes: [node("a", "alpha", 0, 0)] };
    expect(migrateNotes({ alpha: p1 }).nodes).toEqual([]);
  });

  it("drops a link, since the note's session may not be on the new board", () => {
    let p1 = addNote(emptyCanvas(), "n1", 0, 0);
    p1 = linkNote(p1, "n1", "a");
    expect(notesOf(migrateNotes({ alpha: p1 }))[0].linkedRef).toBeUndefined();
  });
});

describe("moveNode", () => {
  it("moves without changing the node's index", () => {
    const s0: CanvasState = {
      ...emptyCanvas(),
      nodes: [node("a", "p1", 0, 0), node("b", "p1", 100, 0), node("c", "p1", 200, 0)],
    };
    const s1 = moveNode(s0, "b", 500, 500);
    expect(s1.nodes.map((n) => n.ref)).toEqual(["a", "b", "c"]);
    expect(s1.nodes[1]).toEqual(at("b", 500, 500));
  });

  it("returns the same object when nothing moved", () => {
    const s0: CanvasState = { ...emptyCanvas(), nodes: [node("a", "p1", 0, 0)] };
    expect(moveNode(s0, "a", s0.nodes[0].x, s0.nodes[0].y)).toBe(s0);
  });

  it("ignores an unknown ref", () => {
    const s0: CanvasState = { ...emptyCanvas(), nodes: [node("a", "p1", 0, 0)] };
    expect(moveNode(s0, "nope", 1, 1)).toBe(s0);
  });
});

describe("resizeNode", () => {
  it("resizes without moving the node or changing its index", () => {
    const s0: CanvasState = {
      ...emptyCanvas(),
      nodes: [node("a", "p1", 0, 0), node("b", "p1", 100, 0), node("c", "p1", 200, 0)],
    };
    const before = s0.nodes[1];
    const s1 = resizeNode(s0, "b", 700, 500);
    expect(s1.nodes.map((n) => n.ref)).toEqual(["a", "b", "c"]);
    expect(s1.nodes[1].x).toBe(before.x);
    expect(s1.nodes[1].y).toBe(before.y);
    expect([nodeW(s1.nodes[1]), nodeH(s1.nodes[1])]).toEqual([700, 500]);
  });

  it("clamps to a size whose terminal still has usable columns", () => {
    const s0: CanvasState = { ...emptyCanvas(), nodes: [node("a", "p1", 0, 0)] };
    const s1 = resizeNode(s0, "a", 10, 10);
    expect([nodeW(s1.nodes[0]), nodeH(s1.nodes[0])]).toEqual([MIN_CARD_W, MIN_CARD_H]);
  });

  it("returns the same object when the size did not change", () => {
    const s0: CanvasState = { ...emptyCanvas(), nodes: [node("a", "p1", 0, 0)] };
    expect(resizeNode(s0, "a", CARD_W, CARD_H)).toBe(s0);
    expect(resizeNode(s0, "nope", 400, 400)).toBe(s0);
  });

  it("defaults an un-resized node to the card size", () => {
    const s0: CanvasState = { ...emptyCanvas(), nodes: [node("a", "p1", 0, 0)] };
    expect(nodeW(s0.nodes[0])).toBe(CARD_W);
    expect(nodeH(s0.nodes[0])).toBe(CARD_H);
  });

  it("survives a pruneCanvas call", () => {
    // Resizing then pruning must not reset the size — pruneCanvas spreads the node array,
    // so this is really a guard against a future rewrite that rebuilds nodes.
    const s0 = resizeNode(addNodeAt(emptyCanvas(), "a", "p1", 0, 0), "a", 800, 600);
    const s1 = pruneCanvas(addNodeAt(s0, "b", "p1", 100, 0), new Set(["a", "b"]));
    const a = s1.nodes.find((n) => n.ref === "a")!;
    expect([nodeW(a), nodeH(a)]).toEqual([800, 600]);
  });
});

describe("zoomAt", () => {
  it("keeps the canvas point under the cursor fixed", () => {
    const s0 = { ...emptyCanvas(), pan: { x: 30, y: 40 }, zoom: 1 };
    const [sx, sy] = [200, 150];
    const before = { x: (sx - s0.pan.x) / s0.zoom, y: (sy - s0.pan.y) / s0.zoom };
    const s1 = zoomAt(s0, 1.5, sx, sy);
    const after = { x: (sx - s1.pan.x) / s1.zoom, y: (sy - s1.pan.y) / s1.zoom };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("clamps and stops rather than drifting at the limits", () => {
    const zoomedOut = zoomAt({ ...emptyCanvas(), zoom: MIN_ZOOM }, 0.5, 0, 0);
    expect(zoomedOut.zoom).toBe(MIN_ZOOM);
    const zoomedIn = zoomAt({ ...emptyCanvas(), zoom: MAX_ZOOM }, 2, 0, 0);
    expect(zoomedIn.zoom).toBe(MAX_ZOOM);
    // At the limit nothing moved, so the pan must not have shifted either.
    expect(zoomedIn.pan).toEqual({ x: 0, y: 0 });
  });
});

describe("fit", () => {
  it("accounts for a resized node's real extent", () => {
    // fit() used to assume every node was CARD_W x CARD_H; a widened node would then hang
    // off the right edge of a "fitted" view.
    const wide = {
      ...emptyCanvas(),
      nodes: [{ ref: "a", projectId: "p1", x: 0, y: 0, w: 1600, h: 900 }],
    };
    const s = fit(wide, 800, 600);
    expect(1600 * s.zoom + s.pan.x).toBeLessThanOrEqual(800.001);
    expect(900 * s.zoom + s.pan.y).toBeLessThanOrEqual(600.001);
  });

  it("brings every node inside the viewport", () => {
    const s = fit({ ...emptyCanvas(), nodes: [at("a", 0, 0), at("b", 2000, 1400)] }, 800, 600);
    for (const n of s.nodes) {
      const x = n.x * s.zoom + s.pan.x;
      const y = n.y * s.zoom + s.pan.y;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + CARD_W * s.zoom).toBeLessThanOrEqual(800);
      expect(y + CARD_H * s.zoom).toBeLessThanOrEqual(600);
    }
  });

  it("never zooms past the clamp for a single small node", () => {
    const s = fit({ ...emptyCanvas(), nodes: [at("a", 0, 0)] }, 4000, 4000);
    expect(s.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it("survives an empty canvas and a zero-size viewport", () => {
    expect(fit(emptyCanvas(), 800, 600).zoom).toBe(1);
    expect(fit({ ...emptyCanvas(), nodes: [at("a", 0, 0)] }, 0, 0).zoom).toBe(1);
  });
});

describe("sticky notes", () => {
  it("adds a note at the point it was asked for", () => {
    const s = addNote(emptyCanvas(), "n1", 120, 240);
    expect(notesOf(s)).toEqual([
      { id: "n1", x: 120, y: 240, w: NOTE_W, h: NOTE_H, text: "" },
    ]);
  });

  it("reads as no notes on a canvas saved before notes existed", () => {
    // The field is optional precisely so old persisted state loads; this is that contract.
    const legacy = { nodes: [], pan: { x: 0, y: 0 }, zoom: 1 };
    expect(notesOf(legacy)).toEqual([]);
    expect(notesOf(addNote(legacy, "n1", 0, 0))).toHaveLength(1);
  });

  it("moves, resizes, and edits without disturbing the others", () => {
    let s = addNote(addNote(emptyCanvas(), "a", 0, 0), "b", 500, 0);
    s = moveNote(s, "b", 700, 100);
    s = resizeNote(s, "b", 400, 300);
    s = setNoteText(s, "b", "check the reaper grace window");
    expect(notesOf(s)[0]).toEqual({ id: "a", x: 0, y: 0, w: NOTE_W, h: NOTE_H, text: "" });
    expect(notesOf(s)[1]).toEqual({
      id: "b",
      x: 700,
      y: 100,
      w: 400,
      h: 300,
      text: "check the reaper grace window",
    });
  });

  it("clamps a resize to a size that still holds a line of text", () => {
    const s = resizeNote(addNote(emptyCanvas(), "a", 0, 0), "a", 5, 5);
    expect([notesOf(s)[0].w, notesOf(s)[0].h]).toEqual([MIN_NOTE_W, MIN_NOTE_H]);
  });

  it("returns the same object when nothing changed", () => {
    const s = addNote(emptyCanvas(), "a", 10, 10);
    expect(moveNote(s, "a", 10, 10)).toBe(s);
    expect(setNoteText(s, "a", "")).toBe(s);
    expect(moveNote(s, "nope", 1, 1)).toBe(s);
    expect(removeNote(s, "nope")).toBe(s);
  });

  it("removes a note", () => {
    const s = removeNote(addNote(addNote(emptyCanvas(), "a", 0, 0), "b", 0, 0), "a");
    expect(notesOf(s).map((n) => n.id)).toEqual(["b"]);
  });

  it("survives a pruneCanvas call, which owns sessions and must not touch notes", () => {
    // The reason notes are a separate array: pruneCanvas drops nodes whose session is gone,
    // and a note has no session to be gone.
    const s = addNote(addNodeAt(emptyCanvas(), "s1", "p1", 0, 0), "n1", 40, 40);
    const after = pruneCanvas(s, new Set());
    expect(after.nodes).toEqual([]);
    expect(notesOf(after)).toHaveLength(1);
  });

  it("is included in fit, so a note off to one side is not left off-screen", () => {
    const withNote = addNote({ ...emptyCanvas(), nodes: [at("a", 0, 0)] }, "n1", 2400, 1600);
    const s = fit(withNote, 800, 600);
    const n = notesOf(s)[0];
    expect(n.x * s.zoom + s.pan.x).toBeGreaterThanOrEqual(-0.001);
    expect((n.x + n.w) * s.zoom + s.pan.x).toBeLessThanOrEqual(800.001);
    expect((n.y + n.h) * s.zoom + s.pan.y).toBeLessThanOrEqual(600.001);
  });

  it("fits a canvas that has only notes", () => {
    const only = addNote(emptyCanvas(), "n1", 900, 900);
    const s = fit(only, 800, 600);
    expect(s.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    expect(notesOf(s)[0].x * s.zoom + s.pan.x).toBeGreaterThanOrEqual(-0.001);
  });
});

describe("note links", () => {
  const withNote = () =>
    addNote(
      { ...emptyCanvas(), nodes: [node("s1", "p1", 0, 0), node("s2", "p1", 100, 0)] },
      "n1",
      0,
      0,
    );

  it("points a note at a session and back at nothing", () => {
    let s = linkNote(withNote(), "n1", "s1");
    expect(notesOf(s)[0].linkedRef).toBe("s1");
    s = linkNote(s, "n1", "s2");
    expect(notesOf(s)[0].linkedRef).toBe("s2");
    s = linkNote(s, "n1", null);
    // Absent, not undefined: persisted state round-trips through JSON, which drops one and
    // keeps the other, and absent is what a note that never had a link looks like.
    expect("linkedRef" in notesOf(s)[0]).toBe(false);
  });

  it("returns the same object when the link did not change", () => {
    const s = linkNote(withNote(), "n1", "s1");
    expect(linkNote(s, "n1", "s1")).toBe(s);
    expect(linkNote(s, "nope", "s1")).toBe(s);
    // Unlinking a note that was never linked is also a no-op.
    const fresh = withNote();
    expect(linkNote(fresh, "n1", null)).toBe(fresh);
  });

  it("keeps the note but drops the link when the session is deleted", () => {
    // The note is the user's writing and is never ours to delete. The link points at
    // something that no longer exists, and a tether to nowhere is worse than none.
    const s = linkNote(withNote(), "n1", "s1");
    const after = pruneCanvas(s, new Set(["s2"]));
    expect(notesOf(after)).toHaveLength(1);
    expect(notesOf(after)[0].text).toBe("");
    expect("linkedRef" in notesOf(after)[0]).toBe(false);
  });

  it("leaves a live link alone across a pruneCanvas call", () => {
    const s = linkNote(withNote(), "n1", "s1");
    expect(notesOf(pruneCanvas(s, new Set(["s1", "s2"])))[0].linkedRef).toBe("s1");
  });

  it("still prunes a canvas that has no notes at all", () => {
    const s: CanvasState = { ...emptyCanvas(), nodes: [node("s1", "p1", 0, 0)] };
    expect(pruneCanvas(s, new Set(["s1"]))).toBe(s);
    expect(s.notes).toBeUndefined();
  });
});

describe("linkEndpoints", () => {
  it("runs centre to centre, which the boxes then clip by painting over it", () => {
    const note = { id: "n", x: 0, y: 0, w: 200, h: 100, text: "" };
    const n = { ref: "s", projectId: "p1", x: 400, y: 300, w: 600, h: 400 };
    expect(linkEndpoints(note, n)).toEqual({ x1: 100, y1: 50, x2: 700, y2: 500 });
  });

  it("uses the default card size for a node that was never resized", () => {
    const note = { id: "n", x: 0, y: 0, w: 100, h: 100, text: "" };
    const n = { ref: "s", projectId: "p1", x: 0, y: 0 };
    expect(linkEndpoints(note, n)).toEqual({
      x1: 50,
      y1: 50,
      x2: CARD_W / 2,
      y2: CARD_H / 2,
    });
  });
});

describe("toCanvasPoint", () => {
  it("inverts the plane transform, so a right-click lands where it was aimed", () => {
    const s = { ...emptyCanvas(), pan: { x: 120, y: -40 }, zoom: 1.5 };
    const p = toCanvasPoint(s, 300, 200);
    // Round-trip through the forward transform the renderer applies.
    expect(p.x * s.zoom + s.pan.x).toBeCloseTo(300, 6);
    expect(p.y * s.zoom + s.pan.y).toBeCloseTo(200, 6);
  });
});

describe("misc", () => {
  it("clamps zoom into range", () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });

  it("scales a drag delta by zoom so the card tracks the cursor", () => {
    expect(toCanvasDelta(100, 50, 2)).toEqual({ dx: 50, dy: 25 });
    expect(toCanvasDelta(100, 50, 0.5)).toEqual({ dx: 200, dy: 100 });
  });
});
