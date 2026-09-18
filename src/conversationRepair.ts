/**
 * Recovering Claude sessions that reopened an older conversation.
 *
 * Before Conduit followed a session's conversation past a `/clear`, a restart resumed the
 * conversation from BEFORE the clear. The Rust scan (`conversation_repair.rs`) finds the
 * conversation each such session really moved on to; this module decides which of those to
 * offer. It stays free of `store.ts` so the node-env vitest can import it (same reason as
 * `startup.ts`).
 */

/** Mirrors `conversation_repair::Branch`: another conversation a session's clears led to. */
export interface Branch {
  conversation: string;
  clears: number;
  updatedAt: number;
  title: string;
  bytes: number;
}

/** Mirrors `conversation_repair::DriftCandidate`. */
export interface DriftCandidate {
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionName: string;
  currentConversation: string;
  latestConversation: string;
  clears: number;
  latestUpdatedAt: number;
  latestTitle: string;
  latestBytes: number;
  /** Older forks, most recently active first — see the Rust doc for why they exist. */
  otherBranches: Branch[];
}

export const DISMISSED_KEY = "conduit.conversationRepair.dismissed";

/** A dismissal is for ONE offer: the same session moving on again later is a new offer. */
export function offerKey(c: Pick<DriftCandidate, "sessionId" | "latestConversation">): string {
  return `${c.sessionId}:${c.latestConversation}`;
}

/** The candidates still worth offering, most recently active first. */
export function pendingOffers(
  candidates: DriftCandidate[],
  dismissed: ReadonlySet<string>,
): DriftCandidate[] {
  return candidates
    .filter((c) => !dismissed.has(offerKey(c)))
    .sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
}

/** "3 clears later · 1.2 MB · active 2h ago" — how far the conversation is from the one
 *  Conduit would reopen, how much is in it, and how fresh it is. */
export function describeConversation(
  c: { clears: number; bytes: number; updatedAt: number },
  now: number,
): string {
  const parts = [c.clears === 1 ? "1 clear later" : `${c.clears} clears later`];
  if (c.bytes > 0) parts.push(formatBytes(c.bytes));
  if (c.updatedAt > 0) parts.push(`active ${ago(now - c.updatedAt)}`);
  return parts.join(" · ");
}

export function describeOffer(c: DriftCandidate, now: number): string {
  return describeConversation(
    { clears: c.clears, bytes: c.latestBytes, updatedAt: c.latestUpdatedAt },
    now,
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Dismissed offers, per machine. Unreadable storage reads as "nothing dismissed". */
export function readDismissed(storage: Pick<Storage, "getItem"> | undefined): Set<string> {
  try {
    const raw = storage?.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeDismissed(
  storage: Pick<Storage, "setItem"> | undefined,
  dismissed: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch {
    // Private window / blocked storage: the offer simply comes back next launch.
  }
}
