import { describe, it, expect } from "vitest";
import { cycleTabRef, moveTab, reopenTabAt, splitTab } from "./layout";
import type { ProjectLayout } from "./store";

const L = (): ProjectLayout => ({
  groups: [
    { id: "g1", tabs: [{ kind: "file", ref: "/a" }, { kind: "file", ref: "/b" }], activeRef: "/a" },
    { id: "g2", tabs: [{ kind: "session", ref: "s1" }], activeRef: "s1" },
  ],
  activeGroupId: "g1",
  weights: [0.6, 0.4],
});

describe("moveTab", () => {
  it("reorders within a group and activates the tab", () => {
    const r = moveTab(L(), "g1", "/a", "g1", 2); // move /a to the end
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["/b", "/a"]);
    expect(r.groups[0].activeRef).toBe("/a");
    expect(r.activeGroupId).toBe("g1");
  });
  it("moves across groups at an index", () => {
    const r = moveTab(L(), "g1", "/b", "g2", 0);
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["/a"]);
    expect(r.groups[1].tabs.map((t) => t.ref)).toEqual(["/b", "s1"]);
    expect(r.groups[1].activeRef).toBe("/b");
    expect(r.activeGroupId).toBe("g2");
  });
  it("is a no-op for an unknown ref or group", () => {
    const base = L();
    expect(moveTab(base, "g1", "/nope", "g2", 0)).toBe(base);
    expect(moveTab(base, "gX", "/a", "g2", 0)).toBe(base);
  });
});

describe("splitTab", () => {
  it("splits right: new column after target, target weight halved", () => {
    const r = splitTab(L(), "/b", "g1", "right", "gNew");
    expect(r.groups.map((g) => g.id)).toEqual(["g1", "gNew", "g2"]);
    expect(r.groups[1].tabs.map((t) => t.ref)).toEqual(["/b"]);
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["/a"]); // /b removed from source
    expect(r.weights).toEqual([0.3, 0.3, 0.4]); // g1 halved 0.6 -> 0.3 + new 0.3
    expect(r.activeGroupId).toBe("gNew");
  });
  it("splits left: new column before target", () => {
    const r = splitTab(L(), "s1", "g1", "left", "gNew");
    expect(r.groups.map((g) => g.id)).toEqual(["gNew", "g1", "g2"]);
    expect(r.weights).toEqual([0.3, 0.3, 0.4]);
  });
  it("fixes source activeRef when the active tab is split out", () => {
    const r = splitTab(L(), "/a", "g1", "right", "gNew");
    expect(r.groups[0].activeRef).toBe("/b"); // was /a, now the remaining tab
  });
  it("is a no-op for an unknown target group", () => {
    const base = L();
    expect(splitTab(base, "/a", "gX", "right", "gNew")).toBe(base);
  });
});

describe("cycleTabRef", () => {
  const g = L().groups[0]; // tabs /a, /b — active /a
  it("steps forward and backward with wrapping", () => {
    expect(cycleTabRef(g, 1)).toBe("/b");
    expect(cycleTabRef(g, -1)).toBe("/b"); // wraps from index 0 to the end
    expect(cycleTabRef({ ...g, activeRef: "/b" }, 1)).toBe("/a"); // wraps forward
  });
  it("returns null with fewer than two tabs", () => {
    expect(cycleTabRef(L().groups[1], 1)).toBe(null);
    expect(cycleTabRef({ tabs: [], activeRef: null }, 1)).toBe(null);
  });
  it("starts from the first tab when activeRef dangles", () => {
    expect(cycleTabRef({ ...g, activeRef: "/gone" }, 1)).toBe("/b");
  });
});

describe("reopenTabAt", () => {
  const tab = { kind: "file", ref: "/c" } as const;
  it("restores at the recorded index in the original group", () => {
    const r = reopenTabAt(L(), "g1", 1, { ...tab });
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["/a", "/c", "/b"]);
    expect(r.groups[0].activeRef).toBe("/c");
    expect(r.activeGroupId).toBe("g1");
  });
  it("clamps an out-of-range index", () => {
    const r = reopenTabAt(L(), "g1", 99, { ...tab });
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["/a", "/b", "/c"]);
  });
  it("falls back to the active group when the original group is gone", () => {
    const r = reopenTabAt(L(), "gGone", 0, { ...tab });
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["/c", "/a", "/b"]);
    expect(r.activeGroupId).toBe("g1");
  });
  it("focuses an existing tab instead of duplicating", () => {
    const r = reopenTabAt(L(), "g2", 0, { kind: "file", ref: "/b" });
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["/a", "/b"]);
    expect(r.groups[1].tabs.map((t) => t.ref)).toEqual(["s1"]);
    expect(r.groups[0].activeRef).toBe("/b");
    expect(r.activeGroupId).toBe("g1");
  });
});
