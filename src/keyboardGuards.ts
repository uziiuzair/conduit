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

/**
 * True when the app is running on a Mac. Pass `navigator.platform || navigator.userAgent`.
 * `navigator.platform` is deprecated and occasionally empty in a webview, which is why the
 * caller ORs in the user agent; taking the resolved string keeps this pure and testable.
 */
export function isMacPlatform(platformOrUA: string): boolean {
  return /Mac|iPhone|iPod|iPad/i.test(platformOrUA);
}

/** A keydown, reduced to the fields a shortcut decision actually reads. */
export type ModifierKeys = {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * The 1-based tab position a keystroke selects (9 = last, browser convention), or null.
 *
 * The modifier DIFFERS BY PLATFORM and neither choice is arbitrary:
 * - macOS uses Cmd+1..9, matching every Mac tabbed app.
 * - Windows/Linux use **Alt**+1..9, which is what VS Code binds there. Ctrl+digit cannot
 *   be used: it is a real terminal control code (Ctrl+3 is ESC, which would interrupt the
 *   agent) and must reach the PTY untouched. Meta is equally unavailable -- it is the
 *   Windows key, which the OS reserves for the taskbar. Binding this to Cmd-only, as it
 *   was, left Windows with no numeric tab switching at all.
 *
 * Alt+digit does reach a terminal as a meta-prefixed escape, so this is the same trade VS
 * Code makes: the window-level capture handler claims it before xterm sees it.
 */
export function tabSwitchDigit(e: ModifierKeys, isMac: boolean): number | null {
  const primaryHeld = isMac ? e.metaKey && !e.altKey : e.altKey && !e.metaKey;
  if (!primaryHeld || e.ctrlKey || e.shiftKey) return null;
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}
