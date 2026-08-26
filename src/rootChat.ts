// Root chat pure logic: the ChatItem shapes mirror what Rust emits — both the live
// stream (root-chat-item events) and history replay (root_chat_history) produce items
// via the same transcript::parse_line, so the frontend has exactly one item type.

export type ChatItem =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | { kind: "event"; event: string; label: string; mono?: string | null }
  | { kind: "usage"; [k: string]: unknown };

export interface RootChat {
  id: string;
  title: string;
  accountId?: string | null;
  createdAt: number;
}

export function appendItem(items: ChatItem[] | undefined, item: ChatItem): ChatItem[] {
  return [...(items ?? []), item];
}

/** Usage records ride the same stream for future meters; they never render as rows. */
export function isRenderable(item: ChatItem): boolean {
  return item.kind !== "usage";
}

export function canSend(text: string, running: boolean): boolean {
  return !running && text.trim().length > 0;
}

/** Time-of-day greeting for the HQ home state (vault-chat convention). */
export function greeting(hour: number): string {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  if (hour < 22) return "Evening";
  return "Night owl";
}

/** Compact relative time for the recent-chats list. `createdAt` is unix SECONDS
 *  (the Rust store's convention); `now` is Date.now() milliseconds. */
export function relativeTime(createdAt: number, now: number): string {
  const sec = Math.round(now / 1000 - createdAt);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.round(sec / 86400)}d ago`;
  return new Date(createdAt * 1000).toLocaleDateString();
}
