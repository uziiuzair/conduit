# Per-project canvas view — viability

**Date:** 2026-08-10
**Status:** Viability analysis, not yet a committed design
**Sub-project:** 6 of 6 — see `2026-08-10-nodeterm-lessons-overview.md`

## The question

nodeterm's organising metaphor is an infinite pan/zoom canvas: every terminal is a draggable
node you can place, group, and zoom into. Conduit's is a VS Code-style pane layout —
`ProjectLayout { groups: EditorGroup[], activeGroupId, weights[] }` — plus a board view
toggled with a keyboard shortcut.

Can Conduit offer a canvas as a per-project view, and what does it actually cost?

The short answer: **yes, in a staged form, and the naive form is a trap.** The trap is
specific and measurable, and it is the reason this document exists.

## The trap: zoomed terminals

The obvious implementation is to lay terminals out absolutely and apply a CSS `transform:
scale()` to a viewport wrapper. This works immediately and looks correct for about a minute.

It is wrong because a terminal is not vector content. Conduit renders through
`@xterm/addon-canvas`, which rasterizes glyphs into a bitmap at device pixel ratio. A CSS
transform scales that finished bitmap. At any zoom other than exactly 1.0 the text is
resampled — blurry when scaling up, aliased into illegibility when scaling down. Small text
is the worst case, and a terminal is nothing but small text.

nodeterm hit this and solved it by writing their own renderer. `src/renderer/glyphgrid/` is a
WebGL2 glyph-atlas engine with its own camera, cell packing, cursor, decorations, box-drawing
glyphs, and frame driver: **roughly 11,900 lines including tests**, plus an xterm addon to
drive it. Their recent commit log shows it is still being corrected — "stop mip-blurring text
at a zoom that is barely under 1", "the font-weight setting reaches the shared renderer".

That is the honest price of live, legible terminals at arbitrary zoom. It should not be paid
speculatively, and for Conduit it should probably not be paid at all.

## The way around it

There is a cheaper path that nodeterm did not take, and it is available to Conduit because
Conduit does not need *every* node live at *every* zoom.

**Scale the font, not the bitmap.** xterm.js re-rasterizes its atlas when `options.fontSize`
changes. If the node's container size and the font size are scaled by the same factor, the
computed columns and rows stay constant — so the PTY is never resized and the agent's output
never reflows — while the glyphs are rendered natively at the new size and stay crisp.

The gesture handling then becomes:

- **During** a pinch or wheel-zoom, apply the CSS transform. Transiently blurry, which is
  fine because it lasts as long as the gesture.
- **On settle**, set `fontSize = base * zoom` on the visible live nodes and drop the transform.
  Crisp, at a cost paid once per zoom-end rather than per frame.

**Below a legibility threshold, stop being a terminal.** Under roughly 8px effective font
size, no rendering technique helps — the text is unreadable regardless of sharpness. That is
the point at which a node should become a *card*: title, agent glyph, status badge, last line
of output as static text. Which is also, conveniently, what you want for performance: twenty
simultaneously live xterm instances is not a load anyone should carry to look at a map.

This is standard level-of-detail rendering, and it converts the hard problem (arbitrary-zoom
live terminals) into an easy one (live terminals at a few discrete zoom levels, cards
everywhere else).

## The constraint that actually governs the design

Conduit's hardest invariant, from CLAUDE.md: keep-alive terminals are load-bearing, an xterm
or `TerminalView` must never be reparented or conditionally unmounted, and layout is expressed
purely through CSS from group weights.

This sounds like an obstacle to a canvas. It is the opposite — it is the thing that makes a
canvas cheap, because **the layout is already pure CSS over a stable mounted set.** A canvas
is not a different component tree. It is a different CSS expression of the same tree:

| | Pane view | Canvas view |
| --- | --- | --- |
| Positioning | flex, sized from `weights[]` | absolute, from per-node `{x, y, w, h}` |
| Container | one wrapper per group | one transformed viewport wrapper |
| Terminal DOM | mounted, never reparented | mounted, never reparented |

Switching views changes classes and inline styles on ancestors. No terminal mounts, unmounts,
or moves in the React tree. The board view already establishes this pattern — the invariant
survived that, and it survives this for the same reason.

Two rules follow, and they are absolute:

1. **Card mode hides the terminal with CSS, it does not unmount it.** `visibility: hidden` or
   `opacity: 0` with the card drawn over it. The moment a card is implemented as "render a
   card *instead of* the terminal", the PTY dies and the feature has broken the app's central
   invariant.
2. **Node identity is stable and order-independent.** The absolutely-positioned node list must
   be keyed by session id and must not be sorted or reordered by position, because React
   reorders DOM to match list order and that is a reparent.

Rule 2 is why this design **does not use React Flow**, despite nodeterm using it. React Flow
owns node DOM, reorders it for z-index and selection, and virtualizes nodes out of the tree at
scale — every one of which is an unmount. A hand-rolled pan/zoom viewport is roughly 200 lines
(wheel and trackpad handling, a transform matrix, drag with pointer capture, a fit-to-content
helper) and gives complete control over DOM stability. It also honors the lean-dependency
rule, where React Flow plus its dependencies would not.

## Staged proposal

**Stage 1 — Canvas as a third project view, cards only.**
A per-project `canvas` view alongside panes and the board, holding one card per session:
title, agent glyph, live status badge, last output line, position and size persisted on the
project. Pan, zoom, drag, and a fit-to-content command. Terminals stay mounted and hidden.
Double-clicking a card switches to the pane view focused on that session.

This is the whole spatial-map value — see everything, place it meaningfully, know at a glance
what is running — with none of the rendering risk. It is a self-contained feature that touches
no terminal code.

**Stage 2 — Live terminals above a zoom threshold.**
Above the legibility threshold, promote visible cards to live terminals using the
font-scaling technique. Cap the number of simultaneously live nodes and demote the rest to
cards by distance from the viewport center. This is where the real work is, and it should not
begin until Stage 1 has been used enough to know whether it is wanted.

**Stage 3 — A custom glyph renderer.**
Explicitly not recommended. If Stage 2 proves insufficient, the correct response is to narrow
the zoom range, not to write 12,000 lines. Recorded here so that the option is visibly
considered and visibly declined.

## Data model

Additive to `ProjectLayout`, so existing persisted layouts load unchanged:

```ts
export interface CanvasNode { ref: string; x: number; y: number; w: number; h: number }
export interface ProjectLayout {
  groups: EditorGroup[]
  activeGroupId: string | null
  weights: number[]
  view?: "panes" | "board" | "canvas"        // absent = "panes"
  canvas?: { nodes: CanvasNode[]; pan: { x: number; y: number }; zoom: number }
}
```

`validateLayout` gains the matching repair pass it already performs for groups: drop canvas
nodes whose session is gone, auto-place sessions that have no node yet, clamp zoom to its
range.

## What this is not

- **Not a replacement for the pane layout.** The pane view is faster for keyboard-driven work
  and stays the default. This is a second way to look at the same project.
- **Not a node-graph.** No edges, no connections, no dataflow. nodeterm's context links are
  drawn as edges; Conduit's equivalent belongs in sub-project 5 and does not need a canvas.
- **Not multi-kind nodes.** nodeterm has sticky notes, editors, diff views, and web nodes on
  its canvas. Conduit has dedicated panels for those and should not duplicate them spatially.

## Recommendation

Build Stage 1. It is a contained feature with a real payoff and no risk to the terminal
invariant. Treat Stage 2 as a separate decision to be made with Stage 1 in hand, and treat
Stage 3 as closed.

Estimated shape of Stage 1: one new component for the viewport, one for the card, roughly 200
lines of pan/zoom logic, the layout-model addition above, and a keyboard shortcut. No backend
change at all.
