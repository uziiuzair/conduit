import { describe, expect, test } from "vitest";
import {
  buildEditorContext,
  closeDiffs,
  popDiff,
  pushDiff,
  visibleDiff,
  type PendingDiff,
} from "./ideBridge";

const d = (sessionId: string, diffId: string, tabName = diffId): PendingDiff => ({
  sessionId,
  diffId,
  tabName,
  oldFilePath: "/a",
  newFilePath: "/a",
  newFileContents: "x",
});

describe("diff queue", () => {
  test("fifo per session, independent across sessions", () => {
    let q: PendingDiff[] = [];
    q = pushDiff(q, d("s1", "d1"));
    q = pushDiff(q, d("s1", "d2"));
    q = pushDiff(q, d("s2", "d3"));
    expect(visibleDiff(q, "s1")?.diffId).toBe("d1");
    q = popDiff(q, "s1", "d1");
    expect(visibleDiff(q, "s1")?.diffId).toBe("d2");
    expect(visibleDiff(q, "s2")?.diffId).toBe("d3");
    expect(visibleDiff(q, "s3")).toBeNull();
  });

  test("a duplicate diffId for the same session is not queued twice", () => {
    let q: PendingDiff[] = [];
    q = pushDiff(q, d("s1", "d1"));
    q = pushDiff(q, d("s1", "d1"));
    expect(q).toHaveLength(1);
  });

  test("closeDiffs by tab name and wholesale", () => {
    const q = [d("s1", "d1", "T1"), d("s1", "d2", "T2"), d("s2", "d3", "T3")];
    expect(closeDiffs(q, "s1", "T1").map((x) => x.diffId)).toEqual(["d2", "d3"]);
    expect(closeDiffs(q, "s1", null).map((x) => x.diffId)).toEqual(["d3"]);
    // untouched input (pure)
    expect(q).toHaveLength(3);
  });
});

test("buildEditorContext shapes tabs and active file", () => {
  const c = buildEditorContext({
    openPaths: [
      { path: "/w/src/a.ts", language: "typescript", active: true },
      { path: "/w/README.md", language: "markdown", active: false },
    ],
    selection: null,
    markers: [],
  });
  expect(c.activeFile).toBe("/w/src/a.ts");
  expect(c.selection).toBeNull();
  expect(c.openFiles).toEqual([
    { path: "/w/src/a.ts", label: "a.ts", languageId: "typescript", active: true },
    { path: "/w/README.md", label: "README.md", languageId: "markdown", active: false },
  ]);
});

test("buildEditorContext with no active file and a selection", () => {
  const sel = {
    text: "x",
    filePath: "/w/a.ts",
    fileUrl: "file:///w/a.ts",
    selection: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
      isEmpty: false,
    },
  };
  const c = buildEditorContext({ openPaths: [], selection: sel, markers: [] });
  expect(c.activeFile).toBeNull();
  expect(c.selection).toEqual(sel);
  expect(c.diagnostics).toEqual([]);
});
