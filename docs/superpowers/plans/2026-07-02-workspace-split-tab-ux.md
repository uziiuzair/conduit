# Workspace Split / Tab UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** VS Code-style workspace UX: drag-to-reorder tabs, directional **left/right** split via per-pane drop zones, and remove the split button — within the existing column layout model (no Rust/data-model change).

**Architecture:** Extract pure `ProjectLayout` transforms into a framework-agnostic `src/layout.ts` (vitest-tested), wire two thin store actions to them, then rework `WorkspaceCenter`'s native HTML5 drag-and-drop (reorder caret + directional pane overlay) and CSS.

**Tech Stack:** React 19 + TS, Zustand, native HTML5 DnD, vitest. Spec: [`docs/superpowers/specs/2026-07-02-workspace-split-tab-ux-design.md`](../specs/2026-07-02-workspace-split-tab-ux-design.md).

**Conventions:** worktree `/Users/uziiuzair/ooozzy/Conduit/.worktrees/monaco-editor`, branch `feat/monaco-editor`. Conventional Commits ending in the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Don't bump the version. Dev runs: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`.

---

## Task 1 — Pure layout reducers `src/layout.ts` + vitest (TDD)

**Files:** Create `src/layout.ts`, `src/layout.test.ts`.

- [ ] **Step 1: Write the failing tests.** Create `src/layout.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to confirm they fail.** `pnpm test` → FAIL (`Cannot find module './layout'`).

- [ ] **Step 3: Implement `src/layout.ts`:**

```ts
// src/layout.ts — pure ProjectLayout transforms. NO Tauri / Zustand imports, so vitest can
// exercise these in a node env (types are erased `import type`). validateLayout (in store.ts)
// prunes any empty source group + renormalizes weights after these run.
import type { ProjectLayout, WsTab } from "./store";

function clone(l: ProjectLayout): ProjectLayout {
  return {
    groups: l.groups.map((g) => ({ ...g, tabs: [...g.tabs] })),
    activeGroupId: l.activeGroupId,
    weights: [...l.weights],
  };
}

/** Move `ref` from `fromGroupId` to `toGroupId` at `toIndex` (reorder when from === to). */
export function moveTab(
  layout: ProjectLayout,
  fromGroupId: string,
  ref: string,
  toGroupId: string,
  toIndex: number,
): ProjectLayout {
  const l = clone(layout);
  const from = l.groups.find((g) => g.id === fromGroupId);
  const to = l.groups.find((g) => g.id === toGroupId);
  if (!from || !to) return layout;
  const srcIdx = from.tabs.findIndex((t) => t.ref === ref);
  if (srcIdx === -1) return layout;
  const [tab] = from.tabs.splice(srcIdx, 1);
  let idx = Math.max(0, Math.min(toIndex, to.tabs.length));
  if (from === to && srcIdx < idx) idx -= 1; // account for the removed slot
  to.tabs.splice(idx, 0, tab);
  to.activeRef = ref;
  l.activeGroupId = to.id;
  return l;
}

/** Split `ref` into a new single-tab column beside `targetGroupId` (half its width). */
export function splitTab(
  layout: ProjectLayout,
  ref: string,
  targetGroupId: string,
  side: "left" | "right",
  newGroupId: string,
): ProjectLayout {
  const l = clone(layout);
  const targetIdx = l.groups.findIndex((g) => g.id === targetGroupId);
  if (targetIdx === -1) return layout;
  let tab: WsTab | undefined;
  for (const g of l.groups) {
    const i = g.tabs.findIndex((t) => t.ref === ref);
    if (i !== -1) {
      [tab] = g.tabs.splice(i, 1);
      if (g.activeRef === ref) g.activeRef = g.tabs.length ? g.tabs[g.tabs.length - 1].ref : null;
      break;
    }
  }
  if (!tab) return layout;
  const insertAt = side === "left" ? targetIdx : targetIdx + 1;
  const half = l.weights[targetIdx] / 2;
  l.weights[targetIdx] = half;
  l.weights.splice(insertAt, 0, half);
  l.groups.splice(insertAt, 0, { id: newGroupId, tabs: [tab], activeRef: ref });
  l.activeGroupId = newGroupId;
  return l;
}
```

- [ ] **Step 4: Run tests to confirm GREEN.** `pnpm test` → all pass (the 5 registry tests + the new layout tests). Also `pnpm exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit.**

```bash
git add src/layout.ts src/layout.test.ts && git commit -m "feat(layout): pure moveTab/splitTab reducers with vitest

Framework-agnostic ProjectLayout transforms (reorder/move-at-index and
left/right column split with weight halving), unit-tested in a node env.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Store actions wiring

**Files:** Modify `src/store.ts`.

Add two actions that reuse the existing `applyLayout(projectId, fn)` pipeline (clone → reducer → `validateLayout` → `persistLayout`). Keep `openToSide`/`moveTabToGroup` for now (removed in Task 3 once call sites are gone).

- [ ] **Step 1: Import the pure reducers.** At the top of `src/store.ts`:

```ts
import { moveTab as reduceMoveTab, splitTab as reduceSplitTab } from "./layout";
```

- [ ] **Step 2: Declare the actions in the `AppState` interface** (next to `moveTabToGroup`):

```ts
  moveTab: (projectId: string, fromGroupId: string, ref: string, toGroupId: string, toIndex: number) => void;
  splitTab: (projectId: string, ref: string, targetGroupId: string, side: "left" | "right") => void;
```

- [ ] **Step 3: Implement them in the store body** (next to `moveTabToGroup`, using the same id
generator the store already uses for group ids — read how `rOpenToSide`/`defaultLayout` create group
ids and reuse that exact helper, e.g. `newId()`/`crypto.randomUUID()`; match the real code):

```ts
  moveTab: (projectId, fromGroupId, ref, toGroupId, toIndex) =>
    applyLayout(projectId, (l) => reduceMoveTab(l, fromGroupId, ref, toGroupId, toIndex)),

  splitTab: (projectId, ref, targetGroupId, side) =>
    applyLayout(projectId, (l) => reduceSplitTab(l, ref, targetGroupId, side, <NEW_GROUP_ID>)),
```

Replace `<NEW_GROUP_ID>` with the store's real id-generation call (match `rOpenToSide`).

- [ ] **Step 4: Verify.** `pnpm exec tsc --noEmit` → clean. `pnpm test` → all pass.

- [ ] **Step 5: Commit.**

```bash
git add src/store.ts && git commit -m "feat(store): moveTab/splitTab actions over pure layout reducers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — WorkspaceCenter DnD rework + CSS + cleanup (launch-verify)

**Files:** Modify `src/components/WorkspaceCenter.tsx`, `src/theme.css`, `src/store.ts` (remove dead actions), `src/components/Icons.tsx` (remove `SplitIcon` if unused).

Rework the native DnD. Read the real `WorkspaceCenter.tsx` first (tab strip ~245-350, `.term-stack` render ~183-217, drag state/refs ~46-61, `.group-chrome` drop ~139-170, right-edge `.split-dropzone` ~219-237).

- [ ] **Step 1: Remove the split button.** Delete the `.tab-split` `<button>` (with `SplitIcon`) from each tab in `GroupTabStrip`.

- [ ] **Step 2: Tab reorder (insertion caret).** On each tab `<div>`, add `onDragOver`/`onDrop` that compute an insertion index from the cursor vs the tab's horizontal midpoint (`e.currentTarget.getBoundingClientRect()`), track it in state (e.g. `dropTab: { groupId, index } | null`), render a thin accent caret at that boundary, and on drop call `moveTab(projectId, dragData.current.fromGroupId, dragData.current.tab.ref, group.id, index)`. Also allow dropping on the strip's empty fill area → append (`index = group.tabs.length`). Clear the caret on `onDragLeave`/`onDragEnd`.

- [ ] **Step 3: Directional pane overlay (replaces the right-edge zone).** Delete the single `.split-dropzone` block (~219-237). Instead, while `dragging`, render — as a sibling of each `CodeEditorPane`/terminal in `.term-stack`, positioned by the same `geom[gi]` `{left,width}` — a `.pane-dropzones` overlay per group containing three regions (`left`/`center`/`right`). `onDragOver` sets `dropZone: { groupId, zone } | null` (compute zone from cursor x within the region: left third / center / right third) and `e.preventDefault()`; highlight the active region. `onDrop`:
  - `left`/`right` → `splitTab(projectId, dragData.current.tab.ref, group.id, zone)`,
  - `center` → `moveTab(projectId, dragData.current.fromGroupId, dragData.current.tab.ref, group.id, <end index>)`.
  Keep the existing `.group-chrome` strip drop working (or fold it into the strip reorder from Step 2). Clear state on drop/leave/dragend.

- [ ] **Step 4: Wire the new store selectors** in `GroupTabStrip`/`WorkspaceCenter`: add `moveTab`, `splitTab`; remove the `openToSide` selector. Remove any remaining references to `openToSide`/`moveTabToGroup` (the group-chrome drop now uses `moveTab` with an end index, or is superseded by the pane center zone — pick one and keep behavior).

- [ ] **Step 5: Remove now-dead store actions.** In `src/store.ts`, delete `openToSide`/`moveTabToGroup` (interface decls + bodies + the `rOpenToSide` reducer if unused). `grep` to confirm no references remain.

- [ ] **Step 6: CSS.** In `src/theme.css`: delete `.split-dropzone`/`.split-dropzone.active` and `.tab-split` rules (and the `.tab:hover .tab-split` / `:hover` variants). Add: `.pane-dropzones` (absolute, `inset:0`, `display:flex`, `z-index` above the pane, only present while dragging), `.pane-dropzone` regions (flex `1`/`2`/`1` for left/center/right or three equal thirds) with an `--accent`-tinted `.active` highlight, and `.tab-caret` (a ~2px accent vertical bar as the insertion indicator). Reuse existing `--accent`/`color-mix` patterns from the old `.split-dropzone`.

- [ ] **Step 7: Typecheck + build.** `pnpm exec tsc --noEmit` → clean; `pnpm test` → all pass; `pnpm build` → succeeds (do NOT commit `dist/`).

- [ ] **Step 8: Launch-verify (GUI gate — handled by the controller/human).** `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, then confirm: (1) no split button on tabs; (2) drag a tab sideways within a strip → caret shows, drops reorder; (3) drag a tab over a pane's left/right third → that side highlights, drop creates a new column there (target column halves); (4) drag onto a pane's center → tab moves into that group; (5) drag a tab into another strip at a position → moves there; (6) works for terminal tabs too; (7) split panes still resize via the divider; (8) layout persists across restart.

- [ ] **Step 9: Commit.**

```bash
git add src/components/WorkspaceCenter.tsx src/theme.css src/store.ts src/components/Icons.tsx && git commit -m "feat(workspace): VS Code-style tab reorder + directional split, drop the split button

Native-DnD reorder with insertion caret; per-pane left/center/right drop zones
(left/right split into a new column, center moves into the group); removes the
split button and the right-edge split zone; deletes the superseded
openToSide/moveTabToGroup actions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: §2 reducers → Task 1; §3 store → Task 2; §4 DnD + button removal → Task 3; §6 files all covered; §7 testing → Task 1 vitest + Task 3 launch-verify.
- Type consistency: `moveTab`/`splitTab` signatures identical across `layout.ts`, `store.ts`, and Task 3 call sites.
- Placeholder note: `<NEW_GROUP_ID>` in Task 2 Step 3 is an explicit instruction to substitute the store's real id generator (read `rOpenToSide`), not a shipped placeholder.
