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
  const sameGroup = from === to;
  const toLenBeforeRemoval = to.tabs.length; // from===to shares the array; capture before splice mutates it
  const [tab] = from.tabs.splice(srcIdx, 1);
  let idx = Math.max(0, Math.min(toIndex, toLenBeforeRemoval));
  if (sameGroup && srcIdx < idx) idx -= 1; // account for the removed slot
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
