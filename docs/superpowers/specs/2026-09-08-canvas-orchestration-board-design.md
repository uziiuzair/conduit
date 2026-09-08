# Canvas as an orchestration board — design

**Date:** 2026-09-08
**Status:** Approved design, not yet implemented
**Supersedes the open questions in:** `2026-08-10-project-canvas-view-viability.md`

## The problem

The canvas shipped in two stages and works: sessions are cards on a pan/zoom plane, the
real terminals paint inside the frames, notes can be dropped beside them. But it does not
yet earn its place, and the reason is precise.

`reconcile()` auto-places **every session in the project** into a three-column grid. Every
card is on the board because it exists, not because anyone put it there — so position
carries no information, and the result is a list with extra steps. What the user sees is
"a lot of Claude sessions, that is about it."

The underlying need is different and was stated plainly: **as load on Conduit increases,
finding and following work becomes a hassle.** Twenty to forty sessions across half a dozen
projects, and no answer to "what is waiting on me" or "where did that piece of work go".

So this is not a request for a whiteboard. It is a request for a surface on which a fleet
stays legible. The whiteboard primitives — sections, text, shapes, ink — are how the user
expresses structure on that surface; they are the means, not the end.

## What this design commits to

Six decisions, each taken deliberately and each with a discarded alternative.

**1. The canvas is an orchestration board, not the primary workspace.** You arrange, group,
annotate, find and dispatch on it; you still type in panes. Panes stay the default and stay
faster for keyboard work.

**2. Membership is curated, not derived.** The canvas starts empty. Sessions arrive by drag
from the sidebar, from the attention rail, or from the canvas's own "new session here". A
session existing is no longer a reason for it to be on the board. This inverts the canvas
from a derived view of a project into an owned document, and it is the single change that
gives position meaning.

**3. There is one canvas, and it is global.** It holds sessions from any project. The
per-project canvas is retired — `centerMode` returns to `terminals | board`. Named,
switchable boards were considered and rejected: moving between canvases is overhead that
buys nothing when the point is to see everything at once.

**4. Sections are visual containers, not commands.** A section is a titled, coloured,
resizable box that groups what sits inside it and moves its contents when dragged, exactly
as in Figma. It has no broadcast, no stop-all, no spawn-into. Actionable sections and
task-board-bound sections were both considered; both are real features and both belong to
later increments, if ever. Membership is **geometric** — whatever is inside the bounds
belongs to it — so there is no membership list to drift out of sync with position, nesting
falls out for free, and dragging a session into a section requires no code beyond the drag
that already moves it.

**5. Attention is routed into the viewport, not merely stored on it.** This is the part
that answers "following". An infinite canvas is *worse* than a sidebar at high load, for a
specific reason: a sidebar always shows all thirty rows, whereas a canvas shows whatever
the viewport happens to frame, and the session that has been waiting forty minutes can sit
three thousand pixels off-screen. So the board gets an attention rail (a cross-project queue
of what is waiting on you, sorted by wait time), edge pips (pointers on the viewport border
aimed at off-screen sessions that need you), and a fly-to camera. The rail is not a second
sidebar: the sidebar is a project-grouped tree of everything, the rail is a flat queue
filtered to *waiting on you*.

**6. The plane stays hand-rolled.** See "Rejected: adopting a canvas library" below.

## Sequencing

Four increments, in this order. Each is shippable on its own.

- **Increment 0 — Crisp rendering.** Terminals stop being resampled bitmaps at any zoom, and
  the sub-threshold card becomes genuinely informative. This is a defect fix on what already
  ships, it is felt daily, and everything else sits on top of it.
- **Increment 1 — The plane.** Global, curated membership, sections, selection, undo,
  attention rail, edge pips, fly-to. This is the increment that answers the stated problem.
- **Increment 2 — Annotation.** Free text, shapes (rect / ellipse / line / arrow), and
  connectors that bind to two objects and follow them.
- **Increment 3 — Ink.** Freehand pencil and eraser.

**The implementation plan covers Increments 0 and 1 only.** Together they are a coherent
shippable release — a canvas that renders correctly and answers the stated problem.
Increments 2 and 3 are specified here so the data model is designed for them, and each gets
its own plan when it is scheduled.

The order is not arbitrary. Increments 0 and 1 are almost entirely Conduit-specific work
that no drawing library would have supplied. Increment 2 is where the box-object model pays
off: sections, notes, text and shapes are all `{x, y, w, h}` with the same selection, resize
and hit-testing, so each one after the first is nearly free. Increment 3 is the odd one out
— arbitrary paths, distance-to-polyline hit-testing, eraser semantics, smoothing — a
separate machine that happens to live on the same plane, which is why it is last and why it
is the natural place to revisit the library question.

---

## Increment 0 — Crisp rendering

### The defect

`.term-stack.canvas-mode` carries `transform: translate(pan) scale(zoom)`. A terminal is a
rasterized glyph atlas produced by the WebGL or canvas renderer at device pixel ratio. A CSS
transform resamples that finished bitmap: soft when magnified, aliased when reduced.

Zoomed **in** is the more damaging case, and the current design leaves it entirely
unguarded. `MAX_ZOOM` is 2, so at full magnification every glyph is a 13px raster stretched
to 26px — precisely the detail the user zoomed in to read, thrown away. `LIVE_ZOOM_MIN`
(0.55) guards only the zoomed-out band, where blur matters least because nobody is reading.

The jank has a second cause. Every visible terminal is its own GPU-composited surface;
changing the scale on a common ancestor forces the compositor to re-rasterize all of them on
every frame of the gesture. Ten sessions is ten large textures per frame.

The 2026-08-10 viability document predicted this exactly, designed the fix, and deferred it
with the note "Revisit only if that middle band proves annoying in use." It has.

### The fix, in three parts

**Scale the font, not the bitmap.** Drop `scale()` from the **stack** transform; keep
`translate()` for pan. Each terminal host is sized `logical × zoom` in screen pixels, and
`term.options.fontSize` is set to `base × zoom`. Glyphs are then rasterized natively at the
size they are displayed. The primitive already exists and is already understood in this
codebase — `Terminal.tsx` does exactly this for the app-wide font-zoom in the View menu, and
its comment records the crucial property: setting `options.fontSize` changes cell metrics
without firing the `ResizeObserver`, because the host box is unchanged.

Only the stack changes. The **underlay keeps `translate(pan) scale(zoom)`** — it draws card
frames, sections and tethers as DOM and SVG, which a transform scales as vectors and which
stay crisp at any factor. Losing the shared transform means the two layers no longer agree
for free, so each terminal host is positioned in screen pixels — `x × zoom`, `y × zoom`,
`w × zoom`, `h × zoom` — computed from the same canvas state the underlay uses. Both layers
still derive from one `CanvasState` read through `useProjectCanvas`'s successor, which is
what the hook's own doc comment says is load-bearing: two independent reconciliations would
drift by a frame, and a terminal one frame out of its frame is very visible.

**Never refit — pin the grid.** This is the one inversion against the existing font-zoom
code, which calls `fit()` afterwards. On the canvas the box and the font scale by the same
factor, so `cols`/`rows` are already correct; recomputing them invites ±1 drift from
font-metric rounding, and a one-column change resizes the PTY and reflows the agent's
output. Set the font, do not fit, and accept a hairline gap at the box edge. Drift becomes
impossible by construction rather than by care.

This needs one guard. Because the host box is now `logical × zoom`, a zoom change *does*
alter the box and *will* fire the `ResizeObserver`, whose handler calls `fit()` — the very
thing we must avoid. The handler therefore fits only when the **logical** size changed, not
when the screen size did. Resizing a card by its grip still changes the logical size, still
refits, and still reflows, which is what a resize should do; zooming does not.

**Terminals sit out the zoom gesture.** During an active pinch or wheel-zoom, drop to card
level-of-detail: terminals hidden by CSS, chrome only. A DOM and SVG transform is smooth at
any scale, so the gesture is fluid, and on settle the terminals return already crisp at the
new font size. The viability document proposed "transiently blurry during the gesture";
"transiently cards" is strictly better, since there is no blurry frame at all, and the card
renderer already exists for the sub-threshold case. Panning keeps terminals live —
translation does not re-rasterize.

Terminals are hidden with `visibility`, never unmounted, and never reparented. On becoming
visible again each one gets a repaint nudge (`term.refresh(0, term.rows - 1)`) for the same
reason a re-attach does — an alt-screen program may otherwise leave the pane showing a stale
frame.

### The zoom ladder

Zoom quantizes to a ladder whose levels are integer font sizes. Fractional font sizes give
fractional cell widths and visibly uneven glyph spacing across a row, which is its own kind
of ugly. Pinch and wheel move continuously and snap to the nearest rung on release.

A new pure module `src/terminalZoom.ts` owns it: the ladder, `snapZoom(z, base)`, and
`fontForZoom(z, base)`. With a 13px base the rungs run roughly 6, 7, 8, 9, 10, 11, 12, 13,
14, 16, 18, 20, 22, 26 — clamped to `MIN_ZOOM`/`MAX_ZOOM`. It is pure, so vitest covers it.

### Cost, and what pays for it

Re-rasterizing N glyph atlases on every zoom-settle is not free. Only terminals intersecting
the viewport receive the new font; the rest update lazily when they scroll into view. That
is also, incidentally, the "cap on simultaneously live nodes, demoting the furthest from the
viewport centre" that the viability document left open — it arrives here as a side effect.

`LIVE_ZOOM_MIN` survives with a changed meaning. It stops being "below here rendering looks
bad" and becomes "below here 8px type is meaningless regardless of sharpness" — a legibility
floor, not a quality floor.

### The rich card

Below the floor, and during zoom gestures, a node renders as a card. Today that card shows a
status word. It becomes the view that makes zoomed-out *useful* rather than degraded, and
every field is real DOM text, so it is crisp at any zoom by construction:

- agent glyph and session name (`AgentGlyph`, `glyphStateFor`)
- project name in the project's colour (`resolveProjectColor`) — necessary now that one
  board holds several projects
- status ring and label, plus the current activity string (`LiveState.activity`, set from
  `PreToolUse`) — "what it is doing right now" without scraping the terminal
- for a session needing input, how long it has been waiting (`LiveState.updatedAt`)
- context-window percentage (`sessionContext`, via `meterLevel`/`meterTitle`)
- worktree branch or "project root"

Deliberately not the last lines of terminal output: `LiveState.activity` says the same thing
semantically, already exists, and needs no scrollback plumbing.

---

## Increment 1 — The plane

### Where it lives

The global canvas must render **inside `WorkspaceCenter`**, because `.term-stack` lives
there and already flat-maps every project's sessions into one permanently mounted set. This
is what makes a cross-project board nearly free on the hard part: the terminals are already
all mounted at all times. Canvas mode currently re-adds an ownership gate that pane mode
dropped (`if (canvasMode && ownerProjectId !== projectId) return null`); removing that gate
is most of "global".

It cannot be a sibling surface the way `RootChatView` is. Root chat hides `WorkspaceCenter`
with `display: none`, which would hide every terminal with it.

So: a workspace-level `canvasOpen: boolean` in the store, distinct from the per-project
`centerMode`. When open, `WorkspaceCenter` renders the canvas underlay and positions the
stack from the global canvas, ignoring the active project's layout; the tab strip is
replaced by the canvas toolbar. The sidebar stays visible — it is the drag source.

### Curation

A session joins the board by:

- **drag from the sidebar.** The machinery exists: `SESSION_DRAG_MIME` with
  `hasSessionDrag`/`readSessionDrag` in `layout.ts`, built for the sidebar-to-pane drag. The
  canvas is another drop target advertising the same MIME, which is what lets the drop
  overlay render before the drop lands — `dataTransfer.getData` is blocked during `dragover`
  and only `types` is readable.
- **the attention rail**, for a session that needs you but is not yet on the board. It drops
  near the viewport centre. Curation then happens as a side effect of triage, which is the
  moment the user actually cares about that session.
- **the canvas's own right-click "new session here"**, as today.

A session leaves by delete-from-board, which removes the node and nothing else — the session
keeps running. Deleting the *session* still removes its node, exactly as `reconcile` does
now.

`reconcile()` therefore loses its auto-placement half and keeps its pruning half, and
`useProjectCanvas` becomes `useCanvas` — same single-read guarantee, no project argument,
and no write-back of auto-placements, since there are none left to persist. Notes keep
the existing rule: a note whose linked session is gone keeps the note and loses only the
link, because the note is the user's writing.

### Sections

```ts
export interface CanvasSection {
  id: string;
  x: number; y: number; w: number; h: number;
  title: string;
  /** Index into a fixed palette. Absent = neutral. */
  color?: number;
}
```

Geometric containment, computed not stored:

```ts
membersOf(state, section) // every node / note / section whose bounds sit inside
```

Dragging a section translates it and everything it contains, computed at drag start so that
membership cannot change mid-gesture. Nesting is automatic: a section inside a section is
simply contained by it. Resizing a section does **not** move its contents — it changes what
it contains, which is Figma's behaviour and the one that makes "draw a box around these
three" work.

**Z-order is derived, not stored.** Sections paint behind everything, ordered by descending
area, so a nested section paints over its parent. Then notes and other objects in array
order. Then terminals, which are structurally on top because they live in a sibling layer.
Deriving it avoids a `z` field, avoids reordering arrays — which the file header of
`canvas.ts` forbids, because React reorders DOM to match list order and a reorder is a
reparent that kills a PTY — and removes a whole class of "bring to front" bugs. The cost,
accepted: you cannot draw on top of a terminal. You can draw behind one, which is what a
section needs.

### Selection and undo

Neither exists today; both are prerequisites for everything after this increment, and a
pencil without undo is hostile.

**Selection** is ephemeral component state, never persisted: an array of
`{ kind: "node" | "note" | "section", id: string }`. Click selects, shift-click adds,
marquee drags a rubber band over the plane, Escape clears. Move and delete operate on the
whole selection.

**Undo** is a snapshot stack, and it is unusually cheap here because `CanvasState` is
already a pure immutable value with pure transition functions — every mutation already
returns a new object and returns the *same* object when nothing changed. A new pure module
`src/canvasHistory.ts` holds past and future stacks, capped at 50 entries. Entries are
pushed at **gesture start**, not per pointer-move, so one drag is one undo step. Structural
sharing means a snapshot costs a few pointers, not a copy of the plane.

### Attention

Three pieces, all fed from state the app already computes — `live` (status, activity,
`updatedAt`) and the shared rules in `statusRules.ts`.

**The rail** is a docked strip listing every session across every project whose status is
`needsInput`, plus any caught by the 20-minute stale-`running` watchdog, sorted by wait time
descending. Each row shows agent, session, project, and how long. Clicking a row flies to it
if it is on the board, and offers to place it if it is not.

**Edge pips** solve the failure mode that makes an infinite canvas worse than a list. For
each attention-needing node outside the viewport, a pip is drawn on the viewport border
along the ray from viewport centre to node centre, tinted by its project colour. Click flies
to it. The geometry is a pure function — `edgePips(nodes, viewport)` — and therefore tested.

**Fly-to** animates pan and zoom over roughly 300ms with easing, via a pure
`interpolateCamera(from, to, t)`. Snapping the camera instead would destroy the spatial
memory this whole design is trying to build: seeing the board move is what teaches you where
things are.

Passive status stays as it is — the ring on `AgentGlyph` already encodes idle, running and
needs-you, and the card carries the label.

---

## Increments 2 and 3 — Annotation and ink

Recorded here so the model is designed for them, not built yet.

**Increment 2** adds free text, shapes (rect, ellipse, line, arrow) and connectors. All of
these are box objects on the model above and share its selection, resize and hit-testing.
Connectors are the exception worth the extra work and the reason they outrank ink: a
connector *binds* to two objects by id and follows them when either moves, so it encodes a
relationship that survives rearrangement — "this feeds that", "blocked by". A freehand line
between two cards is a picture of a relationship at one moment. The seam exists:
`linkEndpoints()` in `canvas.ts` already draws note-to-session tethers centre to centre,
relying on the boxes painting over the line so the visible segment is exactly the gap.

**Increment 3** adds freehand ink and an eraser. It shares nothing with the box model —
arbitrary point arrays, distance-to-polyline hit-testing, smoothing, and a storage footprint
an order of magnitude larger than everything else on the plane. It is also the natural point
to re-open the library question with real usage in hand.

---

## Data model and persistence

```ts
export interface CanvasNode {
  ref: string;        // session id, and the React key — stable for the node's life
  projectId: string;  // NEW: required. On a global board a session id no longer locates it.
  x: number; y: number; w?: number; h?: number;
}

export interface CanvasState {
  nodes: CanvasNode[];
  notes?: CanvasNote[];
  sections?: CanvasSection[];   // NEW
  pan: { x: number; y: number };
  zoom: number;
}
```

`projectId` is required rather than absent-means-host, which is the opposite of
`WsTab.projectId` for borrowed tabs — and correctly so, because a global board has no host
project for absence to mean.

Every new collection stays optional (`sections?`) for the same reason `notes?` is, so state
written by an older build loads unchanged.

**Storage.** One global canvas replaces the per-project map: a new localStorage key
`conduit.canvas`, alongside the existing per-machine `conduit.canvases`. Canvas state stays
per-machine and out of `state.json` — a Rust `Store` that fails to parse is an empty store,
and an empty store makes every live tmux session an orphan for the startup sweep to kill.
Canvas layout is not worth putting anywhere near that blast radius.

**Migration.** The old per-project canvases are not merged; their node placements were
auto-generated by the very `reconcile()` this design removes, and merging several projects'
coordinate spaces onto one plane would pile cards on top of each other. The new board starts
empty, which is what was asked for. But **notes are migrated**, because `canvas.ts` already
holds the rule that a note is the user's writing and is never ours to delete — they are
carried across with a per-project offset so they do not overlap. The old key is left in
place rather than deleted, so nothing is unrecoverable.

Ink in Increment 3 may outgrow localStorage's practical size; that is called out there as
the moment to move canvas state to a file behind a Rust command, not before.

## Testing

Following the repo's convention — pure logic is tested, wiring is not, and component tests
are deliberately absent.

New and extended vitest suites, all node-env and free of `store.ts` imports:

- `src/terminalZoom.test.ts` — ladder monotonicity, snapping, `fontForZoom` at both clamps.
- `src/canvas.test.ts` (extended) — section containment including nesting, section drag
  moving contents, resize *not* moving contents, derived z-order, curated add/remove,
  `reconcile` no longer auto-placing, `projectId` round-tripping.
- `src/canvasHistory.test.ts` — push/undo/redo, cap, one-gesture-one-entry, no-op
  transitions not creating entries.
- `src/canvasAttention.test.ts` — rail ordering by wait time, `edgePips` geometry for each
  border and corner, `interpolateCamera` endpoints.

Verification that cannot be automated, and must be done by launching the app: text sharpness
at every ladder rung from 6 to 26; that zooming never reflows an agent's output (watch a
running Claude session's wrapped lines while zooming); gesture smoothness with ten or more
live sessions; and that a session's PTY survives being dragged in, sectioned, moved,
undone and redone.

## Risks

**Font metrics at small sizes.** Box-drawing glyphs and ligatures can misalign when the cell
width lands on a fraction. The integer ladder is the mitigation; rungs 6 through 9 need
looking at with a real TUI on screen.

**WebGL context exhaustion.** A global board can put more terminals on screen at once than
any pane layout, and WebKit caps live GL contexts. `terminalRenderer.ts` already degrades a
pane to canvas in place without rewriting the stored preference, so the failure mode is
graceful — but it will be hit more often, and the viewport-culling in Increment 0 is the
main defence.

**Memory.** More visible sessions means more live terminals, which interacts with
`session_budget`'s reaper. A reap is indistinguishable after the fact from a lost tmux
server and is logged unconditionally; if reaps start appearing during canvas use, the
budget's `max_detached` is the dial, not the canvas.

**Curation friction.** An empty board on first open is the whole point, but it is also a
cliff. The empty state must say what to do, and the attention rail's "place it" path is the
low-effort way in.

## Rejected: adopting a canvas library

Considered seriously, because Increments 2 and 3 are exactly what such libraries provide,
and because the usual objection does not apply here. The viability document rejected React
Flow on the grounds that it owns node DOM and reorders or virtualizes it — fatal to a PTY.
Conduit already dodges that: terminals live in a sibling `.term-stack` overlay and the canvas
draws only chrome beneath, so a library would never touch a terminal. It would own the
plane; we would place a tagged placeholder per session, read its bounds, and mirror its
camera onto the stack as the same CSS transform. Because both are driven by the same three
numbers, that sync is structural rather than per-frame arithmetic.

**tldraw** is the best fit technically and aesthetically. It is rejected on licensing:
commercial production use requires a paid Business License, the free hobby licence is
non-commercial and mandates a "made with tldraw" watermark on the canvas, and the SDK ships
technical enforcement — licence-key validation and deployment-environment detection. Conduit
is free MIT open source, so the watermark is what we would actually get.

**Excalidraw** is MIT with no key and no watermark, exposes `excalidrawAPI`
(`updateScene`, `getSceneElements`) and a `customData` field per element that would carry a
session id. It is rejected for this increment rather than forever: its hand-drawn aesthetic
is a strong visual identity that clashes with a precision developer tool full of terminals
and only partly tunes away, it captures keyboard shortcuts, and its scene format would
become our persistence.

Both share the same permanent seam, which is the deeper reason to wait: pointer events over
a terminal never reach the library, so a marquee cannot sweep across a card and the library
holds a model of a plane it cannot fully see.

The decisive argument is sequencing. Increments 0 and 1 are roughly 70% work no library
supplies — attention rail, edge pips, fly-to, sidebar-drag curation, terminal overlay sync,
cross-project status aggregation — and they are the increments needing the tightest terminal
control. Adopting a library now pays its full integration cost up front for its smallest
slice of value. If the engine question is re-opened at Increment 3, what would be discarded
is pan, zoom, drag, selection and undo — a few hundred lines, most of them already written —
while everything Conduit-specific survives, because it concerns sessions and attention
rather than shapes.

## What this is not

- **Not a replacement for the pane layout.** Panes stay the default and stay faster for
  keyboard-driven work.
- **Not multiple boards.** One canvas. Switching between boards is overhead when the point
  is seeing everything at once.
- **Not actionable sections.** A section groups; it does not broadcast, stop, or spawn.
- **Not bound to the task board.** Deriving section membership from `.conduit/` board state
  is a real idea and a later one; the two are shaped differently today, the board being
  per-project files and this being a global per-machine document.
- **Not a context mechanism.** As with notes today, nothing on the canvas reaches an agent,
  a prompt, or a spawn. Association is for the reader.
