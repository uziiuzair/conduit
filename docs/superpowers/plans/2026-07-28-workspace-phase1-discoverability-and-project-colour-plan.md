# Phase 1 -- Layout Discoverability + Project Colour -- Implementation Plan

- **Date:** 2026-07-28
- **Design:** `docs/superpowers/specs/2026-07-28-workspace-2d-layout-and-panel-ux-design.md` (sections 0, 1.1-1.2, 1.4, 1.6, 2.5 `evenPanes`, 5, 6)
- **Scope:** Phase 1 only. No layout model change (`ProjectLayout` stays `{ groups, weights }`),
  no cross-project work, no docks beyond a Focus Mode toggle.
- **Why first:** it is the lowest-risk phase, it makes affordances that already exist findable, and
  it lands per-pane project identity **before** phase 3 needs it as a safety mechanism (design 1.4).
- **Branch:** `feat/workspace-phase1` based on `origin/main` (currently `e88ce09`, v0.18.0).
  **Not** on `ci/windows-support`, which has an unrelated open PR (#29).

---

## Task 1 -- Project colour tokens (per theme)

Themes are not pure CSS: `src/themes.ts` defines `cssVars: Record<string, string>` written onto
`:root`, one set per theme. `gitLanes: string[]` is the existing precedent for a per-theme colour
set and should be matched in spirit.

Add **8 tokens** to the `cssVars` of **all three** themes (`warm-near-black`, `warm-dim`,
`warm-light`), tuned per theme so each reads correctly against that theme's own background:

```
--proj-gray  --proj-red   --proj-amber  --proj-green
--proj-teal  --proj-blue  --proj-violet --proj-pink
```

Seed the dark values from the existing `gitLanes` arrays (already hand-tuned for these
backgrounds) rather than inventing hues. The light theme needs genuinely darker, more saturated
values (see its `gitLanes`, which are already much darker) so a 3px stripe stays visible on a light
background.

Export a single source of truth for the palette so UI code never hardcodes the list:

```ts
// src/themes.ts
export const PROJECT_COLORS = ["gray","red","amber","green","teal","blue","violet","pink"] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];
```

**Do not** store hex anywhere in project state (design 5.2). State stores the token *name*; the
theme maps it. `var(--proj-${color})` is the only lookup.

## Task 2 -- `Project.color` state + persistence

Mirror the `rename_project` path exactly; it is the smallest existing example of the same shape.

- `src/store.ts`: `Project` gains `color?: string | null`.
- `src-tauri/src/store.rs`: `Project` gains `#[serde(default)] pub color: Option<String>`.
  `#[serde(default)]` is **required** so existing `state.json` files load (same reason as
  `default_accounts`). Add a `Store::set_project_color` alongside `rename_project`.
- `src-tauri/src/lib.rs`: `set_project_color(project_id, color: Option<String>)` command,
  registered in the `invoke_handler!` list next to `rename_project`.
- `src/store.ts` action `setProjectColor(projectId, color: string | null): Promise<void>` -- follow
  `reorderProject`'s **optimistic-then-persist** comment and ordering: a persist failure should cost
  the colour on next launch, never the project.

Validate the token name against `PROJECT_COLORS` in Rust before writing, so a bad value cannot
poison state into referencing a nonexistent CSS var.

## Task 3 -- Assigning a colour (Sidebar context menu)

In `SessionContextMenu`'s `menu.kind === "project"` branch (`Sidebar.tsx`), add a **Colour** entry
above `Remove Project`, using the **same inline-expander pattern as the session menu's `Account`
submenu** (`accountOpen` state + reset on menu-target change). Do not introduce a new flyout
mechanism.

Expanded content: a single row of 8 swatch buttons plus a `None` option. Each swatch is a
`button` with an `aria-label` of the colour name and `title` set likewise, so it is reachable
without sight of the colour (design 1.6). The currently selected swatch gets a ring, not just a
checkmark.

## Task 4 -- Where the colour appears

Three carriers, in the order they matter (design 5.1). **No tinted row backgrounds.**

1. **Sidebar project row.** A 3px stripe on the left edge of `.project-head`, via a `::before` or a
   `border-left`, coloured `var(--proj-*)`. When no colour is set, the stripe is absent (not
   transparent-but-spaced), so uncoloured projects keep today's exact metrics.
2. **Sidebar session rows.** A small dot in that project's colour on each session row. It must not
   collide with the existing status dot (`.dot running` / `.dot done`); place it on the opposite
   side or inset it as a leading marker.
3. **Pane tab strip.** In `GroupTabStrip` (`WorkspaceCenter.tsx`), a chip carrying the project
   colour for the group's active **session** tab. This is the carrier that earns the feature
   (design 1.4) and the one phase 3 depends on. Show colour + project name when the pane is wide
   enough; degrade to the colour chip alone when narrow. The strip already degrades the VS Code
   button by `soloGroup`, so follow that precedent.

For uncoloured projects, render nothing anywhere. The feature must be invisible until used.

## Task 5 -- Divider discoverability + double-click to even

`theme.css` `.group-divider` (7px hit area, transparent at rest, 1px line tinting on hover).

- Widen the hit area to **10px** while keeping the visual line at 1px. Only the hit area changes;
  the line must not get thicker or the workspace gains visible gutters.
- Add a short **hover delay** (~120ms) before the accent tint so passing the cursor across a
  divider does not flash. CSS `transition-delay` on the hover state is sufficient; no JS timer.
- Keep `cursor: col-resize` (already present) -- that is the strongest existing signal and it works;
  the problem is purely that the 7px band is easy to miss.

**Double-click a divider = even the two panes it separates** (design 2.5). Add
`onDoubleClick` to the `.group-divider` element in `WorkspaceCenter.tsx`, setting
`weights[i]` and `weights[i+1]` to their combined average via the existing `setGroupWeights`.

## Task 6 -- `evenGroupWeights` + View menu items

- `src/store.ts`: `evenGroupWeights(projectId)` sets every weight in the project's layout to
  `1 / groups.length` and persists through the existing `applyLayout` / `persistLayout` pipeline
  (do not write `weights` directly around it).
- `src-tauri/src/menu.rs`, View menu: `Even Pane Sizes` with accelerator `CmdOrCtrl+Alt+0`,
  placed near `Toggle Sidebar` / `Toggle Right Panel`.
- `src/App.tsx`: handle the `even-panes` menu id in the existing menu-event `switch` (the one that
  already handles `toggle-sidebar`).

## Task 7 -- Focus Mode

A single toggle that hides **both** docks, for when the workspace needs the whole window.

- `src/store.ts`: `focusMode: boolean` + `toggleFocusMode()`. It must be **derived, not
  destructive**: remember the prior `sidebarCollapsed` / `rightCollapsed` values and restore them
  on toggle-off, so leaving Focus Mode does not reveal a panel the user had deliberately hidden.
- `src-tauri/src/menu.rs`: View menu item `Focus Mode`, accelerator `CmdOrCtrl+Alt+F`.
  **Tauri accelerators do not support chords**, so VS Code's `⌘K Z` is not available; do not try.
- Add `Reset Layout` (no accelerator) in the same menu: show both docks, restore default dock
  widths, and even the panes. This is the escape hatch if a user gets lost, and it is the only
  guaranteed way back from an odd state.
- Do **not** bind Escape to exit Focus Mode. Escape is already load-bearing (`04c4f2c` /
  `7197a03`: the macOS fullscreen shim and its IME guard) and must not gain another meaning.

---

## Constraints (violating any of these is a defect, not a style question)

1. **Never reparent or conditionally unmount a `TerminalView` / `xterm`.** Every change here is CSS
   and state only. If a diff moves a terminal in the JSX tree, it is wrong. The tab-strip chip
   (task 4.3) is inside `GroupTabStrip`, which is separate from `.term-stack`; keep it that way.
2. **`RightColumn` stays mounted when hidden.** `App.tsx` deliberately uses
   `display: contents` / `display: none` rather than unmounting, because it hosts a keep-alive
   shell PTY. Focus Mode must reuse the existing `rightCollapsed` mechanism, not a new one.
3. **Legacy `state.json` must load.** `#[serde(default)]` on the new field, with a Rust unit test
   pinning that a project JSON with no `color` deserializes.
4. **No hex in project state**; token names only (design 5.2).
5. **Colour is never the only signal** (design 1.6): every coloured element pairs with a name,
   label, or `aria-label`.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml` (add: colour-token validation, legacy-load).
- `cargo fmt` + `cargo clippy --manifest-path src-tauri/Cargo.toml`.
- `pnpm exec tsc --noEmit` and `pnpm build`.
- **Launch the app** (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`, per CLAUDE.md, so
  the installed app's state is not clobbered). A typecheck does not verify a UI change. Confirm:
  colour assignment persists across restart; all three themes render the palette legibly;
  divider double-click evens; Focus Mode round-trips without revealing a deliberately hidden panel.
- No version bump and no CHANGELOG entry in this branch. Phase 1 is a feature set, so it earns a
  MINOR bump, but that happens **once** at release, not per branch (CLAUDE.md).
