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
  addNote,
  moveNote,
  nodeH,
  nodeW,
  notesOf,
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
  reconcile,
  toCanvasDelta,
  zoomAt,
} from "./canvas";

const at = (ref: string, x: number, y: number) => ({ ref, x, y });

describe("reconcile", () => {
  it("places every session that has no node yet", () => {
    const s = reconcile(emptyCanvas(), ["a", "b"]);
    expect(s.nodes.map((n) => n.ref)).toEqual(["a", "b"]);
    expect(s.nodes[0]).not.toEqual(s.nodes[1]);
  });

  it("drops nodes whose session is gone", () => {
    const s = reconcile({ ...emptyCanvas(), nodes: [at("a", 0, 0), at("b", 0, 0)] }, ["b"]);
    expect(s.nodes.map((n) => n.ref)).toEqual(["b"]);
  });

  it("keeps hand-placed positions untouched", () => {
    const placed = { ...emptyCanvas(), nodes: [at("a", 999, 777)] };
    expect(reconcile(placed, ["a"]).nodes[0]).toEqual(at("a", 999, 777));
  });

  it("preserves node ORDER when a session is added", () => {
    // Load-bearing: the renderer keys by session id and React reorders DOM to match list
    // order. A reorder is a reparent, and a reparent kills the PTY.
    const s0 = reconcile(emptyCanvas(), ["a", "b", "c"]);
    const s1 = reconcile(s0, ["a", "b", "c", "d"]);
    expect(s1.nodes.map((n) => n.ref)).toEqual(["a", "b", "c", "d"]);
  });

  it("preserves the order of survivors when one is removed", () => {
    const s0 = reconcile(emptyCanvas(), ["a", "b", "c"]);
    const s1 = reconcile(s0, ["a", "c"]);
    expect(s1.nodes.map((n) => n.ref)).toEqual(["a", "c"]);
  });

  it("does not auto-place on top of a hand-placed card", () => {
    // Someone dragged "a" onto the origin slot; "b" must land somewhere else.
    const s = reconcile({ ...emptyCanvas(), nodes: [at("a", 0, 0)] }, ["a", "b"]);
    const b = s.nodes.find((n) => n.ref === "b")!;
    expect([b.x, b.y]).not.toEqual([0, 0]);
  });

  it("is idempotent", () => {
    const once = reconcile(emptyCanvas(), ["a", "b", "c"]);
    expect(reconcile(once, ["a", "b", "c"])).toEqual(once);
  });
});

describe("moveNode", () => {
  it("moves without changing the node's index", () => {
    const s0 = reconcile(emptyCanvas(), ["a", "b", "c"]);
    const s1 = moveNode(s0, "b", 500, 500);
    expect(s1.nodes.map((n) => n.ref)).toEqual(["a", "b", "c"]);
    expect(s1.nodes[1]).toEqual(at("b", 500, 500));
  });

  it("returns the same object when nothing moved", () => {
    const s0 = reconcile(emptyCanvas(), ["a"]);
    expect(moveNode(s0, "a", s0.nodes[0].x, s0.nodes[0].y)).toBe(s0);
  });

  it("ignores an unknown ref", () => {
    const s0 = reconcile(emptyCanvas(), ["a"]);
    expect(moveNode(s0, "nope", 1, 1)).toBe(s0);
  });
});

describe("resizeNode", () => {
  it("resizes without moving the node or changing its index", () => {
    const s0 = reconcile(emptyCanvas(), ["a", "b", "c"]);
    const before = s0.nodes[1];
    const s1 = resizeNode(s0, "b", 700, 500);
    expect(s1.nodes.map((n) => n.ref)).toEqual(["a", "b", "c"]);
    expect(s1.nodes[1].x).toBe(before.x);
    expect(s1.nodes[1].y).toBe(before.y);
    expect([nodeW(s1.nodes[1]), nodeH(s1.nodes[1])]).toEqual([700, 500]);
  });

  it("clamps to a size whose terminal still has usable columns", () => {
    const s0 = reconcile(emptyCanvas(), ["a"]);
    const s1 = resizeNode(s0, "a", 10, 10);
    expect([nodeW(s1.nodes[0]), nodeH(s1.nodes[0])]).toEqual([MIN_CARD_W, MIN_CARD_H]);
  });

  it("returns the same object when the size did not change", () => {
    const s0 = reconcile(emptyCanvas(), ["a"]);
    expect(resizeNode(s0, "a", CARD_W, CARD_H)).toBe(s0);
    expect(resizeNode(s0, "nope", 400, 400)).toBe(s0);
  });

  it("defaults an un-resized node to the card size", () => {
    const s0 = reconcile(emptyCanvas(), ["a"]);
    expect(nodeW(s0.nodes[0])).toBe(CARD_W);
    expect(nodeH(s0.nodes[0])).toBe(CARD_H);
  });

  it("survives a reconcile", () => {
    // Resizing then adding a session must not reset the size — `reconcile` spreads the
    // node, so this is really a guard against a future rewrite that rebuilds nodes.
    const s0 = resizeNode(reconcile(emptyCanvas(), ["a"]), "a", 800, 600);
    const s1 = reconcile(s0, ["a", "b"]);
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
    const wide = { ...emptyCanvas(), nodes: [{ ref: "a", x: 0, y: 0, w: 1600, h: 900 }] };
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

  it("survives a reconcile, which owns sessions and must not touch notes", () => {
    // The reason notes are a separate array: reconcile drops nodes whose session is gone,
    // and a note has no session to be gone.
    const s = addNote(reconcile(emptyCanvas(), ["s1"]), "n1", 40, 40);
    const after = reconcile(s, []);
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
