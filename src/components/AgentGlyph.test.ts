import { describe, it, expect } from "vitest";
import { AGENT_MARKS, glyphStateFor } from "./AgentGlyph";
import { AGENTS } from "../agents";

// Node-env only: this imports the module for its two pure exports and never renders the
// component, so no DOM is involved.

describe("glyphStateFor", () => {
  it("draws no ring on a session that has never started", () => {
    // The ring only means something if most rows do not have one.
    expect(glyphStateFor("idle", false)).toBeUndefined();
    expect(glyphStateFor(undefined, false)).toBeUndefined();
  });

  it("rings a loaded but quiet session", () => {
    expect(glyphStateFor("idle", true)).toBe("idle");
  });

  it("ranks needing you above being busy", () => {
    // A session that is both mid-tool and blocked on a permission prompt is, to the user,
    // blocked — surfacing "working" would hide the thing they have to act on.
    expect(glyphStateFor("needsInput", true, true)).toBe("needsInput");
  });

  it("shows compaction as working", () => {
    // Distinct as a sidebar chip (the word is useful), identical as a ring: busy, don't type.
    expect(glyphStateFor("idle", true, true)).toBe("running");
    expect(glyphStateFor("running", true)).toBe("running");
  });

  it("keeps a finished session distinct from an idle one", () => {
    expect(glyphStateFor("done", true)).toBe("done");
  });

  it("survives a status string it has never heard of", () => {
    // Statuses arrive from the hook stream; an unknown one must degrade to "it's loaded",
    // not to a blank glyph on a live session.
    expect(glyphStateFor("some-future-status", true)).toBe("idle");
  });
});

describe("AGENT_MARKS", () => {
  it("has a mark for every agent Conduit can spawn", () => {
    // A missing mark silently falls back to a monogram, which is the thing these replaced.
    for (const a of AGENTS) expect(AGENT_MARKS[a.id], a.id).toBeDefined();
  });

  it("keeps each mark a single path in its source viewBox", () => {
    for (const a of AGENTS) {
      const mark = AGENT_MARKS[a.id]!;
      expect(mark.viewBox, a.id).toMatch(/^0 0 \d+ \d+$/);
      // One path, so `fill: currentColor` tints the whole mark and nothing carries a
      // hardcoded brand colour that would fight the theme.
      expect(mark.path.length, a.id).toBeGreaterThan(20);
      expect(mark.path, a.id).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });
});
