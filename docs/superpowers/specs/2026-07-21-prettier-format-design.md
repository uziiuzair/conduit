# Prettier Format: Fallback + formatOnSave + Toolbar Button + Global Config — Design

**Date:** 2026-07-21
**Status:** Approved, pending implementation
**Problem owner:** Editor formatting — "Format Document" exists but silently does nothing when
prettier isn't installed or the file is read-only; there is no format-on-save, no visible
Format control, and no way to configure formatting without a project prettier install.

## Problem

Conduit already ships a "Format Document" feature: the native **Edit → Format Document**
menu item (`src-tauri/src/menu.rs:107-109`, `Shift+Alt+F`) emits `"menu"` →
`App.tsx:300` → `store.ts:1914 formatActiveDocument` → the Rust `format_content` command
(`src-tauri/src/format.rs`), which pipes the editor buffer through the project's own
`prettier` / `rustfmt` / `gofmt` over stdin→stdout and applies the result as one
undo-preserving edit. Prettier is **not bundled** — it is resolved at runtime from the
project's `node_modules/.bin/prettier`, else `$SHELL -lc "command -v prettier"`. Renderer
RAM cost of the current feature is ~0.

Three gaps make it look broken and incomplete:

1. **It fails invisibly.** Verified on this machine: `command -v prettier` → not found, and
   the repo has no local prettier. `format.rs:127` then returns `Err("prettier not found")`.
   Conduit has **no in-app toast system** — "toast" in the code (`store.ts:1916`) is
   `notify_user`, an `osascript` macOS banner (`notify.rs:21`) that needs notification
   permission and vanishes in seconds. Worse, three of four exit paths of
   `formatActiveDocument` produce **no feedback at all**:

   | Path | `store.ts` | Feedback today |
   | --- | --- | --- |
   | prettier not found | `:1935` | OS banner (missable) |
   | model read-only (binary / >24 MB truncated / 8–24 MB / non-UTF-8) | `:1925` | none |
   | `formatted === content` (already formatted / ignored) | `:1945` | none |
   | buffer changed mid-format | `:1942` | OS banner (missable) |

   A minified file is the worst case: large single-line bundles trip the read-only memory
   guard (`fsops.rs:86-164` — editable only for valid UTF-8 ≤ 8 MB; loaded read-only
   8–24 MB; truncated read-only > 24 MB), so `formatActiveDocument` returns at `:1925`
   before prettier is ever called — a fully silent no-op. This is exactly what the user hit.

2. **No format-on-save.** `saveFile` (`store.ts:1752`) only runs the optional `trimOnSave`
   whitespace cleanup (`:1763`). There is no `formatOnSave`.

3. **No visible Format control and no config.** The only trigger is the native Edit menu
   item; there is no toolbar button. And when no project prettier exists, the user has no
   way to make formatting work or to set formatting rules.

## Decision summary (from brainstorming)

- **Keep the shell-out architecture; add a *lazy* renderer fallback.** When Rust reports no
  project prettier, dynamically `import()` `prettier/standalone` + parsers in the renderer
  and format there. Dynamic import keeps it out of the initial bundle; heap cost (~a few MB,
  dominated by the TypeScript parser) is paid only on first fallback use, then cached. At
  rest: 0. Real project prettier (RAM ~0) is always preferred; the renderer-heap fallback is
  the last resort — so the "don't overload RAM" constraint is structural, not hoped-for.
- **Global formatting config with project override.** A new **Settings → Formatting** page
  holds a Conduit-global prettier config. Config resolves most-specific-wins (see below).
- **In-app toast system.** Add a minimal one; route all Format outcomes to it. This is the
  root-cause fix for "it does nothing."
- **formatOnSave: opt-in, off by default.** Mirrors the existing `trimOnSave` machinery;
  hooks into `saveFile` inside the existing save re-entrancy window.
- **Toolbar Format button** in the editor breadcrumb, in addition to the Edit menu item.
- **Rejected:** bundling a node+prettier CLI sidecar (large app-size increase); loading
  prettier-standalone eagerly into the initial bundle (defeats the RAM goal).

## Config precedence (the one rule)

When formatting a file, options resolve **most-specific wins**:

1. **Project-local prettier binary** (`node_modules/.bin/prettier`, walking up from the
   file) — runs as today via `format.rs`, reads the project's own config. Highest. Unchanged.
2. **Project static prettier config** (`.prettierrc`, `.prettierrc.json`, `.prettierrc.yaml`
   / `.yml`, or `package.json` `"prettier"` field) — used by the renderer fallback when no
   local binary exists. Read via a new Rust helper. JS configs (`.prettierrc.js`,
   `prettier.config.js`) cannot be read without executing them → treated as "no static
   config," falls through to global; the toast notes this.
3. **Conduit global config** — the Settings → Formatting page. Used when the project says
   nothing.
4. **Prettier built-in defaults** — floor (standalone applies these for any unset option).

Consequences, stated explicitly to avoid ambiguity:

- **Project always overrides global; global overrides prettier defaults.**
- The global config feeds **only the renderer fallback**. When a project-local prettier
  binary runs (step 1), it uses its own config/defaults — Conduit's global config is *not*
  injected into it. Rationale: if you installed prettier, you get prettier's behavior; the
  global config is purely the no-prettier fallback's settings.
- A project with a local binary but no `.prettierrc` therefore formats with prettier
  defaults, not Conduit's global config. Accepted.

## Design

### A — In-app toast system

New, minimal, general-purpose (Format is the first consumer; save-failed etc. can migrate
later but that is out of scope here).

- **Store slice** in `src/store.ts`: `toasts: Toast[]` where
  `Toast = { id: string; body: string; kind?: "info" | "error"; }`, plus actions
  `pushToast(body, kind?)` and `dismissToast(id)`. Auto-dismiss is handled in the component
  (timer), not the store, so the store stays pure.
- **Component** `src/components/Toasts.tsx`: fixed-position container (bottom-center),
  renders the stack, each toast auto-dismisses after ~4 s (hover pauses optional — YAGNI,
  skip for v1). Mounted once near the app root (`App.tsx`).
- **Styling** in `src/theme.css`, matching existing surface tokens.
- `formatActiveDocument` (`store.ts:1914`) switches its `toast()` helper from
  `notify_user` to `pushToast`. All four outcome paths get a message:
  - not found → after fallback attempt (see B), success toast names the source
    ("Formatted with bundled prettier (default rules)") or an error toast.
  - read-only → `pushToast("Can't format: file is read-only (too large / binary).", "error")`
    — replaces the silent `:1925` return **for the format action** (the guard stays; it just
    speaks now).
  - `formatted === content` → `pushToast("Already formatted.")`.
  - buffer changed → existing message via `pushToast(..., "error")`.

### B — Lazy fallback formatter

- New module `src/format/fallback.ts`. Exports
  `formatWithFallback(path, content, options): Promise<string>`.
- Uses **dynamic import** so nothing lands in the initial Vite bundle:
  `const prettier = await import("prettier/standalone")` and per-language parser plugins
  (`prettier/plugins/babel`, `.../estree`, `.../typescript`, `.../postcss`,
  `.../html`, `.../markdown`, `.../yaml`). Parser plugins are imported based on the file's
  language so unused parsers are not fetched. Imports are module-cached after first use.
- Language/parser mapping mirrors `format.rs`'s `PRETTIER_EXTS`:
  js/jsx/mjs/cjs → `babel`+`estree`; ts/tsx → `typescript`+`estree`; json/jsonc →
  `babel`+`estree` (parser `json`); css/scss/less → `postcss`; html → `html`; vue → `html`
  (best-effort; if it throws, error toast "Vue formatting needs a project prettier");
  md/markdown → `markdown`; yaml/yml → `yaml`.
- New dependency: `prettier` (^3) added to `package.json` `dependencies` (the standalone +
  plugins builds ship inside the `prettier` package). This is the first renderer-side
  formatter dep; it is loaded lazily only.

### C — Config resolution (Rust + wiring)

- **Rust:** extend `src-tauri/src/format.rs`. New command `resolve_prettier_options(dir,
  path) -> PrettierConfig | null`:
  - Walk up from the file to `dir` (bounded by `dir`) looking for `.prettierrc`,
    `.prettierrc.json`, `.prettierrc.yaml`/`.yml`, then `package.json` `"prettier"`.
  - Parse JSON / YAML into a normalized `PrettierConfig` struct (the eight fields below).
    Unknown keys ignored. `extends` not resolved (YAGNI); its presence is surfaced so the UI
    can note reduced fidelity. JS configs skipped (can't execute).
  - Returns the found options, or `null` if none found. Pure parse fn is unit-tested.
  - Register in `lib.rs` invoke handler.
- **Frontend resolution** (in `formatActiveDocument` / the shared format helper):
  1. call `format_content` (Rust). If it succeeds → done (project binary or PATH prettier).
  2. if it fails specifically with "prettier not found" → build options via precedence:
     `resolve_prettier_options(dir, path)` (step 2) ?? global config from settings (step 3);
     call `formatWithFallback(path, content, options)`. Other errors (real syntax errors from
     a found prettier) surface as-is.

### D — Global formatting config + Settings → Formatting page

- **Config shape** `FormatConfig` (persisted, localStorage, mirroring `usagePrefs` /
  `trimOnSave` persistence patterns in `store.ts` ~`:475-490`,`:1071`):
  `printWidth: 80`, `tabWidth: 2`, `useTabs: false`, `semi: true`, `singleQuote: false`,
  `trailingComma: "all"`, `bracketSpacing: true`, `endOfLine: "lf"`. These map 1:1 to
  prettier options passed to the fallback.
- **Store:** `formatConfig: FormatConfig`, `setFormatConfig(patch)`, plus `formatOnSave`
  (see E). Read on init, written on change.
- **Settings page** `src/components/FormatPrefsPanel.tsx` (mirrors
  `UsagePrefsPanel.tsx`): the eight fields (number inputs / checkboxes / selects) + the two
  save toggles (`trimOnSave` moved next to the new `formatOnSave`, both as checkboxes).
  Registered under Settings alongside the existing Usage-display panel.

### E — formatOnSave (opt-in, off by default)

- **State:** `formatOnSave: boolean` (default `false`), `toggleFormatOnSave()`, persisted
  like `trimOnSave` (`store.ts:475/485/488/875/1071/1883`).
- **Hook point:** inside `saveFile` (`store.ts:1752`), within the existing
  `registry.saving.add(path)` window, next to the `trimOnSave` cleanup (`:1763`). Sequence:
  1. enter saving window (unchanged).
  2. if `trimOnSave` → whitespace cleanup (unchanged).
  3. **if `formatOnSave` and `formatter_for(path)` is truthy** → format the buffer (Rust,
     then fallback per precedence), and if the result differs, apply it to the model with the
     same undo-preserving `pushEditOperations` as `formatActiveDocument`.
  4. **snapshot `writtenVersion` AFTER the format edit** (the current `:1771` snapshot moves
     below the format step), then `getValue()` and write (unchanged).
- **Must not call `formatActiveDocument`** — it early-returns on `registry.saving.has(path)`
  (`:1925`). The format logic is refactored into a shared internal helper
  (`formatBuffer(path, model): Promise<boolean>` — returns whether an edit was applied) that
  both `formatActiveDocument` and `saveFile` call. `formatActiveDocument` keeps its own
  active-tab resolution + toasts; `saveFile` calls the helper directly.
- **Fast path:** when `formatter_for(path)` is None, skip entirely so non-formattable saves
  stay instant. Format failure on save must **not** block the write — on error, push a toast
  and proceed to save the un-formatted buffer.
- **Perf note:** the first save in a config-less project pays the fallback dynamic import
  once (cached after). Opt-in + off-by-default keeps this off the default ⌘S path.

### F — Toolbar Format button

- Add a `md-toggle-btn` labeled "Format" in the editor breadcrumb
  (`CodeEditorPane.tsx:696-740`, beside the EOL / ± Diff / Preview toggles) → calls
  `formatActiveDocument`.
- **Visible only when the active file has a formatter** (`formatter_for(activePath)` truthy),
  else hidden — no dead button on plaintext/unsupported files.
- The native Edit → Format Document item (`menu.rs:107`) is unchanged and remains.

## Testing

- **Rust** (`cargo test --manifest-path src-tauri/Cargo.toml`): unit-test the new
  `resolve_prettier_options` parser over `.prettierrc` JSON, YAML, and `package.json`
  `"prettier"` fixtures, plus "no config → null" and "JS config → null". Extend existing
  `formatter_for` tests if the ext set changes (it does not).
- **Frontend** (no runner — launch the dev app with
  `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`):
  1. Format a file in a config-less project → bundled fallback formats it, toast names the
     source.
  2. Format in a project with a `.prettierrc` (no local binary) → fallback honors it.
  3. Format in a project *with* local prettier → shell-out path unchanged.
  4. Open a > 8 MB minified file, Format → "read-only / too large" toast (no silent no-op).
  5. Enable formatOnSave, edit + ⌘S a `.ts` file → saved content is formatted; a
     non-formattable file saves instantly; a syntax-error file saves un-formatted with a toast.
  6. Toolbar button appears only on formatter-eligible files and formats on click.

## Release

- One **MINOR** version bump (`0.x.0`) across the three version files (`package.json`,
  `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) + `cargo build` to refresh
  `Cargo.lock`, per CLAUDE.md — this is a user-facing feature set.
- CHANGELOG entry `## X.Y.Z — 2026-07-DD` with Added (bundled fallback, format-on-save,
  toolbar button, Formatting settings) and Fixed (silent Format Document failures now
  surface in-app).

## Out of scope (YAGNI)

- Migrating other `notify_user` callers (save-failed, discard) to the new toast — deferred.
- `extends` / plugin / `.editorconfig` / JS-config resolution in the fallback.
- Formatters beyond prettier's fallback (rustfmt/gofmt remain shell-out-only; no bundled
  fallback for them — Rust/Go toolchains are assumed installed if you edit those files).
- Per-project formatting config UI inside Conduit (projects configure via their own
  `.prettierrc`, which already wins).
