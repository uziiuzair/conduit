// src/terminalZoom.ts — the canvas's zoom ladder. NO Tauri / Zustand / React imports.
//
// A terminal on the canvas is NOT a scaled bitmap: the stack carries no `scale()`, each
// host is sized in screen pixels, and the glyphs are rasterized natively by setting
// `options.fontSize`. That only looks right at INTEGER font sizes — a fractional size
// gives a fractional cell width, and the rounding error accumulates visibly across a row.
//
// So zoom quantizes. A gesture moves continuously and snaps to a rung on settle.
// Design: docs/superpowers/specs/2026-09-08-canvas-orchestration-board-design.md

import { LIVE_ZOOM_MIN, MAX_ZOOM, clampZoom } from "./canvas";

/**
 * Every font size the canvas is willing to render at, in CSS pixels.
 *
 * Dense at the small end because that is where a one-pixel step is a large proportional
 * change, sparse at the large end where it is not.
 */
export const FONT_LADDER: readonly number[] = [
  6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 32,
];

/**
 * The rungs usable for a given base font size — those whose zoom lands inside the band
 * where terminals actually render.
 *
 * Below `LIVE_ZOOM_MIN` there is no terminal to be crisp, so no rung is needed; above
 * `MAX_ZOOM` there is no reachable zoom. The base itself is always included, because zoom
 * 1.0 is the unzoomed state and must never be snapped away from.
 */
export function rungsFor(base: number): number[] {
  const kept = FONT_LADDER.filter((f) => {
    const zoom = f / base;
    return zoom >= LIVE_ZOOM_MIN && zoom <= MAX_ZOOM;
  });
  return kept.includes(base) ? kept : [...kept, base].sort((a, b) => a - b);
}

/**
 * The zoom a gesture settles to: the nearest rung, or the value untouched when it is below
 * the legibility floor — down there the view is cards, which are DOM and crisp at any
 * scale, so quantizing would only make panning-out feel notchy for no gain.
 */
export function snapZoom(zoom: number, base: number): number {
  const z = clampZoom(zoom);
  if (z < LIVE_ZOOM_MIN) return z;
  const rungs = rungsFor(base);
  let best = rungs[0] / base;
  for (const f of rungs) {
    if (Math.abs(f / base - z) < Math.abs(best - z)) best = f / base;
  }
  return best;
}

/** The font size to rasterize at for a given zoom. Always a rung, therefore an integer. */
export function fontForZoom(zoom: number, base: number): number {
  const rungs = rungsFor(base);
  const z = clampZoom(zoom);
  if (z < LIVE_ZOOM_MIN) return rungs[0];
  let best = rungs[0];
  for (const f of rungs) {
    if (Math.abs(f / base - z) < Math.abs(best / base - z)) best = f;
  }
  return best;
}
