import { describe, it, expect } from "vitest";
import { mergeSlices } from "./storeSync";
import type { Project, ProjectLayout, Session } from "./store";

const session = (id: string): Session => ({
  id,
  name: id,
  useWorktree: false,
  agent: "claude",
});

const project = (id: string, sessions: Session[] = []): Project => ({
  id,
  name: id,
  path: `/repo/${id}`,
  sessions,
});

const layout = (tag: string): ProjectLayout => ({
  groups: [{ id: tag, tabs: [], activeRef: null }],
  activeGroupId: tag,
  weights: [1],
});

const makeLayout = (p: Project): ProjectLayout => layout(`made-${p.id}`);

/** Every existing test predates `mountedIds` and asserts switch-mode-equivalent
 *  behavior — passing every known id keeps that behavior unchanged. */
const allIds = (...ps: Project[]) => new Set(ps.map((p) => p.id));

describe("mergeSlices", () => {
  it("(a) adds a fetched-new project with a layout built via makeLayout", () => {
    const current = { projects: [], layouts: {} };
    const fetched = [project("p1")];

    const result = mergeSlices(current, fetched, makeLayout, allIds(...fetched));

    expect(result.projects).toEqual(fetched);
    expect(result.addedProjectIds).toEqual(["p1"]);
    expect(result.removedProjectIds).toEqual([]);
    expect(result.layouts.p1).toEqual(layout("made-p1"));
  });

  it("(b) an existing MOUNTED project keeps its LOCAL layout object identity", () => {
    const localLayout = layout("local");
    const current = { projects: [project("p1")], layouts: { p1: localLayout } };
    // Rust's copy changed shape (new session) but this window's layout must not be replaced.
    const fetched = [project("p1", [session("s1")])];

    const result = mergeSlices(current, fetched, makeLayout, allIds(...fetched));

    expect(result.layouts.p1).toBe(localLayout);
    expect(result.addedProjectIds).toEqual([]);
    expect(result.removedProjectIds).toEqual([]);
  });

  it("(b') an existing project NOT mounted in this window adopts the fetched layout instead", () => {
    const localLayout = layout("local");
    const current = { projects: [project("p1")], layouts: { p1: localLayout } };
    const fetched = [project("p1", [session("s1")])];

    // p1 is not in mountedIds -- this window doesn't render it (a foreign profile's
    // project in window mode), so it has no local edit worth protecting.
    const result = mergeSlices(current, fetched, makeLayout, new Set());

    expect(result.layouts.p1).toEqual(layout("made-p1"));
    expect(result.layouts.p1).not.toBe(localLayout);
    // The project itself still follows the usual identity rule (d): JSON changed -> the
    // fetched object is adopted.
    expect(result.projects[0]).toBe(fetched[0]);
  });

  it("(c) drops a project Rust no longer reports, layout included", () => {
    const current = {
      projects: [project("p1"), project("p2")],
      layouts: { p1: layout("l1"), p2: layout("l2") },
    };
    const fetched = [project("p1")]; // p2 removed elsewhere; Rust is authoritative

    const result = mergeSlices(current, fetched, makeLayout, allIds(...fetched));

    expect(result.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(result.layouts).not.toHaveProperty("p2");
    // Named so the caller (store.ts) can replay removeProject's own dirty/maximized/registry
    // cleanup for exactly these ids — this module has no store or registry to do it itself.
    expect(result.removedProjectIds).toEqual(["p2"]);
  });

  it("(d) adopts fetched session content, preserving reference equality only when the project's JSON is unchanged", () => {
    const unchanged = project("p1", [session("s1")]);
    const changedLocal = project("p2", [session("s2")]);
    const changedFetched = project("p2", [session("s2"), session("s3")]); // new session arrived
    const current = {
      projects: [unchanged, changedLocal],
      layouts: { p1: layout("l1"), p2: layout("l2") },
    };
    const fetched = [
      project("p1", [session("s1")]), // structurally identical, different object
      changedFetched,
    ];

    const result = mergeSlices(current, fetched, makeLayout, allIds(...fetched));

    const p1 = result.projects.find((p) => p.id === "p1");
    const p2 = result.projects.find((p) => p.id === "p2");
    expect(p1).toBe(unchanged); // unchanged JSON -> local reference preserved
    expect(p2).toBe(changedFetched); // changed JSON -> fetched object adopted wholesale
    expect(p2?.sessions.map((s) => s.id)).toEqual(["s2", "s3"]);
    // Local layouts for both existing projects are untouched either way.
    expect(result.layouts.p1).toBe(current.layouts.p1);
    expect(result.layouts.p2).toBe(current.layouts.p2);
    expect(result.removedProjectIds).toEqual([]);
  });
});
