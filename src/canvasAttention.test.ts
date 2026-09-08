import { describe, expect, it } from "vitest";
import { WORKING_STALE_MS } from "./statusRules";
import {
  attentionQueue,
  cameraFor,
  easeInOutCubic,
  edgePips,
  interpolateCamera,
} from "./canvasAttention";

const NOW = 1_000_000_000;

describe("attentionQueue", () => {
  it("lists sessions awaiting input, longest wait first", () => {
    const q = attentionQueue(
      [
        { ref: "recent", projectId: "p1", status: "needsInput", updatedAt: NOW - 60_000 },
        { ref: "old", projectId: "p2", status: "needsInput", updatedAt: NOW - 600_000 },
      ],
      NOW,
    );
    expect(q.map((i) => i.ref)).toEqual(["old", "recent"]);
    expect(q[0].waitedMs).toBe(600_000);
  });

  it("ignores idle, running and done sessions", () => {
    const q = attentionQueue(
      [
        { ref: "a", projectId: "p1", status: "idle", updatedAt: NOW },
        { ref: "b", projectId: "p1", status: "running", updatedAt: NOW },
        { ref: "c", projectId: "p1", status: "done", updatedAt: NOW },
      ],
      NOW,
    );
    expect(q).toEqual([]);
  });

  it("includes a session stuck in running past the stale watchdog", () => {
    const q = attentionQueue(
      [{ ref: "stuck", projectId: "p1", status: "running", updatedAt: NOW - WORKING_STALE_MS - 1 }],
      NOW,
    );
    expect(q.map((i) => i.ref)).toEqual(["stuck"]);
  });

  it("treats a missing timestamp as no wait rather than an infinite one", () => {
    const q = attentionQueue([{ ref: "a", projectId: "p1", status: "needsInput" }], NOW);
    expect(q[0].waitedMs).toBe(0);
  });
});

describe("edgePips", () => {
  const viewport = { w: 1000, h: 800 };
  const camera = { pan: { x: 0, y: 0 }, zoom: 1 };

  it("emits nothing for a box already on screen", () => {
    expect(edgePips([{ ref: "a", x: 400, y: 300, w: 100, h: 100 }], camera, viewport)).toEqual([]);
  });

  it("pins a pip to the right border for a box off to the right", () => {
    const [pip] = edgePips([{ ref: "a", x: 5000, y: 380, w: 100, h: 100 }], camera, viewport, 20);
    expect(pip.ref).toBe("a");
    expect(pip.x).toBeCloseTo(viewport.w - 20, 6);
    expect(pip.y).toBeGreaterThan(0);
    expect(pip.y).toBeLessThan(viewport.h);
  });

  it("pins a pip to the top border for a box above", () => {
    const [pip] = edgePips([{ ref: "a", x: 450, y: -5000, w: 100, h: 100 }], camera, viewport, 20);
    expect(pip.y).toBeCloseTo(20, 6);
  });

  it("respects pan and zoom when deciding what is off screen", () => {
    const panned = { pan: { x: -4900, y: 0 }, zoom: 1 };
    expect(edgePips([{ ref: "a", x: 5000, y: 380, w: 100, h: 100 }], panned, viewport)).toEqual([]);
  });

  it("points roughly north-east for a box up and to the right", () => {
    const [pip] = edgePips([{ ref: "a", x: 9000, y: -9000, w: 10, h: 10 }], camera, viewport, 20);
    expect(pip.angle).toBeLessThan(0); // atan2 with a negative dy
    expect(Math.cos(pip.angle)).toBeGreaterThan(0);
  });
});

describe("cameraFor", () => {
  it("centres the box in the viewport at the requested zoom", () => {
    const cam = cameraFor({ ref: "a", x: 1000, y: 1000, w: 200, h: 100 }, { w: 800, h: 600 }, 2);
    // centre of the box in canvas units is (1100, 1050); at zoom 2 that is (2200, 2100)
    expect(cam.pan.x).toBeCloseTo(400 - 2200, 6);
    expect(cam.pan.y).toBeCloseTo(300 - 2100, 6);
    expect(cam.zoom).toBe(2);
  });
});

describe("interpolateCamera", () => {
  const a = { pan: { x: 0, y: 0 }, zoom: 1 };
  const b = { pan: { x: 100, y: 200 }, zoom: 2 };

  it("returns the endpoints exactly", () => {
    expect(interpolateCamera(a, b, 0)).toEqual(a);
    expect(interpolateCamera(a, b, 1)).toEqual(b);
  });

  it("is monotonic in between", () => {
    const mid = interpolateCamera(a, b, 0.5);
    expect(mid.pan.x).toBeGreaterThan(0);
    expect(mid.pan.x).toBeLessThan(100);
    expect(mid.zoom).toBeGreaterThan(1);
  });
});

describe("easeInOutCubic", () => {
  it("pins both ends and passes through the middle", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
  });
});
