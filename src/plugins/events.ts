/** A plugin-facing event: an id from permissions.ts + a sanitized payload. */
export interface PluginEvent {
  event: string;
  [k: string]: unknown;
}

/** Frontend "hook" relay payload shape (mirrors App.tsx HookPayload). */
export interface HookPayload { session: string; event: string; body: unknown; }

/** Map a raw hook relay to a sanitized `lifecycle.<verb>` event id. Never forwards
 *  `body`. The real verbs come from the Rust hook relay (hooks.rs): stop,
 *  notification, sessionstart, sessionend, prompt, tooluse, pretool, precompact,
 *  todos. Only the ids listed under `hooks:lifecycle` in permissions.ts are actually
 *  delivered to a plugin — the permission gate drops the rest. */
export function sanitizeHookPayload(p: HookPayload): { event: string; session: string } {
  return { event: `lifecycle.${p.event}`, session: p.session };
}

/** Reduce any session-like object to the safe fields plugins may see. */
export function sanitizeSession(s: { id: string; title?: string }): { id: string; title: string } {
  return { id: s.id, title: s.title ?? "" };
}
