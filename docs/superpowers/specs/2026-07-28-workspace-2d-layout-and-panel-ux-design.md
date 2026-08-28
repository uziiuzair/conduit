# Workspace 2D Layout, Cross-Project Panes, Dock UX, Project Organization -- Design

- **Date:** 2026-07-28
- **Status:** Draft (exploration; not yet approved)
- **Scope:** Four related asks that together turn the workspace from "up to N columns of one
  project" into a real IDE workspace: (1) sessions from *different projects* side by side,
  (2) true 2D splitting (horizontal + vertical + arbitrary nesting) with resizing,
  (3) show / hide / move / auto-reveal for the left and right panels, (4) project reordering
  and colour coding in the sidebar.
- **Supersedes the non-goals of:** `2026-07-02-workspace-split-tab-ux-design.md`, which explicitly
  deferred "up/down splits, nested grids, a split-tree data model" and predicted that vertical
  splitting "would require replacing `weights: number[]` with a split-tree". That prediction was
  correct and this document cashes it in.

---

## 0. What already exists (read this before building anything)

Three of the requested behaviours are **already implemented**. Two of them are invisible, which is
itself the bug.

| Assumed missing | Reality | Real defect |
| --- | --- | --- |
| "splits are fixed size and cannot be resized" | They resize. `WorkspaceCenter.startDrag` drags `.group-divider` and writes `setGroupWeights`. | The divider is **transparent at rest** (`theme.css`: 7px hit area, a 1px line that only tints on hover). Nothing says "grab me". A resize affordance nobody finds is a missing feature. |
| "only 3 columns" | No cap exists. `MIN_WEIGHT = 0.14` permits ~7 columns. | Three is simply what stays legible. The limit is real but it is *ergonomic*, and it is the argument for 2D: the fourth pane should go **below**, not further right. |
| "want to move projects in the sidebar" | Drag-reorder works today (`Sidebar.tsx` -> `reorderProject`). | No grouping, no colour, no visual anchor. Reordering 15 uniform grey rows does not actually help you find anything. |

Also already present and worth keeping: pane maximize (`⇧⌘M`), `Toggle Sidebar` (`⌘B`) and
`Toggle Right Panel` (`⌥⌘B`) in the View menu, and per-panel width resizers on both sides.

So the honest problem statement is narrower and sharper than "we need IDE layout features":

> The layout model is 1-D and project-scoped, and almost every affordance we *do* have is
> undiscoverable.

Both halves matter. Shipping the data-model work without fixing discoverability produces a more
powerful workspace that users still cannot find their way around.

---

## 1. The human element (the part that decides whether this ships well)

Design constraints derived from how people actually use split IDEs, in priority order.

**1.1 Spatial memory is the whole point of splitting.** Users do not think "pane 3", they think
"the one bottom-left". Any operation that silently re-flows panes destroys that memory and costs
more than the feature gains. Consequence: closing a pane must give its space to its *sibling*
(the neighbour it was split from), never trigger a global re-layout. This is why the split tree
is not merely a nicer data structure: a flat array cannot express "who owns the space I vacate".

**1.2 The user must see the outcome before committing.** Today's drop overlay highlights a thin
band at the edge of a pane. The user has to infer the result. Every IDE that does this well
(VS Code, IntelliJ, Rider, Figma) highlights **the rectangle the pane will actually occupy**.
This is a small change with a disproportionate payoff and should ship in the first phase.

**1.3 Hover-triggered UI is loved when it is deliberate and hated when it is eager.** Visual
Studio's auto-hide is the canonical implementation of what was asked for ("scroll away hidden
until I move the cursor to the edge") and also the canonical complaint: panels leaping out while
you reach for a scrollbar. Non-negotiable mitigations, all four: an open delay (~250 ms), a
generous close delay (~400 ms), suppression during any drag, and **opt-in** via Settings. A peek
must overlay the workspace, never reflow it, or the terminal under it reflows twice per accidental
hover.

**1.4 Cross-project panes create a new failure mode: running the right command in the wrong repo.**
Once two projects are on screen, "which repo is this pane" stops being ambient context and becomes
a thing the user must *verify*, on every prompt, forever. That is unacceptable friction and a real
hazard (a `git reset --hard` in the wrong worktree). This is the load-bearing reason project
colour coding is in the same design document rather than a separate one: **colour is the safety
mechanism that makes cross-project layouts usable**, and organization in the sidebar is its
secondary benefit, not its primary one.

**1.5 A 2D grid without directional keyboard focus is a downgrade.** With columns, `⌃Tab` and
`⌘1..9` are adequate. Once panes are above and below each other, "next pane" has no meaning a user
can predict. Directional focus (`⌥⌘←/→/↑/↓`) is not polish, it is a prerequisite for shipping 2D.

**1.6 Colour must never be the only signal.** ~8% of men have some colour vision deficiency. Every
coloured element pairs with text (the project name) or an optional 2-letter badge.

---

## 2. Part A -- 2D layout via a normalized n-ary split tree

### 2.1 The critical architectural constraint

`CLAUDE.md` is blunt about this and it is correct: **never reparent or conditionally unmount an
`xterm` / `TerminalView`; it kills the underlying `claude` PTY.** Today's workspace obeys this by
rendering panes as a *flat stack* of absolutely positioned siblings (`.term-stack`), with layout
expressed purely as inline `left%` / `width%` computed by `geometry(weights)`.

The naive implementation of a split tree renders the tree as nested DOM. **That would reparent
every terminal on every split and is an instant, non-obvious PTY massacre.**

The design that avoids it, and the single most important idea in this document:

> **The tree is a data model, not a DOM structure.** It is flattened to absolute rectangles before
> render. The DOM stays exactly as flat as it is today.

`geometry(weights) -> {left, width}[]` becomes `flatten(tree) -> {leafId -> {left, top, width,
height}}`. The pane elements gain `top` and `height` alongside the `left` and `width` they already
have. Nothing else about the render path changes. Splitting, closing, and resizing continue to be
pure CSS repositioning of stable DOM nodes.

### 2.2 The model

```ts
// src/store.ts
export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface LayoutLeaf {
  kind: "leaf";
  id: string;
  tabs: WsTab[];
  activeRef: string | null;
}

export interface LayoutSplit {
  kind: "split";
  id: string;
  dir: "row" | "col";      // row = children side by side; col = children stacked
  children: LayoutNode[];  // n-ary, NOT binary
  weights: number[];       // index-aligned to children, sums to 1
}

export interface ProjectLayout {
  root: LayoutNode;
  activeLeafId: string | null;
}
```

**Why n-ary and not binary.** A binary tree turns three equal columns into `split(A, split(B, C))`.
Dragging the first divider then resizes A against *the combined B+C block*, which is not what the
user is pointing at, and "make all panes equal" becomes ill-defined. N-ary keeps three columns as
one node with `weights [.33, .33, .33]`, so the existing `startDrag` logic (adjust `w[i]` and
`w[i+1]`, clamp both at `MIN_WEIGHT`) transfers **unchanged**. This is the difference between
resizing that feels physical and resizing that feels haunted.

The user's own example expresses cleanly:

```
split(col, weights [0.6, 0.4])
├── split(row, weights [0.33, 0.33, 0.34])   <- three columns across the top
│   ├── leaf A
│   ├── leaf B
│   └── leaf C
└── leaf D                                    <- one full-width pane below
```

### 2.3 Invariants (enforced by `normalizeLayout`, the successor to `validateLayout`)

- **I1 -- No same-direction nesting.** A `row` child of a `row` parent is inlined into the parent,
  its weights scaled by the slot it occupied. Without this, repeated splitting silently builds
  deep spines that resize unpredictably and serialize enormous.
- **I2 -- No degenerate splits.** A split with one child is replaced by that child; a split with
  zero children is removed.
- **I3 -- Weights are index-aligned to children, positive, and sum to 1.**
- **I4 -- Empty leaves are pruned**, except a single last leaf, which is kept so the workspace
  always has a drop target (today's behaviour, preserved).
- **I5 -- `activeLeafId` always resolves**, falling back to the first leaf in document order.

### 2.4 `flatten` is pure and testable

```ts
// src/layout.ts (extends the existing pure module; no Tauri / Zustand imports)
export interface Rect { left: number; top: number; width: number; height: number } // percentages
export interface Divider { id: string; splitId: string; index: number; dir: "row" | "col"; rect: Rect }

export function flatten(root: LayoutNode): { leaves: Map<string, Rect>; dividers: Divider[] };
```

Dividers come out of the same pass, which means they are no longer derived by
`groups.slice(1)` in the component. Each split node contributes `children.length - 1` dividers,
each carrying the `splitId` and child `index` it adjusts, so the drag handler stays a two-weight
edit against a known node.

Properties worth unit testing (`layout.test.ts` already exists and runs under vitest):
every leaf gets exactly one rect; rects tile `[0,100]²` with no gaps or overlaps; `flatten` after
`normalize` is stable; `split -> close` round-trips back to the original geometry.

### 2.5 Operations

| Operation | Behaviour |
| --- | --- |
| `splitLeaf(tree, ref, targetLeafId, side)` | `side` widens from `"left" \| "right"` to `"left" \| "right" \| "up" \| "down"`. Inserts a sibling in the parent when the parent's `dir` already matches the axis (the common case, and why I1 matters); otherwise wraps the target in a new split of the needed direction. New pane takes half the target's slot, as today. |
| `closeLeaf` | Space goes to the **sibling** it was split from, then `normalize` collapses the degenerate parent. Preserves 1.1. |
| `resize` | Unchanged in spirit: adjust `weights[i]` / `weights[i+1]` on the identified split node, clamped by `MIN_WEIGHT`. |
| `evenPanes(splitId?)` | Reset weights to uniform. Bound to **double-click on a divider** (scoped to that split) and a `View -> Even Pane Sizes` item (whole tree). Standard in VS Code and universally expected. |
| `focusDirection(dir)` | Geometric, not tree-structural: from the active leaf's rect, pick the candidate whose rect overlaps on the perpendicular axis and is nearest in `dir`, tie-broken by the last-focused. Tree-walking gives technically-correct answers that feel wrong across nesting boundaries. |

### 2.6 Drop zones: three regions become five

`PaneZone` goes from `"left" | "center" | "right"` to `"left" | "right" | "up" | "down" | "center"`.

Region geometry, following VS Code: the inner **40% x 40%** of a pane is `center` (add as a tab);
outside it, the pointer's normalized distance to each of the four edges is compared and the nearest
wins, which resolves the diagonal corners without dead zones.

Per 1.2, the highlight must be **the resulting rectangle** (the half of the pane the new pane would
take, or the whole pane for `center`), rendered as a translucent accent fill with an accent border.
The existing `.pane-dropzones` overlay is already an absolutely positioned sibling layer that never
wraps the panes; it stays that way and just gains two regions and a preview fill.

### 2.7 Persistence and migration

`src-tauri/src/store.rs` mirrors this: `ProjectLayout { groups: Vec<EditorGroup>, weights: Vec<f64> }`
becomes a serde-tagged recursive enum. Migration on load is total and lossless:

```
{ groups, weights }  ->  { kind: "split", dir: "row", children: groups.map(leaf), weights }
```

A single-group layout normalizes straight to a bare leaf by I2. Old state files therefore open with
identical geometry and no user-visible event. Write a Rust unit test pinning that.

---

## 3. Part B -- sessions from different projects in one workspace

### 3.1 Why it is blocked today

`layouts: Record<projectId, ProjectLayout>`, and `WorkspaceCenter` renders `layouts[selectedProjectId]`.
Every session belonging to another project is explicitly forced to `display: none` by `placeSession`.
Selecting a project in the sidebar swaps the entire centre pane.

### 3.2 The good news, which changes the cost estimate substantially

`WsTab.ref` is a bare string: a session id, or an absolute file path. Both are **already globally
unique** (session ids are uuids; paths are absolute). `WorkspaceCenter` already builds `allSessions`
by flattening **every** project's sessions into one keep-alive stack, and already keeps them all
mounted.

So there is no identifier refactor and no remounting to do. The blocker is purely that the layout
is *keyed* by project and the placement function *gates* on project. Change:

```ts
layouts: Record<projectId, ProjectLayout>   ->   workspaceLayout: ProjectLayout
```

plus dropping the `ownerProjectId !== projectId` early return in `placeSession`. Lookups that
currently search one project's sessions (`GroupTabStrip`'s `label`, `activeSession`) search all
projects instead, which is a one-line change each.

### 3.3 The real design question: what does clicking a project in the sidebar mean?

This is the decision that determines whether the feature feels coherent. Once the workspace is not
project-scoped, "selected project" is competing with "focused pane" as the source of truth, and two
sources of truth is exactly how this ships feeling broken.

**Recommendation: the sidebar becomes a source list, not a mode switch**, matching VS Code's
Explorer.

- Clicking a **session** opens it into the active leaf (or focuses it if already open). It no longer
  swaps the workspace.
- Clicking a **project header** expands / collapses it. That is all it does.
- The right panel (Files / Changes / Todos / Terminal / Git) **follows the focused pane**, not the
  sidebar selection. It already resolves its directory via `effectiveDirOf(project, session,
  sessionDirs)`; it just needs the session to come from the focused leaf.

That last point is worth stating plainly: **the right panel following focus is a genuine
improvement independent of cross-project work**, and it is what makes cross-project coherent rather
than confusing. It is also the change most likely to surprise existing users, so it belongs behind
the same release note as the rest.

**Per-pane project identity is mandatory** (1.4). Every tab strip carries its project's colour chip
plus the project name when the pane is wide enough to fit it. Section 5 defines the colour system
this consumes.

### 3.4 Retaining what is lost

Per-project layouts are a real feature today: switching project restores that project's
arrangement. Preserve it as **named layout presets**, which is strictly more capable:

- `layoutPresets: { id, name, tree }[]`, saved and restored explicitly from a `View -> Layouts`
  submenu, with the last per-project arrangement auto-saved as an implicit preset on first
  migration so nobody loses their setup.
- This is the feature JetBrains ships and VS Code users have requested for a decade. It falls out
  nearly free once the tree is serializable in isolation, so it should be in scope, but late.

### 3.5 Honest risks

- **The window title and any "current project" affordance become ambiguous.** Resolve from the
  focused pane, and accept that with no pane focused there is no current project.
- **Session restore on open** (`restoreSessionsOnOpen`, `Terminal.tsx` eager spawn) is written
  per-project. Opening a workspace that references six projects would eagerly spawn all their
  sessions. Needs an explicit rule: spawn only sessions **present in the workspace layout**, plus
  the opened project's own.
- **The Conductor / fleet is project-scoped by design** (`fleet_list` is per project, and there is a
  documented cross-project leak in `fleet_peek` / `fleet_send`, SPEC-0 in the orchestration-v2
  design). A cross-project *view* must not become a cross-project *fleet*. The fleet boundary stays
  keyed on the session's owning project and this design does not touch it. Worth an explicit test.

---

## 4. Part C -- docks: show, hide, move, auto-reveal

### 4.1 Prior art, and what to take from each

| Product | Model | Take |
| --- | --- | --- |
| **VS Code** | Activity Bar, Primary Sidebar, Secondary Sidebar, Panel, Editor. Views drag between containers; every view has a `Move View` command; `⌘B` / `⌥⌘B` / `⌘J`; Zen mode. | The container model, the drag-between-docks interaction, and command-palette parity for every drag action. |
| **JetBrains** | Tool windows with Docked / Undocked / Float / Window modes, Pinned vs Unpinned (unpinned = hide on focus loss), and **edge stripe buttons** that peek on hover. | Edge stripes are exactly the requested "hidden until I move the cursor to the edge", and are better than VS Code here. |
| **Visual Studio** | Pushpin auto-hide; panel collapses to an edge tab, slides out on hover. | The canonical implementation, and the canonical warning about eagerness (1.3). |
| **Zed** | Left / right / bottom docks, panels assignable to a dock. | Minimal viable version of the same idea. |

### 4.2 Proposal, in ascending cost. Each tier ships independently.

**Tier 1 -- reach parity and add relief (cheap, do first).**
`⌘B` / `⌥⌘B` already exist. Add **Focus Mode** (`⌘K Z`): hide both docks, keep only the workspace.
Add explicit `View -> Even Pane Sizes` and `View -> Reset Layout`. Fix divider discoverability
(1.0 / 1.2): keep the 1px line but widen the hit area, and tint on hover with a short delay so
passing through does not flash.

**Tier 2 -- edge rails with opt-in peek (the requested behaviour).**
A hidden dock leaves a ~28px rail carrying its view icons. Click a rail icon: pin the dock open to
that view. Hover a rail icon: **peek**, an overlay that slides over the workspace and never reflows
it, dismissed on mouse-leave or `Escape`. All four mitigations from 1.3 are requirements, not
polish, and peek is off by default under Settings -> "Reveal hidden panels on hover".

**Tier 3 -- moveable views (highest value, and where the real trap is).**
`viewLayout: Record<viewId, { dock: "left" | "right" | "bottom"; order: number }>` with drag between
docks, plus a `Move View` menu for keyboard and accessibility parity. Requires a bottom dock, which
does not exist yet.

> **The trap:** `RightColumn` hosts a **keep-alive shell `TerminalView`** (`App.tsx` deliberately
> wraps it in `display: contents` / `display: none` rather than unmounting it, for exactly this
> reason). Dragging that view to another dock reparents its DOM and kills the shell PTY. This is
> the same class of bug as 2.1 and it will not be caught by a typecheck.
>
> **Resolution:** Tier 3 ships moving only the non-terminal views (Files, Changes, Todos, Git). The
> shell terminal stays pinned to its dock, with its move affordance absent rather than broken.
> Making it movable requires promoting docks to absolutely-positioned regions with the shell
> terminal in its own flat stack, which is the same trick as 2.1 and should be its own effort.

---

## 5. Part D -- project organization and colour

### 5.1 Colour is a safety feature first (1.4) and an organizational one second

**Do not tint whole rows.** A saturated row background in a dark IDE flattens the type hierarchy,
fails contrast at the exact moment the text matters, and is the single most common way this feature
ships ugly. Every product that does this well uses a small carrier: JetBrains uses a thin per-window
stripe, VS Code's Peacock tints the title bar edge, Finder tags and GitHub labels use dots and pills.

**Where the colour appears, in order of importance:**

1. A **3px stripe on the left edge of the project row** in the sidebar.
2. A **dot on each of that project's session rows**, so it survives scrolling past the header.
3. A **chip in the tab strip of every pane** showing that project's session. This is the one that
   earns the feature: it is what stops you typing into the wrong repo in a cross-project layout.

### 5.2 A fixed palette, not a colour picker

A free RGB picker guarantees, within a week, an unreadable set of near-identical muddy hues.
Ship **8 named tokens**: Grey, Red, Amber, Green, Teal, Blue, Violet, Pink.

- Stored as `Project.color?: string` holding **the token name**, never a hex, so each theme
  (Warm Light / Warm Dim / Warm Near-Black) can re-map the hue to values that work against its own
  background. Defined as CSS custom properties per theme in `theme.css`, alongside the existing
  theme tokens.
- Assigned from the existing project right-click menu in `Sidebar.tsx`, via a `Colour` submenu of
  8 swatches plus `None`, matching the existing `Account` submenu pattern.
- Paired with text always (1.6). Optionally a 2-letter badge derived from the project name, user
  overridable, which also solves narrow-pane tab strips where the name does not fit.

### 5.3 Grouping

Reordering already works. What is missing at 15+ projects is **grouping**: collapsible folders in
the sidebar, each with its own colour that its children inherit by default. This is the natural
partner to colour and the thing that actually makes a long list navigable. Recommend scoping it in,
but last, since it changes the sidebar's data model (`projects: Project[]` gains a tree or a
`groupId`) and nothing else in this document depends on it.

---

## 6. Cross-cutting: the keyboard model

Per 1.5 this is a prerequisite, not polish. Proposed bindings, following VS Code where a convention
exists:

| Action | Binding |
| --- | --- |
| Focus pane left / right / up / down | `⌥⌘←` `⌥⌘→` `⌥⌘↑` `⌥⌘↓` |
| Split active pane in direction | `⇧⌥⌘` + arrow |
| Move active tab to pane in direction | `⌃⇧⌘` + arrow |
| Even pane sizes | `⌥⌘0` |
| Maximize pane toggle | `⇧⌘M` (exists) |
| Toggle left dock / right dock | `⌘B` / `⌥⌘B` (exist) |
| Focus mode | `⌘K Z` |

Every drag interaction in this document needs a keyboard or menu equivalent. That is an
accessibility requirement, and separately it is what makes the features discoverable at all, since
a menu item is the only affordance a user can find without being told it exists.

---

## 7. Suggested phasing

Each phase is independently shippable and independently valuable. Ordered by value per unit of risk,
not by the order the asks arrived.

| Phase | Contents | Risk |
| --- | --- | --- |
| **1. Discoverability + colour** | Divider affordance, double-click to even, `View` items, Focus Mode, project colours (5.1, 5.2). | Low. No model change. Delivers the "IDEs have this on day one" feeling immediately and de-risks phase 3 by putting per-pane project identity in place first. |
| **2. Split tree** | `LayoutNode`, `normalize`, `flatten`, five drop zones with rect preview, Rust migration, directional focus keys. | Medium. Contained by 2.1. Heavily unit-testable, and `layout.test.ts` already exists. |
| **3. Cross-project workspace** | Single workspace layout, sidebar becomes a source list, right panel follows focus, layout presets. | **Highest.** Behavioural change for existing users; touches session restore and the fleet boundary (3.5). |
| **4. Docks** | Tier 1 done in phase 1; Tier 2 edge rails + peek; Tier 3 moveable non-terminal views. | Medium, with the `RightColumn` PTY trap called out in 4.2. |
| **5. Sidebar grouping** | Collapsible project folders inheriting colour. | Low, isolated. |

Phase 2 before 3 is deliberate: the tree is self-contained and testable, whereas cross-project
changes user-visible behaviour. Doing 3 first means debugging a behaviour change and a model change
at once.

---

## 8. Open decisions (need a call before phase 3 is planned)

1. **Does clicking a project in the sidebar stop switching the workspace?** (3.3) The recommendation
   is yes, source-list semantics, right panel follows focus. This is the one genuinely
   user-visible behaviour change in this document. The alternative (keep project switching, add an
   explicit "pin session across projects") preserves muscle memory but leaves two competing sources
   of truth, and will feel bolted on.
2. **Is hover-peek off by default?** (1.3, 4.2) The recommendation is yes, discoverable via the
   rail's tooltip and a Settings toggle.
3. **One workspace layout, or several open at once?** This design assumes one plus named presets
   (3.4). Multiple simultaneous workspaces means multiple windows, which is a much larger effort
   and is out of scope here.
