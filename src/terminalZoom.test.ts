import { describe, expect, it } from "vitest";
import { LIVE_ZOOM_MIN, MAX_ZOOM } from "./canvas";
import { FONT_LADDER, fontForZoom, rungsFor, snapZoom } from "./terminalZoom";

describe("FONT_LADDER", () => {
  it("is strictly ascending integers", () => {
    for (let i = 1; i < FONT_LADDER.length; i++) {
      expect(FONT_LADDER[i]).toBeGreaterThan(FONT_LADDER[i - 1]);
      expect(Number.isInteger(FONT_LADDER[i])).toBe(true);
    }
  });
});

describe("rungsFor", () => {
  it("keeps only rungs whose zoom is legible and within range", () => {
    const rungs = rungsFor(13);
    for (const font of rungs) {
      const zoom = font / 13;
      expect(zoom).toBeGreaterThanOrEqual(LIVE_ZOOM_MIN);
      expect(zoom).toBeLessThanOrEqual(MAX_ZOOM);
    }
    // 13 itself is 1.0 and must always survive: it is the unzoomed state.
    expect(rungs).toContain(13);
  });

  it("never returns an empty ladder, whatever the base", () => {
    for (const base of [8, 10, 13, 16, 20]) {
      expect(rungsFor(base).length).toBeGreaterThan(0);
    }
  });
});

describe("snapZoom", () => {
  it("leaves 1.0 exactly alone", () => {
    expect(snapZoom(1, 13)).toBe(1);
  });

  it("snaps to the nearest rung", () => {
    // 9/13 = 0.6923, 10/13 = 0.7692. 0.70 is nearer the first.
    expect(snapZoom(0.7, 13)).toBeCloseTo(9 / 13, 6);
    expect(snapZoom(0.75, 13)).toBeCloseTo(10 / 13, 6);
  });

  it("does not snap below the legibility floor, where no terminal renders", () => {
    expect(snapZoom(0.3, 13)).toBe(0.3);
  });

  it("clamps rather than snapping past the top of the range", () => {
    expect(snapZoom(5, 13)).toBe(MAX_ZOOM);
  });
});

describe("fontForZoom", () => {
  it("returns the base at zoom 1", () => {
    expect(fontForZoom(1, 13)).toBe(13);
  });

  it("returns an integer at every rung", () => {
    for (const font of rungsFor(13)) {
      expect(fontForZoom(font / 13, 13)).toBe(font);
    }
  });

  it("returns the smallest rung below the legibility floor", () => {
    expect(fontForZoom(0.1, 13)).toBe(rungsFor(13)[0]);
  });
});
