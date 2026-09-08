# Canvas Orchestration Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Conduit's per-project canvas into one global, curated orchestration board on which a multi-project fleet stays legible — and make its terminals render crisply at every zoom.

**Architecture:** Increment 0 stops CSS-scaling terminal bitmaps: the stack transform loses `scale()`, each terminal host is sized in screen pixels, and `options.fontSize` is set from a ladder of integer sizes so glyphs rasterize natively. Increment 1 replaces the per-project auto-populated canvas with one global document whose membership is curated by drag, adds visual sections with geometric containment, selection and undo, and routes attention into the viewport with a rail, edge pips and a fly-to camera.

**Tech Stack:** React 19 + TypeScript, Zustand (`src/store.ts`), xterm.js with WebGL/canvas renderer addons, vitest (node env, colocated `*.test.ts`), Tauri v2 (no Rust changes in this plan).

**Spec:** `docs/superpowers/specs/2026-09-08-canvas-orchestration-board-design.md`

## Global Constraints

- **Never unmount, reparent, or reorder a terminal.** Every session's `TerminalView` is permanently mounted in one `.term-stack` and positioned purely by a `style` prop. Hiding is CSS (`visibility`/`display`), never conditional rendering. React reorders DOM to match list order, so no array holding node identity may ever be sorted or re-indexed.
- **Zooming must never reflow an agent's output.** A `cols`/`rows` change resizes the PTY. Only a *logical* size change (the resize grip) may refit.
- **Pure logic lives in modules with no Tauri / Zustand / React imports**, so vitest can exercise it in a node env. `src/store.ts` must never be imported from a tested pure module — it touches `localStorage` at module scope and throws under the node-env vitest.
- **Component tests are deliberately absent** in this repo. Pure modules get vitest suites; UI is verified by `pnpm exec tsc --noEmit`, `pnpm build`, and launching the app.
- **Run the dev app isolated:** `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`. A plain `pnpm tauri dev` shares `state.json` with the installed Conduit.app and clobbers its state.
- **Commits:** Conventional Commits, scoped (`feat(canvas): …`). **Never** add a `Co-Authored-By: Claude` or any AI-attribution trailer.
- **Branch:** all work on `feat/canvas-board`. Never push or merge to `main` without explicit human approval.
- Pre-PR gates: `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/terminalZoom.ts` | The integer font ladder; maps a canvas zoom to a snapped zoom and a font size. Pure. |
| `src/terminalZoom.test.ts` | Tests for the above. |
| `src/canvasHistory.ts` | Generic undo/redo snapshot stack. Pure. |
| `src/canvasHistory.test.ts` | Tests for the above. |
| `src/canvasAttention.ts` | Attention queue ordering, viewport edge pips, camera interpolation. Pure. |
| `src/canvasAttention.test.ts` | Tests for the above. |
| `src/hooks/useCanvas.ts` | The single read of the global canvas, shared by the underlay and the terminal placer. |
| `src/components/CanvasRail.tsx` | The attention rail and the edge pips. |
| `src/components/CanvasSection.tsx` | One section's frame, title and colour swatch row. |

**Modified:**

| File | Change |
| --- | --- |
| `src/canvas.ts` | `projectId` on `CanvasNode`; sections; geometric containment; derived z-order; curated add/remove; `reconcile` loses auto-placement; old-canvas note migration. |
| `src/canvas.test.ts` | Extended for all of the above. |
| `src/components/Terminal.tsx` | `canvasScale` prop; font from the ladder; `ResizeObserver` gated on logical size; repaint nudge on reveal. |
| `src/components/WorkspaceCenter.tsx` | Stack transform loses `scale()`; screen-pixel placement; ownership gate dropped; global canvas instead of per-project; zoom-gesture LOD. |
| `src/components/CanvasView.tsx` | Global canvas; rich card; sections; selection and marquee; undo; toolbar; drop target. |
| `src/components/Sidebar.tsx` | Sessions become drag sources for the canvas (reuses `SESSION_DRAG_MIME`). |
| `src/store.ts` | `canvas` + `setGlobalCanvas` + `canvasOpen`; `CenterMode` loses `"canvas"`; migration on load. |
| `src/App.tsx` | `Cmd/Ctrl+Shift+C` toggles the board. |
| `src/theme.css` | Canvas-mode transform split, rich card, sections, rail, pips, marquee. |
| `src/hooks/useProjectCanvas.ts` | Deleted — replaced by `useCanvas.ts`. |
| `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` | Docs and version bump. |

---

# Increment 0 — Crisp rendering

### Task 1: The integer font ladder

**Files:**
- Create: `src/terminalZoom.ts`
- Test: `src/terminalZoom.test.ts`

**Interfaces:**
- Consumes: `LIVE_ZOOM_MIN`, `MAX_ZOOM`, `MIN_ZOOM`, `clampZoom` from `src/canvas.ts`.
- Produces: `FONT_LADDER: readonly number[]`, `rungsFor(base: number): number[]`, `snapZoom(zoom: number, base: number): number`, `fontForZoom(zoom: number, base: number): number`.

- [ ] **Step 1: Write the failing test**

Create `src/terminalZoom.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LIVE_ZOOM_MIN, MAX_ZOOM } from "./canvas";
import { FONT_LADDER, fontForZoom, rungsFor, snapZoom } from "./terminalZoom";

describe("FONT_LADDER", () => {
  it("is strictly ascending integers", () => {
    for (let i = 1; i < FONT_LADDER.length; i++) {
      expect(FONT_LADDER[i]).toBeGreaterThan(FONT_LADDER[i - 1]);
      expect(Number.isInteger(FONT_LADDER[i])).toBe(true);
    }
  });
});

describe("rungsFor", () => {
  it("keeps only rungs whose zoom is legible and within range", () => {
    const rungs = rungsFor(13);
    for (const font of rungs) {
      const zoom = font / 13;
      expect(zoom).toBeGreaterThanOrEqual(LIVE_ZOOM_MIN);
      expect(zoom).toBeLessThanOrEqual(MAX_ZOOM);
    }
    // 13 itself is 1.0 and must always survive: it is the unzoomed state.
    expect(rungs).toContain(13);
  });

  it("never returns an empty ladder, whatever the base", () => {
    for (const base of [8, 10, 13, 16, 20]) {
      expect(rungsFor(base).length).toBeGreaterThan(0);
    }
  });
});

describe("snapZoom", () => {
  it("leaves 1.0 exactly alone", () => {
    expect(snapZoom(1, 13)).toBe(1);
  });

  it("snaps to the nearest rung", () => {
    // 9/13 = 0.6923, 10/13 = 0.7692. 0.70 is nearer the first.
    expect(snapZoom(0.7, 13)).toBeCloseTo(9 / 13, 6);
    expect(snapZoom(0.75, 13)).toBeCloseTo(10 / 13, 6);
  });

  it("does not snap below the legibility floor, where no terminal renders", () => {
    expect(snapZoom(0.3, 13)).toBe(0.3);
  });

  it("clamps rather than snapping past the top of the range", () => {
    expect(snapZoom(5, 13)).toBe(MAX_ZOOM);
  });
});

describe("fontForZoom", () => {
  it("returns the base at zoom 1", () => {
    expect(fontForZoom(1, 13)).toBe(13);
  });

  it("returns an integer at every rung", () => {
    for (const font of rungsFor(13)) {
      expect(fontForZoom(font / 13, 13)).toBe(font);
    }
  });

  it("returns the smallest rung below the legibility floor", () => {
    expect(fontForZoom(0.1, 13)).toBe(rungsFor(13)[0]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test -- src/terminalZoom.test.ts`
Expected: FAIL — `Failed to resolve import "./terminalZoom"`.

- [ ] **Step 3: Write the implementation**

Create `src/terminalZoom.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test -- src/terminalZoom.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/terminalZoom.ts src/terminalZoom.test.ts
git commit -m "feat(canvas): add the integer font ladder for crisp zoomed terminals"
```

---

### Task 2: Terminal renders at the zoomed font, and never refits for a zoom

**Files:**
- Modify: `src/components/Terminal.tsx` — props block (~line 30-70), create effect's `ResizeObserver` (~line 488), visible effect (~line 539), font-zoom effect (~line 662-675)

**Interfaces:**
- Consumes: `fontForZoom` from `src/terminalZoom.ts` (Task 1).
- Produces: a new optional prop on `TerminalView`: `canvasScale?: number`. Undefined means "not on the canvas" and preserves today's behaviour exactly.

**Why the shape it has:** `Terminal.tsx` already does font-scaling for the View menu's font zoom, and its comment records the key property — setting `options.fontSize` changes cell metrics *without* firing the `ResizeObserver`, because the host box is unchanged. On the canvas the host box **does** change (it is `logical × zoom`), so the observer fires and its `fit()` would renegotiate `cols`/`rows` with the PTY, reflowing the agent's output on every zoom step. The fix is to fit only when the *logical* size changed.

- [ ] **Step 1: Add the prop**

In the props type of `TerminalView`, beside `style?: React.CSSProperties;`, add:

```tsx
  /**
   * Canvas zoom, when this terminal is being placed by the canvas.
   *
   * Undefined everywhere else, which is what keeps pane mode byte-for-byte unchanged.
   * The canvas sizes the host box in SCREEN pixels (`logical × canvasScale`) and carries
   * no `scale()` transform, so the glyphs must be rasterized at `base × canvasScale` or
   * they would be the wrong size rather than merely soft.
   */
  canvasScale?: number;
```

Add `canvasScale,` to the destructured parameter list.

- [ ] **Step 2: Track the scale in a ref that lands before paint**

Immediately after the `visibleRef` declaration (~line 540), add:

```tsx
  // Read by the ResizeObserver closure, which is created once. A layout effect so the ref
  // is current before the browser can deliver a resize for the box this scale just changed.
  const canvasScaleRef = useRef(canvasScale);
  useLayoutEffect(() => {
    canvasScaleRef.current = canvasScale;
  }, [canvasScale]);

  /** Last host size in LOGICAL (unscaled) pixels, so a zoom-driven resize is recognisable. */
  const lastLogicalRef = useRef<{ w: number; h: number } | null>(null);
```

Ensure `useLayoutEffect` is in the React import at the top of the file.

- [ ] **Step 3: Gate the ResizeObserver on logical size**

Replace the observer created in the one-shot create effect (~line 488):

```tsx
    // Re-fit when the host area changes size (window resize, panel toggles).
    const ro = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      scheduleFit();
    });
```

with:

```tsx
    // Re-fit when the host area changes size (window resize, panel toggles).
    //
    // On the canvas the box is `logical × zoom`, so a ZOOM changes it too — and refitting
    // for a zoom is exactly what must not happen: it renegotiates cols/rows with the PTY
    // and reflows the agent's output. The box and the font scale by the same factor, so
    // the grid is already correct; only a change in the LOGICAL size (the resize grip)
    // is a real resize.
    const ro = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      const el = innerRef.current;
      if (el) {
        const scale = canvasScaleRef.current ?? 1;
        const w = el.clientWidth / scale;
        const h = el.clientHeight / scale;
        const last = lastLogicalRef.current;
        lastLogicalRef.current = { w, h };
        if (last && Math.abs(last.w - w) < 1 && Math.abs(last.h - h) < 1) return;
      }
      scheduleFit();
    });
```

- [ ] **Step 4: Drive the font from the ladder**

Replace the font-zoom effect (~line 662-675) with:

```tsx
  // App-wide font zoom (View menu) and canvas zoom, which reach the terminal the same way:
  // by changing the rasterized glyph size rather than by scaling a finished bitmap.
  //
  // Outside the canvas, setting options.fontSize changes cell metrics WITHOUT firing the
  // ResizeObserver (the host box is unchanged), so cols/rows must be renegotiated with the
  // PTY explicitly. ON the canvas the opposite holds and the fit must be skipped: the box
  // already scaled by the same factor, so the grid is right, and refitting would only add
  // +/-1 drift from font-metric rounding -- which resizes the PTY and reflows the agent.
  // Hidden keep-alive terminals skip the fit (0x0 hazard) and pick the new size up through
  // the reveal-refit path.
  const fontZoom = useStore((s) => s.fontZoom);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const base = TERM_BASE_FONT + fontZoom;
    const size = canvasScale === undefined ? base : fontForZoom(canvasScale, base);
    if (term.options.fontSize === size) return;
    term.options.fontSize = size;
    if (canvasScale === undefined && visibleRef.current) scheduleFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontZoom, canvasScale]);
```

Add the import at the top of the file:

```tsx
import { fontForZoom } from "../terminalZoom";
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean. `canvasScale` is optional, so no call site needs changing yet.

- [ ] **Step 6: Commit**

```bash
git add src/components/Terminal.tsx
git commit -m "feat(canvas): rasterize terminal glyphs at the canvas zoom instead of scaling the bitmap"
```

---

### Task 3: Place terminals in screen pixels; the stack stops scaling

**Files:**
- Modify: `src/components/WorkspaceCenter.tsx:170-210` (`placeSession`), the `.term-stack` style (~line 374-382), the `TerminalView` call site (~line 385)

**Interfaces:**
- Consumes: `canvasScale` prop from Task 2.
- Produces: nothing new; changes the meaning of the canvas branch of `placeSession` from canvas units to screen pixels.

**Why:** `.term-stack.canvas-mode` currently carries `translate(pan) scale(zoom)`. That `scale()` is the resampling. The **underlay keeps its transform** — `.canvas-plane` is DOM and SVG, which a transform scales as vectors and which stays crisp — so only the stack changes. Losing the shared transform means the layers no longer agree for free, so the stack's children must be positioned in screen pixels derived from the same `CanvasState` the underlay uses.

- [ ] **Step 1: Convert the canvas branch of `placeSession` to screen pixels**

Replace the `if (canvasMode) { … }` block (~line 188-210) with:

```tsx
    // Canvas mode positions the SAME mounted terminals by absolute coordinates instead of
    // group percentages. This is the whole trick behind live terminals in canvas nodes:
    // one mounted set, two CSS expressions of it.
    //
    // The coordinates are SCREEN pixels, not canvas units. The stack carries only
    // translate(pan) -- no scale() -- because scaling a terminal scales a rasterized glyph
    // atlas, which is the blur. Each host is therefore sized `logical x zoom` and its
    // glyphs are rasterized at `base x zoom` by TerminalView's canvasScale.
    //
    // `right`/`bottom` are cleared explicitly because .term-host is `inset: 0`, and
    // leaving them at 0 would fight the width/height set here.
    if (canvasMode) {
      const node = canvas.nodes.find((n) => n.ref === sessionId);
      if (!node) {
        return { visible: false, inActiveGroup: false, style: { display: "none" } as React.CSSProperties };
      }
      const z = canvas.zoom;
      return {
        // Hidden below the legibility threshold, and during a zoom gesture -- the card
        // renders instead. Hidden is CSS-only, so the PTY and the xterm are untouched.
        visible: z >= LIVE_ZOOM_MIN && !zooming,
        inActiveGroup: false, // never steal the keyboard just because a node scrolled by
        style: {
          left: node.x * z,
          top: (node.y + HEADER_H) * z,
          width: nodeW(node) * z,
          // Stops above the footer strip so the resize grip stays reachable -- the
          // terminal paints above the card frame and would otherwise cover it.
          height: (nodeH(node) - HEADER_H - FOOTER_H) * z,
          right: "auto",
          bottom: "auto",
          padding: `${6 * z}px ${8 * z}px`,
        } as React.CSSProperties,
      };
    }
```

`zooming` is introduced in Task 4; for this task, declare it as a constant `false` immediately above `placeSession` so the file compiles:

```tsx
  // Replaced by real gesture state in the next task.
  const zooming = false;
```

- [ ] **Step 2: Drop `scale()` from the stack**

Replace the `.term-stack` style (~line 374-382):

```tsx
            canvasMode
              ? {
                  transform: `translate(${canvas.pan.x}px, ${canvas.pan.y}px) scale(${canvas.zoom})`,
                }
```

with:

```tsx
            canvasMode
              ? {
                  // translate ONLY. The children are already sized and placed in screen
                  // pixels by placeSession; a scale() here is what resampled the glyph
                  // atlas and made zoomed text soft. The underlay keeps its scale(), being
                  // vector content that a transform renders crisply.
                  transform: `translate(${canvas.pan.x}px, ${canvas.pan.y}px)`,
                }
```

- [ ] **Step 3: Pass the scale to the terminal**

At the `TerminalView` call site inside the `allSessions.map` (~line 385-420), add the prop:

```tsx
              canvasScale={canvasMode ? canvas.zoom : undefined}
```

- [ ] **Step 4: Typecheck and build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both clean.

- [ ] **Step 5: Verify in the app**

Run: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`

Open a project, open the canvas, and check:
- Cards and terminals stay aligned at zoom 1, 0.7 and 2.
- Text at zoom 2 is **sharp**, not a magnified 13px raster.
- With a running agent whose output is wrapped near the right edge, zoom in and out: no line rewraps.

- [ ] **Step 6: Commit**

```bash
git add src/components/WorkspaceCenter.tsx
git commit -m "feat(canvas): place canvas terminals in screen pixels so the stack needs no scale"
```

---

### Task 4: Terminals sit out the zoom gesture — and anything off-screen sits out entirely

**Files:**
- Modify: `src/components/WorkspaceCenter.tsx` (owns the `zooming` state), `src/components/CanvasView.tsx:120-142` (wheel handler), `src/components/Terminal.tsx` (repaint nudge)

**Interfaces:**
- Consumes: `snapZoom` from `src/terminalZoom.ts`.
- Produces: a new prop on `CanvasUnderlay`: `onZoomActive: (active: boolean) => void`.

**Why:** every visible terminal is its own GPU-composited surface, so changing scale on a common ancestor re-rasterizes all of them every frame. With terminals hidden during the gesture only lightweight chrome transforms, which is smooth at any scale — and on settle the terminals return already crisp at the snapped rung, so there is never a blurry frame at all.

- [ ] **Step 1: Own the gesture flag in `WorkspaceCenter`**

Replace the placeholder from Task 3:

```tsx
  // Replaced by real gesture state in the next task.
  const zooming = false;
```

with:

```tsx
  // True while a pinch/wheel-zoom is in flight. Terminals hide for its duration: a dozen
  // GPU-composited surfaces re-rasterizing every frame is the jank, and hiding them makes
  // the gesture a pure chrome transform. Set from CanvasUnderlay, which owns the wheel
  // listener, and cleared by it on settle.
  const [zooming, setZooming] = useState(false);
```

Pass it down at the `CanvasUnderlay` call site (~line 369):

```tsx
          <CanvasUnderlay
            projectId={projectId}
            viewportRef={canvasViewportRef}
            onZoomActive={setZooming}
          />
```

- [ ] **Step 2: Snap and report from the wheel handler**

In `CanvasView.tsx`, add `onZoomActive` to the `CanvasUnderlay` props type and destructuring:

```tsx
  /** Raised true while a zoom gesture is in flight, false ~120ms after it settles.
   *  WorkspaceCenter hides the terminals for that window — see its `zooming`. */
  onZoomActive: (active: boolean) => void;
```

Then replace the ctrl/meta branch of `onWheel` (~line 126-135) with:

```tsx
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        onZoomActive(true);
        setCanvas(
          zoomAt(canvas, Math.exp(-e.deltaY / 200), e.clientX - rect.left, e.clientY - rect.top),
        );
        if (settleRef.current) window.clearTimeout(settleRef.current);
        // Settle: snap to a rung so the glyphs rasterize at an integer size, then let the
        // terminals back. Read through the ref because this closure is one gesture old by
        // the time it fires.
        settleRef.current = window.setTimeout(() => {
          const cur = canvasRef.current;
          const snapped = snapZoom(cur.zoom, TERM_BASE_FONT + useStore.getState().fontZoom);
          if (snapped !== cur.zoom) {
            // Snap about the viewport centre, so settling does not slide the plane.
            const el = viewportRef.current;
            setCanvas(
              el
                ? zoomAt(cur, snapped / cur.zoom, el.clientWidth / 2, el.clientHeight / 2)
                : { ...cur, zoom: snapped },
            );
          }
          onZoomActive(false);
        }, 120);
        return;
      }
```

Add near the other refs at the top of `CanvasUnderlay`:

```tsx
  const settleRef = useRef<number | null>(null);
  // The wheel closure is rebuilt per render but its timeout is not; the ref is what the
  // settle reads so it snaps the LATEST zoom rather than the one the gesture started at.
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  useEffect(
    () => () => {
      if (settleRef.current) window.clearTimeout(settleRef.current);
    },
    [],
  );
```

Add the imports:

```tsx
import { snapZoom } from "../terminalZoom";
```

and export `TERM_BASE_FONT` from `src/components/Terminal.tsx` by changing `const TERM_BASE_FONT = 13;` to `export const TERM_BASE_FONT = 13;`, importing it in `CanvasView.tsx`.

- [ ] **Step 3: Repaint on reveal**

In `Terminal.tsx`'s visible effect (~line 545), inside the `requestAnimationFrame` callback and immediately after the `fit.fit()` try/catch, add:

```tsx
      // A pane that was hidden mid-frame can come back showing a stale composite -- the
      // same failure a re-attach has. Cheap, and only on the transition to visible.
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        /* not measurable yet */
      }
```

- [ ] **Step 4: Cull off-screen terminals**

The spec's other half of the cost story: re-rasterizing N glyph atlases on every zoom-settle
is not free, a global board puts far more terminals on screen at once than any pane layout,
and WebKit caps how many live GL contexts exist. Only nodes near the viewport go live; the
rest are cards until they scroll in. This is also the "cap on simultaneously live nodes"
that the 2026-08-10 viability document left open.

In `WorkspaceCenter.tsx`, above `placeSession`:

```tsx
/** How far outside the viewport a node still counts as live, in screen pixels. Generous, so
 *  scrolling a node into frame does not flash a card first. */
const CULL_MARGIN = 400;
```

and inside the canvas branch, replace the `visible:` line with:

```tsx
        visible: z >= LIVE_ZOOM_MIN && !zooming && onScreen,
```

computing `onScreen` just above the returned object:

```tsx
      // The stack carries translate(pan), so a node's screen position is its scaled
      // coordinate plus the pan. No viewport yet (first paint) counts as on-screen -- a
      // terminal that never went live would never spawn its PTY.
      const vp = canvasViewportRef.current;
      const sx = node.x * z + canvas.pan.x;
      const sy = node.y * z + canvas.pan.y;
      const onScreen =
        !vp ||
        (sx + nodeW(node) * z > -CULL_MARGIN &&
          sx < vp.clientWidth + CULL_MARGIN &&
          sy + nodeH(node) * z > -CULL_MARGIN &&
          sy < vp.clientHeight + CULL_MARGIN);
```

- [ ] **Step 5: Do not re-rasterize a hidden terminal**

A culled or gesture-hidden terminal must not rebuild its atlas — that is the cost culling
exists to avoid. In `Terminal.tsx`, add the guard to the font effect from Task 2, right after
the `if (term.options.fontSize === size) return;` line:

```tsx
    // A hidden terminal picks the size up on reveal (below). Setting it here would rebuild
    // the glyph atlas for a pane nobody is looking at, which is exactly the cost the
    // canvas's culling exists to avoid.
    if (!visibleRef.current) return;
```

and apply the pending size on reveal, inside the visible effect's `requestAnimationFrame`
callback **before** `fit.fit()`:

```tsx
      const base = TERM_BASE_FONT + useStore.getState().fontZoom;
      const wanted =
        canvasScaleRef.current === undefined
          ? base
          : fontForZoom(canvasScaleRef.current, base);
      if (term.options.fontSize !== wanted) term.options.fontSize = wanted;
```

- [ ] **Step 6: Typecheck and build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: clean.

- [ ] **Step 7: Verify in the app**

With six or more sessions open on the canvas:
- Pinch-zoom: terminals blink to cards, the gesture is smooth, and on release terminals return crisp. No blurry intermediate frame.
- Pan (two-finger scroll, no modifier): terminals stay live and do not blink.
- After settling, zoom reads a ladder value; text is sharp at each.
- Pan a node far off-screen: it becomes a card. Pan it back: it is live and crisp, with its scrollback intact — no respawn, no lost output.

- [ ] **Step 8: Commit**

```bash
git add src/components/WorkspaceCenter.tsx src/components/CanvasView.tsx src/components/Terminal.tsx
git commit -m "feat(canvas): drop terminals to cards during a zoom gesture and snap to a font rung"
```

---

### Task 5: The rich card

**Files:**
- Modify: `src/components/CanvasView.tsx:378-386` (the `!showTerminals` body), `src/theme.css`

**Interfaces:**
- Consumes: `useStore` (`live`, `projects`, `sessionContext`), `resolveProjectColor` from `src/layout.ts`, `meterLevel`/`meterTitle` from `src/contextMeter.ts`, `AgentGlyph`/`glyphStateFor` from `./AgentGlyph`.
- Produces: no new exports.

**Why:** below the legibility floor — and during every zoom gesture — the card *is* the view. Today it shows one status word. Every field below is real DOM text, so it stays crisp at any zoom by construction, which is the whole reason zoomed-out can be the useful view rather than the degraded one.

- [ ] **Step 1: Replace the card body**

Replace:

```tsx
              {!showTerminals && (
                <div className="canvas-card-body">
                  <span className="canvas-card-status">{statusLabel(status)}</span>
                </div>
              )}
```

with:

```tsx
              {/* The card IS the view below the legibility floor and during zoom gestures,
                  so it carries what the terminal would have told you. All DOM text, hence
                  crisp at any zoom -- which is the point of hiding the raster at all. */}
              {!showTerminals && (
                <div className="canvas-card-body rich">
                  <div className="canvas-card-row">
                    <span className={`canvas-card-status ${status}`}>{statusLabel(status)}</span>
                    {waitedMs !== null && (
                      <span className="canvas-card-waited" title="Waiting for you">
                        {formatWaited(waitedMs)}
                      </span>
                    )}
                  </div>
                  {activity && (
                    <div className="canvas-card-activity" title={activity}>
                      {activity}
                    </div>
                  )}
                  <div className="canvas-card-row dim">
                    <span className="canvas-card-project" style={{ color: projColor ?? undefined }}>
                      {ownerProject?.name ?? "—"}
                    </span>
                    {sessionContext[node.ref] && (
                      <span className={`canvas-ctx ${meterLevel(sessionContext[node.ref].fraction)}`}>
                        {Math.round(sessionContext[node.ref].fraction * 100)}%
                      </span>
                    )}
                  </div>
                </div>
              )}
```

- [ ] **Step 2: Derive the new values beside the existing `status`**

Inside the same `canvas.nodes.map(...)` callback, next to where `status` is already computed, add:

```tsx
          const liveEntry = live[node.ref];
          const activity = liveEntry?.activity;
          // How long this session has been waiting on a human. Only meaningful while it IS
          // waiting -- `updatedAt` is when the status was last asserted, whatever it is.
          const waitedMs =
            status === "needsInput" && liveEntry?.updatedAt
              ? Date.now() - liveEntry.updatedAt
              : null;
          const ownerProject = projects.find((p) => p.sessions.some((s) => s.id === node.ref));
          // resolveProjectColor is the ONE place precedence is decided: a user-chosen colour
          // beats the derived accent, which is used only while autoProjectColors is on, and
          // null falls through to each consumer's neutral CSS fallback. Never call
          // projectAccent directly or the sidebar and the board disagree.
          const projColor = ownerProject
            ? resolveProjectColor(ownerProject.id, ownerProject.color, autoProjectColors)
            : null;
```

`resolveProjectColor(projectId: string, explicit: string | null | undefined, autoColors: boolean): string | null` — `src/layout.ts:99`.

Read `autoProjectColors` from the store beside the other selectors at the top of `CanvasUnderlay`:

```tsx
  const autoProjectColors = useStore((s) => s.autoProjectColors);
```

- [ ] **Step 3: Add the duration formatter**

At the bottom of `CanvasView.tsx`, beside `statusLabel`:

```tsx
/** Coarse "how long" for a card: minutes up to an hour, then hours. Never seconds — a
 *  card is read at a glance and a ticking number is noise. */
function formatWaited(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
```

- [ ] **Step 4: Style it**

In `src/theme.css`, beside the existing `.canvas-card-body` rules:

```css
/* The rich card. Shown below LIVE_ZOOM_MIN and during zoom gestures — i.e. whenever the
   terminal is hidden — so it has to carry the session's state on its own. DOM text, so it
   stays crisp at every zoom, which is the whole reason the raster is hidden. */
.canvas-card-body.rich {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 10px; overflow: hidden;
}
.canvas-card-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.canvas-card-row.dim { color: var(--text-dim); font-size: 11px; }
.canvas-card-status { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
.canvas-card-status.needsInput { color: var(--warn, #e0b341); }
.canvas-card-status.running { color: var(--accent); }
.canvas-card-waited { font-size: 11px; color: var(--warn, #e0b341); }
.canvas-card-activity {
  font-size: 12px; color: var(--text-mid);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.canvas-card-project { font-weight: 500; }
```

- [ ] **Step 5: Typecheck, build, verify**

Run: `pnpm exec tsc --noEmit && pnpm build`, then launch the app, zoom below 0.55 with a running session and one awaiting input. Expect: activity line on the running one, a wait duration on the waiting one, project name in the project's colour, context percentage.

- [ ] **Step 6: Commit**

```bash
git add src/components/CanvasView.tsx src/theme.css
git commit -m "feat(canvas): make the zoomed-out card carry the session's real state"
```

---

**Increment 0 gate.** Before starting Increment 1, run all three checks and launch the app:

```bash
pnpm exec tsc --noEmit && pnpm test && pnpm build
```

Confirm by hand: sharp text at every rung from the smallest to 2.0; no reflow while zooming a running agent; smooth gestures with ten live sessions.

---

# Increment 1 — The plane

### Task 6: Curated membership replaces auto-placement

**Files:**
- Modify: `src/canvas.ts` (`CanvasNode`, `reconcile`, and the auto-placement helpers)
- Test: `src/canvas.test.ts`

**Interfaces:**
- Produces: `CanvasNode.projectId: string` (required); `pruneCanvas(state: CanvasState, liveSessionIds: Set<string>): CanvasState`; `addNodeAt(state: CanvasState, ref: string, projectId: string, x: number, y: number): CanvasState`; `removeNode(state: CanvasState, ref: string): CanvasState`; `migrateNotes(old: Record<string, CanvasState>): CanvasState`.
- Removes: `reconcile`, `firstFreeSlot`, `slotKey`, `COLS`, `GAP`.

**Why:** `reconcile()` auto-places every session in the project, so every card is on the board because it exists rather than because anyone put it there — which is exactly why position carries no information today. Pruning stays (a node whose session is gone must go); placing does not.

- [ ] **Step 1: Write the failing tests**

In `src/canvas.test.ts`, delete the `describe("reconcile", …)` block and add:

```ts
const node = (ref: string, projectId: string, x: number, y: number) => ({ ref, projectId, x, y });

describe("pruneCanvas", () => {
  it("drops nodes whose session is gone and keeps the rest in order", () => {
    const s: CanvasState = {
      ...emptyCanvas(),
      nodes: [node("a", "p1", 0, 0), node("b", "p2", 100, 0), node("c", "p1", 200, 0)],
    };
    const out = pruneCanvas(s, new Set(["a", "c"]));
    expect(out.nodes.map((n) => n.ref)).toEqual(["a", "c"]);
  });

  it("never places a session that has no node", () => {
    const out = pruneCanvas(emptyCanvas(), new Set(["a", "b"]));
    expect(out.nodes).toEqual([]);
  });

  it("returns the SAME object when nothing changed", () => {
    const s: CanvasState = { ...emptyCanvas(), nodes: [node("a", "p1", 0, 0)] };
    expect(pruneCanvas(s, new Set(["a"]))).toBe(s);
  });

  it("keeps a note whose linked session is gone, and drops only the link", () => {
    let s = addNote(emptyCanvas(), "n1", 0, 0);
    s = linkNote(s, "n1", "gone");
    const out = pruneCanvas(s, new Set<string>());
    expect(notesOf(out)).toHaveLength(1);
    expect(notesOf(out)[0].linkedRef).toBeUndefined();
  });
});

describe("addNodeAt / removeNode", () => {
  it("adds a node carrying its project", () => {
    const s = addNodeAt(emptyCanvas(), "a", "p1", 40, 60);
    expect(s.nodes).toEqual([{ ref: "a", projectId: "p1", x: 40, y: 60 }]);
  });

  it("is idempotent — a session already on the board is not duplicated", () => {
    const s = addNodeAt(addNodeAt(emptyCanvas(), "a", "p1", 0, 0), "a", "p1", 500, 500);
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0].x).toBe(0);
  });

  it("removes a node without touching notes", () => {
    let s = addNodeAt(emptyCanvas(), "a", "p1", 0, 0);
    s = addNote(s, "n1", 10, 10);
    const out = removeNode(s, "a");
    expect(out.nodes).toEqual([]);
    expect(notesOf(out)).toHaveLength(1);
  });

  it("returns the SAME object when removing something absent", () => {
    const s = emptyCanvas();
    expect(removeNode(s, "nope")).toBe(s);
  });
});

describe("migrateNotes", () => {
  it("carries every project's notes onto one plane, offset so they do not overlap", () => {
    const p1: CanvasState = { ...addNote(emptyCanvas(), "n1", 0, 0), nodes: [] };
    const p2: CanvasState = { ...addNote(emptyCanvas(), "n2", 0, 0), nodes: [] };
    const out = migrateNotes({ alpha: p1, beta: p2 });
    expect(notesOf(out).map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    const ys = notesOf(out).map((n) => n.y);
    expect(new Set(ys).size).toBe(2);
  });

  it("carries no nodes — their placements were auto-generated", () => {
    const p1: CanvasState = { ...emptyCanvas(), nodes: [node("a", "alpha", 0, 0)] };
    expect(migrateNotes({ alpha: p1 }).nodes).toEqual([]);
  });

  it("drops a link, since the note's session may not be on the new board", () => {
    let p1 = addNote(emptyCanvas(), "n1", 0, 0);
    p1 = linkNote(p1, "n1", "a");
    expect(notesOf(migrateNotes({ alpha: p1 }))[0].linkedRef).toBeUndefined();
  });
});
```

Add `addNodeAt`, `removeNode`, `pruneCanvas`, `migrateNotes` and the `CanvasState` type import to the test file's import block, and remove `reconcile`.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test -- src/canvas.test.ts`
Expected: FAIL — `pruneCanvas is not exported`.

- [ ] **Step 3: Implement**

In `src/canvas.ts`, add `projectId` to `CanvasNode`:

```ts
export interface CanvasNode {
  /** Session id. Also the React key — stable for the node's whole life. */
  ref: string;
  /**
   * The project owning this session.
   *
   * REQUIRED, which is the opposite of `WsTab.projectId` for borrowed tabs — and correctly
   * so. A tab lives in a project's layout, so absence can mean "the host"; a global board
   * has no host for absence to mean, and a session id alone does not locate its project
   * without scanning every one of them.
   */
  projectId: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}
```

Delete `reconcile`, `slotKey`, `firstFreeSlot`, and the `GAP` / `COLS` constants. Add:

```ts
/**
 * Drop nodes whose session no longer exists, and strip links to sessions that are gone.
 *
 * The pruning half of what `reconcile` used to do. The PLACING half is deliberately absent:
 * membership on this board is curated, and a session existing is not a reason for it to be
 * on screen — that is what makes a position mean something.
 *
 * Returns the SAME object when nothing changed, which the store's write-back guard relies
 * on to avoid an infinite render loop.
 */
export function pruneCanvas(state: CanvasState, liveSessionIds: Set<string>): CanvasState {
  const kept = state.nodes.filter((n) => liveSessionIds.has(n.ref));
  const notes = notesOf(state);
  // A note whose linked session is gone keeps the note and loses only the link. The note is
  // the user's writing and is never ours to delete; the link points at nothing, and leaving
  // it would draw a tether to nowhere.
  const dangling = notes.some((n) => n.linkedRef !== undefined && !liveSessionIds.has(n.linkedRef));
  if (kept.length === state.nodes.length && !dangling) return state;
  const nextNotes = dangling
    ? notes.map((n) =>
        n.linkedRef !== undefined && !liveSessionIds.has(n.linkedRef) ? stripLink(n) : n,
      )
    : notes;
  return {
    ...state,
    nodes: kept,
    ...(state.notes === undefined && !dangling ? {} : { notes: nextNotes }),
  };
}

/**
 * Put a session on the board at (x, y).
 *
 * Idempotent: a session already present keeps its existing position, so a second drop is
 * harmless rather than a teleport. New nodes are APPENDED and existing ones keep their
 * array index — see the file header for why that ordering is load-bearing.
 */
export function addNodeAt(
  state: CanvasState,
  ref: string,
  projectId: string,
  x: number,
  y: number,
): CanvasState {
  if (state.nodes.some((n) => n.ref === ref)) return state;
  return { ...state, nodes: [...state.nodes, { ref, projectId, x, y }] };
}

/** Take a session off the board. The session itself is untouched and keeps running. */
export function removeNode(state: CanvasState, ref: string): CanvasState {
  const kept = state.nodes.filter((n) => n.ref !== ref);
  return kept.length === state.nodes.length ? state : { ...state, nodes: kept };
}

/** Vertical spacing between one project's migrated notes and the next project's. */
const MIGRATE_ROW_H = 1000;

/**
 * Fold the old per-project canvases into the one global board.
 *
 * Only NOTES cross. The node placements were produced by the auto-placer this design
 * removes, and stacking several projects' coordinate spaces onto one plane would pile cards
 * on top of each other — whereas a note is the user's writing, and `stripLink`'s comment
 * already records that it is never ours to delete.
 *
 * Links are dropped: the linked session may not be on the new board at all, and a tether to
 * nothing is worse than no tether.
 */
export function migrateNotes(old: Record<string, CanvasState>): CanvasState {
  const notes: CanvasNote[] = [];
  const seen = new Set<string>();
  Object.keys(old)
    .sort()
    .forEach((projectId, row) => {
      for (const n of notesOf(old[projectId])) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        notes.push({ ...stripLink(n), y: n.y + row * MIGRATE_ROW_H });
      }
    });
  return { ...emptyCanvas(), ...(notes.length ? { notes } : {}) };
}
```

- [ ] **Step 4: Run and confirm the suite passes**

Run: `pnpm test -- src/canvas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/canvas.ts src/canvas.test.ts
git commit -m "feat(canvas): curate board membership instead of auto-placing every session"
```

---

### Task 7: Sections

**Files:**
- Modify: `src/canvas.ts`
- Test: `src/canvas.test.ts`

**Interfaces:**
- Produces: `CanvasSection`; `SECTION_MIN_W`/`SECTION_MIN_H`/`SECTION_PALETTE`; `sectionsOf`; `Box`; `boxOfNode`/`boxOfNote`/`boxOfSection`; `containsBox`; `Members`; `membersOf`; `addSection`; `resizeSection`; `setSectionTitle`; `setSectionColor`; `removeSection`; `translateMany`; `sectionsByZ`.

**Why:** membership is **geometric** — whatever sits inside the bounds belongs. No membership list means nothing to drift out of sync with position, nesting falls out for free, and dragging a session into a section needs no code beyond the drag that already moves it. Z-order is **derived** (sections behind, by descending area) rather than stored, because storing it would mean an order field or an array reorder, and `canvas.ts`'s header forbids reordering: React reorders DOM to match list order, and a reorder is a reparent that kills a PTY.

- [ ] **Step 1: Write the failing tests**

Append to `src/canvas.test.ts`:

```ts
describe("sections", () => {
  const withSection = () => addSection(emptyCanvas(), "s1", 0, 0, 800, 600, "Auth");

  it("adds a section with a title and no colour", () => {
    const s = withSection();
    expect(sectionsOf(s)).toHaveLength(1);
    expect(sectionsOf(s)[0]).toMatchObject({ id: "s1", x: 0, y: 0, w: 800, h: 600, title: "Auth" });
    expect(sectionsOf(s)[0].color).toBeUndefined();
  });

  it("contains only what fits fully inside its bounds", () => {
    let s = withSection();
    s = addNodeAt(s, "in", "p1", 10, 10); // default card 560x340 — fits
    s = addNodeAt(s, "out", "p1", 900, 10); // outside entirely
    const m = membersOf(s, "s1");
    expect(m.nodes).toEqual(["in"]);
  });

  it("does not contain a node that merely overlaps the edge", () => {
    let s = withSection();
    s = addNodeAt(s, "edge", "p1", 700, 10); // 700 + 560 > 800
    expect(membersOf(s, "s1").nodes).toEqual([]);
  });

  it("contains a nested section", () => {
    let s = withSection();
    s = addSection(s, "s2", 50, 50, 300, 300, "Inner");
    expect(membersOf(s, "s1").sections).toEqual(["s2"]);
    expect(membersOf(s, "s2").sections).toEqual([]);
  });

  it("never contains itself", () => {
    expect(membersOf(withSection(), "s1").sections).toEqual([]);
  });

  it("moves its contents when translated, and keeps node array order", () => {
    let s = withSection();
    s = addNodeAt(s, "a", "p1", 10, 10);
    s = addNodeAt(s, "b", "p1", 10, 400);
    const m = membersOf(s, "s1");
    const out = translateMany(s, { ...m, sections: [...m.sections, "s1"] }, 100, 50);
    expect(out.nodes.map((n) => n.ref)).toEqual(["a", "b"]);
    expect(out.nodes[0]).toMatchObject({ x: 110, y: 60 });
    expect(sectionsOf(out)[0]).toMatchObject({ x: 100, y: 50 });
  });

  it("does NOT move contents when resized — a resize changes what it contains", () => {
    let s = withSection();
    s = addNodeAt(s, "a", "p1", 10, 10);
    const out = resizeSection(s, "s1", 400, 300);
    expect(out.nodes[0]).toMatchObject({ x: 10, y: 10 });
    expect(sectionsOf(out)[0]).toMatchObject({ w: 400, h: 300 });
  });

  it("clamps a resize to the minimum", () => {
    const out = resizeSection(withSection(), "s1", 10, 10);
    expect(sectionsOf(out)[0].w).toBe(SECTION_MIN_W);
    expect(sectionsOf(out)[0].h).toBe(SECTION_MIN_H);
  });

  it("removes a section without removing what was inside it", () => {
    let s = withSection();
    s = addNodeAt(s, "a", "p1", 10, 10);
    const out = removeSection(s, "s1");
    expect(sectionsOf(out)).toEqual([]);
    expect(out.nodes).toHaveLength(1);
  });

  it("orders sections back-to-front by descending area, so a nested one paints over", () => {
    let s = withSection();
    s = addSection(s, "s2", 50, 50, 300, 300, "Inner");
    expect(sectionsByZ(s).map((x) => x.id)).toEqual(["s1", "s2"]);
  });

  it("sets and clears a colour", () => {
    let s = setSectionColor(withSection(), "s1", 2);
    expect(sectionsOf(s)[0].color).toBe(2);
    s = setSectionColor(s, "s1", null);
    expect(sectionsOf(s)[0].color).toBeUndefined();
  });

  it("renames", () => {
    expect(sectionsOf(setSectionTitle(withSection(), "s1", "Deploy"))[0].title).toBe("Deploy");
  });
});
```

Extend the test file's import block with every new name used above.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test -- src/canvas.test.ts`
Expected: FAIL — `addSection is not exported`.

- [ ] **Step 3: Implement**

Append to `src/canvas.ts`:

```ts
// ---- sections ----

/**
 * A titled container drawn behind its contents.
 *
 * Purely visual: it groups, and it moves what it holds. It does not broadcast, stop, spawn,
 * or otherwise act on the sessions inside it — those would be a different feature with a
 * different set of risks, and the whole point of this one is organising by hand.
 *
 * Membership is GEOMETRIC and computed on demand (`membersOf`), never stored. There is
 * therefore no list to drift out of sync with position, and nesting is free.
 */
export interface CanvasSection {
  /** Generated at creation; stable for the section's life and its React key. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** Index into `SECTION_PALETTE`. Absent = neutral, which is what a fresh section is. */
  color?: number;
}

export const SECTION_MIN_W = 240;
export const SECTION_MIN_H = 180;

/**
 * Section tints. Deliberately its own short list rather than the project palette: a section
 * is the user's own grouping, and borrowing project colours would make two unrelated
 * meanings share a hue.
 */
export const SECTION_PALETTE: readonly string[] = [
  "#6b7cff",
  "#e0723f",
  "#3fa66b",
  "#c04f8a",
  "#c9a227",
  "#5aa9c9",
];

/** A canvas's sections, defaulting to none for state saved before sections existed. */
export const sectionsOf = (state: CanvasState): CanvasSection[] => state.sections ?? [];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const boxOfNode = (n: CanvasNode): Box => ({ x: n.x, y: n.y, w: nodeW(n), h: nodeH(n) });
export const boxOfNote = (n: CanvasNote): Box => ({ x: n.x, y: n.y, w: n.w, h: n.h });
export const boxOfSection = (s: CanvasSection): Box => ({ x: s.x, y: s.y, w: s.w, h: s.h });

/** True when `inner` sits FULLY inside `outer`. Overlap is not membership: a card half in
 *  and half out belongs to neither, which is the only reading that keeps a drag honest. */
export function containsBox(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export interface Members {
  nodes: string[];
  notes: string[];
  sections: string[];
}

/** Everything geometrically inside a section. The section itself is never a member. */
export function membersOf(state: CanvasState, sectionId: string): Members {
  const self = sectionsOf(state).find((s) => s.id === sectionId);
  if (!self) return { nodes: [], notes: [], sections: [] };
  const outer = boxOfSection(self);
  return {
    nodes: state.nodes.filter((n) => containsBox(outer, boxOfNode(n))).map((n) => n.ref),
    notes: notesOf(state)
      .filter((n) => containsBox(outer, boxOfNote(n)))
      .map((n) => n.id),
    sections: sectionsOf(state)
      .filter((s) => s.id !== sectionId && containsBox(outer, boxOfSection(s)))
      .map((s) => s.id),
  };
}

export function addSection(
  state: CanvasState,
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
): CanvasState {
  const section: CanvasSection = {
    id,
    x,
    y,
    w: Math.max(SECTION_MIN_W, w),
    h: Math.max(SECTION_MIN_H, h),
    title,
  };
  return { ...state, sections: [...sectionsOf(state), section] };
}

/** Update one section in place, preserving array order. Same object back when unchanged. */
function patchSection(
  state: CanvasState,
  id: string,
  patch: (s: CanvasSection) => CanvasSection,
): CanvasState {
  const sections = sectionsOf(state);
  const i = sections.findIndex((s) => s.id === id);
  if (i === -1) return state;
  const next = patch(sections[i]);
  const cur = sections[i];
  if (
    next.x === cur.x &&
    next.y === cur.y &&
    next.w === cur.w &&
    next.h === cur.h &&
    next.title === cur.title &&
    next.color === cur.color
  ) {
    return state;
  }
  const copy = [...sections];
  copy[i] = next;
  return { ...state, sections: copy };
}

/**
 * Resize from the bottom-right. Contents are NOT moved — a resize changes what the section
 * CONTAINS, which is what makes "draw a box around those three" work.
 */
export const resizeSection = (state: CanvasState, id: string, w: number, h: number): CanvasState =>
  patchSection(state, id, (s) => ({
    ...s,
    w: Math.max(SECTION_MIN_W, w),
    h: Math.max(SECTION_MIN_H, h),
  }));

export const setSectionTitle = (state: CanvasState, id: string, title: string): CanvasState =>
  patchSection(state, id, (s) => ({ ...s, title }));

/** `null` clears the colour back to neutral. Written as a delete so the field is absent
 *  rather than `undefined` — persisted state round-trips through JSON, which keeps one and
 *  drops the other, and absent is what a never-coloured section looks like. */
export function setSectionColor(state: CanvasState, id: string, color: number | null): CanvasState {
  return patchSection(state, id, (s) => {
    if (color === null) {
      const { color: _drop, ...rest } = s;
      return rest;
    }
    return { ...s, color };
  });
}

/** Remove the section. What was inside it stays on the plane — deleting a container must
 *  never delete a running session. */
export function removeSection(state: CanvasState, id: string): CanvasState {
  const sections = sectionsOf(state);
  const kept = sections.filter((s) => s.id !== id);
  return kept.length === sections.length ? state : { ...state, sections: kept };
}

/**
 * Translate an explicit set of things by the same delta — how a section drag moves its
 * contents.
 *
 * The membership is passed IN rather than recomputed, because a drag must use the set
 * captured when the gesture started: recomputing mid-drag would let items join and leave as
 * the box swept over them, which reads as the section eating the board.
 */
export function translateMany(
  state: CanvasState,
  members: Members,
  dx: number,
  dy: number,
): CanvasState {
  if (dx === 0 && dy === 0) return state;
  const nodeIds = new Set(members.nodes);
  const noteIds = new Set(members.notes);
  const sectionIds = new Set(members.sections);
  return {
    ...state,
    // Index preserved throughout — see the file header.
    nodes: state.nodes.map((n) => (nodeIds.has(n.ref) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
    ...(state.notes === undefined
      ? {}
      : {
          notes: notesOf(state).map((n) =>
            noteIds.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
          ),
        }),
    ...(state.sections === undefined
      ? {}
      : {
          sections: sectionsOf(state).map((s) =>
            sectionIds.has(s.id) ? { ...s, x: s.x + dx, y: s.y + dy } : s,
          ),
        }),
  };
}

/**
 * Sections back to front: largest first, so a nested section paints over its parent.
 *
 * Derived, never stored. A stored z would mean either an order field to maintain or an
 * array reorder — and reordering is forbidden here, because React reorders DOM to match
 * list order and a reorder is a reparent, which kills a PTY.
 */
export const sectionsByZ = (state: CanvasState): CanvasSection[] =>
  [...sectionsOf(state)].sort((a, b) => b.w * b.h - a.w * a.h);
```

Add `sections?: CanvasSection[];` to `CanvasState`, documented as optional for the same reason `notes?` is, and include sections in `fit()`'s content boxes.

- [ ] **Step 4: Run and confirm the suite passes**

Run: `pnpm test -- src/canvas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/canvas.ts src/canvas.test.ts
git commit -m "feat(canvas): add visual sections with geometric containment and derived z-order"
```

---

### Task 8: Undo

**Files:**
- Create: `src/canvasHistory.ts`, `src/canvasHistory.test.ts`

**Interfaces:**
- Produces: `History<T>`; `emptyHistory<T>()`; `HISTORY_CAP`; `pushHistory<T>(h, snapshot): History<T>`; `undo<T>(h, current): { history: History<T>; state: T } | null`; `redo<T>(h, current): { history: History<T>; state: T } | null`.

**Why:** unusually cheap here, because `CanvasState` is already a pure immutable value whose transitions return a new object — and return the *same* object when nothing changed. Snapshots therefore cost a few pointers, not a copy of the plane. Entries are pushed at gesture **start**, so one drag is one undo step rather than two hundred.

- [ ] **Step 1: Write the failing test**

Create `src/canvasHistory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HISTORY_CAP, emptyHistory, pushHistory, redo, undo } from "./canvasHistory";

describe("canvasHistory", () => {
  it("undoes to the pushed snapshot and hands the current state to redo", () => {
    const h = pushHistory(emptyHistory<string>(), "a");
    const back = undo(h, "b");
    expect(back).not.toBeNull();
    expect(back!.state).toBe("a");
    const fwd = redo(back!.history, back!.state);
    expect(fwd!.state).toBe("b");
  });

  it("returns null with nothing to undo or redo", () => {
    expect(undo(emptyHistory<string>(), "a")).toBeNull();
    expect(redo(emptyHistory<string>(), "a")).toBeNull();
  });

  it("clears the redo stack on a new push — a new edit forks the timeline", () => {
    const h = pushHistory(emptyHistory<string>(), "a");
    const back = undo(h, "b")!;
    const forked = pushHistory(back.history, "c");
    expect(forked.future).toEqual([]);
    expect(redo(forked, "d")).toBeNull();
  });

  it("caps the past, discarding the oldest", () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < HISTORY_CAP + 10; i++) h = pushHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toBe(10);
  });

  it("does not push a snapshot identical to the last one", () => {
    const s = { a: 1 };
    const h = pushHistory(pushHistory(emptyHistory<object>(), s), s);
    expect(h.past).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test -- src/canvasHistory.test.ts`
Expected: FAIL — cannot resolve `./canvasHistory`.

- [ ] **Step 3: Implement**

Create `src/canvasHistory.ts`:

```ts
// src/canvasHistory.ts — undo/redo as a snapshot stack. NO Tauri / Zustand / React imports.
//
// Generic over the snapshot type so it stays testable without the canvas, but it exists for
// `CanvasState`, and it is cheap precisely because that type is already a pure immutable
// value: every transition returns a new object built by spreading the old one, so a
// snapshot shares almost all of its structure with its neighbours and costs a few pointers.
//
// Entries are pushed at GESTURE START, not per pointer-move, so one drag is one undo step.

export interface History<T> {
  /** Oldest first. The last entry is what an undo returns to. */
  past: T[];
  /** Newest first. The head is what a redo returns to. */
  future: T[];
}

/** How far back undo reaches. Snapshots are cheap, but not free, and a board is not a
 *  document anyone edits for hours without a reload. */
export const HISTORY_CAP = 50;

export const emptyHistory = <T>(): History<T> => ({ past: [], future: [] });

/**
 * Record the state as it was BEFORE an edit.
 *
 * A new edit forks the timeline, so the redo stack is discarded — the alternative is a tree,
 * and nobody has ever wanted one in a canvas.
 */
export function pushHistory<T>(h: History<T>, snapshot: T): History<T> {
  if (h.past.length > 0 && h.past[h.past.length - 1] === snapshot) return h;
  const past = [...h.past, snapshot];
  return { past: past.length > HISTORY_CAP ? past.slice(past.length - HISTORY_CAP) : past, future: [] };
}

/** Step back. `current` is what redo will return to. Null when there is nothing to undo. */
export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.past.length === 0) return null;
  const state = h.past[h.past.length - 1];
  return {
    history: { past: h.past.slice(0, -1), future: [current, ...h.future] },
    state,
  };
}

/** Step forward. `current` becomes the newest past entry. Null when there is nothing to redo. */
export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (h.future.length === 0) return null;
  const [state, ...rest] = h.future;
  return { history: { past: [...h.past, current], future: rest }, state };
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test -- src/canvasHistory.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/canvasHistory.ts src/canvasHistory.test.ts
git commit -m "feat(canvas): add an undo snapshot stack for the board"
```

---

### Task 9: Attention geometry

**Files:**
- Create: `src/canvasAttention.ts`, `src/canvasAttention.test.ts`

**Interfaces:**
- Produces: `Camera`; `Viewport`; `AttentionSource`; `AttentionItem`; `attentionQueue(sources: AttentionSource[], now: number): AttentionItem[]`; `PipBox`; `Pip`; `edgePips(boxes: PipBox[], camera: Camera, viewport: Viewport, margin?: number): Pip[]`; `cameraFor(box: PipBox, viewport: Viewport, zoom: number): Camera`; `interpolateCamera(from: Camera, to: Camera, t: number): Camera`; `easeInOutCubic(t: number): number`.
- Consumes: `WORKING_STALE_MS` from `src/statusRules.ts`.

**Why:** an infinite canvas is *worse* than a sidebar at high load for one specific reason — a sidebar always shows all thirty rows, a canvas shows whatever the viewport frames, and the session that has waited forty minutes can sit three thousand pixels off-screen. Edge pips and the rail are what put it back in view.

- [ ] **Step 1: Write the failing test**

Create `src/canvasAttention.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WORKING_STALE_MS } from "./statusRules";
import {
  attentionQueue,
  cameraFor,
  easeInOutCubic,
  edgePips,
  interpolateCamera,
} from "./canvasAttention";

const NOW = 1_000_000_000;

describe("attentionQueue", () => {
  it("lists sessions awaiting input, longest wait first", () => {
    const q = attentionQueue(
      [
        { ref: "recent", projectId: "p1", status: "needsInput", updatedAt: NOW - 60_000 },
        { ref: "old", projectId: "p2", status: "needsInput", updatedAt: NOW - 600_000 },
      ],
      NOW,
    );
    expect(q.map((i) => i.ref)).toEqual(["old", "recent"]);
    expect(q[0].waitedMs).toBe(600_000);
  });

  it("ignores idle, running and done sessions", () => {
    const q = attentionQueue(
      [
        { ref: "a", projectId: "p1", status: "idle", updatedAt: NOW },
        { ref: "b", projectId: "p1", status: "running", updatedAt: NOW },
        { ref: "c", projectId: "p1", status: "done", updatedAt: NOW },
      ],
      NOW,
    );
    expect(q).toEqual([]);
  });

  it("includes a session stuck in running past the stale watchdog", () => {
    const q = attentionQueue(
      [{ ref: "stuck", projectId: "p1", status: "running", updatedAt: NOW - WORKING_STALE_MS - 1 }],
      NOW,
    );
    expect(q.map((i) => i.ref)).toEqual(["stuck"]);
  });

  it("treats a missing timestamp as no wait rather than an infinite one", () => {
    const q = attentionQueue([{ ref: "a", projectId: "p1", status: "needsInput" }], NOW);
    expect(q[0].waitedMs).toBe(0);
  });
});

describe("edgePips", () => {
  const viewport = { w: 1000, h: 800 };
  const camera = { pan: { x: 0, y: 0 }, zoom: 1 };

  it("emits nothing for a box already on screen", () => {
    expect(edgePips([{ ref: "a", x: 400, y: 300, w: 100, h: 100 }], camera, viewport)).toEqual([]);
  });

  it("pins a pip to the right border for a box off to the right", () => {
    const [pip] = edgePips([{ ref: "a", x: 5000, y: 380, w: 100, h: 100 }], camera, viewport, 20);
    expect(pip.ref).toBe("a");
    expect(pip.x).toBeCloseTo(viewport.w - 20, 6);
    expect(pip.y).toBeGreaterThan(0);
    expect(pip.y).toBeLessThan(viewport.h);
  });

  it("pins a pip to the top border for a box above", () => {
    const [pip] = edgePips([{ ref: "a", x: 450, y: -5000, w: 100, h: 100 }], camera, viewport, 20);
    expect(pip.y).toBeCloseTo(20, 6);
  });

  it("respects pan and zoom when deciding what is off screen", () => {
    const panned = { pan: { x: -4900, y: 0 }, zoom: 1 };
    expect(edgePips([{ ref: "a", x: 5000, y: 380, w: 100, h: 100 }], panned, viewport)).toEqual([]);
  });

  it("points roughly north-east for a box up and to the right", () => {
    const [pip] = edgePips([{ ref: "a", x: 9000, y: -9000, w: 10, h: 10 }], camera, viewport, 20);
    expect(pip.angle).toBeLessThan(0); // atan2 with a negative dy
    expect(Math.cos(pip.angle)).toBeGreaterThan(0);
  });
});

describe("cameraFor", () => {
  it("centres the box in the viewport at the requested zoom", () => {
    const cam = cameraFor({ ref: "a", x: 1000, y: 1000, w: 200, h: 100 }, { w: 800, h: 600 }, 2);
    // centre of the box in canvas units is (1100, 1050); at zoom 2 that is (2200, 2100)
    expect(cam.pan.x).toBeCloseTo(400 - 2200, 6);
    expect(cam.pan.y).toBeCloseTo(300 - 2100, 6);
    expect(cam.zoom).toBe(2);
  });
});

describe("interpolateCamera", () => {
  const a = { pan: { x: 0, y: 0 }, zoom: 1 };
  const b = { pan: { x: 100, y: 200 }, zoom: 2 };

  it("returns the endpoints exactly", () => {
    expect(interpolateCamera(a, b, 0)).toEqual(a);
    expect(interpolateCamera(a, b, 1)).toEqual(b);
  });

  it("is monotonic in between", () => {
    const mid = interpolateCamera(a, b, 0.5);
    expect(mid.pan.x).toBeGreaterThan(0);
    expect(mid.pan.x).toBeLessThan(100);
    expect(mid.zoom).toBeGreaterThan(1);
  });
});

describe("easeInOutCubic", () => {
  it("pins both ends and passes through the middle", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test -- src/canvasAttention.test.ts`
Expected: FAIL — cannot resolve `./canvasAttention`.

- [ ] **Step 3: Implement**

Create `src/canvasAttention.ts`:

```ts
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
```

- [ ] **Step 4: Run and confirm it passes**

Run: `pnpm test -- src/canvasAttention.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/canvasAttention.ts src/canvasAttention.test.ts
git commit -m "feat(canvas): add attention queue ordering, edge pips and camera interpolation"
```

---

### Task 10: One global canvas in the store

**Files:**
- Modify: `src/store.ts:281` (`CenterMode`), `:665-680` (`readCanvases`/`writeCanvases`), `:1502-1521` (slice types), `:3435-3452` (initial state and actions)

**Interfaces:**
- Produces: store fields `canvas: CanvasState`, `setGlobalCanvas: (next: CanvasState) => void`, `canvasOpen: boolean`, `setCanvasOpen: (open: boolean) => void`.
- Removes: `canvases: Record<string, CanvasState>`, `setCanvas`, and `"canvas"` from `CenterMode`.

**Why localStorage, not `state.json`:** a Rust `Store` that fails to parse is an EMPTY store, and an empty store makes every live tmux session look like an orphan to the startup sweep — which then kills every running agent. Canvas layout is not worth going near that blast radius, and it is per-machine anyway.

- [ ] **Step 1: Narrow `CenterMode`**

```ts
export type CenterMode = "terminals" | "board";
```

- [ ] **Step 2: Replace the persistence helpers**

Keep `readCanvases` (migration reads it) and add beside it:

```ts
const CANVAS_KEY = "conduit.canvas";

function writeCanvas(v: CanvasState): void {
  try {
    localStorage.setItem(CANVAS_KEY, JSON.stringify(v));
  } catch {
    /* quota or private mode — the board is a convenience, not data to lose sleep over */
  }
}

function readCanvas(): CanvasState {
  try {
    const raw = localStorage.getItem(CANVAS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CanvasState;
      // A node written before the board went global carries no project, and a session id
      // alone does not locate one. Dropping it costs a placement on a per-machine file;
      // keeping it would mean every consumer handling a node it cannot resolve.
      return {
        ...parsed,
        nodes: (parsed.nodes ?? []).filter((n) => typeof n.projectId === "string"),
      };
    }
    // First run after the board went global. Notes cross; node placements do not, because
    // they were auto-generated. The OLD key is deliberately left in place rather than
    // deleted, so nothing here is unrecoverable.
    const migrated = migrateNotes(readCanvases());
    writeCanvas(migrated);
    return migrated;
  } catch {
    return emptyCanvas();
  }
}
```

Import `emptyCanvas` and `migrateNotes` from `./canvas` alongside the existing `CanvasState` type import.

- [ ] **Step 3: Swap the slice**

Replace the `canvases` / `setCanvas` declarations in the store type with:

```ts
  /** The one global board. Cross-project, curated, per-machine. */
  canvas: CanvasState;
  setGlobalCanvas: (next: CanvasState) => void;
  /** Whether the board is showing. Workspace-level, deliberately NOT per project — the
   *  board holds sessions from every project, so there is no project for it to belong to. */
  canvasOpen: boolean;
  setCanvasOpen: (open: boolean) => void;
```

and the implementations:

```ts
    canvas: readCanvas(),
    setCanvasOpen: (open) => set({ canvasOpen: open }),
    setGlobalCanvas: (next) =>
      set(() => {
        writeCanvas(next);
        return { canvas: next };
      }),
```

with `canvasOpen: false,` in the initial state. Delete the old `canvases: readCanvases(),` and `setCanvas` action, and drop the `"canvas"` arm from `toggleCenterMode`.

- [ ] **Step 4: Typecheck to find every caller**

Run: `pnpm exec tsc --noEmit`
Expected: errors in `WorkspaceCenter.tsx`, `CanvasView.tsx`, `hooks/useProjectCanvas.ts` — every one is fixed by Task 11. Do not patch them here.

- [ ] **Step 5: Commit (with Task 11)**

This task and Task 11 land together, because the store change breaks the callers by design. Do not commit alone.

---

### Task 11: The board goes global

**Files:**
- Create: `src/hooks/useCanvas.ts`
- Delete: `src/hooks/useProjectCanvas.ts`
- Modify: `src/components/WorkspaceCenter.tsx`, `src/components/CanvasView.tsx`, `src/App.tsx`

**Interfaces:**
- Produces: `useCanvas(): { canvas: CanvasState; setCanvas: (next: CanvasState) => void }`.
- Changes: `CanvasUnderlay` loses its `projectId` prop; `CanvasControls` loses its `projectId` prop.

**Why this lives inside `WorkspaceCenter`:** `.term-stack` is there, and it already flat-maps **every** project's sessions into one permanently mounted set — which is what makes a cross-project board nearly free on the hard part. It cannot be a sibling surface the way `RootChatView` is: root chat hides `WorkspaceCenter` with `display: none`, which would hide every terminal with it.

- [ ] **Step 1: Write the hook**

Create `src/hooks/useCanvas.ts`:

```ts
import { useEffect, useMemo } from "react";
import { useStore } from "../store";
import { type CanvasState, pruneCanvas } from "../canvas";

/**
 * The global board: stored state pruned against the sessions that exist right now, plus a
 * setter.
 *
 * Shared by the two halves of the board — the underlay that draws frames and sections, and
 * the workspace that positions the live terminals — so both read exactly the same
 * coordinates. Two independent prunings would drift by one frame whenever a session went
 * away, and a terminal one frame out of its frame is very visible.
 */
export function useCanvas(): {
  canvas: CanvasState;
  setCanvas: (next: CanvasState) => void;
} {
  const stored = useStore((s) => s.canvas);
  const write = useStore((s) => s.setGlobalCanvas);
  const projects = useStore((s) => s.projects);

  const liveIds = useMemo(
    () => new Set(projects.flatMap((p) => p.sessions.map((s) => s.id))),
    [projects],
  );

  const canvas = useMemo(() => pruneCanvas(stored, liveIds), [stored, liveIds]);

  // Persist a pruning so a removed session does not reappear on reload. Guarded on identity:
  // `pruneCanvas` returns the SAME object when nothing changed, so an unguarded write would
  // loop forever.
  useEffect(() => {
    if (canvas !== stored) write(canvas);
  }, [canvas, stored, write]);

  return { canvas, setCanvas: write };
}
```

Delete `src/hooks/useProjectCanvas.ts`.

- [ ] **Step 2: Rewire `WorkspaceCenter`**

- Replace `const canvasMode = centerMode === "canvas";` with `const canvasMode = useStore((s) => s.canvasOpen);`
- Replace `const { canvas } = useProjectCanvas(projectId ?? null);` with `const { canvas } = useCanvas();`
- **Delete the ownership gate** in `placeSession` — the block beginning `if (canvasMode && ownerProjectId !== projectId)`. Replace its comment with:

```tsx
    // Pane mode deliberately does NOT check ownership: a layout may borrow another
    // project's session (WsTab.projectId), and `groupIndexOfRef` below already hides
    // anything the active layout does not hold. Canvas mode does not check either, and
    // that IS the global board: membership is the node list, which spans every project.
```

- Every place gating canvas rendering on `layout && activeProject` (~line 307, ~line 369) must gate on `canvasMode` alone — the board outlives having a selected project, which is the whole point.
- Remove the `"canvas"` arm from the header button (~line 737-750) and replace it with a board toggle:

```tsx
        <button
          className={`header-btn board-tab ${canvasOpen ? "active" : ""}`}
          title={canvasOpen ? "Hide the board" : "Show the board (Cmd/Ctrl+Shift+C)"}
          onClick={() => setCanvasOpen(!canvasOpen)}
        >
          <span className="board-tab-dot" />
          <span>{canvasOpen ? "Hide board" : "Board"}</span>
        </button>
```

reading `canvasOpen` and `setCanvasOpen` from the store in that component.

- [ ] **Step 3: Rewire `CanvasView`**

- Drop the `projectId` prop from `CanvasUnderlay` and `CanvasControls`; use `useCanvas()` instead of `useProjectCanvas(projectId)`.
- Wherever a node's project is needed (open, delete, account menu), resolve it from the node: `const owner = projects.find((p) => p.id === node.projectId);` — never from a single active project.
- `onOpenSession` becomes: `selectSession(node.projectId, node.ref); setCanvasOpen(false);`
- `onDeleteSession` passes `node.projectId` to `deleteSession`.
- "New session here" uses `selectedProjectId`; when it is null, render the item disabled with the title "Select a project first".
- The empty state becomes: `Empty board — drag a session in from the sidebar, or right-click to add a section.`

- [ ] **Step 4: Add the keyboard toggle**

In `src/App.tsx`, beside the existing `Cmd/Ctrl+Shift+B` handler at line 153, add:

```tsx
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const s = useStore.getState();
        s.setCanvasOpen(!s.canvasOpen);
        return;
      }
```

Verified free against `src-tauri/src/menu.rs` — no native accelerator claims `CmdOrCtrl+Shift+C`.

- [ ] **Step 5: Typecheck, build and verify**

Run: `pnpm exec tsc --noEmit && pnpm test && pnpm build`, then launch the app.

Expected: the board opens with `Cmd+Shift+C` and is **empty** on first run (or holds only migrated notes). No session appears automatically. Switching the selected project does not change the board.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/hooks/useCanvas.ts src/components/WorkspaceCenter.tsx src/components/CanvasView.tsx src/App.tsx
git rm src/hooks/useProjectCanvas.ts
git commit -m "feat(canvas): make the board one global, curated, cross-project surface"
```

---

### Task 12: Putting sessions on the board

**Files:**
- Modify: `src/components/Sidebar.tsx` (drag source), `src/components/CanvasView.tsx` (drop target, remove item), `src/theme.css`

**Interfaces:**
- Consumes: `SESSION_DRAG_MIME`, `hasSessionDrag`, `readSessionDrag` from `src/layout.ts`; `addNodeAt`, `removeNode`, `toCanvasPoint` from `src/canvas.ts`.

**Why the MIME type:** `dataTransfer.getData` is blocked during `dragover` and only `types` is readable, so advertising a custom type is the only way a drop target can know a drag is droppable *before* it lands — which is what the drop overlay needs in order to render at all.

- [ ] **Step 1: Confirm the sidebar already advertises the type**

Run: `grep -n "SESSION_DRAG_MIME" src/components/Sidebar.tsx`

If a session row already sets it on `dragstart`, no change is needed. If not, add to the session row:

```tsx
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  SESSION_DRAG_MIME,
                  JSON.stringify({ sessionId: session.id, projectId: project.id }),
                );
                e.dataTransfer.effectAllowed = "copyMove";
              }}
```

The payload type is `SessionDragPayload { sessionId: string; projectId: string }` (`src/layout.ts:284`), and `readSessionDrag` rejects anything whose two fields are not both strings — a drag from outside the app can advertise any type it likes.

- [ ] **Step 2: Make the board a drop target**

On the `.canvas-underlay` element in `CanvasView.tsx`:

```tsx
      onDragOver={(e) => {
        if (!hasSessionDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropActive) setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        setDropActive(false);
        const payload = readSessionDrag(e.dataTransfer);
        if (!payload) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        // Drop where the cursor is, centred on it rather than corner-anchored — a card
        // whose top-left lands under the pointer appears to jump down and right.
        const p = toCanvasPoint(canvas, e.clientX - rect.left, e.clientY - rect.top);
        snapshot();
        setCanvas(
          addNodeAt(canvas, payload.sessionId, payload.projectId, p.x - CARD_W / 2, p.y - CARD_H / 2),
        );
      }}
```

with `const [dropActive, setDropActive] = useState(false);`, `CARD_W`/`CARD_H` added to the `../canvas` import, and a `.canvas-underlay.drop-active` outline rule in `theme.css`:

(`snapshot()` arrives in Task 14; until then, drop the call and add it back there.)

```css
.canvas-underlay.drop-active { outline: 2px dashed var(--accent); outline-offset: -6px; }
```

- [ ] **Step 3: Add "Remove from board"**

In `CanvasMenu`, for a `nodeRef` click, add an item above the destructive session delete:

```tsx
        <button className="ctx-item" onClick={onRemoveFromBoard}>
          Remove from board
        </button>
```

wired to `setCanvas(removeNode(canvas, menu.nodeRef))`. Its title attribute: `"Takes the card off the board. The session keeps running."` — the distinction from Delete session must be visible, not inferred.

- [ ] **Step 4: Typecheck, build, verify**

Drag a session from project A onto the board, then one from project B. Both keep running, both show live terminals, and each card shows its own project name in its own colour. "Remove from board" leaves the session in the sidebar and running.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/components/CanvasView.tsx src/theme.css
git commit -m "feat(canvas): put sessions on the board by dragging them from the sidebar"
```

---

### Task 13: Sections on screen

**Files:**
- Create: `src/components/CanvasSection.tsx`
- Modify: `src/components/CanvasView.tsx`, `src/theme.css`

**Interfaces:**
- Consumes: `sectionsByZ`, `membersOf`, `translateMany`, `resizeSection`, `setSectionTitle`, `setSectionColor`, `removeSection`, `addSection`, `SECTION_PALETTE`, `SECTION_MIN_W/H` from `src/canvas.ts`.

- [ ] **Step 1: Render sections behind everything**

Inside `.canvas-plane`, as the first children (before the tether SVG), map `sectionsByZ(canvas)` to `<CanvasSectionFrame>`. Sections are painted first, so they are behind by document order — no `z-index` needed, which is the point of deriving the order rather than storing it.

- [ ] **Step 2: Write the frame component**

Create `src/components/CanvasSection.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { SECTION_PALETTE, type CanvasSection } from "../canvas";

/**
 * One section's frame.
 *
 * Nothing here takes the pointer except the title chip and the grip: the body must stay
 * transparent to clicks, or a section would swallow every interaction with the cards it
 * contains -- and the cards are the point.
 *
 * The chip sits ABOVE the box rather than inside it, matching Figma, for the same reason:
 * inside, it would compete for space with whatever the section holds.
 */
export function CanvasSectionFrame({
  section,
  selected,
  onMovePointerDown,
  onResizePointerDown,
  onContextMenu,
  onRename,
}: {
  section: CanvasSection;
  selected: boolean;
  onMovePointerDown: (e: React.PointerEvent) => void;
  onResizePointerDown: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const tint =
    section.color === undefined
      ? "var(--border)"
      : SECTION_PALETTE[section.color % SECTION_PALETTE.length];

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== section.title) onRename(next);
    else setDraft(section.title);
  };

  return (
    <div
      className={`canvas-section ${selected ? "selected" : ""}`}
      style={{ left: section.x, top: section.y, width: section.w, height: section.h }}
    >
      <div
        className="canvas-section-box"
        style={{
          borderColor: tint,
          // A wash, not a fill: the cards inside have to stay readable over it.
          background: `color-mix(in srgb, ${tint} 8%, transparent)`,
        }}
      />
      {editing ? (
        <input
          ref={inputRef}
          className="canvas-section-title editing"
          style={{ background: tint }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(section.title);
              setEditing(false);
            }
            e.stopPropagation(); // the board owns Escape, undo and Delete
          }}
        />
      ) : (
        <div
          className="canvas-section-title"
          style={{ background: tint }}
          title={section.title}
          onPointerDown={onMovePointerDown}
          onDoubleClick={() => {
            setDraft(section.title);
            setEditing(true);
          }}
          onContextMenu={onContextMenu}
        >
          {section.title}
        </div>
      )}
      <div
        className="canvas-section-grip"
        title="Drag to resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}
```

Add to the stylesheet block in Step 5:
`.canvas-section-title.editing { pointer-events: auto; border: none; outline: none; font: inherit; color: #fff; }`

- [ ] **Step 3: Drag moves the contents**

Extend the existing `drag` state in `CanvasUnderlay` with `kind: "section"` and a captured member set:

```tsx
  const [drag, setDrag] = useState<{
    ref: string | null;
    kind: "node" | "note" | "section";
    mode: "pan" | "move" | "resize";
    lastX: number;
    lastY: number;
    /** Captured at gesture start for a section move — recomputing per frame would let
     *  items join and leave as the box swept over them, which reads as the section
     *  eating the board. */
    members?: Members;
  } | null>(null);
```

On section `pointerdown` in `"move"` mode, capture `const m = membersOf(canvas, id); setDrag({ …, members: { ...m, sections: [...m.sections, id] } })`. On `pointermove`, `setCanvas(translateMany(canvas, drag.members!, dx, dy))`. On `"resize"`, `setCanvas(resizeSection(canvas, id, section.w + dx, section.h + dy))` — contents deliberately untouched.

- [ ] **Step 4: Create, colour and delete**

Add to the plane's right-click menu: **New section here**, creating `addSection(canvas, uid(), p.x, p.y, 900, 640, "Section")`. Add to a section's own right-click menu: a swatch row over `SECTION_PALETTE` plus a Neutral swatch calling `setSectionColor(canvas, id, null)`, **Rename**, and **Delete section** with the title `"Removes the container. Everything inside stays on the board."`

- [ ] **Step 5: Style it**

```css
/* Sections paint behind everything by document order — see sectionsByZ for why the order is
   derived rather than stored. The title chip sits ABOVE the box so it stays grabbable when
   the box is full of cards. */
.canvas-section { position: absolute; border-radius: 10px; pointer-events: none; }
.canvas-section-box { position: absolute; inset: 0; border-radius: 10px; border: 2px solid; }
.canvas-section-title {
  position: absolute; top: -26px; left: 0; pointer-events: auto; cursor: grab;
  font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 6px;
  color: #fff; white-space: nowrap; max-width: 70%; overflow: hidden; text-overflow: ellipsis;
}
.canvas-section.selected .canvas-section-box { box-shadow: 0 0 0 2px var(--accent); }
.canvas-section-grip {
  position: absolute; right: -6px; bottom: -6px; width: 14px; height: 14px;
  pointer-events: auto; cursor: nwse-resize; border-radius: 3px; background: var(--border);
}
```

- [ ] **Step 6: Typecheck, build, verify**

Draw a section around three cards from two projects; drag its title — all three move with it, terminals stay alive. Resize it smaller so one card falls outside; drag again — that card stays put. Nest a section inside another; the inner one paints over.

- [ ] **Step 7: Commit**

```bash
git add src/components/CanvasSection.tsx src/components/CanvasView.tsx src/theme.css
git commit -m "feat(canvas): draw, colour and drag sections that carry their contents"
```

---

### Task 14: Selection, marquee and undo

**Files:**
- Modify: `src/components/CanvasView.tsx`, `src/theme.css`

**Interfaces:**
- Consumes: `emptyHistory`, `pushHistory`, `undo`, `redo` from `src/canvasHistory.ts`; `boxOfNode`/`boxOfNote`/`boxOfSection`/`containsBox` from `src/canvas.ts`.

- [ ] **Step 1: Selection state**

```tsx
  /** Ephemeral and never persisted — a selection is a thing you are doing, not a thing the
   *  board is. */
  const [selection, setSelection] = useState<Array<{ kind: "node" | "note" | "section"; id: string }>>([]);
```

Click on an object selects it alone; shift-click toggles it in the set; a click on empty plane clears. Selected objects get a `selected` class.

- [ ] **Step 2: Marquee**

A drag starting on empty plane with no modifier draws a rubber band (screen-space rect in component state) and on release selects everything whose canvas box is fully inside it, via `containsBox`. Shift-drag adds to the existing selection. Plain-drag-on-empty currently pans; move panning to space-drag and middle-drag, and note it in the empty state hint: `Drag to select · Space-drag or middle-drag to pan`.

```css
.canvas-marquee {
  position: absolute; border: 1px solid var(--accent); pointer-events: none;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
```

- [ ] **Step 3: Undo**

```tsx
  const historyRef = useRef(emptyHistory<CanvasState>());
  /** Record the state as it was BEFORE a gesture. Called on pointer-down and before any
   *  discrete edit, never per pointer-move — that is what makes one drag one undo step. */
  const snapshot = useCallback(() => {
    historyRef.current = pushHistory(historyRef.current, canvas);
  }, [canvas]);
```

Call `snapshot()` at the start of every move/resize drag and before each menu action that mutates. Bind, in the board's `keydown` handler:

```tsx
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const step = undo(historyRef.current, canvas);
        if (step) {
          historyRef.current = step.history;
          setCanvas(step.state);
        }
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const step = redo(historyRef.current, canvas);
        if (step) {
          historyRef.current = step.history;
          setCanvas(step.state);
        }
        return;
      }
```

- [ ] **Step 4: Delete the selection**

`Backspace`/`Delete` with a non-empty selection: snapshot, then apply `removeNode` / `removeNote` / `removeSection` per entry. **Never** deletes the session itself — that stays behind the sidebar's own confirming path, which is where the safety lives.

- [ ] **Step 5: Typecheck, build, verify**

Marquee three objects, drag them together, `Cmd+Z` — they return; `Cmd+Shift+Z` — they go back. One drag is one undo step. Terminals survive every one of these; check a running agent is still streaming afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/components/CanvasView.tsx src/theme.css
git commit -m "feat(canvas): add selection, marquee and undo to the board"
```

---

### Task 15: The attention rail, edge pips and fly-to

**Files:**
- Create: `src/components/CanvasRail.tsx`
- Modify: `src/components/CanvasView.tsx`, `src/theme.css`

**Interfaces:**
- Consumes: `attentionQueue`, `edgePips`, `cameraFor`, `interpolateCamera`, `easeInOutCubic` from `src/canvasAttention.ts`.

- [ ] **Step 1: Build the sources**

In `CanvasUnderlay`, derive:

```tsx
  const sources = useMemo(
    () =>
      projects.flatMap((p) =>
        p.sessions.map((s) => ({
          ref: s.id,
          projectId: p.id,
          status: live[s.id]?.status ?? "idle",
          updatedAt: live[s.id]?.updatedAt,
        })),
      ),
    [projects, live],
  );
  // Re-read on a coarse tick so wait times age without a render per second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const queue = useMemo(() => attentionQueue(sources, now), [sources, now]);
```

Note the queue spans **every project**, including sessions not on the board — that is deliberate, and it is what makes the rail a triage surface rather than a board index.

- [ ] **Step 2: The rail**

`CanvasRail.tsx` renders a docked strip listing each queue entry: agent glyph, session name, project name in its colour, and the wait duration. Clicking a row:

- if the session has a node → fly to it
- if it does not → `setCanvas(addNodeAt(canvas, ref, projectId, <viewport centre in canvas units>))` and then fly to it

Curation as a side effect of triage is the low-effort way onto an empty board, and it happens at the moment the user actually cares about that session.

Empty state: `Nothing is waiting on you.`

- [ ] **Step 3: Edge pips**

```tsx
  const pipBoxes = useMemo(
    () =>
      queue
        .map((q) => canvas.nodes.find((n) => n.ref === q.ref))
        .filter((n): n is CanvasNode => Boolean(n))
        .map((n) => ({ ref: n.ref, x: n.x, y: n.y, w: nodeW(n), h: nodeH(n) })),
    [queue, canvas.nodes],
  );
  const pips = useMemo(() => {
    const el = viewportRef.current;
    if (!el) return [];
    return edgePips(pipBoxes, { pan: canvas.pan, zoom: canvas.zoom }, {
      w: el.clientWidth,
      h: el.clientHeight,
    });
  }, [pipBoxes, canvas.pan, canvas.zoom]);
```

Render each as an absolutely positioned marker at `{left: pip.x, top: pip.y}` with `transform: translate(-50%, -50%) rotate(${pip.angle}rad)`, tinted by its project colour, `title` giving the session name and wait. Click flies to it. The pip layer sits **above** `.term-stack` so it is never hidden behind a terminal — the one thing on the board that must outrank them, since its whole job is being seen.

- [ ] **Step 4: Fly-to**

```tsx
  const flyRef = useRef<number | null>(null);
  const flyTo = useCallback(
    (ref: string) => {
      const el = viewportRef.current;
      const node = canvasRef.current.nodes.find((n) => n.ref === ref);
      if (!el || !node) return;
      const from = { pan: canvasRef.current.pan, zoom: canvasRef.current.zoom };
      const to = cameraFor(
        { ref, x: node.x, y: node.y, w: nodeW(node), h: nodeH(node) },
        { w: el.clientWidth, h: el.clientHeight },
        // Land at a rung, so the terminal is crisp the moment the flight ends.
        snapZoom(Math.max(canvasRef.current.zoom, LIVE_ZOOM_MIN), TERM_BASE_FONT + fontZoom),
      );
      const start = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / 300);
        const cam = interpolateCamera(from, to, easeInOutCubic(t));
        setCanvas({ ...canvasRef.current, pan: cam.pan, zoom: cam.zoom });
        if (t < 1) flyRef.current = requestAnimationFrame(step);
      };
      if (flyRef.current) cancelAnimationFrame(flyRef.current);
      flyRef.current = requestAnimationFrame(step);
    },
    [setCanvas, fontZoom],
  );
  useEffect(() => () => { if (flyRef.current) cancelAnimationFrame(flyRef.current); }, []);
```

Snapping the camera instead of animating would destroy the spatial memory this board exists to build: seeing the plane move is what teaches you where things are.

- [ ] **Step 5: Style**

```css
/* The rail is a cross-project QUEUE filtered to "waiting on you" — not a second sidebar,
   which is a project-grouped tree of everything. */
.canvas-rail {
  position: absolute; top: var(--tabstrip-h); right: 0; bottom: 0; width: 240px; z-index: 4;
  background: var(--panel-bg); border-left: 1px solid var(--border);
  display: flex; flex-direction: column; overflow-y: auto;
}
.canvas-rail-row {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.canvas-rail-row:hover { background: var(--hover); }
.canvas-rail-waited { margin-left: auto; font-size: 11px; color: var(--warn, #e0b341); }
.canvas-pip-layer { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.canvas-pip { position: absolute; pointer-events: auto; cursor: pointer; width: 18px; height: 18px; }
```

- [ ] **Step 6: Typecheck, build, verify**

With a session awaiting input scrolled far off-screen: a pip appears on the border pointing at it, the rail lists it with a growing wait time, and clicking either flies the camera there and lands at a crisp rung. A session not on the board is listed too, and clicking it places and flies to it.

- [ ] **Step 7: Commit**

```bash
git add src/components/CanvasRail.tsx src/components/CanvasView.tsx src/theme.css
git commit -m "feat(canvas): route attention into the viewport with a rail, edge pips and fly-to"
```

---

### Task 16: Documentation and release

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add the CLAUDE.md section**

Replace the canvas paragraph, if any, and add a section titled **"Where the orchestration board lives"** recording the invariants a future agent would otherwise break:

- the board is global and **curated** — `pruneCanvas` prunes, nothing auto-places, and that is what makes a position mean something
- `CanvasNode.projectId` is **required**, the opposite of `WsTab.projectId`, because a global board has no host project for absence to mean
- z-order is **derived** (`sectionsByZ`, then document order), never stored, because reordering an array is a reparent and a reparent kills a PTY
- the canvas stack carries **`translate()` only**; the underlay keeps `scale()`. Terminals are placed in screen pixels and rasterize at `fontForZoom`, and **must never be refit for a zoom** — only a logical size change may refit
- section membership is geometric and captured at drag start
- canvas state is localStorage on purpose: an unparseable `state.json` is an empty store, and an empty store makes the startup sweep kill every running agent

- [ ] **Step 2: README**

Add the board to the feature list and the file map, with the `Cmd/Ctrl+Shift+C` shortcut.

- [ ] **Step 3: Version bump — all three files in lockstep**

`0.35.0` → **`0.36.0`** (a shipped, user-facing feature set). Edit `package.json`, `src-tauri/Cargo.toml` line 3, and `src-tauri/tauri.conf.json`, then:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
```

Expected: all three read `0.36.0`.

- [ ] **Step 4: Changelog**

Add the top entry, `## 0.36.0 — <today>`, no contributor names:

```markdown
- **Added — One global board.** The canvas is now a single cross-project surface you build
  by hand: drag sessions in from the sidebar, from any project, and arrange them where they
  mean something. The old per-project canvas, which placed every session automatically, is
  gone.
- **Added — Sections.** Draw a titled, coloured box around a group of sessions and drag it
  to move the whole group. Sections nest.
- **Added — Attention rail and edge markers.** A queue of everything waiting on you, across
  every project, sorted by how long it has waited — and markers on the edge of the board
  pointing at the ones off screen. Clicking either flies you there.
- **Added — Selection and undo.** Rubber-band select, move several things at once, and undo
  with Cmd/Ctrl+Z.
- **Fixed — Terminals are sharp at every zoom.** Zoomed text was a scaled bitmap, soft when
  magnified and rough when reduced. Terminals now redraw at the zoomed size instead of being
  stretched, and zooming no longer reflows a running agent's output.
- **Changed — Zoomed-out cards say more.** A card below the legibility threshold now shows
  what the session is doing, how long it has been waiting, its project and its context use.
```

- [ ] **Step 5: Full gate**

```bash
pnpm exec tsc --noEmit && pnpm test && pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all clean. No Rust source changed in this plan, so the Rust legs should be untouched — but the version bump touches `Cargo.toml`, which is why they run.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md CHANGELOG.md package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json Cargo.lock
git commit -m "chore(release): 0.36.0"
```

---

## Manual verification checklist

Run against a real build (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`) before proposing a merge. Everything here is something the test suite cannot see.

- [ ] Text is sharp at every ladder rung from the smallest to 2.0 — check box-drawing characters and a TUI, not just prose.
- [ ] Zooming a running agent never rewraps its output.
- [ ] A zoom gesture with ten or more live sessions is smooth, and terminals return crisp without a blurry frame.
- [ ] Panning keeps terminals live and does not blink them.
- [ ] Sessions from three different projects live on one board, all streaming.
- [ ] A session survives being dragged in, sectioned, moved, undone and redone — its PTY is still attached and still streaming afterwards.
- [ ] "Remove from board" leaves the session running; "Delete session" still confirms.
- [ ] A section drag moves its contents; a section resize does not.
- [ ] An off-screen session awaiting input produces an edge pip and a rail row; both fly to it.
- [ ] Old sticky notes from a per-project canvas survived the migration.
- [ ] Quitting with a running agent still raises the shutdown guard.
