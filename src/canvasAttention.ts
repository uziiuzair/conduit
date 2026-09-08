// src/canvasAttention.ts — routing attention into the viewport. NO Tauri / Zustand / React.
//
// An infinite canvas is WORSE than a sidebar at high load, for one reason: a sidebar always
// shows all thirty rows, and a canvas shows whatever the viewport happens to frame. The
// session that has been waiting forty minutes can sit three thousand pixels off screen.
// This module is what puts it back in view — the rail's ordering, the border pips, and the
// camera move that takes you there.
//
// Design: docs/superpowers/specs/2026-09-08-canvas-orchestration-board-design.md

import { WORKING_STALE_MS } from "./statusRules";

export interface Camera {
  pan: { x: number; y: number };
  zoom: number;
}

export interface Viewport {
  w: number;
  h: number;
}

/** What the store knows about one session, reduced to what attention needs. */
export interface AttentionSource {
  ref: string;
  projectId: string;
  status: string;
  /** When the status was last asserted, epoch ms. Absent for a session that never emitted. */
  updatedAt?: number;
}

export interface AttentionItem {
  ref: string;
  projectId: string;
  waitedMs: number;
}

/**
 * Everything waiting on a human, longest wait first.
 *
 * Two arms, matching the rules the rest of the app already derives status by. `needsInput`
 * is the obvious one. A session stuck in `running` past the 20-minute watchdog is the other:
 * `statusRules.ts` already treats that as no longer trustworthy, and from the user's side a
 * turn that silently died needs them exactly as much as one that asked a question.
 *
 * A missing timestamp reads as no wait rather than an infinite one — an unknown quantity
 * must not sort to the top of a queue whose whole job is ordering by urgency.
 */
export function attentionQueue(sources: AttentionSource[], now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const s of sources) {
    const waitedMs = s.updatedAt ? Math.max(0, now - s.updatedAt) : 0;
    const stuck = s.status === "running" && s.updatedAt !== undefined && waitedMs > WORKING_STALE_MS;
    if (s.status !== "needsInput" && !stuck) continue;
    items.push({ ref: s.ref, projectId: s.projectId, waitedMs });
  }
  return items.sort((a, b) => b.waitedMs - a.waitedMs);
}

export interface PipBox {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pip {
  ref: string;
  /** Screen coordinates on the viewport border, already inset by the margin. */
  x: number;
  y: number;
  /** Direction from the viewport centre toward the box, for rotating a marker. */
  angle: number;
}

/**
 * A marker on the viewport border for every box that is off screen.
 *
 * The position is where the ray from the viewport centre to the box centre crosses the
 * border, inset by `margin` so the marker is drawn fully inside rather than half-clipped.
 */
export function edgePips(
  boxes: PipBox[],
  camera: Camera,
  viewport: Viewport,
  margin = 18,
): Pip[] {
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  const pips: Pip[] = [];
  for (const b of boxes) {
    const sx = (b.x + b.w / 2) * camera.zoom + camera.pan.x;
    const sy = (b.y + b.h / 2) * camera.zoom + camera.pan.y;
    const onScreen =
      sx >= margin && sx <= viewport.w - margin && sy >= margin && sy <= viewport.h - margin;
    if (onScreen) continue;
    const dx = sx - cx;
    const dy = sy - cy;
    if (dx === 0 && dy === 0) continue;
    // Scale the ray until it meets whichever border it reaches first.
    const tx = dx === 0 ? Infinity : (cx - margin) / Math.abs(dx);
    const ty = dy === 0 ? Infinity : (cy - margin) / Math.abs(dy);
    const t = Math.min(tx, ty);
    pips.push({ ref: b.ref, x: cx + dx * t, y: cy + dy * t, angle: Math.atan2(dy, dx) });
  }
  return pips;
}

/** The camera that puts a box in the middle of the viewport at a given zoom. */
export function cameraFor(box: PipBox, viewport: Viewport, zoom: number): Camera {
  return {
    zoom,
    pan: {
      x: viewport.w / 2 - (box.x + box.w / 2) * zoom,
      y: viewport.h / 2 - (box.y + box.h / 2) * zoom,
    },
  };
}

/** Smooth both ends, so a fly-to starts and stops rather than jerks. */
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * The camera part-way between two.
 *
 * Snapping instead would destroy the spatial memory this whole board is built to create:
 * seeing the plane move is what teaches you where things are.
 */
export function interpolateCamera(from: Camera, to: Camera, t: number): Camera {
  if (t <= 0) return from;
  if (t >= 1) return to;
  return {
    zoom: from.zoom + (to.zoom - from.zoom) * t,
    pan: {
      x: from.pan.x + (to.pan.x - from.pan.x) * t,
      y: from.pan.y + (to.pan.y - from.pan.y) * t,
    },
  };
}
