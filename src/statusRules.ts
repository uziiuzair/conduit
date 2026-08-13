// The time-aware rules behind the per-session agent status — the frontend half.
//
// `src-tauri/src/status_rules.rs` is the other half, and the two MUST agree: Rust owns the
// mirror the Conductor reads through `fleet_list`, this file owns the `live` map the sidebar
// dot renders, and both are fed by the same hook stream. The moment each surface invents its
// own timeout or its own reading of a notification, one of them tells the user a session is
// busy while the other says it finished.
//
// Keep the constants and the three functions below in lockstep with the Rust file. The
// comments there carry the full reasoning; this file states the rule and points at it.

import type { SessionStatus } from "./store";

/** How long a `running` session may go without any event before it is presumed gone. */
export const WORKING_STALE_MS = 20 * 60_000;

/** How long a freshly `done` session ignores tool-level `running` signals. */
export const DONE_HOLDOFF_MS = 3_000;

/** Has a `running` session gone quiet for longer than the window? */
export function isStaleWorking(
  status: SessionStatus | undefined,
  updatedAt: number | undefined,
  now: number,
  staleMs: number = WORKING_STALE_MS,
): boolean {
  if (status !== "running") return false;
  // No timestamp = an entry that predates this rule. Treat it as fresh rather than sweeping
  // a session we have no evidence about.
  if (updatedAt === undefined) return false;
  return Math.max(0, now - updatedAt) > staleMs;
}

/**
 * Should a tool-level `running` signal be ignored because the turn just ended?
 *
 * Claude runs hooks in parallel, so a `PostToolUse` POST can land after the `Stop` for the
 * same turn. A real new turn (`prompt`) is never held off — only the tool chatter is.
 */
export function holdsOffWorking(
  status: SessionStatus | undefined,
  updatedAt: number | undefined,
  now: number,
): boolean {
  if (status !== "done" || updatedAt === undefined) return false;
  return Math.max(0, now - updatedAt) < DONE_HOLDOFF_MS;
}

/**
 * What a `notification` event means for a session currently at `current`.
 * `undefined` = leave the status alone.
 *
 * Claude's `Notification` payload carries a `notification_type` separating four quite
 * different situations. `idle_prompt` is the one that cuts both ways: it fires after a
 * normally finished turn (so treating it as "needs input" left a false alarm on every
 * completed session) AND it is the only signal that rescues a session stuck on `running`
 * when Esc killed the turn before any `Stop` hook ran. A payload with no type at all keeps
 * the pre-rule behavior so an older Claude build cannot lose its badge.
 */
export function notificationStatus(
  notificationType: string | undefined,
  current: SessionStatus | undefined,
): SessionStatus | undefined {
  if (notificationType === undefined) return "needsInput";
  switch (notificationType) {
    case "permission_prompt":
    case "elicitation_dialog":
    case "agent_needs_input":
      return "needsInput";
    case "idle_prompt":
      return current === "running" ? "idle" : undefined;
    default:
      return undefined;
  }
}
