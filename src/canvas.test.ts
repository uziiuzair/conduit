import { describe, expect, it } from "vitest";
import {
  CARD_H,
  CARD_W,
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
