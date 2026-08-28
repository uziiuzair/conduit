# Cross-project panes — design

**Status:** shipped (0.28.0 panes + badging, 0.29.0 the sidebar drag)
**Touches:** `src/store.ts`, `src/layout.ts`, `src/components/WorkspaceCenter.tsx`,
`src/components/Sidebar.tsx`, `src-tauri/src/store.rs`, `src/theme.css`

## The problem

Panes could only ever hold sessions from one project. Not because anyone decided that, but
because a layout is *keyed* by project (`layouts: Record<projectId, ProjectLayout>`), so the
question "which project is this tab's session in" was answered by "the layout it is in" and
nothing ever stored it. Working across two repos meant switching projects and losing the
side-by-side view.

## The model

One optional field:

```ts
interface WsTab {
  kind: TabKind;
  ref: string;
  preview?: boolean;
  projectId?: string;   // set ONLY on a borrowed tab
}
```

`projectId` is present only when a session is *borrowed* from another project into this
layout's panes. **Absent means the host project**, which is what every tab written before
this feature is — so existing `state.json` files and the Rust `WsTab` struct load unchanged,
and the field is `skip_serializing_if = "Option::is_none"` so the common case does not grow
a key. Two Rust tests pin all three halves of that (an old tab must not deserialize as an
orphan; a borrowed one must survive a round trip; a local one must not gain the key).

Nothing reads the field directly. `tabProjectId(tab, hostProjectId)` in `layout.ts` is the
only accessor, so the absent case is handled once.

### Why so little had to move

`WorkspaceCenter` already flat-maps **every** project's sessions into one permanent
keep-alive terminal stack and positions them with CSS alone — that is the load-bearing trick
that lets splits and project switches happen without unmounting an `xterm` and killing its
PTY. The terminals for other projects were already mounted; `placeSession` simply returned
`display: none` for them.

So pane mode just stops gating on ownership, and `groupIndexOfRef` (which searches the
active layout by ref) decides visibility as it always did. **Canvas mode keeps the gate**: a
canvas is reconciled from its own project's sessions, so a borrowed session has no node
there and must stay hidden.

### The one genuinely dangerous piece

`repairLayout` decides whether a tab survives, and it runs on **every layout write**.
Validating a borrowed tab against the *host* project would prune it the instant it was
created — the feature would look broken rather than absent. It therefore takes every project
and checks a foreign tab against its own:

```ts
const owner = t.projectId ?? hostProjectId;
return !!owner && (byProject.get(owner)?.has(t.ref) ?? false);
```

It moved out of `store.ts` into `layout.ts` precisely so this is testable (`store.ts` cannot
be imported under the node-env vitest — it touches `localStorage` at module scope).
`store.ts` keeps a thin `validateLayout` wrapper that supplies `uid()`.

A companion rule: **removal repairs every layout, not the owner's.**
`revalidateAllLayouts` runs on `removeSession`/`removeProject` because a dead session may be
sitting in someone else's panes. It skips persisting layouts that did not change.

## Differentiation

Once a layout holds more than one project (`isMixedLayout`), **every** tab is badged with
its project's name and colour — not only the visitors. Badging only the foreign ones would
make "no badge" mean "the host project", which is exactly the knowledge the badge exists to
supply. When a layout is not mixed, the strip renders precisely as it did before, so users
who never use this pay nothing.

A pane whose tabs all belong to one project also wears that colour along its top edge, so
panes are distinguishable before a single tab is read. A pane holding two projects gets no
strip colour — the per-tab bars already say it, and a strip colour would have to pick a
winner.

`projectAccent(projectId)` derives the colour from the id (FNV-1a → hue, fixed
saturation/lightness, hues spread by a large odd step so ids differing in one character do
not land next to each other). **Never stored**: a colour the user did not choose must not
become state to migrate, and it has to work for every project that already exists the moment
they update. The sidebar's folder icon uses the same function, so a colour on a tab always
has a referent.

## Getting a session in there

Two ways, and the second is the one people reach for.

**Right-click → "Open beside \<project\>"** (sidebar, offered only when the session is not
already in the project on screen).

**Drag the row onto a pane.** This shipped a release late because the pane drop overlay was
gated on a `TabDrag` — state set by a tab's `onDragStart` — which a sidebar row never
produces, so dragging a session into the workspace did nothing *for any project*, not just
across projects.

The drag crosses component trees, so it travels as a MIME type:

```ts
export const SESSION_DRAG_MIME = "application/x-conduit-session";
```

It **has** to be a MIME type. `dataTransfer.getData` is blocked during `dragover` — only
`types` is readable — so advertising a custom type is the only way a drop target can know a
drag is droppable *before* it lands, which is precisely what the overlay needs in order to
render at all. A module-level variable could not do it: the overlay is gated on React state
in a different tree.

Two consequences worth keeping:

- **The tab strip must accept the drop itself.** `.group-chrome` (z-index 4) sits above
  `.term-stack` (2), so the pane overlay never receives a pointer that is over a strip — and
  the strip is the most natural place to aim.
- **`insertTabAt` dedupes by ref.** A session is ONE mounted terminal, placed by the *first*
  group whose tabs contain its ref. A duplicate ref would draw in one pane and leave the
  other permanently blank. The dedupe is correctness, not tidiness.

A `dragend`/`drop` window listener clears the overlay: a drag cancelled with Esc fires no
`dragleave`, and a stuck overlay sits at z-index 30 across the terminals and would read as a
frozen app.

## Behaviour notes

- Closing a borrowed tab removes it from the layout only. The session, its PTY and its own
  project are untouched.
- Selecting a sidebar session that is **already visible** in the panes on screen focuses that
  tab instead of switching projects — switching would tear down the view the user built in
  order to show them something they can already see.
- The right column (Files/Changes/Git) already resolved through `findSession(projects, id)`,
  so it follows a borrowed session to *its* repo with no change. The tab strip's cwd readout
  and _Open in VS Code_ were changed to do the same; they had been scoped to the host.

## Relationship to the July spike

There is an earlier, broader design —
`2026-07-28-workspace-2d-layout-and-panel-ux-design.md`, §3 "Part B" (currently on the
unmerged `release/0.19.0` branch, commit `2ab15da`) — which reached the same
finding about cost (`WsTab.ref` is already globally unique, the terminals are already all
mounted, the blocker is purely that the layout is *keyed* by project and `placeSession`
*gates* on project) but proposed a different model:

> `layouts: Record<projectId, ProjectLayout>` → `workspaceLayout: ProjectLayout`

…with the sidebar demoted to a source list, the right panel following the focused pane, and
per-project layouts preserved as named presets.

**This ships the narrower model instead**: layouts stay keyed by project, and a tab may
*borrow* a session from another. The reasons are all about blast radius.

| | One global workspace (spike) | Borrowed tabs (shipped) |
| --- | --- | --- |
| Migration | Every `state.json` rewritten | None — absent `projectId` already means "local" |
| Behaviour for existing users | Sidebar clicks stop switching workspace; per-project arrangements become presets | Unchanged unless you borrow |
| Per-project layouts | Replaced by presets (must be built, or people lose their setups) | Kept as-is |
| Risk to session restore | Opening a workspace referencing six projects eagerly spawns all of them (spike §3.5) | Does not arise — the eager-spawn effect is still gated on `projectId !== selectedProjectId`; a borrowed session spawns on reveal like any other |
| "Current project" | Ambiguous; must be derived from the focused pane | Still unambiguous — the host |

The spike is not wrong; it is a bigger, better end state that needs the sidebar rework, the
right-panel-follows-focus change and layout presets to land together to be coherent. This is
the increment that delivers the actual request without any of them.

### The spike's risks, checked against what shipped

- **Session restore.** Does not apply (see the table). Borrowed sessions spawn lazily on
  first reveal, which is the pre-existing behaviour for any not-yet-visible pane.
- **The fleet boundary must stay project-scoped.** Verified: `fleet_mcp.rs` scopes every tool
  through `snap.project_id` — the session's *own* project, from the fleet status mirror — and
  neither `fleet.rs` nor `fleet_mcp.rs` reads layouts at all. A borrowed *view* therefore
  cannot become a cross-project *fleet*. Nothing in this change touches that path.
- **Per-pane project identity is mandatory.** Agreed and implemented (see Differentiation),
  including the spike's point that it is what stops you typing into the wrong repo.

### What is still open from the spike

The single workspace layout, sidebar-as-source-list, right-panel-follows-focus, named layout
presets, the 2D (row/column) tree, and the dock UX. Nothing here forecloses any of them:
`tabProjectId` already answers "which project is this tab's session in" for every tab, which
is the lookup a single global layout would need on *every* tab rather than on the borrowed
ones.

## Rejected

- **A layout that owns a set of projects.** Would have made every layout write a
  multi-project transaction and forced a migration on every existing `state.json`, to express
  something one optional field on the borrowing tab already says.
- **Storing a chosen colour per project.** More state, a migration, a settings surface, and
  it would not colour anyone's existing projects until they picked one.
- **Moving the session between projects on drop.** A session's worktree, transcript and
  account are rooted in its project. Borrowing a *view* of it is the honest operation.
