import type { ApprovalItem, ChatItem } from "../data/types";

let seq = 0;
/** Monotonic id generator (deterministic; avoids Math.random for testability). */
export function genId(prefix = "x"): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Append a user prompt as a chat bubble. Pure: returns a new array. */
export function appendPrompt(items: ChatItem[], text: string, id: string = genId("u")): ChatItem[] {
  const trimmed = text.trim();
  if (!trimmed) return items;
  return [...items, { kind: "bubble", id, role: "user", text: trimmed }];
}

/** Append an assistant reply bubble. */
export function appendAssistantReply(items: ChatItem[], text: string, id: string = genId("a")): ChatItem[] {
  return [...items, { kind: "bubble", id, role: "assistant", text }];
}

/** Resolve an approval item (immutably) to allow/deny. */
export function resolveApproval(
  items: ChatItem[],
  approvalId: string,
  decision: "allow" | "deny",
): ChatItem[] {
  return items.map((it) =>
    it.kind === "approval" && it.id === approvalId ? { ...it, resolved: decision } : it,
  );
}

/** The first unresolved approval in a feed, if any. */
export function pendingApproval(items: ChatItem[]): ApprovalItem | null {
  return (
    items.find((it): it is ApprovalItem => it.kind === "approval" && !it.resolved) ?? null
  );
}

/**
 * Group a flat feed for rendering: consecutive `event` items collapse onto one
 * timeline rail; everything else stays standalone. Returns render rows.
 */
export type FeedRow =
  | { type: "item"; item: Exclude<ChatItem, { kind: "event" }> }
  | { type: "events"; id: string; events: Extract<ChatItem, { kind: "event" }>[] };

export function groupFeed(items: ChatItem[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let run: Extract<ChatItem, { kind: "event" }>[] = [];
  const flush = () => {
    if (run.length) {
      rows.push({ type: "events", id: `evs-${run[0].id}`, events: run });
      run = [];
    }
  };
  for (const it of items) {
    if (it.kind === "event") {
      run.push(it);
    } else {
      flush();
      rows.push({ type: "item", item: it });
    }
  }
  flush();
  return rows;
}
