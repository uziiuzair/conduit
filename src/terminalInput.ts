/**
 * Programmatic input into a running agent's TUI.
 *
 * Typing is one keystroke per read; a machine write is one read carrying the whole
 * message, and the TUI on the other end cannot tell the difference — so it guesses. Every
 * modern one guesses the same way: a single read with a lot of text (or any newline) is a
 * PASTE, and a paste is inserted verbatim. A trailing `\r` is then part of the pasted body
 * and lands in the composer as one more newline, so the message sits there unsent, waiting
 * for a human to press Enter. Measured against Claude Code: a 40-character line submitted,
 * a 742-character single line and a three-line brief did not.
 *
 * The Rust twin is `pty::paste_and_submit` (used by `fleet_send`), and the two must agree —
 * a session does not care which side of the app injected the text.
 */

/** Start/end of DEC mode 2004 bracketed paste. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * `text` as a bracketed paste followed by the Enter that submits it.
 *
 * The end marker closes the paste, so the `\r` after it is unambiguously a keypress even
 * when the whole string arrives in one read — which is why this is one write and not two
 * with a delay between them. ESC is dropped from the body: a `CSI 201~` inside it would
 * close the paste early and turn the remainder into keystrokes.
 */
export function pasteAndSubmit(text: string): string {
  return `${PASTE_START}${text.replace(/\x1b/g, "")}${PASTE_END}\r`;
}
