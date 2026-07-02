# Workspace Split / Tab UX (VS Code-style) — Design

- **Date:** 2026-07-02
- **Status:** Approved
- **Scope:** Make Conduit's editor/terminal splitting feel like VS Code: **directional left/right
  drop zones**, **drag-to-reorder tabs**, and **remove the split button**. Applies to the shared
  tab strip, so terminals get it too.
- **Non-goals (explicitly out):** up/down splits, nested grids, a split-tree data model. The layout
  stays a flat array of **columns**. Vertical/grid splitting is a possible future effort and would
  require replacing `weights: number[]` with a split-tree.
- **Predecessor:** built on the Monaco editor work (`feat/monaco-editor`); same worktree/branch.

---

## 1. Why this is frontend-only

The current layout is a strict 1-D column model: `ProjectLayout = { groups: EditorGroup[],
activeGroupId, weights: number[] }`, with `weights` index-aligned to `groups`, placed by
`geometry(weights) → {left%, width%}`. Left/right splitting is *inserting a column at an index* —
it does **not** change the data model, so the Rust serde structs, persistence, and `validateLayout`
(which already keeps `groups.length === weights.length` and normalizes) are **unchanged**. Terminals
and editor panes share the same geometry, so the feature works for both, and the keep-alive flat DOM
stack is preserved (inserting a column only re-indexes + repositions panes via CSS — never reparents
an xterm/editor host).

## 2. Pure layout reducers (new module, unit-testable)

Create `src/layout.ts` — **pure** `ProjectLayout → ProjectLayout` transforms with **no** Tauri /
Zustand imports (types imported `import type` from `store.ts`, erased at runtime, so `vitest` can
exercise them in a node env, exactly like `registry.ts`):

- `moveTab(layout, fromGroupId, ref, toGroupId, toIndex): ProjectLayout`
  Unified move: **reorder within a strip** (`fromGroupId === toGroupId`) or **move to another strip
  at a position**. Removes `ref` from its source group, inserts it at `toIndex` in the destination
  group's `tabs`, and sets it active there (`activeRef` + `activeGroupId`). Clamps `toIndex` to
  `[0, tabs.length]`. No-op if the move leaves order unchanged. Generalizes today's append-only
  `moveTabToGroup`.

- `splitTab(layout, ref, targetGroupId, side, newGroupId): ProjectLayout`
  Removes `ref` from its current group, creates a new single-tab group `{ id: newGroupId, tabs:
  [ref], activeRef: ref }`, and inserts it into `groups[]` **immediately left or right** of
  `targetGroupId` (per `side: "left" | "right"`), splicing `weights[]` at the same index. **The new
  column takes half the target column's weight; the target keeps the other half** (VS Code-style
  halving). Sets the new group active. `newGroupId` is passed in (caller generates it) so the pure
  function stays deterministic/testable. Generalizes today's append-right `openToSide`.

Both rely on `validateLayout` (unchanged, in `store.ts`) to prune a source group that a move/split
leaves empty and to renormalize weights.

## 3. Store wiring

`store.ts` gains two thin actions that clone → call the pure reducer → `validateLayout` →
`persistLayout` (the existing `applyLayout` pipeline):

- `moveTab(projectId, fromGroupId, ref, toGroupId, toIndex)`
- `splitTab(projectId, ref, targetGroupId, side)` — generates `newGroupId` with the store's existing
  id generator, then calls the pure `splitTab`.

The now-superseded `openToSide` and `moveTabToGroup` actions are **removed** once their call sites
are updated (they are only used by the split button, the right-edge zone, and the group-chrome drop
— all reworked here).

## 4. Drag-and-drop UX (extend the existing native HTML5 DnD)

Tabs are already `draggable` with a `dragData` ref + `dragging` state. We extend, not rewrite.

- **Reorder / move-at-index.** Dragging a tab over a tab strip shows an **insertion caret** between
  tabs (a thin accent bar at the boundary nearest the cursor). Drop → `moveTab(from, ref, toGroup,
  index)`. Works within one strip (reorder) and across strips (move to a position).

- **Directional split.** While a drag is in progress, each pane body renders a **full-pane drop
  overlay** divided into three zones — **left third / center / right third**. `onDragOver` computes
  the zone from the cursor x and highlights it (reuse the existing `--accent` drop styling). On drop:
  - **left / right → `splitTab(ref, thatGroup, side)`** (new column beside the target),
  - **center → `moveTab(from, ref, thatGroup, end)`** (move into that group).
  This **replaces** today's single right-edge `.split-dropzone`.

- **Remove** the per-tab split button (`.tab-split` + `SplitIcon` usage) and its CSS.

Native drag image only (no custom ghost — YAGNI). Drop-on-own-position is a no-op.

## 5. Edge cases

- Splitting/moving the **only** tab out of a group empties the source group → `validateLayout`
  prunes it and its weight (net reposition, matching VS Code).
- `MIN_WEIGHT` (0.14) clamping: halving a small column could dip a sibling below `MIN_WEIGHT`;
  `validateLayout` normalization + the divider-drag clamp already tolerate this — a freshly split
  pair sums correctly and remains resizable. No special handling needed beyond normalization.
- Dropping a tab into its current group's center at its current position → no-op.

## 6. Files

**Add**
- `src/layout.ts` — pure `moveTab` / `splitTab` reducers.
- `src/layout.test.ts` — vitest unit tests (reorder indices, cross-group move, weight halving,
  empty-group pruning, no-op).

**Change**
- `src/store.ts` — add `moveTab` / `splitTab` actions delegating to `src/layout.ts`; remove
  `openToSide` / `moveTabToGroup`.
- `src/components/WorkspaceCenter.tsx` — remove the split button; add per-tab reorder caret; replace
  the right-edge dropzone with the per-pane directional overlay; wire the new actions.
- `src/components/Icons.tsx` — drop the now-unused `SplitIcon` export only if nothing else imports
  it (verify first).
- `src/theme.css` — remove `.split-dropzone` + `.tab-split` rules; add the directional-overlay
  zones and the reorder-caret styles.

## 7. Testing

- **`src/layout.ts`:** vitest unit tests for both reducers (indices, halving, pruning, no-op,
  cross-group vs same-group). This is the correctness-critical part and is fully testable.
- **DnD interactions:** launch-verified in the app (no frontend DnD test runner) — reorder within a
  strip, move across strips at a position, split left/right via the pane overlay, move-into-group via
  center, and confirming terminals behave identically. Dev runs use
  `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`.

## 8. Sequencing

Implemented on `feat/monaco-editor` (same worktree). After this lands, the paused Monaco remainder
resumes: Task 8 (retire `FileViewer`) then Phase 2 (smart reload) and Phase 3 (file-tree CRUD).
