// src/keyboardGuards.ts — deciding whether a keystroke belongs to a global keyboard
// shortcut or to whatever the user is actually typing into. NO Tauri / Zustand / React
// imports, so vitest exercises this in a node env with fake DOM-like targets.
//
// A window-level keydown listener sees every keystroke in the app, including ones typed
// into a live agent terminal or an ordinary text field — neither of which is asking for a
// global command just because it happens to share a key combination with one. The two
// checks below used to be written out by hand in three separate closures (and were
// missing outright from a fourth), which is how Ctrl+Shift+C ended up both copying a
// terminal selection AND toggling the canvas: the toggle's own listener never checked
// `.term-host` at all, so it fired first (capture phase) and flipped the view underneath
// the copy that xterm still went on to perform.

/** An input, a textarea, or a contenteditable region — an ordinary editable field. */
const EDITABLE_SELECTOR = "textarea, input, [contenteditable='true']";

/** True when the keystroke landed inside a live terminal — it belongs to whatever agent
 *  or shell is running there, not to a global shortcut that happens to share its keys. */
export function isInTerminal(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(".term-host");
}

/** True when the keystroke landed inside an ordinary editable field. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(EDITABLE_SELECTOR);
}

/**
 * True when a global keyboard shortcut must leave this keystroke alone entirely — inside a
 * terminal or an editable field. The two checks stay exported separately for a caller that
 * treats them differently, like the canvas's own Escape handler, which blurs an editable
 * field but does nothing extra (just returns) for a terminal.
 */
export function blocksGlobalShortcut(target: EventTarget | null): boolean {
  return isInTerminal(target) || isEditableTarget(target);
}
