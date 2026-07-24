# Prettier Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Format Document" work everywhere and visibly — add a lazy bundled prettier fallback, format-on-save, a toolbar Format button, a global Formatting settings page, and an in-app toast so failures stop being silent.

**Architecture:** Preferred path is unchanged (Rust `format.rs` shells out to the project's own prettier/rustfmt/gofmt, ~0 renderer RAM). When Rust reports "prettier not found", the renderer lazily `import()`s `prettier/standalone` + parsers and formats there, using options resolved most-specific-wins: project `.prettierrc` (read by a new Rust command) → Conduit global config (new settings page) → prettier defaults. All Format outcomes route to a new minimal in-app toast.

**Tech Stack:** React 19 + TypeScript (Vite, pnpm), Zustand store (`src/store.ts`), Monaco editor, Rust/Tauri backend (`src-tauri/src/`), vitest (node env, `src/**/*.test.ts`), cargo test.

**Spec:** `docs/superpowers/specs/2026-07-21-prettier-format-design.md`

---

## File map

- Create `src/format/options.ts` — pure: `PrettierOptions`, `DEFAULT_FORMAT_CONFIG`, `parserSpecFor`, `mergeFormatOptions`, `hasFormatter`. No monaco/Tauri imports (vitest-node testable, mirrors `src/trim.ts`).
- Create `src/format/options.test.ts` — vitest unit tests for the pure functions.
- Create `src/format/fallback.ts` — `formatWithFallback` (dynamic-imports `prettier/standalone` + plugins).
- Create `src/components/Toasts.tsx` — the in-app toast stack.
- Create `src/components/FormatPrefsPanel.tsx` — Settings → Formatting page.
- Modify `src-tauri/src/format.rs` — add `PrettierConfig`, `parse_config_str`, `extract_package_prettier`, `resolve_prettier_config` + tests.
- Modify `src-tauri/src/lib.rs` — add + register `resolve_prettier_options` command.
- Modify `src/store.ts` — toast slice, `formatConfig`/`formatOnSave` state, shared `formatBuffer`, rewritten `formatActiveDocument`, `saveFile` format-on-save hook.
- Modify `src/App.tsx` — mount `<Toasts/>`.
- Modify `src/components/Settings.tsx` — register the Formatting tab.
- Modify `src/components/CodeEditorPane.tsx` — toolbar Format button.
- Modify `src/theme.css` — toast styles.
- Modify `package.json` — add `prettier`.
- Modify `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `CHANGELOG.md` — version bump.

---

## Task 1: Add the prettier dependency

**Files:**
- Modify: `package.json` (dependencies block, currently lines 30–43)

- [ ] **Step 1: Add prettier to dependencies**

In `package.json`, add to the `"dependencies"` object (keep alphabetical — after `"react-dom"` is fine; exact position not significant):

```json
    "prettier": "^3.4.2",
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: adds `prettier` to `pnpm-lock.yaml`, no errors.

- [ ] **Step 3: Verify the standalone entry resolves**

Run: `node -e "require('prettier/standalone'); require('prettier/plugins/typescript'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat(format): add prettier dependency for bundled fallback"
```

---

## Task 2: Rust prettier-config resolver (TDD)

**Files:**
- Modify: `src-tauri/src/format.rs` (add struct + parse fns + resolver + tests)
- Modify: `src-tauri/src/lib.rs` (command + registration)

- [ ] **Step 1: Write failing tests**

Append inside the existing `#[cfg(test)] mod tests { ... }` block in `src-tauri/src/format.rs` (it currently ends at the closing brace after `formatter_selection_by_extension`):

```rust
    #[test]
    fn parse_json_prettierrc() {
        let c = parse_config_str(r#"{ "printWidth": 100, "singleQuote": true }"#).unwrap();
        assert_eq!(c.print_width, Some(100));
        assert_eq!(c.single_quote, Some(true));
        assert_eq!(c.tab_width, None);
    }

    #[test]
    fn parse_yaml_prettierrc() {
        let c = parse_config_str("printWidth: 120\nuseTabs: true\n").unwrap();
        assert_eq!(c.print_width, Some(120));
        assert_eq!(c.use_tabs, Some(true));
    }

    #[test]
    fn parse_garbage_is_none() {
        assert!(parse_config_str("this: : : not valid {").is_none());
    }

    #[test]
    fn package_json_prettier_object() {
        let c = extract_package_prettier(r#"{ "name": "x", "prettier": { "semi": false } }"#).unwrap();
        assert_eq!(c.semi, Some(false));
    }

    #[test]
    fn package_json_prettier_string_ref_is_none() {
        // A string value points to an external config file — v1 skips it.
        assert!(extract_package_prettier(r#"{ "prettier": "./my-config.json" }"#).is_none());
    }

    #[test]
    fn package_json_without_prettier_is_none() {
        assert!(extract_package_prettier(r#"{ "name": "x" }"#).is_none());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml format::`
Expected: FAIL — `parse_config_str` / `extract_package_prettier` / `PrettierConfig` not found.

- [ ] **Step 3: Implement the struct + parse functions**

In `src-tauri/src/format.rs`, add `Deserialize` to the imports and add the new items. Change the top `use serde::Serialize;` line to:

```rust
use serde::{Deserialize, Serialize};
```

Then add, after the `FormatResult` struct (around line 18):

```rust
/// A subset of prettier's config, all optional — the eight options Conduit's bundled
/// fallback honors. camelCase matches both prettier's own keys and the frontend option
/// names, so it round-trips to the renderer with no remapping.
#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrettierConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub print_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_tabs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semi: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub single_quote: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trailing_comma: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bracket_spacing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_of_line: Option<String>,
}

/// Parse a `.prettierrc`/`.prettierrc.json`/`.prettierrc.yaml` body. `.prettierrc` may be
/// either JSON or YAML, so try JSON first, then YAML. Unknown keys are ignored by serde.
/// Returns None on parse failure (caller falls through to global config).
fn parse_config_str(s: &str) -> Option<PrettierConfig> {
    if let Ok(c) = serde_json::from_str::<PrettierConfig>(s) {
        return Some(c);
    }
    serde_yaml::from_str::<PrettierConfig>(s).ok()
}

/// Pull a `"prettier"` object out of a package.json body. A string value points to an
/// external config file — v1 skips that (returns None). No `"prettier"` key → None.
fn extract_package_prettier(s: &str) -> Option<PrettierConfig> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let p = v.get("prettier")?;
    if p.is_object() {
        serde_json::from_value::<PrettierConfig>(p.clone()).ok()
    } else {
        None
    }
}

const PRETTIER_CONFIG_NAMES: &[&str] = &[
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierrc.yml",
];

/// Walk up from the file looking for the nearest static prettier config (prettier's own
/// upward search). First hit wins. `.prettierrc.js`/`prettier.config.js` are ignored —
/// they can't be read without executing them. Returns None when nothing is found.
pub fn resolve_prettier_config(path: &Path) -> Option<PrettierConfig> {
    let mut dir = path.parent()?;
    loop {
        for name in PRETTIER_CONFIG_NAMES {
            let f = dir.join(name);
            if f.is_file() {
                if let Ok(body) = std::fs::read_to_string(&f) {
                    if let Some(c) = parse_config_str(&body) {
                        return Some(c);
                    }
                }
            }
        }
        let pkg = dir.join("package.json");
        if pkg.is_file() {
            if let Ok(body) = std::fs::read_to_string(&pkg) {
                if let Some(c) = extract_package_prettier(&body) {
                    return Some(c);
                }
            }
        }
        dir = dir.parent()?;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml format::`
Expected: PASS (all `format::tests::*`).

- [ ] **Step 5: Add and register the command**

In `src-tauri/src/lib.rs`, near the other format binding (`format_content` is defined around line 1065 and registered around line 1584), add the command wrapper next to it:

```rust
#[tauri::command]
fn resolve_prettier_options(path: String) -> Option<format::PrettierConfig> {
    format::resolve_prettier_config(std::path::Path::new(&path))
}
```

And add `resolve_prettier_options` to the `tauri::generate_handler![ ... ]` list (the same list that contains `format_content`, around line 1584).

- [ ] **Step 6: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/format.rs src-tauri/src/lib.rs
git commit -m "feat(format): resolve nearest project prettier config (Rust command)"
```

---

## Task 3: Pure frontend format-options module (TDD)

**Files:**
- Create: `src/format/options.ts`
- Test: `src/format/options.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/format/options.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parserSpecFor,
  mergeFormatOptions,
  hasFormatter,
  DEFAULT_FORMAT_CONFIG,
} from "./options";

describe("parserSpecFor", () => {
  it("maps ts/tsx to typescript + estree", () => {
    expect(parserSpecFor("/p/a.tsx")).toEqual({ parser: "typescript", plugins: ["typescript", "estree"] });
    expect(parserSpecFor("/p/a.ts")?.parser).toBe("typescript");
  });
  it("maps js family to babel", () => {
    expect(parserSpecFor("/p/a.mjs")).toEqual({ parser: "babel", plugins: ["babel", "estree"] });
  });
  it("maps css/scss/less to postcss with matching parser", () => {
    expect(parserSpecFor("/p/a.scss")).toEqual({ parser: "scss", plugins: ["postcss"] });
  });
  it("returns null for unsupported extensions", () => {
    expect(parserSpecFor("/p/a.rs")).toBeNull();
    expect(parserSpecFor("/p/Makefile")).toBeNull();
  });
});

describe("mergeFormatOptions", () => {
  it("project overrides global; unset project fields fall to global", () => {
    const merged = mergeFormatOptions({ printWidth: 120 }, DEFAULT_FORMAT_CONFIG);
    expect(merged.printWidth).toBe(120);
    expect(merged.tabWidth).toBe(DEFAULT_FORMAT_CONFIG.tabWidth);
  });
  it("null project config yields global", () => {
    expect(mergeFormatOptions(null, DEFAULT_FORMAT_CONFIG)).toEqual(DEFAULT_FORMAT_CONFIG);
  });
});

describe("hasFormatter", () => {
  it("true for prettier + rust + go files, false otherwise", () => {
    expect(hasFormatter("/p/a.ts")).toBe(true);
    expect(hasFormatter("/p/a.rs")).toBe(true);
    expect(hasFormatter("/p/a.go")).toBe(true);
    expect(hasFormatter("/p/a.txt")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/format/options.test.ts`
Expected: FAIL — module `./options` not found.

- [ ] **Step 3: Implement the module**

Create `src/format/options.ts`:

```ts
// src/format/options.ts — pure formatting-option logic. NO monaco / Tauri / prettier
// imports so vitest exercises it in a node env (mirrors src/trim.ts). The store maps
// these onto invoke() calls and undo-preserving model edits.

/** The eight prettier options Conduit's bundled fallback and global config expose.
 *  Keys are prettier's own camelCase names, so they pass straight into standalone. */
export interface PrettierOptions {
  printWidth: number;
  tabWidth: number;
  useTabs: boolean;
  semi: boolean;
  singleQuote: boolean;
  trailingComma: "none" | "es5" | "all";
  bracketSpacing: boolean;
  endOfLine: "lf" | "crlf" | "cr" | "auto";
}

/** Conduit's out-of-the-box global config (= prettier 3 defaults). */
export const DEFAULT_FORMAT_CONFIG: PrettierOptions = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  endOfLine: "lf",
};

export interface ParserSpec {
  /** prettier parser id */
  parser: string;
  /** plugin loader keys (see src/format/fallback.ts PLUGIN_LOADERS) */
  plugins: string[];
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Map a path to the prettier parser + plugin set the bundled fallback needs. Mirrors
 *  format.rs PRETTIER_EXTS. Returns null for anything prettier's standalone can't handle. */
export function parserSpecFor(path: string): ParserSpec | null {
  switch (extOf(path)) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { parser: "babel", plugins: ["babel", "estree"] };
    case "ts":
    case "tsx":
      return { parser: "typescript", plugins: ["typescript", "estree"] };
    case "json":
    case "jsonc":
      return { parser: "json", plugins: ["babel", "estree"] };
    case "css":
      return { parser: "css", plugins: ["postcss"] };
    case "scss":
      return { parser: "scss", plugins: ["postcss"] };
    case "less":
      return { parser: "less", plugins: ["postcss"] };
    case "html":
      return { parser: "html", plugins: ["html"] };
    case "vue":
      return { parser: "vue", plugins: ["html"] };
    case "md":
    case "markdown":
      return { parser: "markdown", plugins: ["markdown"] };
    case "yaml":
    case "yml":
      return { parser: "yaml", plugins: ["yaml"] };
    default:
      return null;
  }
}

/** True when SOME formatter applies (prettier fallback OR shell-out rustfmt/gofmt).
 *  Mirrors format.rs formatter_for — gates the toolbar button and format-on-save. */
export function hasFormatter(path: string): boolean {
  if (parserSpecFor(path)) return true;
  const e = extOf(path);
  return e === "rs" || e === "go";
}

/** Precedence merge: project config (from .prettierrc) overrides the global config;
 *  fields the project omits fall back to global. Global always has all eight fields. */
export function mergeFormatOptions(
  project: Partial<PrettierOptions> | null,
  global: PrettierOptions,
): PrettierOptions {
  return { ...global, ...(project ?? {}) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/format/options.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format/options.ts src/format/options.test.ts
git commit -m "feat(format): pure parser-spec + option-merge module with tests"
```

---

## Task 4: Lazy bundled fallback formatter

**Files:**
- Create: `src/format/fallback.ts`

- [ ] **Step 1: Implement the fallback formatter**

Create `src/format/fallback.ts`:

```ts
// src/format/fallback.ts — the last-resort renderer formatter. Everything here is loaded
// via dynamic import() so prettier + its parsers stay OUT of the initial bundle; the cost
// (a few MB of JS heap, mostly the TypeScript parser) is paid only the first time a
// config-less project is formatted, then module-cached.

import { parserSpecFor, type PrettierOptions } from "./options";

const PLUGIN_LOADERS: Record<string, () => Promise<unknown>> = {
  babel: () => import("prettier/plugins/babel"),
  estree: () => import("prettier/plugins/estree"),
  typescript: () => import("prettier/plugins/typescript"),
  postcss: () => import("prettier/plugins/postcss"),
  html: () => import("prettier/plugins/html"),
  markdown: () => import("prettier/plugins/markdown"),
  yaml: () => import("prettier/plugins/yaml"),
};

/** Format `content` with bundled prettier-standalone. Throws when the file type has no
 *  bundled parser (caller surfaces the message as a toast). */
export async function formatWithFallback(
  path: string,
  content: string,
  options: PrettierOptions,
): Promise<string> {
  const spec = parserSpecFor(path);
  if (!spec) throw new Error("no bundled formatter for this file type");
  const prettier = await import("prettier/standalone");
  const plugins = await Promise.all(spec.plugins.map((k) => PLUGIN_LOADERS[k]()));
  return prettier.format(content, {
    parser: spec.parser,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: plugins as any,
    ...options,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors from `src/format/fallback.ts` (prettier ships its own types).

- [ ] **Step 3: Commit**

```bash
git add src/format/fallback.ts
git commit -m "feat(format): lazy prettier-standalone fallback formatter"
```

---

## Task 5: In-app toast system

**Files:**
- Modify: `src/store.ts` (Toast type, state, actions, init)
- Create: `src/components/Toasts.tsx`
- Modify: `src/App.tsx` (mount)
- Modify: `src/theme.css` (styles)

- [ ] **Step 1: Add the toast slice to the store interface**

In `src/store.ts`, near the editor-UX state on the store interface (after `formatActiveDocument` at ~line 897, or any coherent spot in the interface), add:

```ts
  /** Transient in-app messages (bottom-center). The FIRST-CLASS editor feedback channel;
   *  notify_user (OS banner) stays for background events only. */
  toasts: Toast[];
  pushToast: (body: string, kind?: ToastKind) => void;
  dismissToast: (id: string) => void;
```

And add the exported types near the top of `src/store.ts` (with the other exported types):

```ts
export type ToastKind = "info" | "error";
export interface Toast {
  id: string;
  body: string;
  kind: ToastKind;
}
```

- [ ] **Step 2: Add init + actions**

In the store initializer object, add to the initial state (next to `hotExit: {}` ~line 1076):

```ts
    toasts: [],
```

And add the actions (next to `clearPendingDiff` ~line 1912, before `formatActiveDocument`):

```ts
    pushToast: (body, kind = "info") =>
      set((s) => ({
        toasts: [
          ...s.toasts,
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, body, kind },
        ].slice(-4), // cap the stack
      })),
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
```

- [ ] **Step 3: Create the component**

Create `src/components/Toasts.tsx`:

```tsx
import { useEffect } from "react";
import { useStore, type ToastKind } from "../store";

function ToastItem({
  id,
  body,
  kind,
  onDone,
}: {
  id: string;
  body: string;
  kind: ToastKind;
  onDone: (id: string) => void;
}) {
  useEffect(() => {
    const h = setTimeout(() => onDone(id), 4000);
    return () => clearTimeout(h);
  }, [id, onDone]);
  return (
    <div className={`toast ${kind}`} onClick={() => onDone(id)} role="button" title="Dismiss">
      {body}
    </div>
  );
}

/** Mounted once at the app root. Renders the transient toast stack bottom-center. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} body={t.body} kind={t.kind} onDone={dismiss} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Mount it in App**

In `src/App.tsx`, add the import near the other component imports at the top:

```ts
import { Toasts } from "./components/Toasts";
```

And render it next to `<UpdateNotice />` (line 544):

```tsx
      <UpdateNotice />
      <Toasts />
```

- [ ] **Step 5: Add styles**

In `src/theme.css`, append:

```css
/* In-app toasts (editor feedback: Format, etc.) */
.toasts {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1000;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  max-width: 480px;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text, #e6e6e6);
  background: var(--surface-raised, #2a2a2a);
  border: 1px solid var(--border, #3a3a3a);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  cursor: pointer;
}
.toast.error {
  border-color: var(--danger, #c0392b);
}
```

(If any of the `var(--…)` tokens above are not defined in `theme.css`, replace them with the nearest existing token — grep `theme.css` for `--surface`, `--border`, `--danger`, `--text` and use the real names.)

- [ ] **Step 6: Verify build**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/store.ts src/components/Toasts.tsx src/App.tsx src/theme.css
git commit -m "feat(ui): minimal in-app toast system"
```

---

## Task 6: Global format config + formatOnSave state

**Files:**
- Modify: `src/store.ts` (persistence helpers, interface, init, actions)

- [ ] **Step 1: Add persistence helpers**

In `src/store.ts`, near the other pref keys (after `writeTrimOnSave`, ~line 490), add. First add the import for the config type at the top (with other `./format` imports if any, else new):

```ts
import { DEFAULT_FORMAT_CONFIG, type PrettierOptions } from "./format/options";
```

Then the helpers:

```ts
const FORMAT_CONFIG_KEY = "conduit.formatConfig";
const FORMAT_ON_SAVE_KEY = "conduit.formatOnSave";
function readFormatConfig(): PrettierOptions {
  try {
    const raw = localStorage.getItem(FORMAT_CONFIG_KEY);
    if (raw) return { ...DEFAULT_FORMAT_CONFIG, ...JSON.parse(raw) };
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_FORMAT_CONFIG };
}
function writeFormatConfig(v: PrettierOptions): void {
  try {
    localStorage.setItem(FORMAT_CONFIG_KEY, JSON.stringify(v));
  } catch {
    /* quota — non-fatal */
  }
}
function readFormatOnSave(): boolean {
  try {
    return localStorage.getItem(FORMAT_ON_SAVE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeFormatOnSave(v: boolean): void {
  try {
    localStorage.setItem(FORMAT_ON_SAVE_KEY, v ? "1" : "0");
  } catch {
    /* quota — non-fatal */
  }
}
```

- [ ] **Step 2: Add to the store interface**

Near `trimOnSave`/`toggleTrimOnSave` (~line 875) add:

```ts
  /** Global prettier config for the bundled fallback (Settings → Formatting). A project's
   *  own .prettierrc overrides these; see format/options.ts mergeFormatOptions. */
  formatConfig: PrettierOptions;
  setFormatConfig: (patch: Partial<PrettierOptions>) => void;
  /** Opt-in: run the document formatter on every save (off by default). */
  formatOnSave: boolean;
  toggleFormatOnSave: () => void;
```

- [ ] **Step 3: Add to init + actions**

Init (next to `trimOnSave: readTrimOnSave()`, ~line 1071):

```ts
    formatConfig: readFormatConfig(),
    formatOnSave: readFormatOnSave(),
```

Actions (next to `toggleTrimOnSave`, ~line 1883):

```ts
    setFormatConfig: (patch) =>
      set((s) => {
        const next = { ...s.formatConfig, ...patch };
        writeFormatConfig(next);
        return { formatConfig: next };
      }),
    toggleFormatOnSave: () =>
      set((s) => {
        const next = !s.formatOnSave;
        writeFormatOnSave(next);
        return { formatOnSave: next };
      }),
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts
git commit -m "feat(format): global format config + formatOnSave prefs (persisted)"
```

---

## Task 7: Shared formatBuffer helper + rewire formatActiveDocument

**Files:**
- Modify: `src/store.ts` (add module-level `formatBuffer`; rewrite `formatActiveDocument` at 1914–1952)

- [ ] **Step 1: Add imports**

At the top of `src/store.ts`, extend the `./format/options` import and add the fallback import:

```ts
import { DEFAULT_FORMAT_CONFIG, mergeFormatOptions, hasFormatter, type PrettierOptions } from "./format/options";
import { formatWithFallback } from "./format/fallback";
```

(Merge with the import added in Task 6 — do not duplicate `DEFAULT_FORMAT_CONFIG`.)

- [ ] **Step 2: Add the shared helper (module-level, above the `create(...)` call)**

Place near the other module-level helpers in `src/store.ts` (e.g. next to `applyWhitespaceCleanup`):

```ts
type FormatOutcome =
  | { kind: "applied"; note: string }
  | { kind: "unchanged" }
  | { kind: "buffer-changed" }
  | { kind: "error"; message: string };

/** Format one editable model in place (undo-preserving). Prefers the project's own
 *  formatter via the Rust shell-out; only when Rust reports "prettier not found" does it
 *  fall back to bundled prettier-standalone with project-.prettierrc-over-global options.
 *  Assumes the model is present and NOT read-only (callers guard that). Never writes disk. */
async function formatBuffer(
  path: string,
  dir: string,
  model: Monaco.editor.ITextModel,
  globalCfg: PrettierOptions,
): Promise<FormatOutcome> {
  const content = model.getValue();
  let formatted: string;
  let note: string;
  try {
    const r = await invoke<{ formatted: string; formatter: string }>("format_content", {
      dir,
      path,
      content,
    });
    formatted = r.formatted;
    note = r.formatter; // "prettier" | "rustfmt" | "gofmt"
  } catch (e) {
    const msg = String(e);
    // Only the missing-prettier case falls back to the bundled renderer formatter.
    // rustfmt/gofmt-not-found and real syntax errors surface as-is.
    if (!msg.startsWith("prettier not found")) return { kind: "error", message: msg };
    try {
      const project = await invoke<Partial<PrettierOptions> | null>("resolve_prettier_options", {
        path,
      });
      formatted = await formatWithFallback(path, content, mergeFormatOptions(project, globalCfg));
      note = project ? "bundled prettier (project config)" : "bundled prettier (default rules)";
    } catch (fe) {
      return { kind: "error", message: String(fe) };
    }
  }
  // The buffer may have moved while the formatter ran; applying a stale result would
  // silently revert those keystrokes.
  if (model.getValue() !== content) return { kind: "buffer-changed" };
  if (formatted === content) return { kind: "unchanged" };
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: formatted }], () => null);
  return { kind: "applied", note };
}
```

- [ ] **Step 3: Rewrite `formatActiveDocument`**

Replace the whole `formatActiveDocument` action (currently `src/store.ts:1914-1952`) with:

```ts
    formatActiveDocument: async () => {
      const s = get();
      const pid = s.selectedProjectId;
      const project = s.projects.find((p) => p.id === pid);
      const g = pid ? activeGroup(s.layouts[pid]) : null;
      const tab = g?.tabs.find((t) => t.ref === g.activeRef);
      if (!project || !tab || tab.kind !== "file") return;
      const path = tab.ref;
      const entry = registry.model(path);
      if (!entry?.model || registry.saving.has(path)) return;
      if (entry.readOnly) {
        get().pushToast("Can't format: file is read-only (too large / binary).", "error");
        return;
      }
      const model = entry.model as unknown as Monaco.editor.ITextModel;
      const outcome = await formatBuffer(path, project.path, model, get().formatConfig);
      switch (outcome.kind) {
        case "applied":
          get().pushToast(`Formatted with ${outcome.note}.`);
          break;
        case "unchanged":
          get().pushToast("Already formatted.");
          break;
        case "buffer-changed":
          get().pushToast("Buffer changed while formatting — try again.", "error");
          break;
        case "error":
          get().pushToast(`Format failed: ${outcome.message}`, "error");
          break;
      }
    },
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (`Monaco` is already imported at `store.ts:25`; `activeGroup`, `registry`, `invoke` are already in scope.)

- [ ] **Step 5: Commit**

```bash
git add src/store.ts
git commit -m "feat(format): bundled-prettier fallback + visible toasts for Format Document"
```

---

## Task 8: format-on-save hook

**Files:**
- Modify: `src/store.ts` (`saveFile`, 1752–1787)

- [ ] **Step 1: Insert the format step inside the saving window**

In `saveFile` (`src/store.ts:1752`), the current block is:

```ts
      registry.saving.add(path);
      if (get().trimOnSave) {
        applyWhitespaceCleanup(entry.model as unknown as Monaco.editor.ITextModel);
      }
      const value = entry.model.getValue();
```

Change it to (add the format-on-save block between the trim cleanup and `getValue`):

```ts
      registry.saving.add(path);
      if (get().trimOnSave) {
        applyWhitespaceCleanup(entry.model as unknown as Monaco.editor.ITextModel);
      }
      // Format-on-save (opt-in, off by default). Runs INSIDE the saving window so its
      // model edit is covered by the same watcher/dirty suppression. Skips instantly for
      // non-formattable files. Must NOT block the save: on error we toast and write the
      // un-formatted buffer. `writtenVersion` below is snapshotted AFTER this edit.
      if (get().formatOnSave && !entry.readOnly && hasFormatter(path)) {
        const dir = path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";
        try {
          const outcome = await formatBuffer(
            path,
            dir,
            entry.model as unknown as Monaco.editor.ITextModel,
            get().formatConfig,
          );
          if (outcome.kind === "error") {
            get().pushToast(`Format on save skipped: ${outcome.message}`, "error");
          }
        } catch (e) {
          get().pushToast(`Format on save skipped: ${String(e)}`, "error");
        }
      }
      const value = entry.model.getValue();
```

Everything after `const value = entry.model.getValue();` (the `writtenVersion` snapshot at :1771 and the write) is unchanged — because it already lives below `getValue`, the version is correctly captured after the format edit.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors (`hasFormatter` imported in Task 7; `formatBuffer`, `pushToast` in scope).

- [ ] **Step 3: Commit**

```bash
git add src/store.ts
git commit -m "feat(format): opt-in format-on-save hook in saveFile"
```

---

## Task 9: Settings → Formatting page

**Files:**
- Create: `src/components/FormatPrefsPanel.tsx`
- Modify: `src/components/Settings.tsx` (tab type, NAV, render)

- [ ] **Step 1: Create the panel**

Create `src/components/FormatPrefsPanel.tsx`:

```tsx
import { useStore, type PrettierOptions } from "../store";

/** Settings → Formatting: global prettier config for the bundled fallback + the two
 *  save toggles. A project's own .prettierrc overrides these global values. */
export function FormatPrefsPanel() {
  const cfg = useStore((s) => s.formatConfig);
  const setCfg = useStore((s) => s.setFormatConfig);
  const trimOnSave = useStore((s) => s.trimOnSave);
  const toggleTrim = useStore((s) => s.toggleTrimOnSave);
  const formatOnSave = useStore((s) => s.formatOnSave);
  const toggleFormat = useStore((s) => s.toggleFormatOnSave);

  const num = (k: keyof PrettierOptions) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg({ [k]: Number(e.target.value) } as Partial<PrettierOptions>);
  const bool = (k: keyof PrettierOptions) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg({ [k]: e.target.checked } as Partial<PrettierOptions>);

  return (
    <div className="usage-prefs">
      <p className="settings-intro">
        On save or via Edit → Format Document, Conduit uses the project's own prettier when
        installed (respecting its config). When a project has no prettier, it falls back to a
        bundled formatter using these global rules — a project's <code>.prettierrc</code>{" "}
        still wins.
      </p>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">On save</div>
        <div className="usage-prefs-checks">
          <label className="account-tag-check">
            <input type="checkbox" checked={formatOnSave} onChange={toggleFormat} />
            Format document on save
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={trimOnSave} onChange={toggleTrim} />
            Trim trailing whitespace on save
          </label>
        </div>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Global prettier rules (fallback)</div>
        <div className="usage-prefs-checks">
          <label className="account-tag-check">
            Print width
            <input
              type="number"
              min={20}
              max={200}
              value={cfg.printWidth}
              onChange={num("printWidth")}
            />
          </label>
          <label className="account-tag-check">
            Tab width
            <input type="number" min={1} max={8} value={cfg.tabWidth} onChange={num("tabWidth")} />
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={cfg.useTabs} onChange={bool("useTabs")} />
            Use tabs
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={cfg.semi} onChange={bool("semi")} />
            Semicolons
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={cfg.singleQuote} onChange={bool("singleQuote")} />
            Single quotes
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={cfg.bracketSpacing} onChange={bool("bracketSpacing")} />
            Bracket spacing
          </label>
        </div>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Trailing commas</div>
        <select
          className="account-select"
          value={cfg.trailingComma}
          onChange={(e) => setCfg({ trailingComma: e.target.value as PrettierOptions["trailingComma"] })}
        >
          <option value="all">All</option>
          <option value="es5">ES5</option>
          <option value="none">None</option>
        </select>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">End of line</div>
        <select
          className="account-select"
          value={cfg.endOfLine}
          onChange={(e) => setCfg({ endOfLine: e.target.value as PrettierOptions["endOfLine"] })}
        >
          <option value="lf">LF</option>
          <option value="crlf">CRLF</option>
          <option value="cr">CR</option>
          <option value="auto">Auto</option>
        </select>
      </div>
    </div>
  );
}
```

(`PrettierOptions` must be re-exported from the store. In `src/store.ts` add near the other re-exports: `export type { PrettierOptions } from "./format/options";` — or import it directly from `../format/options` in the panel. Use whichever matches how the store re-exports `UsagePrefs`.)

- [ ] **Step 2: Register the tab in Settings**

In `src/components/Settings.tsx`:

Add the import (line ~8):

```ts
import { FormatPrefsPanel } from "./FormatPrefsPanel";
```

Add `"formatting"` to the `SettingsTab` union (lines 14–24):

```ts
  | "formatting"
```

Add a NAV entry — put it in the `Coding agents`/editor area; add a new group after General (line ~28):

```ts
  { group: "Editor", items: [{ id: "formatting", label: "Formatting" }] },
```

Add the render branch in the settings body (next to `{tab === "usage" && <UsagePrefsPanel />}`, line 124):

```tsx
              {tab === "formatting" && <FormatPrefsPanel />}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/FormatPrefsPanel.tsx src/components/Settings.tsx src/store.ts
git commit -m "feat(format): Settings → Formatting page (global rules + save toggles)"
```

---

## Task 10: Toolbar Format button

**Files:**
- Modify: `src/components/CodeEditorPane.tsx` (breadcrumb, ~696–740)

- [ ] **Step 1: Import the helper + action**

In `src/components/CodeEditorPane.tsx`, add the import:

```ts
import { hasFormatter } from "../format/options";
```

And read the action near the other store selectors (next to `const saveFile = useStore((s) => s.saveFile);`, ~line 101):

```ts
  const formatActiveDocument = useStore((s) => s.formatActiveDocument);
```

- [ ] **Step 2: Add the button**

In the breadcrumb JSX, insert before `<LanguageSelector ... />` (line 739):

```tsx
        {!!activePath && !noModel && !!fc && !fc.readOnly && hasFormatter(activePath) && (
          <button
            className="md-toggle-btn"
            onClick={() => void formatActiveDocument()}
            title="Format document (⇧⌥F)"
          >
            Format
          </button>
        )}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/CodeEditorPane.tsx
git commit -m "feat(format): toolbar Format button in the editor breadcrumb"
```

---

## Task 11: Version bump + changelog

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `CHANGELOG.md`

- [ ] **Step 1: Bump the three version files 0.17.1 → 0.18.0**

- `package.json` `"version"`: `"0.18.0"`
- `src-tauri/tauri.conf.json` `"version"`: `"0.18.0"`
- `src-tauri/Cargo.toml` line 3 `version`: `"0.18.0"`

- [ ] **Step 2: Refresh Cargo.lock**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds; `Cargo.lock` version line updates.

- [ ] **Step 3: Verify all three agree**

Run: `grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml`
Expected: all show `0.18.0`.

- [ ] **Step 4: Add the changelog entry**

Prepend to `CHANGELOG.md` (newest first; use the real release date):

```markdown
## 0.18.0 — 2026-07-DD

- **Added — Bundled formatter fallback.** Format Document now works even when a project has
  no prettier installed: Conduit falls back to a bundled prettier, loaded on demand. Projects
  with their own prettier/config are unchanged and always take precedence.
- **Added — Format on save.** Opt-in (Settings → Formatting), off by default. Formats the
  document on every save for supported file types.
- **Added — Format button.** A Format button in the editor toolbar for formatter-eligible files.
- **Added — Formatting settings.** Global prettier rules (print width, quotes, semicolons,
  trailing commas, …) used by the fallback; a project's `.prettierrc` overrides them.
- **Fixed — Silent Format Document.** Formatting failures (no prettier, read-only/oversized
  files, nothing to change) now surface as an in-app message instead of doing nothing.
```

- [ ] **Step 5: Commit**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json Cargo.lock CHANGELOG.md
git commit -m "release: prettier format fallback + formatOnSave + toolbar button (v0.18.0)"
```

(Note: `Cargo.lock` is at `src-tauri/Cargo.lock` — adjust the path if `git add Cargo.lock` fails.)

---

## Task 12: Full verification

- [ ] **Step 1: Frontend typecheck + tests + build**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build`
Expected: typecheck clean; all vitest suites pass (incl. `src/format/options.test.ts`); production build succeeds.

- [ ] **Step 2: Rust tests + clippy + fmt**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml && cargo fmt --manifest-path src-tauri/Cargo.toml --check`
Expected: tests pass; no clippy warnings on new code; fmt clean.

- [ ] **Step 3: Launch the dev app (isolated data dir) and verify by behavior**

Run: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`

Verify each:
1. Open a `.ts`/`.css` file in a project with **no** prettier → Edit → Format Document (or the toolbar Format button) reflows it; toast reads "Formatted with bundled prettier (default rules)."
2. Add a `.prettierrc` (`{ "singleQuote": true, "printWidth": 100 }`) to that project, reopen the file, Format → output honors it; toast reads "(project config)."
3. In a project that **has** local prettier installed, Format → still uses the shell-out path (unchanged behavior).
4. Open a > 8 MB minified file, Format → toast "Can't format: file is read-only (too large / binary)." — never a silent no-op.
5. Settings → Formatting → enable "Format document on save." Edit + ⌘S a `.ts` file → saved content is formatted. Save a `.txt` file → instant, no format. Introduce a syntax error, ⌘S → file saves un-formatted with a "Format on save skipped" toast.
6. Change global rules (e.g. tab width 4, no semicolons) → re-format a config-less file → output reflects the new rules.
7. The toolbar Format button shows only on formatter-eligible files (not on `.txt`/plaintext).

- [ ] **Step 4: Update the stale CLAUDE.md note (optional, low-risk)**

`CLAUDE.md` says "The frontend has no test runner." This is now false (vitest present). If touching docs, correct that line. Not required for this feature.

---

## Self-review notes (author)

- **Spec coverage:** A→toast (Task 5, 7), B→fallback (Task 4), C→Rust resolver + wiring (Task 2, 7), D→settings + config state (Task 6, 9), E→formatOnSave (Task 8), F→toolbar button (Task 10), release (Task 11). All covered.
- **Type consistency:** `PrettierOptions` (options.ts) === global config shape; `PrettierConfig` (Rust, all-optional camelCase) deserializes to `Partial<PrettierOptions>` in `formatBuffer`. `parserSpecFor`/`hasFormatter`/`mergeFormatOptions` names match across Tasks 3, 4, 7, 8, 10. `FormatOutcome.kind` values match the `switch` in Task 7.
- **Read-only path** is handled by the *caller* (formatActiveDocument toasts; saveFile skips) — `formatBuffer` assumes editable, as documented.
- **Fallback trigger** keys off the exact Rust string `"prettier not found"` (`format.rs:127`); rustfmt/gofmt-missing and real syntax errors surface verbatim.
```
