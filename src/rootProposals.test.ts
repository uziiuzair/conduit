import { describe, expect, it } from "vitest";
import {
  addDecision,
  approvalFocus,
  removeDecision,
  summarize,
  type PendingDecision,
} from "./rootProposals";

const d = (id: string, createdAt = 100): PendingDecision => ({
  id,
  chatId: "c1",
  projectId: "p1",
  projectName: "conduit",
  task: "add rate limiting",
  createdAt,
});

describe("addDecision", () => {
  it("appends, dedupes by id, and keeps newest first", () => {
    const one = addDecision([], d("a", 100));
    const two = addDecision(one, d("b", 200));
    expect(two.map((x) => x.id)).toEqual(["b", "a"]);
    // The same proposal arriving twice (event plus a catch-up list) must not double.
    expect(addDecision(two, d("b", 200)).map((x) => x.id)).toEqual(["b", "a"]);
    expect(one).toHaveLength(1); // no mutation
  });
});

describe("removeDecision", () => {
  it("drops one and leaves the rest", () => {
    const list = addDecision(addDecision([], d("a")), d("b"));
    expect(removeDecision(list, "a").map((x) => x.id)).toEqual(["b"]);
    expect(removeDecision(list, "ghost")).toHaveLength(2);
  });
});

describe("approvalFocus", () => {
  it("focuses the CARD's project, whatever is selected", () => {
    // Root chat is global, so the approved project is routinely not the selected one —
    // and `Terminal.tsx`'s eager spawn is gated on `projectId === selectedProjectId`, so
    // approving without moving there started nothing at all.
    const card = { ...d("dp-1"), projectId: "p-other", projectName: "billing" };
    expect(approvalFocus(card).projectId).toBe("p-other");
  });

  it("names the project in the toast, because the approval navigates", () => {
    expect(approvalFocus(d("dp-1")).toast).toContain("conduit");
  });
});

describe("summarize", () => {
  it("keeps short tasks whole and clips long ones on a word", () => {
    expect(summarize("ship it")).toBe("ship it");
    const long = "word ".repeat(40).trim();
    const s = summarize(long, 40);
    expect(s.length).toBeLessThanOrEqual(41);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toContain("  ");
  });
});
