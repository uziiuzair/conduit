/**
 * Mouse ownership for a terminal pane.
 *
 * tmux is launched with `mouse on` (see `tmux.rs`), which is load-bearing and NOT the bug:
 * tmux is a screen painter, so its own history is the only coherent scrollback a wheel can
 * scroll. The cost is that `mouse on` claims the BUTTONS too, and in a pane whose program
 * wants no mouse — a plain login shell — tmux's own root bindings answer them:
 * `MouseDrag1Pane` -> `copy-mode -M` (the yellow `[0/27]` position badge and a second
 * cursor) and `MouseDown3Pane` -> `display-menu` (Horizontal Split / Vertical Split / Kill).
 * Neither is what a right-click or a drag means in a terminal.
 *
 * Agent panes never hit this: Claude Code turns on tracking itself, so tmux's bindings all
 * fall through to `send-keys -M` and the program gets the event, exactly as in a native
 * terminal. So the fix belongs to the panes running a bare shell: refuse to enter mouse
 * REPORTING at all (xterm then does selection, word/line click and the context menu the
 * way it does with any non-mouse program), and re-encode the WHEEL by hand so tmux still
 * scrolls its history.
 *
 * Everything here is pure so it can be tested without a DOM; `Terminal.tsx` holds the
 * xterm wiring.
 */

/**
 * DEC private modes that put a terminal into mouse REPORTING.
 *
 * The encodings (1005/1006/1015 — how a report is written) are deliberately absent: they
 * are inert once nothing reports, and swallowing them would be a bigger lie to tell the
 * program than the one we need.
 */
export const MOUSE_TRACKING_MODES = [1000, 1001, 1002, 1003] as const;

export function isMouseTrackingMode(mode: number): boolean {
  return (MOUSE_TRACKING_MODES as readonly number[]).includes(mode);
}

/**
 * Split a DECSET/DECRST parameter list into the tracking modes to swallow and the rest.
 *
 * A parameter may carry sub-parameters (`CSI ? 1000 : 1 h`), which xterm hands over as a
 * nested array; the leading value is the mode.
 */
export function partitionMouseModes(params: (number | number[])[]): {
  mouse: number[];
  other: number[];
} {
  const mouse: number[] = [];
  const other: number[] = [];
  for (const p of params) {
    const mode = Array.isArray(p) ? p[0] : p;
    (isMouseTrackingMode(mode) ? mouse : other).push(mode);
  }
  return { mouse, other };
}

/** Rebuild a DEC private set (`h`) / reset (`l`) for the parameters we are not swallowing. */
export function decPrivateSeq(params: number[], final: "h" | "l"): string {
  return `\x1b[?${params.join(";")}${final}`;
}

/**
 * An SGR (1006) wheel report — the shape tmux reads back out of the pane.
 *
 * 64 is wheel-up, 65 wheel-down; the coordinates are 1-based cells. One report per wheel
 * event that moved at least a whole line, which is what xterm itself emits, so tmux
 * scrolls by exactly as much as it did when it owned the mouse.
 */
export function sgrWheelReport(dir: "up" | "down", col: number, row: number): string {
  return `\x1b[<${dir === "up" ? 64 : 65};${col};${row}M`;
}

/**
 * Wheel delta -> whole lines, carrying the remainder.
 *
 * A trackpad emits many sub-line pixel deltas; dropping them would make a slow scroll do
 * nothing, and rounding each one up would make it bolt. `acc` is the caller-held carry,
 * in the same units as the delta it was measured from.
 */
export function wheelLines(
  acc: number,
  deltaY: number,
  deltaMode: number,
  cellHeight: number,
  rows: number,
): { lines: number; acc: number } {
  // Pixels: a line is one cell tall. Before the first fit there is no cell height to
  // divide by, and reporting nothing is better than reporting a wrong distance.
  if (deltaMode === 0) {
    if (!(cellHeight > 0)) return { lines: 0, acc: 0 };
    const next = acc + deltaY;
    const lines = Math.trunc(next / cellHeight);
    return { lines, acc: next - lines * cellHeight };
  }
  const next = acc + (deltaMode === 2 ? deltaY * rows : deltaY);
  const lines = Math.trunc(next);
  return { lines, acc: next - lines };
}

/** The 1-based cell under a point, clamped to the grid (tmux rejects an off-grid report). */
export function cellFromPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  cols: number,
  rows: number,
): { col: number; row: number } {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 1), max);
  const col = width > 0 ? Math.floor(x / (width / cols)) + 1 : 1;
  const row = height > 0 ? Math.floor(y / (height / rows)) + 1 : 1;
  return { col: clamp(col, cols), row: clamp(row, rows) };
}
