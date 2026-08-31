import { describe, it, expect } from "vitest";
import {
  MOUSE_TRACKING_MODES,
  partitionMouseModes,
  decPrivateSeq,
  sgrWheelReport,
  wheelLines,
  cellFromPoint,
} from "./terminalMouse";

describe("partitionMouseModes", () => {
  it("claims the tracking modes and nothing else", () => {
    for (const m of MOUSE_TRACKING_MODES) {
      expect(partitionMouseModes([m])).toEqual({ mouse: [m], other: [] });
    }
    // The SGR/urxvt ENCODINGS are not tracking — they decide how a report is written,
    // and are inert once nothing reports. Passing them through keeps the swallow minimal.
    expect(partitionMouseModes([1006])).toEqual({ mouse: [], other: [1006] });
    expect(partitionMouseModes([2004])).toEqual({ mouse: [], other: [2004] });
  });

  it("splits a combined sequence so the survivors can be replayed", () => {
    expect(partitionMouseModes([1002, 1006, 2004])).toEqual({
      mouse: [1002],
      other: [1006, 2004],
    });
  });

  it("flattens sub-parameters (CSI ? 1000 : 1 h) onto their leading value", () => {
    expect(partitionMouseModes([[1000, 1]])).toEqual({ mouse: [1000], other: [] });
  });

  it("treats a missing parameter (CSI ? h -> 0) as not ours", () => {
    expect(partitionMouseModes([0])).toEqual({ mouse: [], other: [0] });
  });
});

describe("decPrivateSeq", () => {
  it("rebuilds a DEC private set/reset", () => {
    expect(decPrivateSeq([1006, 2004], "h")).toBe("\x1b[?1006;2004h");
    expect(decPrivateSeq([2004], "l")).toBe("\x1b[?2004l");
  });
});

describe("sgrWheelReport", () => {
  it("uses button 64 for up and 65 for down, 1-based cells", () => {
    expect(sgrWheelReport("up", 12, 3)).toBe("\x1b[<64;12;3M");
    expect(sgrWheelReport("down", 1, 1)).toBe("\x1b[<65;1;1M");
  });
});

describe("wheelLines", () => {
  it("accumulates pixel deltas until a whole cell has passed (xterm parity)", () => {
    const cell = 20;
    let a = 0;
    let r = wheelLines(a, 8, 0, cell, 24);
    expect(r.lines).toBe(0);
    a = r.acc;
    r = wheelLines(a, 8, 0, cell, 24);
    expect(r.lines).toBe(0);
    a = r.acc;
    r = wheelLines(a, 8, 0, cell, 24);
    expect(r.lines).toBe(1);
    // The 4px that did not make a whole line is carried, not dropped.
    expect(r.acc).toBeCloseTo(4);
  });

  it("keeps the sign so a scroll up stays a scroll up", () => {
    expect(wheelLines(0, -60, 0, 20, 24).lines).toBe(-3);
  });

  it("reads line and page delta modes without the cell height", () => {
    expect(wheelLines(0, 3, 1, 20, 24).lines).toBe(3);
    expect(wheelLines(0, -1, 2, 20, 24).lines).toBe(-24);
  });

  it("reports nothing when the cell height is not measurable yet", () => {
    expect(wheelLines(0, 100, 0, 0, 24)).toEqual({ lines: 0, acc: 0 });
  });
});

describe("cellFromPoint", () => {
  it("maps a point to a 1-based cell", () => {
    expect(cellFromPoint(0, 0, 800, 480, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(cellFromPoint(105, 45, 800, 480, 80, 24)).toEqual({ col: 11, row: 3 });
  });

  it("clamps a point outside the grid instead of emitting an invalid cell", () => {
    expect(cellFromPoint(-40, -40, 800, 480, 80, 24)).toEqual({ col: 1, row: 1 });
    expect(cellFromPoint(9999, 9999, 800, 480, 80, 24)).toEqual({ col: 80, row: 24 });
  });
});
