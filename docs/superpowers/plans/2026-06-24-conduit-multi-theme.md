# Conduit Multi-Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three switchable warm themes (Warm Light, Warm Dim, Warm Near-Black) plus an Auto "match macOS" mode, driven by a single TypeScript theme registry, with a sidebar-footer picker and no-flash persistence.

**Architecture:** One registry module (`src/themes.ts`) holds every color for all four color surfaces — app chrome (CSS variables), the xterm terminal palette, the Prism syntax palette, and the git-graph lanes. `applyTheme(id)` writes the chrome tokens onto `document.documentElement` and live-updates every open terminal; React surfaces (FileViewer, GitGraph) re-render off an `activeThemeId` field in the zustand store. `theme.css` only ever references `var(--*)`, so there is no CSS/JS duplication. The preference persists in `localStorage` and is applied before React mounts.

**Tech Stack:** React 19 + TypeScript, zustand, xterm.js, react-syntax-highlighter (Prism), Tauri 2, Vite. No unit-test runner exists — the automated gate is `npx tsc --noEmit` (the `Theme` interface makes a missing color a compile error); behavioral checks are manual in `npm run tauri dev` (Task 9).

**Conventions:** Conventional-commit subjects. End every commit message with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (shown via a second `-m`).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/themes.ts` | Theme registry: types, the 3 themes' full token sets, `applyTheme`, system/storage helpers, terminal registry | **Create** |
| `src/components/ThemeSwitcher.tsx` | Sidebar-footer palette button + theme popover | **Create** |
| `src/store.ts` | `themePref` / `activeThemeId` state + `setThemePref` / `applySystemDark` actions | Modify |
| `src/main.tsx` | Apply theme before first paint; subscribe to system-appearance changes | Modify |
| `src/components/Terminal.tsx` | Read terminal palette from registry; register each live terminal for live updates | Modify |
| `src/components/FileViewer.tsx` | Read Prism palette from the active theme | Modify |
| `src/components/GitGraph.tsx` | Read lane palette from the active theme | Modify |
| `src/theme.css` | Add `--hover` / `--tag-chip-*` defaults; replace hardcoded `rgba(...)` literals with `var()` / `color-mix()` | Modify |
| `src/components/Sidebar.tsx` | Mount `<ThemeSwitcher/>` in the `.add-bar` | Modify |

---

## Task 0: Feature branch

**Files:** none (git only)

- [ ] **Step 1: Branch off main**

The repo has pre-existing uncommitted changes on `main` (hooks.rs, App.tsx, Sidebar.tsx, store.ts, theme.css). Create a branch so theme work is isolated; the pre-existing changes come along on the branch.

Run:
```bash
git checkout -b feat/multi-theme
git status
```
Expected: now on `feat/multi-theme`; same modified files listed.

---

## Task 1: Theme registry (`src/themes.ts`)

**Files:**
- Create: `src/themes.ts`

- [ ] **Step 1: Write the registry**

This is the single source of truth. The `makePrism` builder reproduces today's `conduitPrismTheme` mapping exactly for the Near-Black palette, so the default theme is byte-identical to current behavior.

```ts
import type { Terminal as Xterm, ITheme } from "@xterm/xterm";
import type { CSSProperties } from "react";

export type ThemeId = "warm-near-black" | "warm-dim" | "warm-light";
export type ThemePref = ThemeId | "auto";

export interface Theme {
  id: ThemeId;
  label: string;
  appearance: "dark" | "light";
  /** CSS custom properties written onto :root. Keys include the leading "--". */
  cssVars: Record<string, string>;
  /** xterm.js theme object. */
  terminal: ITheme;
  /** react-syntax-highlighter Prism stylesheet. */
  prism: Record<string, CSSProperties>;
  /** Git-graph lane colors, in order. */
  gitLanes: string[];
}

// ---- Prism builder: palette -> full Prism stylesheet (matches FileViewer's map) ----
interface SynPalette {
  base: string; comment: string; punct: string; prop: string;
  tag: string; num: string; str: string; builtin: string; keyword: string;
}
function makePrism(p: SynPalette): Record<string, CSSProperties> {
  return {
    'code[class*="language-"]': {
      color: p.base, background: "none",
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: "12px", lineHeight: "1.5", whiteSpace: "pre", tabSize: 4,
    },
    'pre[class*="language-"]': { color: p.base, background: "none", margin: 0 },
    comment: { color: p.comment, fontStyle: "italic" },
    prolog: { color: p.comment },
    doctype: { color: p.comment },
    cdata: { color: p.comment },
    punctuation: { color: p.punct },
    property: { color: p.prop },
    tag: { color: p.tag },
    boolean: { color: p.num },
    number: { color: p.num },
    constant: { color: p.num },
    symbol: { color: p.num },
    deleted: { color: p.tag },
    selector: { color: p.str },
    "attr-name": { color: p.num },
    string: { color: p.str },
    char: { color: p.str },
    builtin: { color: p.builtin },
    inserted: { color: p.str },
    operator: { color: p.punct },
    entity: { color: p.builtin },
    url: { color: p.builtin },
    variable: { color: p.base },
    atrule: { color: p.keyword },
    "attr-value": { color: p.str },
    keyword: { color: p.keyword },
    function: { color: p.prop },
    "class-name": { color: p.builtin },
    regex: { color: p.num },
    important: { color: p.tag, fontWeight: "bold" },
  };
}

export const THEMES: Record<ThemeId, Theme> = {
  "warm-near-black": {
    id: "warm-near-black",
    label: "Warm Near-Black",
    appearance: "dark",
    cssVars: {
      "--accent": "#ce8a6e",
      "--sidebar-bg": "#1b1917",
      "--selection-bg": "#272523",
      "--panel-bg": "#151110",
      "--text-bright": "#ece8e4",
      "--text-mid": "#968d86",
      "--text-dim": "#5e574f",
      "--border": "#2a2522",
      "--green": "#88b07c",
      "--red": "#c97a72",
      "--amber": "#c2a063",
      "--pill-needs-bg": "#2a1c13",
      "--pill-needs-text": "#e0a580",
      "--chip-bg": "#241a13",
      "--chip-text": "#c99b86",
      "--term-bg": "#151110",
      "--term-fg": "#d2ccc4",
      "--hover": "rgba(255,255,255,0.03)",
      "--tag-chip-bg": "#20271a",
      "--tag-chip-text": "#88b07c",
    },
    terminal: {
      background: "#151110", foreground: "#d2ccc4", cursor: "#ce8a6e",
      cursorAccent: "#151110", selectionBackground: "#33302c",
      black: "#15161e", red: "#c97a72", green: "#88b07c", yellow: "#c2a063",
      blue: "#ce8a6e", magenta: "#b98ba6", cyan: "#7fa6a0", white: "#a9a199",
      brightBlack: "#4a4540", brightRed: "#c97a72", brightGreen: "#88b07c",
      brightYellow: "#c2a063", brightBlue: "#ce8a6e", brightMagenta: "#b98ba6",
      brightCyan: "#7fa6a0", brightWhite: "#d2ccc4",
    },
    prism: makePrism({
      base: "#d2ccc4", comment: "#5e574f", punct: "#968d86", prop: "#ce8a6e",
      tag: "#c97a72", num: "#c2a063", str: "#88b07c", builtin: "#7fa6a0", keyword: "#b98ba6",
    }),
    gitLanes: ["#ce8a6e", "#88b07c", "#c2a063", "#b98ba6", "#7fa6a0", "#c97a72", "#9c8bd0", "#d2ccc4"],
  },

  "warm-dim": {
    id: "warm-dim",
    label: "Warm Dim",
    appearance: "dark",
    cssVars: {
      "--accent": "#d2906f",
      "--sidebar-bg": "#2a2420",
      "--selection-bg": "#383029",
      "--panel-bg": "#211d1a",
      "--text-bright": "#ece6df",
      "--text-mid": "#ab9f95",
      "--text-dim": "#75695f",
      "--border": "#3b332c",
      "--green": "#8fb37f",
      "--red": "#ce8079",
      "--amber": "#c8a667",
      "--pill-needs-bg": "#3a2818",
      "--pill-needs-text": "#e7ab83",
      "--chip-bg": "#342618",
      "--chip-text": "#d2a78f",
      "--term-bg": "#211d1a",
      "--term-fg": "#d8d2ca",
      "--hover": "rgba(255,255,255,0.03)",
      "--tag-chip-bg": "#28321d",
      "--tag-chip-text": "#8fb37f",
    },
    terminal: {
      background: "#211d1a", foreground: "#d8d2ca", cursor: "#d2906f",
      cursorAccent: "#211d1a", selectionBackground: "#3f372f",
      black: "#2a2420", red: "#ce8079", green: "#8fb37f", yellow: "#c8a667",
      blue: "#d2906f", magenta: "#c093ad", cyan: "#86ada6", white: "#ab9f95",
      brightBlack: "#5b5249", brightRed: "#ce8079", brightGreen: "#8fb37f",
      brightYellow: "#c8a667", brightBlue: "#d2906f", brightMagenta: "#c093ad",
      brightCyan: "#86ada6", brightWhite: "#ece6df",
    },
    prism: makePrism({
      base: "#d8d2ca", comment: "#75695f", punct: "#ab9f95", prop: "#d2906f",
      tag: "#ce8079", num: "#c8a667", str: "#8fb37f", builtin: "#86ada6", keyword: "#c093ad",
    }),
    gitLanes: ["#d2906f", "#8fb37f", "#c8a667", "#c093ad", "#86ada6", "#ce8079", "#a796d8", "#d8d2ca"],
  },

  "warm-light": {
    id: "warm-light",
    label: "Warm Light",
    appearance: "light",
    cssVars: {
      "--accent": "#b5613f",
      "--sidebar-bg": "#efe7da",
      "--selection-bg": "#e4d8c6",
      "--panel-bg": "#f6f1e9",
      "--text-bright": "#2c2622",
      "--text-mid": "#6f655a",
      "--text-dim": "#9c9286",
      "--border": "#ddd2c2",
      "--green": "#5d7c4d",
      "--red": "#b04a42",
      "--amber": "#8f6a25",
      "--pill-needs-bg": "#f0dcc8",
      "--pill-needs-text": "#9a4f2c",
      "--chip-bg": "#ece0cf",
      "--chip-text": "#8a5a3f",
      "--term-bg": "#f6f1e9",
      "--term-fg": "#41382f",
      "--hover": "rgba(0,0,0,0.04)",
      "--tag-chip-bg": "#dfe7d2",
      "--tag-chip-text": "#4f6a3f",
    },
    terminal: {
      background: "#f6f1e9", foreground: "#41382f", cursor: "#b5613f",
      cursorAccent: "#f6f1e9", selectionBackground: "#e0d2bd",
      black: "#41382f", red: "#b04a42", green: "#5d7c4d", yellow: "#8f6a25",
      blue: "#b5613f", magenta: "#8c5878", cyan: "#3f7a72", white: "#6f655a",
      brightBlack: "#9c9286", brightRed: "#b04a42", brightGreen: "#5d7c4d",
      brightYellow: "#8f6a25", brightBlue: "#b5613f", brightMagenta: "#8c5878",
      brightCyan: "#3f7a72", brightWhite: "#2c2622",
    },
    prism: makePrism({
      base: "#41382f", comment: "#9c9286", punct: "#6f655a", prop: "#b5613f",
      tag: "#b04a42", num: "#8f6a25", str: "#5d7c4d", builtin: "#3f7a72", keyword: "#8c5878",
    }),
    gitLanes: ["#b5613f", "#5d7c4d", "#8f6a25", "#8c5878", "#3f7a72", "#b04a42", "#6a55b0", "#2c2622"],
  },
};

export const DEFAULT_THEME_ID: ThemeId = "warm-near-black";
const STORAGE_KEY = "conduit.theme";
const VALID_PREFS: ThemePref[] = ["warm-near-black", "warm-dim", "warm-light", "auto"];

// ---- system appearance (synchronous via matchMedia → enables no-flash boot) ----
export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Calls `cb` whenever the OS light/dark appearance changes. Returns an unsubscribe fn. */
export function watchSystemTheme(cb: (dark: boolean) => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

export function resolveThemeId(pref: ThemePref, systemDark: boolean): ThemeId {
  if (pref === "auto") return systemDark ? "warm-near-black" : "warm-light";
  return pref;
}

// ---- persistence ----
export function readStoredPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as ThemePref | null;
    return v && VALID_PREFS.includes(v) ? v : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function writeStoredPref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

// ---- live terminal registry ----
const liveTerminals = new Set<Xterm>();
let currentId: ThemeId = DEFAULT_THEME_ID;

/** Register a terminal so applyTheme can recolor it live. Returns an unregister fn. */
export function registerTerminal(term: Xterm): () => void {
  liveTerminals.add(term);
  term.options.theme = THEMES[currentId].terminal;
  return () => {
    liveTerminals.delete(term);
  };
}

export function currentTerminalTheme(): ITheme {
  return THEMES[currentId].terminal;
}

// ---- the one mutation that recolors the whole app ----
export function applyTheme(id: ThemeId): void {
  const theme = THEMES[id];
  currentId = id;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.cssVars)) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = id;
  for (const term of liveTerminals) term.options.theme = theme.terminal;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). The exhaustive `Record<ThemeId, Theme>` plus the `Theme` interface guarantee every theme defines every field.

- [ ] **Step 3: Commit**

```bash
git add src/themes.ts
git commit -m "feat(themes): add theme registry with three warm themes" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Store theme state + actions (`src/store.ts`)

**Files:**
- Modify: `src/store.ts` (import block ~line 1-3; `AppState` interface ~line 190-236; store body ~line 262-272 and actions section)

- [ ] **Step 1: Add the themes import**

At the top of `src/store.ts`, directly under the existing `import { homeDir as getHomeDir } ...` line (line 3), add:

```ts
import {
  type ThemeId,
  type ThemePref,
  applyTheme,
  resolveThemeId,
  systemPrefersDark,
  readStoredPref,
  writeStoredPref,
} from "./themes";
```

- [ ] **Step 2: Extend the `AppState` interface**

In the `interface AppState { ... }` block, add these fields after `bottomTab: BottomTab;` (line 200):

```ts
  themePref: ThemePref;
  activeThemeId: ThemeId;
```

And add these action signatures after `setCompacting: (id: string, compacting: boolean) => void;` (line 235), before the closing `}`:

```ts
  setThemePref: (pref: ThemePref) => void;
  applySystemDark: (dark: boolean) => void;
```

- [ ] **Step 3: Seed initial theme state**

In the returned store object, after `bottomTab: "terminal",` (line 271), add:

```ts
    themePref: readStoredPref(),
    activeThemeId: resolveThemeId(readStoredPref(), systemPrefersDark()),
```

- [ ] **Step 4: Implement the actions**

After the `setCompacting: (id, compacting) => ...` action (ends ~line 455), before the final `};` that closes the returned object, add:

```ts
    setThemePref: (pref) => {
      writeStoredPref(pref);
      const id = resolveThemeId(pref, systemPrefersDark());
      applyTheme(id);
      set({ themePref: pref, activeThemeId: id });
    },

    applySystemDark: (dark) => {
      if (get().themePref !== "auto") return;
      const id = resolveThemeId("auto", dark);
      applyTheme(id);
      set({ activeThemeId: id });
    },
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts
git commit -m "feat(themes): track theme preference and active theme in store" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: No-flash boot + system watch (`src/main.tsx`)

**Files:**
- Modify: `src/main.tsx`

- [ ] **Step 1: Apply the saved theme before mount and watch the OS appearance**

Replace the entire contents of `src/main.tsx` with:

```tsx
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useStore } from "./store";
import { applyTheme, resolveThemeId, readStoredPref, systemPrefersDark, watchSystemTheme } from "./themes";
import "@xterm/xterm/css/xterm.css";
import "./theme.css";

// Apply the saved theme BEFORE the first paint so there is no flash of the
// default palette when launching into a non-default theme.
applyTheme(resolveThemeId(readStoredPref(), systemPrefersDark()));

// Keep Auto mode in sync with the macOS light/dark appearance.
watchSystemTheme((dark) => useStore.getState().applySystemDark(dark));

// No StrictMode: its dev-only double-invocation of effects would double-spawn PTYs
// and dispose/recreate xterm instances, fighting the keep-alive design.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main.tsx
git commit -m "feat(themes): apply saved theme before first paint and follow macOS appearance" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Terminal reads the registry (`src/components/Terminal.tsx`)

**Files:**
- Modify: `src/components/Terminal.tsx` (lines 1-30 and the create-once effect ~line 71-147)

- [ ] **Step 1: Replace the hardcoded `TERM_THEME` with a registry import**

Delete the entire `TERM_THEME` constant (lines 7-30, including the comment on line 7). Then change the import line 5 area: directly under `import { invoke, Channel } from "@tauri-apps/api/core";` (line 5), add:

```ts
import { currentTerminalTheme, registerTerminal } from "../themes";
```

- [ ] **Step 2: Use the registry theme when creating the terminal**

In the create-once `useEffect` (line 71), change the xterm constructor's `theme:` line from `theme: TERM_THEME,` to:

```ts
      theme: currentTerminalTheme(),
```

- [ ] **Step 3: Register the terminal for live recolor**

In the same effect, immediately after `termRef.current = term;` (line 119), add:

```ts
    const unregister = registerTerminal(term);
```

Then in that effect's cleanup `return () => { ... }` (line 139), add `unregister();` as the first line inside the cleanup, before `disposedRef.current = true;`:

```ts
    return () => {
      unregister();
      disposedRef.current = true;
      if (resizeTimer.current) window.clearTimeout(resizeTimer.current);
      window.removeEventListener("resize", onWinResize);
      ro.disconnect();
      term.dispose();
    };
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (`TERM_THEME` is gone and no longer referenced.)

- [ ] **Step 5: Commit**

```bash
git add src/components/Terminal.tsx
git commit -m "feat(themes): drive terminal palette from the registry with live recolor" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: FileViewer reads the registry (`src/components/FileViewer.tsx`)

**Files:**
- Modify: `src/components/FileViewer.tsx` (imports line 1-3; constant ~line 14-60; component ~line 107-168; `fvLineNumberStyle` ~line 181-186)

- [ ] **Step 1: Import the registry and store**

Under `import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";` (line 3), add:

```ts
import { useStore } from "../store";
import { THEMES } from "../themes";
```

- [ ] **Step 2: Delete the hardcoded Prism theme**

Remove the comment on line 14, the `const TERM_FG = "#d2ccc4";` line (15), and the entire `const conduitPrismTheme: Record<string, React.CSSProperties> = { ... };` object (lines 16-60). These now live in the registry.

- [ ] **Step 3: Read the active theme's Prism palette inside the component**

At the top of the `FileViewer` component body, immediately after `const [data, setData] = useState<FileContent | null>(null);` (line 116), add:

```ts
  const prismTheme = THEMES[useStore((s) => s.activeThemeId)].prism;
```

Then in BOTH `<SyntaxHighlighter ... />` usages (the `style={conduitPrismTheme}` on lines 149 and 160), change each to:

```tsx
          style={prismTheme}
```

- [ ] **Step 4: Theme the line-number color**

Change `fvLineNumberStyle` (line 181-186) so its `color` uses the theme's dim token instead of a hardcoded hex:

```ts
const fvLineNumberStyle: React.CSSProperties = {
  minWidth: "3.2em",
  paddingRight: "1em",
  color: "var(--text-dim)",
  userSelect: "none",
};
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (No remaining reference to `conduitPrismTheme` or `TERM_FG`.)

- [ ] **Step 6: Commit**

```bash
git add src/components/FileViewer.tsx
git commit -m "feat(themes): drive syntax highlighting from the active theme" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: GitGraph reads the registry (`src/components/GitGraph.tsx`)

**Files:**
- Modify: `src/components/GitGraph.tsx` (imports line 1; lane constants line 11-22; component ~line 169-170)

- [ ] **Step 1: Import the registry and store**

Change line 1 from `import { useMemo } from "react";` to:

```ts
import { useMemo } from "react";
import { useStore } from "../store";
import { THEMES } from "../themes";
```

- [ ] **Step 2: Remove the module-level lane palette**

Delete the comment on line 11, the `const LANE_COLORS = [ ... ];` array (lines 12-21), and the `const laneColor = (i: number) => ...;` line (22). A per-theme `laneColor` is defined inside the component instead.

- [ ] **Step 3: Build `laneColor` from the active theme**

In the `GitGraph` component, the body currently starts at line 169-170:

```tsx
export function GitGraph({ commits }: { commits: GraphCommit[] }) {
  const { rows, lanes } = useMemo(() => buildRows(commits), [commits]);
```

Insert the theme-driven palette as the very first line of the component body, so it reads:

```tsx
export function GitGraph({ commits }: { commits: GraphCommit[] }) {
  const laneColors = THEMES[useStore((s) => s.activeThemeId)].gitLanes;
  const laneColor = (i: number) =>
    laneColors[((i % laneColors.length) + laneColors.length) % laneColors.length];
  const { rows, lanes } = useMemo(() => buildRows(commits), [commits]);
```

The existing `laneColor(seg.color)` and `laneColor(row.color)` calls in the JSX (lines 192, 205) now resolve to the component-local function. No other changes.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/GitGraph.tsx
git commit -m "feat(themes): drive git-graph lane colors from the active theme" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: CSS tokens for light-mode correctness (`src/theme.css`)

**Files:**
- Modify: `src/theme.css` (`:root` ~line 18-24; scattered `rgba(...)` literals)

Today several rules hardcode accent washes (`rgba(206,138,110,α)`) and white hover tints (`rgba(255,255,255,α)`), both of which are wrong on a light background. The accent washes become `color-mix(in srgb, var(--accent) N%, transparent)` — preserving each rule's exact percentage while theming automatically (the modern WKWebView on this macOS supports `color-mix`). The white tints and the tag chip become tokens.

- [ ] **Step 1: Add the new default tokens to `:root`**

In the `:root { ... }` block, after the `--chip-text: #c99b86;` line (line 21), add:

```css
  --hover: rgba(255, 255, 255, 0.03);
  --tag-chip-bg: #20271a;
  --tag-chip-text: #88b07c;
```

(These are the Near-Black defaults; `applyTheme` overrides them at runtime.)

- [ ] **Step 2: Replace the accent-wash literals**

Make these exact replacements (each is a `background:` value):

- `.group-chrome.drop-target` (line 142): `background: rgba(206, 138, 110, 0.1);` → `background: color-mix(in srgb, var(--accent) 10%, transparent);`
- `.split-dropzone` (line 160): `background: rgba(206, 138, 110, 0.05);` → `background: color-mix(in srgb, var(--accent) 5%, transparent);`
- `.split-dropzone.active` (line 165): `background: rgba(206, 138, 110, 0.16);` → `background: color-mix(in srgb, var(--accent) 16%, transparent);`
- `.resizer:hover` (line 189): `background: rgba(206, 138, 110, 0.14);` → `background: color-mix(in srgb, var(--accent) 14%, transparent);`
- `.resizer.dragging` (line 194): `background: rgba(206, 138, 110, 0.22);` → `background: color-mix(in srgb, var(--accent) 22%, transparent);`
- `.sidebar-resizer:hover` (line 211): `background: rgba(206, 138, 110, 0.14);` → `background: color-mix(in srgb, var(--accent) 14%, transparent);`
- `.sidebar-resizer.dragging` (line 215): `background: rgba(206, 138, 110, 0.22);` → `background: color-mix(in srgb, var(--accent) 22%, transparent);`
- `.todo.in_progress` (line 671): `background: rgba(206, 138, 110, 0.08);` → `background: color-mix(in srgb, var(--accent) 8%, transparent);`
- `.v-resizer:hover` (line 1168): `background: rgba(206, 138, 110, 0.14);` → `background: color-mix(in srgb, var(--accent) 14%, transparent);`
- `.v-resizer.dragging` (line 1172): `background: rgba(206, 138, 110, 0.22);` → `background: color-mix(in srgb, var(--accent) 22%, transparent);`

- [ ] **Step 3: Replace the white hover tints with `--hover`**

- `.session-row:hover` (line 296): `background: rgba(255, 255, 255, 0.02);` → `background: var(--hover);`
- `.tree-row:hover` (line 1088): `background: rgba(255, 255, 255, 0.03);` → `background: var(--hover);`

- [ ] **Step 4: Token the tag chip**

`.ref-chip.tag` (lines 822-825) currently:

```css
.ref-chip.tag {
  background: #20271a;
  color: var(--green);
}
```

Change to:

```css
.ref-chip.tag {
  background: var(--tag-chip-bg);
  color: var(--tag-chip-text);
}
```

- [ ] **Step 5: Build to verify the stylesheet compiles**

Run: `npm run build`
Expected: `tsc` passes and `vite build` completes with no CSS errors. (CSS isn't type-checked, so the build is the gate here; visual confirmation comes in Task 9.)

- [ ] **Step 6: Commit**

```bash
git add src/theme.css
git commit -m "feat(themes): tokenize accent washes and hover tints for light mode" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Theme switcher UI (`src/components/ThemeSwitcher.tsx` + Sidebar mount)

**Files:**
- Create: `src/components/ThemeSwitcher.tsx`
- Modify: `src/components/Sidebar.tsx` (`.add-bar` block ~line 44-49)

- [ ] **Step 1: Create the switcher component**

```tsx
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { THEMES, type ThemeId, type ThemePref } from "../themes";

const ORDER: ThemeId[] = ["warm-light", "warm-dim", "warm-near-black"];

/** Small swatch trio: panel bg / sidebar bg / accent. */
function Swatches({ id }: { id: ThemeId }) {
  const v = THEMES[id].cssVars;
  return (
    <span className="theme-swatches">
      <span style={{ background: v["--panel-bg"] }} />
      <span style={{ background: v["--sidebar-bg"] }} />
      <span style={{ background: v["--accent"] }} />
    </span>
  );
}

export function ThemeSwitcher() {
  const themePref = useStore((s) => s.themePref);
  const activeThemeId = useStore((s) => s.activeThemeId);
  const setThemePref = useStore((s) => s.setThemePref);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (pref: ThemePref) => {
    setThemePref(pref);
    setOpen(false);
  };

  return (
    <div className="theme-switcher" ref={wrapRef}>
      {open && (
        <div className="theme-popover" onClick={(e) => e.stopPropagation()}>
          <div className="theme-popover-title">Theme</div>
          {ORDER.map((id) => (
            <button key={id} className="theme-row" onClick={() => pick(id)}>
              <Swatches id={id} />
              <span className="theme-row-label">{THEMES[id].label}</span>
              {themePref === id && <span className="theme-check">✓</span>}
            </button>
          ))}
          <div className="theme-popover-divider" />
          <button className="theme-row" onClick={() => pick("auto")}>
            <Swatches id={activeThemeId} />
            <span className="theme-row-label">Auto · match macOS</span>
            {themePref === "auto" && <span className="theme-check">✓</span>}
          </button>
        </div>
      )}
      <button
        className="theme-btn"
        title="Theme"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        ◐
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Mount the switcher in the sidebar footer**

In `src/components/Sidebar.tsx`, add the import under the existing `./Icons` import block (after line 20):

```ts
import { ThemeSwitcher } from "./ThemeSwitcher";
```

Then change the `.add-bar` block (lines 44-49) from:

```tsx
      <div className="add-bar">
        <button onClick={pickProject}>
          <FolderPlusIcon size={12} />
          <span>Add Project</span>
        </button>
      </div>
```

to:

```tsx
      <div className="add-bar">
        <button onClick={pickProject}>
          <FolderPlusIcon size={12} />
          <span>Add Project</span>
        </button>
        <ThemeSwitcher />
      </div>
```

- [ ] **Step 3: Style the switcher**

Append to the end of `src/theme.css`:

```css
/* ---- Theme switcher (sidebar footer) ---- */
.add-bar {
  display: flex;
  align-items: stretch;
}
.add-bar > button:first-child {
  flex: 1;
}
.theme-switcher {
  position: relative;
  display: flex;
}
.theme-btn {
  width: 36px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  color: var(--accent);
  font-size: 13px;
}
.theme-btn:hover {
  background: var(--hover);
}
.theme-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 6px;
  min-width: 196px;
  background: var(--sidebar-bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 5px;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
  z-index: 1000;
}
.theme-popover-title {
  font-size: 9px;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  padding: 4px 8px 5px;
}
.theme-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-bright);
}
.theme-row:hover {
  background: var(--selection-bg);
}
.theme-row-label {
  flex: 1;
}
.theme-check {
  color: var(--accent);
  font-size: 11px;
}
.theme-popover-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
}
.theme-swatches {
  display: flex;
  width: 30px;
  height: 14px;
  border-radius: 3px;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px var(--border);
}
.theme-swatches > span {
  flex: 1;
}
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: `tsc` passes and `vite build` completes cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/components/ThemeSwitcher.tsx src/components/Sidebar.tsx src/theme.css
git commit -m "feat(themes): add sidebar theme switcher popover" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: End-to-end manual verification

**Files:** none (runtime verification; only commit if a fix is needed)

This is the behavioral test surface for a visual feature. There is no headless way to assert rendered colors here, so verify in the running app.

- [ ] **Step 1: Launch the app**

Run: `npm run tauri dev`
Expected: app builds and opens (first run compiles Rust — may take a minute).

- [ ] **Step 2: Verify switching recolors every surface**

Open a project with at least one session, a file open in the viewer, and the git panel visible. Click the ◐ button in the sidebar footer and pick each theme in turn. For **Warm Light**, **Warm Dim**, and **Warm Near-Black**, confirm ALL of these recolor together:
- [ ] Sidebar / panels / borders / text (chrome)
- [ ] The live terminal (background, text, ANSI colors)
- [ ] The open file's syntax highlighting and line numbers
- [ ] The git graph lanes and ref chips
- [ ] Active checkmark moves to the selected theme

- [ ] **Step 3: Verify light-mode washes**

On **Warm Light**, confirm the previously-white hover/wash rules read correctly (not invisible, not white-on-white):
- [ ] Hover a session row and a file-tree row → subtle dark tint
- [ ] Hover/drag a panel resizer → subtle terracotta tint
- [ ] The in-progress to-do row has a faint accent wash

- [ ] **Step 4: Verify no-flash persistence**

- [ ] Select **Warm Light**, fully quit the app, relaunch → opens directly in Warm Light with **no flash** of the dark theme at startup.

- [ ] **Step 5: Verify Auto mode**

- [ ] Select **Auto · match macOS**. With the app open, toggle the macOS system appearance (System Settings → Appearance, or a global hotkey). The app follows live: light → Warm Light, dark → Warm Near-Black.

- [ ] **Step 6: Typecheck + build clean**

Run: `npx tsc --noEmit && npm run build`
Expected: both PASS.

- [ ] **Step 7: Commit any fixes**

If Steps 2-5 surfaced adjustments, commit them:

```bash
git add -A
git commit -m "fix(themes): address verification findings" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If nothing needed fixing, there is nothing to commit — the feature is complete.

---

## Self-review notes

- **Spec coverage:** three themes (Task 1) · single registry / one `applyTheme` (Task 1) · all four color surfaces themed (Tasks 1,4,5,6,7) · switcher in sidebar footer (Task 8) · Auto mode (Tasks 1,2,3) · localStorage persistence + no-flash boot (Tasks 2,3) · light-mode wash/hover fixes (Task 7). All spec sections map to a task.
- **Spec deviation (intentional):** system appearance is read via `matchMedia("(prefers-color-scheme: dark)")` instead of the Tauri appearance API. It is synchronous (required for no-flash boot) and emits change events for Auto — simpler and fully covers the requirement. Auto's dark target is **Warm Near-Black** per the spec's resolved default; change the single line in `resolveThemeId` to `"warm-dim"` if desired.
- **Type consistency:** `ThemeId`, `ThemePref`, `applyTheme`, `resolveThemeId`, `systemPrefersDark`, `readStoredPref`, `writeStoredPref`, `registerTerminal`, `currentTerminalTheme`, `THEMES`, `activeThemeId`, `themePref`, `setThemePref`, `applySystemDark` are defined once (Tasks 1-2) and used with identical names/signatures everywhere after.
- **No test runner:** gates are `npx tsc --noEmit` (TS tasks), `npm run build` (CSS tasks), and the Task 9 manual checklist — deliberately not a new test framework (YAGNI).
