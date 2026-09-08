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

/** One-line card title: the brief, clipped on a word boundary. */
export function summarize(task: string, max = 80): string {
  const flat = task.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
