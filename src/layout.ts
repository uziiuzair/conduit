// src/layout.ts — pure ProjectLayout transforms. NO Tauri / Zustand imports, so vitest can
// exercise these in a node env (types are erased `import type`). validateLayout (in store.ts)
// prunes any empty source group + renormalizes weights after these run.
import type { EditorGroup, ProjectLayout, WsTab } from "./store";

/**
 * Which project a tab's session belongs to.
 *
 * A layout is keyed by project, so for years the answer was "the project whose layout this
 * is" and nothing stored it. `WsTab.projectId` is set ONLY on a foreign tab -- a session
 * borrowed from another project into this layout's panes. Leaving it absent for the common
 * case is what makes every persisted layout (and the Rust struct) forward-compatible: an
 * old layout read by new code is all-local, which is exactly what it was.
 */
export function tabProjectId(tab: WsTab, hostProjectId: string): string {
  return tab.projectId ?? hostProjectId;
}

/** Every project represented in this layout, host first, in first-appearance order. */
export function layoutProjectIds(layout: ProjectLayout, hostProjectId: string): string[] {
  const seen = [hostProjectId];
  for (const g of layout.groups) {
    for (const t of g.tabs) {
      const pid = tabProjectId(t, hostProjectId);
      if (!seen.includes(pid)) seen.push(pid);
    }
  }
  return seen;
}

/**
 * Does this layout hold sessions from more than one project?
 *
 * Drives whether tabs are badged with their project. Badging only the foreign tabs would
 * make "no badge" mean "the host project", which the user has to already know -- so when a
 * layout is mixed EVERY tab is badged, and when it is not (the overwhelmingly common case)
 * none are and the strip is exactly as it was.
 */
export function isMixedLayout(layout: ProjectLayout, hostProjectId: string): boolean {
  return layoutProjectIds(layout, hostProjectId).length > 1;
}

/**
 * A stable colour for a project, derived from its id.
 *
 * Deterministic rather than stored: a colour the user never chose must not become a thing
 * they have to migrate, and this has to work for every existing project the moment they
 * update. FNV-1a over the id, mapped onto the hue circle at a fixed saturation/lightness so
 * no project can land on an unreadable colour. Hues are spread by a large odd step so ids
 * that differ in one character do not land next to each other.
 */
export function projectHue(projectId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 360) * 137 % 360;
}

/**
 * The curated project palette: warm, muted tones picked to sit inside Conduit's warm-dark
 * theme instead of the raw HSL wheel (whose fixed 58%/62% produced neon lime/violet that
 * fought the UI). Also the swatches the right-click colour picker offers, so a chosen
 * colour and a derived one always come from the same family.
 */
export interface ProjectColor {
  value: string;
  label: string;
}
export const PROJECT_PALETTE: ProjectColor[] = [
  { value: "#c4906c", label: "Terracotta" },
  { value: "#c9a86b", label: "Ochre" },
  { value: "#b8b072", label: "Sand" },
  { value: "#93ad7c", label: "Sage" },
  { value: "#75a898", label: "Seafoam" },
  { value: "#7c9fb8", label: "Slate" },
  { value: "#9691c4", label: "Lavender" },
  { value: "#b989b1", label: "Mauve" },
  { value: "#c47f88", label: "Rose" },
  { value: "#a89383", label: "Driftwood" },
];

/** The project's derived accent as a CSS colour: the id's hue mapped onto the curated
 *  palette. One place, so the tab chip, the pane edge and the sidebar cannot disagree
 *  about what colour a project is. */
export function projectAccent(projectId: string): string {
  return PROJECT_PALETTE[projectHue(projectId) % PROJECT_PALETTE.length].value;
}

/**
 * The colour a project actually wears, or null for "no colour".
 *
 * Precedence: an explicitly chosen colour (stored on the project) always wins — even with
 * auto-colouring off, because the user picked it on purpose. Otherwise the derived accent
 * applies only while auto-colouring is on. Null renders every `--proj-accent` consumer
 * through its neutral CSS fallback.
 */
export function resolveProjectColor(
  projectId: string,
  explicit: string | null | undefined,
  autoColors: boolean,
): string | null {
  if (explicit) return explicit;
  return autoColors ? projectAccent(projectId) : null;
}

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

/** The ref ⌃Tab / ⌃⇧Tab should activate: `delta` steps from the active tab, wrapping.
 *  Null when the group has fewer than two tabs (nothing to cycle to). */
export function cycleTabRef(
  group: { tabs: WsTab[]; activeRef: string | null },
  delta: number,
): string | null {
  const n = group.tabs.length;
  if (n < 2) return null;
  const i = group.tabs.findIndex((t) => t.ref === group.activeRef);
  const base = i === -1 ? 0 : i;
  return group.tabs[(((base + delta) % n) + n) % n].ref;
}

/** Restore a closed tab at its old group/index (⌘⇧T). Focuses an existing tab with
 *  the same ref instead of duplicating; falls back to the active group when the
 *  original group is gone. Index is clamped to the group's current length. */
export function reopenTabAt(
  layout: ProjectLayout,
  groupId: string,
  index: number,
  tab: WsTab,
): ProjectLayout {
  const l = clone(layout);
  for (const g of l.groups) {
    if (g.tabs.some((t) => t.ref === tab.ref)) {
      g.activeRef = tab.ref;
      l.activeGroupId = g.id;
      return l;
    }
  }
  const g =
    l.groups.find((x) => x.id === groupId) ??
    l.groups.find((x) => x.id === l.activeGroupId) ??
    l.groups[0];
  if (!g) return layout; // validateLayout guarantees ≥1 group in practice
  const idx = Math.max(0, Math.min(index, g.tabs.length));
  g.tabs.splice(idx, 0, tab);
  g.activeRef = tab.ref;
  l.activeGroupId = g.id;
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

/** Just enough of a Project for the repair: its id and which sessions it holds. */
export interface LayoutProject {
  id: string;
  sessions: { id: string }[];
}

/**
 * Repair a layout against the projects that actually exist: drop dead session tabs, prune
 * empty groups (and their weights, index-aligned), fix dangling active ids, normalize
 * weights.
 *
 * `all` is EVERY project, not just the host, because a session tab may be foreign (see
 * `WsTab.projectId`) and has to be validated against its OWN project. Checking a foreign
 * tab against the host would prune every cross-project pane on the next repair -- and a
 * repair runs on every layout write, so the split would collapse the instant it was made.
 *
 * `emptyGroupId` is used only when nothing survives; passed in rather than generated so
 * this stays pure (`store.ts` supplies `uid()`).
 */
export function repairLayout(
  layout: ProjectLayout,
  hostProjectId: string | null,
  all: LayoutProject[],
  emptyGroupId: string,
): ProjectLayout {
  const byProject = new Map<string, Set<string>>();
  for (const p of all) byProject.set(p.id, new Set(p.sessions.map((s) => s.id)));
  const liveSession = (t: WsTab): boolean => {
    const owner = t.projectId ?? hostProjectId;
    return !!owner && (byProject.get(owner)?.has(t.ref) ?? false);
  };
  const groups: EditorGroup[] = [];
  const weights: number[] = [];
  layout.groups.forEach((g, i) => {
    const tabs = g.tabs.filter((t) => (t.kind === "file" ? true : liveSession(t)));
    if (tabs.length === 0) return; // prune empty group + its weight
    const activeRef = tabs.some((t) => t.ref === g.activeRef)
      ? g.activeRef
      : tabs[tabs.length - 1].ref;
    groups.push({ id: g.id, tabs, activeRef });
    weights.push(layout.weights?.[i] ?? 1);
  });
  if (groups.length === 0) {
    return {
      groups: [{ id: emptyGroupId, tabs: [], activeRef: null }],
      activeGroupId: emptyGroupId,
      weights: [1],
    };
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const norm = weights.map((w) => w / sum);
  const activeGroupId = groups.some((g) => g.id === layout.activeGroupId)
    ? layout.activeGroupId
    : groups[0].id;
  return { groups, activeGroupId, weights: norm };
}


// ---- Dragging a session out of the sidebar and into a pane ----

/**
 * The drag payload that lets a SIDEBAR row be dropped into the panes.
 *
 * Carried as its own MIME type rather than through a module-level variable because the two
 * ends live in different component trees, and because `dataTransfer.getData` is blocked
 * during `dragover` — only `types` is readable. Advertising a custom type is therefore the
 * only way a drop target can know a drag is droppable BEFORE it lands, which is what the
 * pane overlay needs in order to appear at all.
 */
export const SESSION_DRAG_MIME = "application/x-conduit-session";

export interface SessionDragPayload {
  sessionId: string;
  /** The session's OWN project, which may not be the project being dropped into. */
  projectId: string;
}

/** Structural, so this is testable without a DOM `DataTransfer`. */
export interface DragLike {
  types: readonly string[];
  getData(type: string): string;
}

/** Is this drag a sidebar session? Answerable during `dragover`, where data is not. */
export function hasSessionDrag(dt: DragLike | null | undefined): boolean {
  return !!dt && Array.from(dt.types).includes(SESSION_DRAG_MIME);
}

/** The payload, on drop. Null for any other drag, and for a malformed one — a drag from
 *  outside the app can advertise any type it likes. */
export function readSessionDrag(dt: DragLike | null | undefined): SessionDragPayload | null {
  if (!hasSessionDrag(dt)) return null;
  try {
    const v = JSON.parse(dt!.getData(SESSION_DRAG_MIME));
    return typeof v?.sessionId === "string" && typeof v?.projectId === "string"
      ? { sessionId: v.sessionId, projectId: v.projectId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Put `tab` into `groupId` at `index`, removing any existing copy first.
 *
 * The dedupe is load-bearing, not tidiness: a session is ONE mounted terminal, placed by
 * the first group whose tabs contain its ref. A ref present twice would draw in one pane
 * and leave the other permanently blank.
 */
export function insertTabAt(
  layout: ProjectLayout,
  groupId: string,
  index: number,
  tab: WsTab,
): ProjectLayout {
  const l = clone(layout);
  for (const g of l.groups) {
    const i = g.tabs.findIndex((t) => t.ref === tab.ref);
    if (i !== -1) {
      g.tabs.splice(i, 1);
      if (g.activeRef === tab.ref) g.activeRef = g.tabs[g.tabs.length - 1]?.ref ?? null;
    }
  }
  const g = l.groups.find((x) => x.id === groupId) ?? l.groups[0];
  if (!g) {
    const ng: EditorGroup = { id: groupId, tabs: [tab], activeRef: tab.ref };
    l.groups.push(ng);
    l.weights.push(1);
    l.activeGroupId = ng.id;
    return l;
  }
  g.tabs.splice(Math.max(0, Math.min(index, g.tabs.length)), 0, tab);
  g.activeRef = tab.ref;
  l.activeGroupId = g.id;
  return l;
}
