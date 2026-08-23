import { describe, it, expect } from "vitest";
import {
  cycleTabRef,
  isMixedLayout,
  layoutProjectIds,
  moveTab,
  projectAccent,
  projectHue,
  reopenTabAt,
  repairLayout,
  splitTab,
  tabProjectId,
  type LayoutProject,
} from "./layout";
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


// ---- cross-project panes ----

/** Project A hosts the layout; project B's session s2 is BORROWED into a second pane. */
const MIXED = (): ProjectLayout => ({
  groups: [
    { id: "g1", tabs: [{ kind: "session", ref: "s1" }], activeRef: "s1" },
    { id: "g2", tabs: [{ kind: "session", ref: "s2", projectId: "B" }], activeRef: "s2" },
  ],
  activeGroupId: "g1",
  weights: [0.5, 0.5],
});
const PROJECTS: LayoutProject[] = [
  { id: "A", sessions: [{ id: "s1" }] },
  { id: "B", sessions: [{ id: "s2" }] },
];

describe("tabProjectId", () => {
  it("falls back to the host, which is what every pre-feature tab is", () => {
    expect(tabProjectId({ kind: "session", ref: "s1" }, "A")).toBe("A");
  });
  it("honours an explicit owner", () => {
    expect(tabProjectId({ kind: "session", ref: "s2", projectId: "B" }, "A")).toBe("B");
  });
});

describe("layoutProjectIds / isMixedLayout", () => {
  it("lists the host first, then borrowed projects in first-appearance order", () => {
    expect(layoutProjectIds(MIXED(), "A")).toEqual(["A", "B"]);
  });
  it("does not call an all-local layout mixed", () => {
    // The common case must stay badge-free, or every user pays for a feature few use.
    expect(isMixedLayout(L(), "A")).toBe(false);
    expect(isMixedLayout(MIXED(), "A")).toBe(true);
  });
  it("counts the host even when it contributes no tabs", () => {
    const l: ProjectLayout = {
      groups: [{ id: "g1", tabs: [{ kind: "session", ref: "s2", projectId: "B" }], activeRef: "s2" }],
      activeGroupId: "g1",
      weights: [1],
    };
    expect(isMixedLayout(l, "A")).toBe(true);
  });
});

describe("projectAccent", () => {
  it("is stable for an id and lands on the hue circle", () => {
    expect(projectHue("A")).toBe(projectHue("A"));
    for (const id of ["A", "B", "conduit", "9f3c1e", ""]) {
      const h = projectHue(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
    expect(projectAccent("A")).toMatch(/^hsl\(\d+ 58% 62%\)$/);
  });
  it("separates ids that differ by one character", () => {
    // Sequential uids are the norm, and neighbouring hues would defeat the whole point.
    const a = projectHue("p1");
    const b = projectHue("p2");
    const gap = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    expect(gap).toBeGreaterThan(20);
  });
});

describe("repairLayout", () => {
  it("keeps a borrowed tab whose own project still has the session", () => {
    // The regression that would collapse the feature instantly: a repair runs on EVERY
    // layout write, so validating a foreign tab against the HOST would drop it at once.
    const r = repairLayout(MIXED(), "A", PROJECTS, "new");
    expect(r.groups).toHaveLength(2);
    expect(r.groups[1].tabs[0].ref).toBe("s2");
    expect(r.groups[1].tabs[0].projectId).toBe("B");
  });

  it("drops a borrowed tab when its session is gone", () => {
    const r = repairLayout(MIXED(), "A", [{ id: "A", sessions: [{ id: "s1" }] }, { id: "B", sessions: [] }], "new");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].id).toBe("g1");
    expect(r.weights).toEqual([1]);
  });

  it("drops a borrowed tab when its whole project is gone", () => {
    const r = repairLayout(MIXED(), "A", [{ id: "A", sessions: [{ id: "s1" }] }], "new");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["s1"]);
  });

  it("does not let a borrowed id validate against the host by accident", () => {
    // s2 exists under A here, but the tab claims B — which no longer has it. Matching on
    // ref alone would keep a tab pointing at a session that is not the one it names.
    const r = repairLayout(MIXED(), "A", [{ id: "A", sessions: [{ id: "s1" }, { id: "s2" }] }, { id: "B", sessions: [] }], "new");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["s1"]);
  });

  it("keeps file tabs, which belong to no session", () => {
    const r = repairLayout(L(), "A", PROJECTS, "new");
    expect(r.groups[0].tabs.map((t) => t.ref)).toEqual(["/a", "/b"]);
  });

  it("normalizes weights and returns an empty group when nothing survives", () => {
    const r = repairLayout(MIXED(), "A", [], "new");
    expect(r.groups).toEqual([{ id: "new", tabs: [], activeRef: null }]);
    expect(r.activeGroupId).toBe("new");
    expect(r.weights).toEqual([1]);
  });

  it("re-points a dangling activeRef at the last surviving tab", () => {
    const l: ProjectLayout = {
      groups: [
        {
          id: "g1",
          tabs: [{ kind: "session", ref: "s1" }, { kind: "session", ref: "gone" }],
          activeRef: "gone",
        },
      ],
      activeGroupId: "g1",
      weights: [1],
    };
    const r = repairLayout(l, "A", PROJECTS, "new");
    expect(r.groups[0].activeRef).toBe("s1");
  });
});
