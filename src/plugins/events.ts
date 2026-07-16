/** A plugin-facing event: an id from permissions.ts + a sanitized payload. */
export interface PluginEvent {
  event: string;
  [k: string]: unknown;
}

/** Frontend "hook" relay payload shape (mirrors App.tsx HookPayload). */
export interface HookPayload { session: string; event: string; body: unknown; }

const HOOK_VERB_TO_EVENT: Record<string, string> = {
  run: "lifecycle.run",
  stop: "lifecycle.stop",
  notify: "lifecycle.notify",
};

/** Map a raw hook relay to a sanitized lifecycle event. Never forwards `body`. */
export function sanitizeHookPayload(p: HookPayload): { event: string; session: string } {
  const event = HOOK_VERB_TO_EVENT[p.event] ?? "lifecycle.notify";
  return { event, session: p.session };
}

/** Reduce any session-like object to the safe fields plugins may see. */
export function sanitizeSession(s: { id: string; title?: string }): { id: string; title: string } {
  return { id: s.id, title: s.title ?? "" };
}
