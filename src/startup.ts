/**
 * What is open when Conduit starts.
 *
 * Conduit used to land on `projects[0]` unconditionally, which meant the topmost project in
 * the sidebar got opened -- and, with restore-on-open, every one of its sessions spawned --
 * regardless of what you were actually working on last. Reordering the sidebar changed which
 * project launched. That is the behaviour this module replaces.
 *
 * Pure on purpose: the store cannot be imported under the node-env vitest (it touches
 * `localStorage` and the Tauri bridge at module scope), so the decision lives here where it
 * can be tested directly, and `store.ts` only supplies the three inputs.
 */

/** How Conduit chooses a project at launch. */
export type OpenBehavior =
  /** Reopen whatever project was last selected. Default. */
  | "last"
  /** Open nothing; land on the empty state and wait to be told. */
  | "none";

/**
 * The project to select at launch, or `null` for "open nothing".
 *
 * A stale or absent memory resolves to `null` rather than to the first project. Falling back
 * to `projects[0]` is exactly the behaviour being fixed: on the first launch after this
 * change nothing is remembered yet, so a first-project fallback would reproduce the bug once
 * for every user and then hide it. `null` is also the cheap answer -- no project selected
 * means no session is eagerly spawned -- and the empty state already says which button to
 * press.
 */
export function initialProjectSelection(
  projectIds: string[],
  behavior: OpenBehavior,
  remembered: string | null,
): string | null {
  if (behavior === "none") return null;
  if (remembered && projectIds.includes(remembered)) return remembered;
  return null;
}
