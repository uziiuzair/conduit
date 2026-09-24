// Claude's permission mode, as the hook stream spells it. Pure — the chat chip and
// its optimistic cycle read these, and the node-env vitest pins the mapping.

/** Human label for a hook-reported permission mode; null for unknown/absent (the chip
 *  then names the action instead of claiming a state it cannot know). */
export function modeLabel(mode: string | undefined): string | null {
  switch (mode) {
    case "default":
      return "normal";
    case "acceptEdits":
      return "auto-accept";
    case "plan":
      return "plan";
    case "bypassPermissions":
      return "bypass";
    default:
      return null;
  }
}

/** What one Shift+Tab moves the mode to — Claude's own cycle. Used optimistically
 *  after sending the keystroke; the next hook's `permission_mode` is the truth and
 *  overwrites this if the guess was wrong. */
export function nextMode(mode: string): string {
  switch (mode) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
      return "default";
    default:
      // bypassPermissions (and anything new): Shift+Tab drops back into the
      // normal cycle.
      return "default";
  }
}
