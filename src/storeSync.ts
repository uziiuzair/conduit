/**
 * Cross-window state convergence: the pure merge behind the `store-saved` broadcast (Task 5).
 *
 * Every persisted Rust write now fires `store-saved` in EVERY window. Each window debounces
 * that (`useStoreSync.ts`) and refetches its read slices, then merges the fetched projects
 * into what it already has. That merge is pure and lives here rather than in `store.ts`
 * because `store.ts` touches `localStorage` and the Tauri bridge at module scope and cannot
 * be imported under the node-env vitest — the same reason `startup.ts` and `usageRows.ts`
 * exist standalone. The `Project`/`ProjectLayout` imports below are type-only and erase at
 * compile time, so they don't pull `store.ts`'s module body in.
 *
 * `makeLayout` is a caller-supplied callback (built on `validateLayout` in `store.ts`) rather
 * than something this module calls itself, for the same reason: keeping the layout-building
 * logic (and its `store.ts` dependencies) out of this file entirely.
 *
 * The merge answers exactly four questions:
 *  (a) a project only Rust knows about (created in another window) is ADDED, with a layout
 *      built by `makeLayout`.
 *  (b) a project this window already has keeps its LOCAL layout object identity. A layout is
 *      live UI state — tab order, split panes, the active group — that only this window's own
 *      edits may change; a background refetch must never replace it out from under the user.
 *  (c) a project Rust no longer reports (removed in another window) is DROPPED, layout
 *      included. Rust is authoritative for project existence. `removedProjectIds` names which
 *      ones, so the caller (`mergeSyncedSlices` in `store.ts`) can replay `removeProject`'s own
 *      cleanup for them — clearing `dirty`/`maximized`, releasing the Monaco registry ref —
 *      none of which this module can do itself (it has no store, no registry).
 *  (d) the merged project adopts the fetched fields wholesale (sessions included — that's the
 *      point of the sync), but when a project's JSON is byte-identical to what this window
 *      already has, the EXISTING object reference is kept so nothing that memoizes on project
 *      identity re-renders for no reason. `JSON.stringify` per project is cheap at Conduit's
 *      scale and runs at most every 300ms (the debounce in `useStoreSync.ts`).
 */
import type { Project, ProjectLayout } from "./store";

export interface MergeResult {
  projects: Project[];
  layouts: Record<string, ProjectLayout>;
  addedProjectIds: string[];
  removedProjectIds: string[];
}

export function mergeSlices(
  current: { projects: Project[]; layouts: Record<string, ProjectLayout> },
  fetched: Project[],
  makeLayout: (p: Project) => ProjectLayout,
): MergeResult {
  const currentById = new Map(current.projects.map((p) => [p.id, p]));
  const fetchedIds = new Set(fetched.map((p) => p.id));
  const addedProjectIds: string[] = [];
  const removedProjectIds = current.projects
    .filter((p) => !fetchedIds.has(p.id))
    .map((p) => p.id);
  const layouts: Record<string, ProjectLayout> = {};

  const projects = fetched.map((f) => {
    const existing = currentById.get(f.id);
    if (!existing) {
      addedProjectIds.push(f.id);
      layouts[f.id] = makeLayout(f);
      return f;
    }
    // Existing project: the layout is this window's own, never Rust's — carry it over
    // untouched (falling back to a fresh one only if it is somehow missing).
    layouts[f.id] = current.layouts[f.id] ?? makeLayout(f);
    return JSON.stringify(f) === JSON.stringify(existing) ? existing : f;
  });

  return { projects, layouts, addedProjectIds, removedProjectIds };
}
