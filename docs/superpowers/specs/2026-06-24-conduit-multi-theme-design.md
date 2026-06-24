# Conduit Multi-Theme System — Design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Author:** brainstormed with Claude

## Summary

Add a user-switchable theme system to Conduit with three themes in one warm
("terracotta") family — **Warm Light**, **Warm Dim**, and **Warm Near-Black**
(today's palette, unchanged as the default) — plus an **Auto** mode that follows
the macOS system appearance. A theme picker lives in the sidebar footer. The
choice persists across launches and is applied before first paint (no flash).

The core engineering work is not "edit `theme.css`": color in Conduit lives in
**four** surfaces, three of them hardcoded TypeScript. This design unifies all
four behind a single TypeScript theme registry.

## Goals

- Three cohesive themes sharing one accent identity (warm terracotta).
- A discoverable, visual switcher (shows swatches, not just names).
- Auto mode that tracks the OS light/dark appearance live.
- Persistence with no flash-of-wrong-theme on startup.
- One source of truth for color across all four surfaces.

## Non-Goals (YAGNI)

- User-defined / custom themes or an in-app color editor.
- Per-project themes (theme is a single global preference).
- Theme transition animations (acceptable to add a trivial fade later; not now).
- Cool/neutral (non-warm) themes (explicitly deferred; chosen "keep it warm").

## Background: the four color surfaces

| Surface | File | Today |
|---|---|---|
| App chrome | `src/theme.css` `:root` + scattered `rgba(...)` literals | CSS variables + hardcoded accent/hover washes |
| Terminal (xterm) | `src/components/Terminal.tsx` `TERM_THEME` | Hardcoded 16-color ANSI + bg/fg/cursor |
| Syntax highlighting | `src/components/FileViewer.tsx` `conduitPrismTheme` | Hardcoded Prism token colors |
| Git graph lanes | `src/components/GitGraph.tsx` lane array | Hardcoded 8-color lane palette |

A real multi-theme system must drive all four. Because three are JS, the cleanest
single-source-of-truth is a JS registry that *also emits* the CSS variables.

## Architecture

### Single registry: `src/themes.ts` (new)

```ts
export type ThemeId = "warm-near-black" | "warm-dim" | "warm-light";
export type ThemePref = ThemeId | "auto";

export interface Theme {
  id: ThemeId;
  label: string;
  appearance: "dark" | "light";   // used by Auto + for native window hints
  cssVars: Record<string, string>; // chrome tokens written to :root
  terminal: ITheme;                // xterm theme object
  prism: Record<string, React.CSSProperties>; // FileViewer token styles
  gitLanes: string[];              // GitGraph lane colors
}

export const THEMES: Record<ThemeId, Theme> = { /* ... */ };
export const DEFAULT_THEME: ThemeId = "warm-near-black";
```

The `Theme` interface enforces completeness at compile time — a theme missing a
token won't typecheck. That is the primary "test" for registry completeness.

### `applyTheme(theme: Theme)` contract

1. **Chrome:** for each `[name, value]` in `theme.cssVars`, call
   `document.documentElement.style.setProperty(name, value)`. Also set
   `document.documentElement.dataset.theme = theme.id` (for any attribute-based
   CSS hooks and for debugging).
2. **Terminal:** iterate every live xterm instance and set
   `term.options.theme = theme.terminal` (xterm applies it without a reload).
3. **Syntax + git:** publish `theme.id` (or the `prism`/`gitLanes` objects)
   through the zustand store so `FileViewer` and `GitGraph` re-render from the
   active theme.

`theme.css` continues to reference `var(--*)` only. No per-theme CSS blocks —
JS is the sole writer of values, so there is no CSS↔JS duplication to drift.

### Terminal registry plumbing

`Terminal.tsx` must register/unregister each live `Terminal` instance (or its
`term` ref) so `applyTheme` can reach them. Options: a module-level `Set<Terminal>`
the component adds to on mount and removes from on unmount, or a zustand-tracked
registry. New terminals read the *current* theme on creation.

### CSS token cleanup (light-mode correctness)

Several rules hardcode colors that break on a light background. Promote them to
per-theme tokens:

| Current literal | Used by | New token |
|---|---|---|
| `rgba(206,138,110,0.08)` | `.todo.in_progress` | `--accent-wash` |
| `rgba(206,138,110,0.14)` | resizer/divider hover | `--accent-wash` |
| `rgba(206,138,110,0.22)` | resizer/divider dragging | `--accent-wash-strong` |
| `rgba(206,138,110,0.05/0.16)` | `.split-dropzone` | `--accent-wash` / `--accent-wash-strong` |
| `rgba(255,255,255,0.02)` | `.session-row:hover` | `--hover` |
| `rgba(255,255,255,0.03)` | `.tree-row:hover` | `--hover` |
| `#20271a` | `.ref-chip.tag` bg | `--tag-chip-bg` (+ `--tag-chip-text`) |

On Light, `--hover` becomes a subtle *dark* tint (`rgba(0,0,0,0.04)`) instead of
a white one.

## Palettes (all four surfaces, all three themes)

### Chrome CSS variables

| Variable | Warm Light | Warm Dim | Warm Near-Black |
|---|---|---|---|
| `--accent` | `#b5613f` | `#d2906f` | `#ce8a6e` |
| `--panel-bg` | `#f6f1e9` | `#211d1a` | `#151110` |
| `--sidebar-bg` | `#efe7da` | `#2a2420` | `#1b1917` |
| `--selection-bg` | `#e4d8c6` | `#383029` | `#272523` |
| `--border` | `#ddd2c2` | `#3b332c` | `#2a2522` |
| `--text-bright` | `#2c2622` | `#ece6df` | `#ece8e4` |
| `--text-mid` | `#6f655a` | `#ab9f95` | `#968d86` |
| `--text-dim` | `#9c9286` | `#75695f` | `#5e574f` |
| `--green` | `#5d7c4d` | `#8fb37f` | `#88b07c` |
| `--red` | `#b04a42` | `#ce8079` | `#c97a72` |
| `--amber` | `#8f6a25` | `#c8a667` | `#c2a063` |
| `--pill-needs-bg` | `#f0dcc8` | `#3a2818` | `#2a1c13` |
| `--pill-needs-text` | `#9a4f2c` | `#e7ab83` | `#e0a580` |
| `--chip-bg` | `#ece0cf` | `#342618` | `#241a13` |
| `--chip-text` | `#8a5a3f` | `#d2a78f` | `#c99b86` |
| `--term-bg` | `#f6f1e9` | `#211d1a` | `#151110` |
| `--term-fg` | `#41382f` | `#d8d2ca` | `#d2ccc4` |
| `--accent-wash` (new) | `rgba(181,97,63,0.10)` | `rgba(210,144,111,0.12)` | `rgba(206,138,110,0.10)` |
| `--accent-wash-strong` (new) | `rgba(181,97,63,0.18)` | `rgba(210,144,111,0.22)` | `rgba(206,138,110,0.20)` |
| `--hover` (new) | `rgba(0,0,0,0.04)` | `rgba(255,255,255,0.03)` | `rgba(255,255,255,0.02)` |
| `--tag-chip-bg` (new) | `#dfe7d2` | `#28321d` | `#20271a` |
| `--tag-chip-text` (new) | `#4f6a3f` | `#8fb37f` | `#88b07c` |

(Fonts, `--titlebar-h`, `--tabstrip-h`, etc. are theme-independent and stay in
`:root`.)

### Terminal (xterm ITheme)

| Key | Warm Light | Warm Dim | Warm Near-Black |
|---|---|---|---|
| background | `#f6f1e9` | `#211d1a` | `#151110` |
| foreground | `#41382f` | `#d8d2ca` | `#d2ccc4` |
| cursor | `#b5613f` | `#d2906f` | `#ce8a6e` |
| cursorAccent | `#f6f1e9` | `#211d1a` | `#151110` |
| selectionBackground | `#e0d2bd` | `#3f372f` | `#33302c` |
| black | `#41382f` | `#2a2420` | `#15161e` |
| red | `#b04a42` | `#ce8079` | `#c97a72` |
| green | `#5d7c4d` | `#8fb37f` | `#88b07c` |
| yellow | `#8f6a25` | `#c8a667` | `#c2a063` |
| blue | `#b5613f` | `#d2906f` | `#ce8a6e` |
| magenta | `#8c5878` | `#c093ad` | `#b98ba6` |
| cyan | `#3f7a72` | `#86ada6` | `#7fa6a0` |
| white | `#6f655a` | `#ab9f95` | `#a9a199` |
| brightBlack | `#9c9286` | `#5b5249` | `#4a4540` |
| brightRed | `#b04a42` | `#ce8079` | `#c97a72` |
| brightGreen | `#5d7c4d` | `#8fb37f` | `#88b07c` |
| brightYellow | `#8f6a25` | `#c8a667` | `#c2a063` |
| brightBlue | `#b5613f` | `#d2906f` | `#ce8a6e` |
| brightMagenta | `#8c5878` | `#c093ad` | `#b98ba6` |
| brightCyan | `#3f7a72` | `#86ada6` | `#7fa6a0` |
| brightWhite | `#2c2622` | `#ece6df` | `#d2ccc4` |

### Syntax (Prism token → color)

Base text = terminal `foreground`. `comment` is italic in all themes.

| Token group | Warm Light | Warm Dim | Warm Near-Black |
|---|---|---|---|
| comment / prolog / doctype / cdata | `#9c9286` | `#75695f` | `#5e574f` |
| punctuation / operator | `#6f655a` | `#ab9f95` | `#968d86` |
| property / function | `#b5613f` | `#d2906f` | `#ce8a6e` |
| tag / deleted / important | `#b04a42` | `#ce8079` | `#c97a72` |
| boolean / number / constant / symbol / attr-name / regex | `#8f6a25` | `#c8a667` | `#c2a063` |
| selector / string / char / inserted / attr-value | `#5d7c4d` | `#8fb37f` | `#88b07c` |
| builtin / entity / url / class-name | `#3f7a72` | `#86ada6` | `#7fa6a0` |
| keyword / atrule | `#8c5878` | `#c093ad` | `#b98ba6` |
| base (`fv-text` / `fv-pre`) | `#41382f` | `#d8d2ca` | `#d2ccc4` |

### Git graph lanes (8 colors, order preserved)

| # | Warm Light | Warm Dim | Warm Near-Black |
|---|---|---|---|
| 1 accent | `#b5613f` | `#d2906f` | `#ce8a6e` |
| 2 green | `#5d7c4d` | `#8fb37f` | `#88b07c` |
| 3 amber | `#8f6a25` | `#c8a667` | `#c2a063` |
| 4 magenta | `#8c5878` | `#c093ad` | `#b98ba6` |
| 5 cyan | `#3f7a72` | `#86ada6` | `#7fa6a0` |
| 6 red | `#b04a42` | `#ce8079` | `#c97a72` |
| 7 violet | `#6a55b0` | `#a796d8` | `#9c8bd0` |
| 8 bright | `#2c2622` | `#d8d2ca` | `#d2ccc4` |

## Switcher UI

- **`src/components/ThemeSwitcher.tsx`** (new): a `◐` palette button placed in
  the sidebar `.add-bar`, opening a popover anchored above it.
- Popover lists the three themes, each as `[3-swatch strip][label][✓ if active]`,
  plus a divider and an **Auto · match macOS** row.
- Reuses the existing `.context-menu` / popover styling idiom and dismiss-on-
  outside-click behavior already present in the sidebar.

### Store additions (`src/store.ts`)

```ts
themePref: ThemePref;            // persisted choice: a ThemeId or "auto"
activeThemeId: ThemeId;          // resolved theme actually applied
setThemePref: (p: ThemePref) => void;  // persists + applyTheme + updates state
```

`setThemePref` writes `localStorage["conduit.theme"]`, resolves Auto → concrete
id via system appearance, calls `applyTheme`, and stores both fields so
`FileViewer`/`GitGraph`/switcher re-render.

## Persistence & boot

- **Key:** `localStorage["conduit.theme"]` holding a `ThemePref`. Chosen over the
  Rust per-project layout store because theme is a single global UI preference;
  `localStorage` is synchronous (usable pre-paint) and survives launches in the
  WKWebView.
- **No-flash boot:** in `src/main.tsx`, *before* `ReactDOM.createRoot().render`,
  read the saved pref (default `warm-near-black`), resolve Auto, and call
  `applyTheme` synchronously so the first paint is already correct.
- **Auto mode:** resolve via Tauri's appearance API
  (`getCurrentWindow().theme()` / `@tauri-apps/api`), and subscribe to
  `tauri://theme-changed` (or the window `onThemeChanged` listener). Mapping:
  system **dark → Warm Near-Black**, system **light → Warm Light**. Only re-apply
  while `themePref === "auto"`.

## Files touched

- **New:** `src/themes.ts`, `src/components/ThemeSwitcher.tsx`
- **Edit:** `src/components/Terminal.tsx` (consume registry + live-update + instance registry),
  `src/components/FileViewer.tsx` (read active `prism` from registry),
  `src/components/GitGraph.tsx` (read active `gitLanes`),
  `src/store.ts` (theme state + actions), `src/main.tsx` (no-flash boot + Auto listener),
  `src/components/Sidebar.tsx` (mount `ThemeSwitcher` in `.add-bar`),
  `src/theme.css` (move color vars to be JS-driven defaults; add `--accent-wash`,
  `--accent-wash-strong`, `--hover`, `--tag-chip-*`; replace hardcoded `rgba(...)`).

## Verification

1. **Type-level completeness:** the `Theme` interface forces every theme to define
   every token; a missing color fails `tsc`.
2. **Manual checks** (the meaningful test surface for a visual feature):
   - Switch Light / Dim / Near-Black from the popover → chrome, an open terminal,
     an open file viewer, and the git graph all recolor live.
   - Quit and relaunch on each theme → restores correctly with **no startup flash**.
   - Set Auto, toggle macOS appearance → app follows (light→Light, dark→Near-Black).
   - On Warm Light, confirm row hovers/selection/dropzone washes are visible and
     subtle (not white-on-white), and syntax/terminal text meets contrast.
3. **Lint/typecheck** pass before completion.

## Open question carried into review

- **Auto's dark target:** mapping system-dark → **Warm Near-Black** (the default).
  If you'd prefer system-dark → **Warm Dim**, it's a one-line change.
