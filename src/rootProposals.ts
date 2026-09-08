// Pending decisions: work root chat proposed, waiting on the human. Shapes mirror the
// Rust `pending-decision` event and `list_pending_decisions` exactly — one payload,
// whether it arrived live or as a catch-up on mount.

export interface PendingDecision {
  id: string;
  chatId: string;
  projectId: string;
  projectName: string;
  task: string;
  kind?: string | null;
  agent?: string | null;
  model?: string | null;
  createdAt: number;
}

/** Newest first, deduped by id — the live event and the mount-time list overlap. */
export function addDecision(
  list: PendingDecision[],
  d: PendingDecision,
): PendingDecision[] {
  return [d, ...list.filter((x) => x.id !== d.id)];
}

export function removeDecision(list: PendingDecision[], id: string): PendingDecision[] {
  return list.filter((x) => x.id !== id);
}

/** Where the app must go once a card is approved, and what to tell the user.
 *
 * Approving is the only step that starts real work, and until it navigated, it started
 * nothing: `Terminal.tsx`'s eager spawn is gated on `projectId === selectedProjectId`,
 * and root chat is global, so the approved project is routinely NOT the selected one.
 * "Start it" then looked inert, and because `pendingPrompts` is runtime-only, quitting
 * before opening that project left the session alive with its brief gone — it would
 * later spawn with no task at all.
 *
 * The project is the CARD's, never whatever happens to be selected; that is the whole
 * point, and it is why this is a named rule with a test rather than a line in the store.
 * Navigating away from the chat is deliberate: approving is an explicit user action, so
 * following it to the work is coherent — the toast says which project, because the jump
 * is otherwise unexplained.
 */
export function approvalFocus(d: Pick<PendingDecision, "projectId" | "projectName">): {
  projectId: string;
  toast: string;
} {
  return {
    projectId: d.projectId,
    toast: `Started work in ${d.projectName}.`,
  };
}

/** One-line card title: the brief, clipped on a word boundary. */
export function summarize(task: string, max = 80): string {
  const flat = task.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
