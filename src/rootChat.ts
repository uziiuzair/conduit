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
