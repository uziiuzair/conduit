import { describe, it, expect } from "vitest";
import { moveTab, splitTab } from "./layout";
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
