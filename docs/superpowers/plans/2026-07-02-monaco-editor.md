# Monaco Editor in Conduit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Conduit's read-only `FileViewer` with the Monaco Editor so users can open, edit, and save files in-app, with dirty tracking, theme sync, smart reload on agent-driven disk changes, and file-tree CRUD.

**Architecture:** One hand-wrapped Monaco editor **per split-column (EditorGroup)**, backed by a global path-keyed `ITextModel` **registry** that lives outside React (mirroring the existing `liveTerminals` singleton). Models hold content + undo + dirty state and persist; editors are disposable. All new Rust is `std::fs` only; the only new frontend runtime dependency is `monaco-editor` (workers bundled locally via Vite `?worker`, no CDN).

**Tech Stack:** Tauri v2 (Rust, `std::fs`), React 19 + TypeScript + Vite 7, Zustand 5, `monaco-editor`, `vitest` (dev-only, registry tests). Design spec: [`docs/superpowers/specs/2026-07-02-monaco-editor-design.md`](../specs/2026-07-02-monaco-editor-design.md).

**Execution note:** Run in a dedicated git worktree. This session runs inside the installed Conduit.app, so **every dev run must isolate state**: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`. Do **not** bump the app version. Commit after every task with a scoped Conventional Commit ending in the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## Shared Contracts (LAW — every task uses these exact names/types)

These signatures were pinned before drafting so no phase diverges. If a task below appears to
contradict one of these, the contract wins.

### Rust: `FileContent` (revised, Phase 1)

```rust
// src-tauri/src/fsops.rs — revised read struct.
// Size tiers (NUL-in-first-8KB binary sniff kept):
//   EDIT_CAP  =  8 * 1024 * 1024  (8 MB)  -> fully editable (read_only=false)
//   8..=24 MB                              -> loaded, read_only=true  ("Read-only: large file")
//   HARD_CAP  = 24 * 1024 * 1024  (24 MB)  -> content = first 24 MB, truncated=true + read_only=true
//                                             ("Showing first 24 MB (read-only)")
//   binary (NUL in first 8 KB)             -> binary=true, short placeholder, NO editable model
//   invalid UTF-8 (strict from_utf8 fails) -> read_only=true, lossy from_utf8_lossy PREVIEW
//                                             (reason surfaced by FE as "non-UTF-8 encoding")
//   read error                             -> error = Some(msg), content = "" (msg NEVER in content)
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
    /// Buffer must never be written back (binary / oversized / truncated / non-UTF-8).
    pub read_only: bool,
    /// True on-disk size in bytes (fs::metadata, not the possibly-truncated read length).
    pub size: u64,
    /// Modification time in epoch milliseconds (fractional; carries sub-ms nanos precision).
    pub mtime_ms: f64,
    /// Some(msg) on read failure — FE refuses to build an editable model; never None-vs-content confusion.
    pub error: Option<String>,
}
```

### Rust: `FileStat` (Phase 1 write_file / Phase 2 stat_file)

```rust
// src-tauri/src/fsops.rs — one struct shared by write_file (returns it, exists=true)
// and stat_file (exists=false when the path is missing/unstattable).
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    /// Epoch milliseconds (fractional, same computation as FileContent.mtime_ms). 0.0 when !exists.
    pub mtime_ms: f64,
    /// Size in bytes. 0 when !exists.
    pub size: u64,
    /// false when the path is gone. `write_file` always returns exists=true.
    pub exists: bool,
}
```

### Rust commands

- **`read_file`** (Phase 1)
  - Signature: `#[tauri::command] fn read_file(path: String) -> fsops::FileContent  // wrapper in lib.rs; fsops fn: pub fn read_file(path: &str) -> FileContent`
  - SIGNATURE UNCHANGED (still infallible, error carried in the FileContent.error field). Body rewritten: fs::read then fs::metadata for size+mtime_ms; keep NUL-in-first-8KB binary sniff; replace String::from_utf8_lossy with strict std::str::from_utf8 (invalid -> read_only + lossy preview); apply 8MB EDIT_CAP / 24MB HARD_CAP tiers; on Err(read) set error=Some, content="". Add #[cfg(test)] unit tests for tiering/UTF-8/binary.
- **`write_file`** (Phase 1)
  - Signature: `#[tauri::command] fn write_file(path: String, content: String) -> Result<fsops::FileStat, String>`
  - std::fs ONLY. Reject if parent dir missing (never create_dir_all). Write sibling temp `.{name}.conduit-tmp-{rand}` in the SAME dir -> file.sync_all() -> on Unix reapply the existing file's mode (temp is 0600, would strip +x) -> fs::rename(tmp,path) atomic same-fs replace. Return post-rename FileStat{exists:true} (no separate re-stat). Register in generate_handler!. Called only by store.saveFile; JS args {path,content}.
- **`stat_file`** (Phase 2)
  - Signature: `#[tauri::command] fn stat_file(path: String) -> fsops::FileStat`
  - Infallible: std::fs::metadata; on any error return FileStat{mtime_ms:0.0,size:0,exists:false}. Zero crates. Polled by useFileWatch (~1500ms, visibility-gated) for the set of open file paths; JS args {path}.
- **`create_file`** (Phase 3)
  - Signature: `#[tauri::command] fn create_file(path: String) -> Result<(), String>`
  - Error if target exists (no clobber) — use OpenOptions::new().write(true).create_new(true) or explicit exists() check. std::fs. FE calls openFile(projectId,newPath) on success + bumpDir(parent).
- **`create_dir`** (Phase 3)
  - Signature: `#[tauri::command] fn create_dir(path: String) -> Result<(), String>`
  - fs::create_dir (single level; parent must already exist), error if exists. NOT create_dir_all. FE bumpDir(parent) on success.
- **`rename_path`** (Phase 3)
  - Signature: `#[tauri::command] fn rename_path(from: String, to: String) -> Result<(), String>`
  - Error if dest exists (guard before fs::rename — rename would clobber). Handles files, dirs, and moves. JS args {from,to}. FE: block if the open buffer is dirty; for a clean open file, close-old tab + openFile(new); bumpDir on affected parents.
- **`delete_path`** (Phase 3)
  - Signature: `#[tauri::command] fn delete_path(path: String) -> Result<(), String>`
  - Permanent (no `trash` crate): fs::remove_file for files, fs::remove_dir_all for dirs (stat first to choose). Guarded in FE by dialog.ask confirm + block-on-dirty. FE closes the tab (release+disposeIfUnreferenced) + bumpDir(parent).

### Frontend: `FileContent` / `FileStat` TS mirror

```ts
// Frontend mirror of fsops::FileContent (serde camelCase). read_file resolves (never rejects);
// inspect `error`/`binary`/`readOnly` to decide model creation.
export interface FileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
  readOnly: boolean;
  size: number;
  mtimeMs: number;
  error: string | null;
}
// Also add the FileStat mirror (returned by write_file & stat_file):
// export interface FileStat { mtimeMs: number; size: number; exists: boolean }
```

### `src/monaco/registry.ts` public API

- **`RegistryModel`** — `export interface RegistryModel { getValue(): string; getAlternativeVersionId(): number; onDidChangeContent(listener: () => void): { dispose(): void }; dispose(): void }`
  - Minimal structural subset of monaco.editor.ITextModel. A real ITextModel satisfies it; vitest passes a hand-rolled fake. The reload path (useFileWatch pushEditOperations) casts entry.model to the concrete monaco.editor.ITextModel — those methods are intentionally NOT on this test-facing interface.
- **`ModelFactory`** — `export type ModelFactory = (path: string, value: string, languageId: string) => RegistryModel`
  - Injectable model builder (the test seam). Default builds monaco.editor.createModel(value, languageId, monaco.Uri.file(path)); vitest overrides it via setModelFactory to avoid any real DOM/Monaco.
- **`Baseline`** — `export interface Baseline { mtimeMs: number; size: number }`
  - The on-disk {mtimeMs,size} the watcher diffs against. Set from read_file (via ensureModel) and overwritten by write_file's returned FileStat (via setSaved). Mirrors FileStat minus `exists`.
- **`RegistryEntry`** — `export interface RegistryEntry { model: RegistryModel | null; savedVersionId: number; viewStates: Map<string, unknown>; baseline: Baseline; refCount: number; readOnly: boolean }`
  - THE per-path entry. `model` is null until first reveal (lazy) and stays null for binary/error tabs; `viewStates` is keyed by groupId (opaque monaco.editor.ICodeEditorViewState); `refCount` counts open file TABS across all layouts; `savedVersionId` is model.getAlternativeVersionId() at last save/reload.
- **`setModelFactory`** — `export function setModelFactory(factory: ModelFactory): void`
  - Override the model factory (unit tests / a custom boot). Not called in normal app flow — the default monaco factory is used.
- **`acquire`** — `export function acquire(path: string): number`
  - Increment the tab refCount for a path (call when a file tab opens anywhere, driven by a store reconcile over all layouts). Creates a refCount-only entry ({model:null,refCount:1}) if none exists yet; returns the new count. Does NOT read the file or build a model.
- **`release`** — `export function release(path: string): number`
  - Decrement the tab refCount (call when a file tab closes / project removed). Returns the new count. Never disposes on its own — the caller then calls disposeIfUnreferenced(path).
- **`ensureModel`** — `export function ensureModel(path: string, init: { value: string; languageId: string; readOnly: boolean; baseline: Baseline }): RegistryEntry`
  - Lazily attach the model on first reveal (CodeEditorPane, after read_file for an editable file). If the entry has no model: create it via the factory, set savedVersionId = model.getAlternativeVersionId(), baseline, readOnly, viewStates=new Map(); if a model already exists (shared across groups/projects) it is a no-op and `init` is ignored (no double read). Returns the entry.
- **`model`** — `export function model(path: string): RegistryEntry | undefined`
  - The loaded entry for a path (undefined if never referenced). entry.model may still be null if referenced but not yet revealed. saveFile reads entry.model.getValue(); the reload path reads entry.model as a concrete ITextModel.
- **`dirtyOf`** — `export function dirtyOf(path: string): boolean`
  - The canonical dirty check: entry.model != null && model.getAlternativeVersionId() !== entry.savedVersionId. Correctly reports CLEAN after undo back to the saved state. false when there is no loaded model. Unit-tested.
- **`setSaved`** — `export function setSaved(path: string, baseline: Baseline): void`
  - Mark the current model version as the saved point: savedVersionId = model.getAlternativeVersionId() AND baseline = the new stat. Used after a successful write_file and after a clean silent reload (§6.1).
- **`baseline`** — `export function baseline(path: string): Baseline | undefined`
  - Read the current disk baseline (the watcher compares stat_file result vs this).
- **`setBaseline`** — `export function setBaseline(path: string, baseline: Baseline): void`
  - Advance ONLY the baseline without touching savedVersionId — the dirty-conflict 'Keep mine' action (§6.2) so the watcher stops nagging until the next external change.
- **`getViewState`** — `export function getViewState(path: string, groupId: string): unknown | undefined`
  - Read the saved editor view state for (path, group) — restored via editor.restoreViewState on active-file change / remount. Effective key is `${groupId}::path`.
- **`setViewState`** — `export function setViewState(path: string, groupId: string, state: unknown): void`
  - Save the outgoing model's view state (editor.saveViewState) into the entry before setModel swap and on pane unmount, so cursor/scroll survive tab + project round-trips.
- **`saving`** — `export const saving: Set<string>`
  - In-flight write guard. saveFile does saving.add(path) before invoke('write_file') and saving.delete(path) after; useFileWatch skips any path in this set (closes the save-vs-poll-tick race).
- **`disposeIfUnreferenced`** — `export function disposeIfUnreferenced(path: string): boolean`
  - If refCount <= 0: dispose entry.model (if any) and drop the entry; returns true if it disposed. Safe no-op otherwise. THE only place a model is ever disposed — never on pane/editor unmount. Unit-tested for ref-count correctness.

### `src/monaco/setup.ts` exports

- **`initMonaco`** — `export function initMonaco(): void  // idempotent boot init (imported once at startup): wires self.MonacoEnvironment.getWorker to the local editor.worker (Vite `?worker`), imports basic-languages/monaco.contribution (main-thread Monarch), calls defineConduitThemes() then monaco.editor.setTheme(monacoThemeIdFor(current)); imports NO ts/json/css/html language services`
- **`monaco`** — `export { monaco }  // re-export of `import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'`; single import source, hand-wrapped like xterm (no @monaco-editor/react, no CDN)`
- **`languageFor`** — `export function languageFor(path: string): string  // moved from FileViewer; returns a MONACO language id (default 'plaintext'), NOT a Prism id ('shell' not 'bash', 'html' not 'markup', 'plaintext' not 'text'); sets model language + breadcrumb label`
- **`monacoThemeIdFor`** — `export function monacoThemeIdFor(themeId: ThemeId): string  // 'conduit-warm-near-black' | 'conduit-warm-dim' | 'conduit-warm-light'; ThemeId imported from ../themes`
- **`defineConduitThemes`** — `export function defineConduitThemes(): void  // builds the 3 Monaco themes ONCE from THEMES[id] via monaco.editor.defineTheme(monacoThemeIdFor(id), {...}); base 'vs-dark' for appearance:'dark' else 'vs'; called by initMonaco`

### `src/store.ts` additions

- **`dirty`** (Phase 1) — `dirty: Record<string, boolean>  // absPath -> dirty`
  - Reactive mirror of registry.dirtyOf. NON-PERSISTED. Tab strip reads useStore(s => !!s.dirty[t.ref]) for the dirty dot; close-unsaved + removeProject guards read it. Keep lean (delete key when false).
- **`conflict`** (Phase 1) — `conflict: Record<string, { mtimeMs: number; size: number } | "deleted">  // absPath -> external change`
  - Type/field DEFINED in P1 but only POPULATED in P2 by useFileWatch. NON-PERSISTED. 'deleted' => exists:false banner; the stat object => 'File changed on disk' banner.
- **`dirVersion`** (Phase 3) — `dirVersion: Record<string, number>  // dirPath -> bump counter`
  - NON-PERSISTED. Each FileTree entry re-runs list_dir when dirVersion[entry.path] changes; only the touched folder re-lists so expansion state is preserved.
- **`setDirty`** (Phase 1) — `setDirty: (path: string, dirty: boolean) => void`
  - Updates dirty[path] (delete key on false). Called by CodeEditorPane's onDidChangeContent handler ONLY on a clean<->dirty transition (pane holds a prevDirty ref; registry.dirtyOf is the pure comparator) — no per-keystroke re-render.
- **`clearConflict`** (Phase 1) — `clearConflict: (path: string) => void`
  - Removes conflict[path]. DEFINED P1 (called by saveFile so an own-save clears any stale banner); also used P2 after reload/keep-mine.
- **`setConflict`** (Phase 2) — `setConflict: (path: string, c: { mtimeMs: number; size: number } | "deleted") => void`
  - NON-PERSISTED setter used by useFileWatch when disk {mtimeMs,size} != registry.baseline(path) AND path not in registry.saving. (Companion to the P1 clearConflict; not in the original enumerated list but required to populate `conflict`.)
- **`bumpDir`** (Phase 3) — `bumpDir: (dirPath: string) => void`
  - Increments dirVersion[dirPath]. Called after every CRUD command (create/rename/delete) on the affected parent dir(s) to trigger a targeted re-list.
- **`saveFile`** (Phase 1) — `saveFile: (path: string) => Promise<void>`
  - The §4 save orchestrator. Guard: return early if !registry.model(path) || entry.readOnly || entry.model==null. Else value=model.getValue() -> registry.saving.add(path) -> invoke<FileStat>('write_file',{path,content:value}) -> on ok registry.setSaved(path,{mtimeMs,size}) + setDirty(path,false) + clearConflict(path); finally registry.saving.delete(path); on error invoke('notify_user',...).
- **`requestCloseTab`** (Phase 1) — `requestCloseTab: (projectId: string, groupId: string, ref: string) => Promise<void>`
  - Dirty-guarded replacement for direct closeTab in the tab strip. Session tab OR non-dirty file -> closeTab immediately. Dirty file -> dialog.ask('Discard unsaved changes to <name>?'): on confirm closeTab(projectId,groupId,ref) then registry.release(ref)+disposeIfUnreferenced(ref); on cancel no-op.
- **`removeProject`** (Phase 1) — `removeProject: (id: string) => Promise<void>  // signature unchanged; body gains a dirty guard`
  - Before removing: if any file tab in the project's layout is dirty (s.dirty[ref]), dialog.ask confirm; on cancel abort. On proceed, also release()+disposeIfUnreferenced() each of the project's file-tab paths so their models are reclaimed.

### `src/components/CodeEditorPane.tsx` props

```ts
// src/components/CodeEditorPane.tsx — ONE hand-wrapped editor per EditorGroup (not per tab).
// Rendered by WorkspaceCenter inside .term-stack, absolute-positioned & CSS-placed by geometry[gi],
// mirroring placeSession. The pane DERIVES its active file path internally from the store
// (activeGroup(layouts[projectId]) -> group with id===groupId -> activeRef where the tab kind==='file');
// `visible` is true only when that active tab is a file. Editor is create-once (mount effect,
// mirrors Terminal.tsx); on active-file change it saveViewState->setModel(registry.ensureModel)->restoreViewState;
// layout() on reveal + ResizeObserver; Cmd+S via editor.addCommand(KeyMod.CtrlCmd|KeyCode.KeyS, ()=>saveFile);
// on unmount it saves view state + disposes the EDITOR only (never models).
interface CodeEditorPaneProps {
  projectId: string;
  groupId: string;
  visible: boolean;
  style?: React.CSSProperties;
}
```

### Cross-phase notes

- KEEP-ALIVE ASYMMETRY: TerminalView must NEVER unmount (kills the PTY). CodeEditorPane MAY dispose its editor on unmount, but ONLY after registry.setViewState(...), and it must NEVER dispose a model — models die solely in registry.disposeIfUnreferenced when refCount<=0.
- MODELS ARE LAZY, EDITORS ARE PER-GROUP: registry.acquire/release are TAB-based across ALL layouts (a store reconcile over every group's file tabs); ensureModel creates the model only on first reveal; entry.model stays null for referenced-but-unrevealed tabs and for binary/error tabs (no model at all).
- EDITABLE GATE: FE builds an editable model ONLY when !binary && !readOnly && error===null; everything else is a read-only Monaco with a banner (or, for binary, a placeholder with no model). saveFile is hard-disabled whenever entry.readOnly — highest-severity guard against a lossy/partial buffer overwriting the file.
- DIRTY = version-id idiom: registry.dirtyOf = model.getAlternativeVersionId() !== savedVersionId (reports clean after undo-to-saved). The clean<->dirty TRANSITION + store.setDirty live in CodeEditorPane (onDidChangeContent + prevDirty ref), NOT in the registry, so registry.ts stays framework-agnostic and vitest-only.
- BASELINE is set on read (ensureModel from read_file's {mtimeMs,size}) and OVERWRITTEN on write (setSaved from write_file's returned FileStat). The P2 watcher flags a path only when disk {mtimeMs,size} != registry.baseline(path) AND path NOT in registry.saving.
- SAVE CLEARS CONFLICT: saveFile calls registry.setSaved (advances baseline) + clearConflict(path) + uses the saving guard, so an own-save can never self-trigger the external-change banner.
- conflict map: TYPE defined in P1 (store), POPULATED in P2 by useFileWatch via setConflict; 'deleted' vs the stat object select the two different banners (§6.2 / §6.3). dirVersion is entirely P3.
- read_file stays INFALLIBLE at the IPC layer (returns FileContent, error carried in .error) — do NOT convert it to Result. write_file / create_* / rename_path / delete_path DO return Result<_,String>. stat_file is infallible (exists:false on error).
- mtime_ms is f64 epoch-millis with sub-ms (nanos) precision, computed identically in FileContent, write_file's FileStat, and stat_file's FileStat, so JS equality of {mtimeMs,size} baselines holds. The residual rename->stat microsecond window is accepted/documented (low severity).
- Cmd+S CANNOT collide: editor.addCommand fires only when a Monaco editor is focused; Terminal.tsx binds only Shift+Enter and Cmd+Backspace and acts only when a terminal is focused. No document-level fallback in v1.
- THEME SYNC is a single global call: in themes.ts applyTheme(), after the liveTerminals recolor loop, call monaco.editor.setTheme(monacoThemeIdFor(id)) guarded on Monaco being loaded (import the setter lazily/guarded to avoid a hard themes.ts->monaco import cycle at boot). Themes are built once by defineConduitThemes() in initMonaco().
- languageFor now returns MONACO language ids (default 'plaintext'), a different id set than the retired FileViewer Prism map ('shell' not 'bash', 'html' not 'markup', 'plaintext' not 'text'). It is moved into src/monaco/setup.ts and re-used for both model language and the breadcrumb label.
- requestCloseTab REPLACES the tab strip's direct closeTab call; delete/remove-project confirms use `import { ask } from '@tauri-apps/plugin-dialog'` (already a dep, dialog:default already granted — NO new capability). View state is keyed by `${groupId}::path`, so it won't restore after moveTabToGroup/openToSide (new group id) — cursor/scroll resets in that one case; data is safe; accepted for v1.
- NON-PERSISTED: dirty/conflict/dirVersion never go to state.json (only the WsTab list persists, as today). No hot-exit — ExitRequested (lib.rs ~697-701) still only kills PTYs, so app-quit with dirty buffers silently drops edits (documented, deferred).
- REGISTRATION: all new commands are std::fs in fsops.rs and added to tauri::generate_handler! in lib.rs (~655-694) right after read_file/list_dir. No new Rust crate, no new Tauri plugin. vite.config.ts adds optimizeDeps.include:['monaco-editor'] (+ optional manualChunks); csp:null already permits blob/module workers.

---

## Phase 0 — Spike (throwaway, gating)

> **Nature of this phase.** This is a THROWAWAY spike to de-risk Monaco under Tauri *before* any real Phase 1 work. It is **manual-verification only** — there is no cargo/vitest coverage here (the one piece with a test runner, `registry.ts`, does not exist yet). Do **not** use the red-green TDD template; use concrete implementation steps followed by explicit launch/offline verification with exact expected observations. The branch is already `feat/monaco-editor` (verified: `git branch --show-current` → `feat/monaco-editor`). Do **not** bump the app version. The single load-bearing deliverable is the answer to the §14 open risk: *does `monaco-editor` + `editor.worker` load offline in a real packaged Tauri build under `tauri://localhost`?* Tasks 1–3 build the throwaway harness (each committed so the spike is reviewable), Task 4 runs the CRITICAL offline gate and records findings, Task 5 reverts the throwaway mount while keeping the validated `setup.ts` as Phase 1 notes.

---

### Task 0.1 — Add `monaco-editor` dependency + Vite `optimizeDeps`

**Files:**
- Modify: `package.json` (via `pnpm add` — `dependencies`, currently ends at `"zustand": "^5.0.2"`)
- Modify: `pnpm-lock.yaml` (generated by `pnpm add`)
- Modify: `vite.config.ts` (lines 8–9, inside the returned config object)

- [ ] **Step 1: Install the single new runtime dependency.**
  Run exactly:
  ```bash
  pnpm add monaco-editor
  ```
  This adds `"monaco-editor": "^0.52.x"` (whatever the current 0.52 line resolves to) under `dependencies` in `package.json` and updates `pnpm-lock.yaml`. This is the **only** new frontend runtime dep the whole feature introduces (no `@monaco-editor/react`, no CDN loader). Verify it landed:
  ```bash
  grep '"monaco-editor"' package.json
  ```
  Expected: one line printing `"monaco-editor": "^0.52...",` under `dependencies`.

- [ ] **Step 2: Pre-bundle Monaco in Vite.** `monaco-editor` ships a large tree of ESM modules with CJS interop; `optimizeDeps.include` forces Vite to pre-bundle it so dev cold-start and (critically) the packaged build resolve its entrypoints deterministically. Edit `vite.config.ts` — the returned object currently starts at line 9 with `plugins: [react()],`. Change:
  ```ts
  export default defineConfig(async () => ({
    plugins: [react()],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  ```
  to:
  ```ts
  export default defineConfig(async () => ({
    plugins: [react()],

    // Monaco is a large ESM tree with CJS interop; pre-bundle it so dev cold-start and
    // the packaged `tauri build` resolve its entrypoints deterministically. (Phase 0 spike;
    // validated to be required for the offline packaged worker load.)
    optimizeDeps: {
      include: ["monaco-editor"],
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  ```

- [ ] **Step 3: Typecheck.** Run:
  ```bash
  pnpm exec tsc --noEmit
  ```
  Expected: exits 0, no output (adding a dependency + a Vite config field introduces no type errors; `vite.config.ts` is covered by `tsconfig.node.json`).

- [ ] **Step 4: Commit.**
  ```bash
  git add package.json pnpm-lock.yaml vite.config.ts
  git commit -m "$(cat <<'EOF'
  chore(editor): add monaco-editor dep + vite optimizeDeps for spike

  Phase 0 spike scaffolding — single new frontend runtime dep, no CDN,
  no @monaco-editor/react. optimizeDeps.include pins Monaco pre-bundling
  for the packaged-build offline check.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 0.2 — Minimal `src/monaco/setup.ts` (editor.api + basic-languages + local `editor.worker` + Conduit themes)

**Files:**
- Create: `src/monaco/setup.ts`

> This is the MINIMAL spike version of the file the CONTRACTS describe (`initMonaco`, `monaco` re-export, `monacoThemeIdFor`, `defineConduitThemes`, `languageFor`). It imports **`editor.api` (slim) + `basic-languages/monaco.contribution` (main-thread Monarch) + the local `editor.worker` via Vite `?worker` ONLY** — no ts/json/css/html language services, no CDN. If Task 4's offline gate shows the slim `editor.api` import misbehaves in the packaged bundler, Task 4 switches the top import to the full `monaco-editor` (still `editor.worker` only) and records that as the locked Phase 1 choice.

- [ ] **Step 1: Create the file.** Write `src/monaco/setup.ts` verbatim:
  ```ts
  // src/monaco/setup.ts — Phase 0 SPIKE (throwaway harness; kept as Phase 1 notes).
  //
  // Proves the locked bundling decision from the design (§8): hand-wrap Monaco like
  // xterm, import the SLIM editor.api + basic-languages Monarch tokenizers, and wire
  // ONLY the local editor.worker via Vite `?worker` (NO CDN, NO language workers, NO
  // @monaco-editor/react). Also proves defineTheme + setTheme reflect the Conduit palette.
  //
  // If the slim editor.api import misbehaves in the PACKAGED build (Task 0.4 offline gate),
  // swap the first import for `import * as monaco from "monaco-editor";` (still editor.worker
  // only) and record it here as the locked Phase 1 choice.
  import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
  // Main-thread Monarch tokenizers for the languages FileViewer covered (ts/rust/python/
  // go/yaml/markdown/shell/css/html/json/...). Side-effect registration — must stay top-level.
  import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
  // Local worker, bundled offline by Vite. `?worker` default export is a Worker constructor
  // (typed via vite/client in src/vite-env.d.ts). editor.worker is the ONLY worker we ship.
  import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
  import { THEMES, DEFAULT_THEME_ID, type ThemeId } from "../themes";

  export { monaco };

  /** ThemeId -> the Monaco theme name registered by defineConduitThemes(). */
  export function monacoThemeIdFor(id: ThemeId): string {
    return `conduit-${id}`;
  }

  const hx = (c: string): string => c.replace(/^#/, "");

  /**
   * Build the 3 Conduit Monaco themes ONCE from the existing THEMES palette via
   * monaco.editor.defineTheme (base vs-dark for dark appearances, vs for light).
   * Token rules are mapped from the terminal ANSI palette, which mirrors the Prism
   * palette FileViewer used — enough to prove theme parity in the spike.
   */
  export function defineConduitThemes(): void {
    (Object.keys(THEMES) as ThemeId[]).forEach((id) => {
      const t = THEMES[id];
      const term = t.terminal;
      const fg = term.foreground ?? "#d0d0d0";
      monaco.editor.defineTheme(monacoThemeIdFor(id), {
        base: t.appearance === "dark" ? "vs-dark" : "vs",
        inherit: true,
        rules: [
          { token: "comment", foreground: hx(term.brightBlack ?? fg), fontStyle: "italic" },
          { token: "keyword", foreground: hx(term.magenta ?? fg) },
          { token: "string", foreground: hx(term.green ?? fg) },
          { token: "number", foreground: hx(term.yellow ?? fg) },
          { token: "type", foreground: hx(term.cyan ?? fg) },
          { token: "type.identifier", foreground: hx(term.cyan ?? fg) },
          { token: "delimiter", foreground: hx(term.white ?? fg) },
          { token: "tag", foreground: hx(term.red ?? fg) },
          { token: "attribute.name", foreground: hx(term.yellow ?? fg) },
          { token: "attribute.value", foreground: hx(term.green ?? fg) },
        ],
        colors: {
          "editor.background": term.background ?? "#000000",
          "editor.foreground": fg,
          "editorLineNumber.foreground": term.brightBlack ?? fg,
          "editorCursor.foreground": term.cursor ?? fg,
          "editor.selectionBackground": term.selectionBackground ?? "#3a3a3a",
        },
      });
    });
  }

  let booted = false;
  /**
   * Idempotent boot init. Wires self.MonacoEnvironment.getWorker to the local
   * editor.worker (Vite `?worker`), builds the Conduit themes, and selects the
   * default theme. basic-languages Monarch is already registered by the top-level
   * side-effect import above. Imports NO ts/json/css/html language services.
   */
  export function initMonaco(): void {
    if (booted) return;
    booted = true;
    (self as typeof self & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
    };
    defineConduitThemes();
    monaco.editor.setTheme(monacoThemeIdFor(DEFAULT_THEME_ID));
  }

  // File name / extension -> MONACO language id (default "plaintext"). Note this is a
  // DIFFERENT id set than FileViewer's retired Prism map: "shell" not "bash", "html"
  // not "markup", "plaintext" not "text". Reused for both model language and breadcrumb.
  const EXT_LANG: Record<string, string> = {
    ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    json: "json", jsonc: "json",
    rs: "rust",
    py: "python", pyi: "python",
    go: "go",
    rb: "ruby",
    php: "php",
    java: "java",
    kt: "kotlin", kts: "kotlin",
    swift: "swift",
    c: "c", h: "c",
    cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
    cs: "csharp",
    css: "css", scss: "scss", sass: "scss", less: "less",
    html: "html", htm: "html", xml: "xml", svg: "xml", vue: "html", svelte: "html",
    md: "markdown", markdown: "markdown", mdx: "markdown",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
    yml: "yaml", yaml: "yaml",
    toml: "ini",
    sql: "sql",
    graphql: "graphql", gql: "graphql",
    lua: "lua",
    dart: "dart",
    scala: "scala",
    r: "r",
    pl: "perl",
    ex: "elixir", exs: "elixir",
  };

  export function languageFor(path: string): string {
    const name = (path.split("/").pop() || "").toLowerCase();
    if (name.startsWith("dockerfile")) return "dockerfile";
    if (name.startsWith("makefile")) return "makefile";
    if (name === ".gitignore" || name === ".dockerignore" || name === ".env" || name.startsWith(".env."))
      return "shell";
    const ext = name.includes(".") ? name.split(".").pop()! : "";
    return EXT_LANG[ext] ?? "plaintext";
  }
  ```

- [ ] **Step 2: Typecheck.** Run:
  ```bash
  pnpm exec tsc --noEmit
  ```
  Expected: exits 0, no output. (If it errors on `?worker` typing, `src/vite-env.d.ts` already has `/// <reference types="vite/client" />`, which declares the `*?worker` default-export module — confirmed present. If it errors on `MonacoEnvironment`, the explicit `self as typeof self & { MonacoEnvironment: monaco.Environment }` cast covers it.)

- [ ] **Step 3: Commit.**
  ```bash
  git add src/monaco/setup.ts
  git commit -m "$(cat <<'EOF'
  spike(editor): minimal monaco setup (editor.api + basic-languages + editor.worker)

  Hand-wrapped like xterm: slim editor.api, main-thread basic-languages Monarch,
  local editor.worker via Vite ?worker only (no CDN, no language services).
  Builds the 3 Conduit themes from THEMES via defineTheme; ports languageFor to
  Monaco language ids. Throwaway spike; kept as Phase 1 reference.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 0.3 — Throwaway Monaco mount in `WorkspaceCenter` + dev-launch verify

**Files:**
- Create: `src/components/SpikeMonaco.tsx` (THROWAWAY — deleted in Task 0.5)
- Modify: `src/components/WorkspaceCenter.tsx` (import at line 13–15; render inside `.workspace`, after the `.term-stack` block that ends at line 223)

- [ ] **Step 1: Create the throwaway editor component.** Write `src/components/SpikeMonaco.tsx` verbatim. It mounts ONE Monaco editor create-once (mirroring `Terminal.tsx`), exercises `languageFor`, and lets you switch language models + Conduit themes to prove Monarch parity and `defineTheme`/`setTheme`:
  ```tsx
  // src/components/SpikeMonaco.tsx — THROWAWAY (Phase 0 spike). Deleted in the revert task.
  // Mounts ONE Monaco editor as a full-panel overlay with a toolbar to switch language
  // (proves Monarch parity for FileViewer's languages) and theme (proves defineTheme/setTheme).
  import { useEffect, useRef } from "react";
  import { monaco, initMonaco, monacoThemeIdFor, languageFor } from "../monaco/setup";
  import { useStore } from "../store";
  import type { ThemeId } from "../themes";

  interface Sample {
    label: string;
    path: string;
    content: string;
  }

  const SAMPLES: Sample[] = [
    {
      label: "TS",
      path: "sample.ts",
      content:
        'interface User { id: number; name: string }\n' +
        'const greet = (u: User): string => `hi ${u.name}`; // comment\n' +
        'export const answer = 42;\n',
    },
    {
      label: "Rust",
      path: "sample.rs",
      content:
        '// atomic write demo\nuse std::fs;\nfn main() {\n' +
        '    let msg = "hello";\n    let n: u64 = 24 * 1024 * 1024;\n' +
        '    println!("{msg} {n}");\n}\n',
    },
    {
      label: "Python",
      path: "sample.py",
      content: 'def add(a: int, b: int) -> int:\n    """sum"""\n    return a + b  # comment\n\nprint(add(1, 2))\n',
    },
    {
      label: "Go",
      path: "sample.go",
      content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tconst n = 42 // comment\n\tfmt.Println("hi", n)\n}\n',
    },
    {
      label: "JSON",
      path: "sample.json",
      content: '{\n  "name": "conduit",\n  "version": "0.4.0",\n  "nested": { "ok": true, "n": 3 }\n}\n',
    },
    {
      label: "YAML",
      path: "sample.yaml",
      content: '# config\nname: conduit\nlist:\n  - one\n  - two\nnested:\n  enabled: true\n',
    },
    {
      label: "Markdown",
      path: "sample.md",
      content: '# Title\n\nSome **bold** and `code` and a [link](https://example.com).\n\n- item one\n- item two\n',
    },
    {
      label: "Shell",
      path: "sample.sh",
      content: '#!/usr/bin/env bash\nset -euo pipefail\nname="world" # comment\necho "hello $name"\n',
    },
    {
      label: "CSS",
      path: "sample.css",
      content: '.term-stack {\n  position: absolute; /* comment */\n  inset: 0;\n  color: #ce8a6e;\n}\n',
    },
    {
      label: "HTML",
      path: "sample.html",
      content: '<!doctype html>\n<html>\n  <body class="app">\n    <h1>Conduit</h1>\n  </body>\n</html>\n',
    },
  ];

  export function SpikeMonaco() {
    const hostRef = useRef<HTMLDivElement>(null);
    const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const activeThemeId = useStore((s) => s.activeThemeId);

    // Create the editor exactly once (mirrors Terminal.tsx create-once).
    useEffect(() => {
      initMonaco();
      const host = hostRef.current;
      if (!host) return;
      const first = SAMPLES[0];
      const ed = monaco.editor.create(host, {
        model: monaco.editor.createModel(first.content, languageFor(first.path)),
        automaticLayout: true,
        minimap: { enabled: true },
        fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        scrollBeyondLastLine: false,
      });
      monaco.editor.setTheme(monacoThemeIdFor(useStore.getState().activeThemeId));
      edRef.current = ed;
      return () => {
        ed.getModel()?.dispose();
        ed.dispose();
        edRef.current = null;
      };
    }, []);

    // Follow the app theme too (proves setTheme reflects a live Conduit theme change).
    useEffect(() => {
      if (edRef.current) monaco.editor.setTheme(monacoThemeIdFor(activeThemeId));
    }, [activeThemeId]);

    const pick = (s: Sample) => {
      const ed = edRef.current;
      if (!ed) return;
      const old = ed.getModel();
      ed.setModel(monaco.editor.createModel(s.content, languageFor(s.path)));
      old?.dispose();
    };

    const setTheme = (id: ThemeId) => monaco.editor.setTheme(monacoThemeIdFor(id));

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          background: "var(--panel-bg)",
        }}
      >
        <div style={{ display: "flex", gap: 6, padding: 6, flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-dim)", fontSize: 11, alignSelf: "center" }}>SPIKE:</span>
          {SAMPLES.map((s) => (
            <button key={s.path} className="header-btn" onClick={() => pick(s)}>
              {s.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {(["warm-near-black", "warm-dim", "warm-light"] as ThemeId[]).map((id) => (
            <button key={id} className="header-btn" onClick={() => setTheme(id)}>
              {id}
            </button>
          ))}
        </div>
        <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
      </div>
    );
  }
  ```

- [ ] **Step 2: Wire the throwaway mount into `WorkspaceCenter`.** Two edits.

  Edit A — add the import next to the existing component imports. The file currently reads (lines 13–15):
  ```tsx
  import { TerminalView } from "./Terminal";
  import { FileViewer } from "./FileViewer";
  import { TerminalIcon, FileIcon, CodeIcon, CloseIcon, SplitIcon } from "./Icons";
  ```
  Change to:
  ```tsx
  import { TerminalView } from "./Terminal";
  import { FileViewer } from "./FileViewer";
  import { SpikeMonaco } from "./SpikeMonaco"; // THROWAWAY (Phase 0 spike) — removed in revert task
  import { TerminalIcon, FileIcon, CodeIcon, CloseIcon, SplitIcon } from "./Icons";

  // THROWAWAY (Phase 0 spike): full-panel Monaco overlay to validate offline load,
  // Monarch parity, and theme sync. Flip to false / remove in the revert task.
  const SPIKE_MONACO = true;
  ```

  Edit B — render the overlay inside `.workspace`, immediately after the `.term-stack` closing `</div>` (line 223) and before the `{/* Right-edge drop zone... */}` comment (line 225). The file currently reads:
  ```tsx
          {activeFiles.map((f) => (
            <FileViewer
              key={projectId + "::" + f.ref}
              path={f.ref}
              visible={f.visible}
              style={{ left: `${geom[f.gi].left}%`, width: `${geom[f.gi].width}%` }}
            />
          ))}
        </div>

        {/* Right-edge drop zone: drag a tab here to split it into a new group. */}
  ```
  Change to:
  ```tsx
          {activeFiles.map((f) => (
            <FileViewer
              key={projectId + "::" + f.ref}
              path={f.ref}
              visible={f.visible}
              style={{ left: `${geom[f.gi].left}%`, width: `${geom[f.gi].width}%` }}
            />
          ))}
        </div>

        {/* THROWAWAY (Phase 0 spike) — remove in the revert task. */}
        {SPIKE_MONACO && <SpikeMonaco />}

        {/* Right-edge drop zone: drag a tab here to split it into a new group. */}
  ```

- [ ] **Step 3: Typecheck.** Run:
  ```bash
  pnpm exec tsc --noEmit
  ```
  Expected: exits 0, no output.

- [ ] **Step 4: MANUAL dev verify (required — no frontend test runner).** Launch the dev app with the isolated data dir so it never clobbers the installed Conduit's `state.json`:
  ```bash
  CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
  ```
  Expected on-screen:
  - A full-panel editor overlay covers the workspace, with a toolbar row: `SPIKE:` then buttons `TS Rust Python Go JSON YAML Markdown Shell CSS HTML`, then three theme buttons on the right.
  - The editor shows the TypeScript sample with **line numbers, a minimap on the right, syntax highlighting** (the `interface`/`const`/`export` keywords tinted, the template string green-ish, the `// comment` italic dim), and the **editor background matches the active Conduit theme** (warm-near-black → `#151110`).
  - Clicking each language button reloads the editor with that language's sample and **highlights it correctly** (Rust `fn`/`use`/`let`/strings; Python `def`/docstring/`# comment`; Go `func`/`package`/`import`; YAML keys vs values; Markdown heading/bold/link; Shell shebang/`echo`/vars; CSS selectors/props/`#hex`; HTML tags/attributes; JSON keys/values). This confirms **Monarch highlighting parity for every language `FileViewer` covered**.
  - Clicking `warm-dim` / `warm-light` / `warm-near-black` **recolors the editor instantly** (background + token colors change), and switching the app theme from the app's own theme control also recolors it — confirming `monaco.editor.defineTheme` + `setTheme` reflect a Conduit theme live.
  - Open devtools (right-click → Inspect) → Console: **no** `Could not create web worker` warning and **no** worker/CSP errors. This is the local `editor.worker` succeeding under dev.
  Stop the dev app (Ctrl-C) before committing.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/components/SpikeMonaco.tsx src/components/WorkspaceCenter.tsx
  git commit -m "$(cat <<'EOF'
  spike(editor): throwaway monaco mount with multi-language sample

  Full-panel overlay in WorkspaceCenter mounting one create-once Monaco editor
  with language + theme switchers. Dev-verified: Monarch parity across the
  FileViewer language set and live defineTheme/setTheme for the 3 Conduit themes,
  editor.worker OK in dev. Throwaway; reverted after the offline gate.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 0.4 — CRITICAL offline gate: packaged `tauri build`, Wi-Fi OFF, record findings + lock the import choice

**Files:**
- Modify: `src/monaco/setup.ts` (top import — only if the slim `editor.api` fails the packaged gate; and always: append a `SPIKE FINDINGS` note block at the end recording the locked choice)

> This is the gate the whole feature hangs on (§14): Monaco workers must load **offline** in a real packaged build under Tauri's asset protocol — unverifiable by `tsc`, so it must be built and run. `tauri.conf.json` has `csp:null`, which already permits blob/module workers.

- [ ] **Step 1: Produce a packaged build.** Run:
  ```bash
  pnpm tauri build
  ```
  Expected: `tsc && vite build` succeeds (Monaco chunk emitted; note the first-build/cold-start cost is larger — acceptable per §14), then the Tauri bundler produces `src-tauri/target/release/bundle/macos/Conduit.app` (and a `.dmg` under `bundle/dmg/`). Confirm the app bundle exists:
  ```bash
  ls -la src-tauri/target/release/bundle/macos/Conduit.app
  ```
  Expected: the `.app` directory is listed.

- [ ] **Step 2: THE OFFLINE GATE — launch with Wi-Fi OFF.** Turn Wi-Fi **off** (and unplug Ethernet) on the machine, then open the packaged app directly (isolate its data dir so it can't touch the installed app's state):
  ```bash
  CONDUIT_DATA_DIR_NAME=ConduitTauri-dev open src-tauri/target/release/bundle/macos/Conduit.app
  ```
  Expected on-screen, with **no network**:
  - The same full-panel Monaco overlay appears and the editor **renders with syntax highlighting** exactly as in dev.
  - Every language button still highlights correctly (Monarch is main-thread + bundled) and every theme button still recolors — confirming **offline Monarch parity + defineTheme/setTheme in the packaged build**.
  - Open the packaged devtools console (if release devtools are disabled, temporarily re-enable via `tauri.conf.json`'s dev tooling or run the check under the dev build with Wi-Fi off as a fallback): **no** request to any CDN (`jsdelivr`, `unpkg`, `cdnjs`), **no** `Could not create web worker`, **no** failed `tauri://localhost/...worker` fetch. The `editor.worker` loaded from the local bundle. **This passing is the gate that unblocks Phase 1.**

- [ ] **Step 3: Lock the import decision.** If Step 2 passed with the slim `editor.api` import, keep it. If the editor was **blank / threw a worker or module-resolution error only in the packaged build**, switch `src/monaco/setup.ts`'s first import from:
  ```ts
  import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
  ```
  to the full entry (still `editor.worker`-only — do **not** add language workers):
  ```ts
  import * as monaco from "monaco-editor";
  ```
  Then re-run Steps 1–2 to confirm the full import passes the offline gate. Record whichever import survived as the **locked Phase 1 choice** in the findings note (Step 4).

- [ ] **Step 4: Record findings as Phase 1 notes.** Append this block to the END of `src/monaco/setup.ts` (fill the bracketed results with the actual observations from Steps 1–3 — replace them with concrete text, e.g. `PASS`/`FAIL` and the chosen import):
  ```ts
  // ─────────────────────────────────────────────────────────────────────────────
  // SPIKE FINDINGS (Phase 0 — gate for Phase 1). Do not delete; these are the
  // locked decisions Phase 1 builds on.
  //   • Offline packaged build (Wi-Fi OFF): [PASS/FAIL] — editor + editor.worker
  //     loaded from the local bundle under tauri://localhost, no CDN fetch.
  //   • Locked import: [`monaco-editor/esm/vs/editor/editor.api` (slim)  OR
  //     `monaco-editor` (full)] — editor.worker ONLY, no language services/workers.
  //   • Monarch parity: [PASS/FAIL] for ts/rust/python/go/json/yaml/markdown/
  //     shell/css/html (the FileViewer language set).
  //   • defineTheme + setTheme reflect the 3 Conduit themes: [PASS/FAIL].
  //   • vite optimizeDeps.include:["monaco-editor"]: [required/not-required] for
  //     the packaged worker resolution.
  // ─────────────────────────────────────────────────────────────────────────────
  ```

- [ ] **Step 5: Turn Wi-Fi back on. Typecheck + commit findings.**
  ```bash
  pnpm exec tsc --noEmit
  ```
  Expected: exits 0. Then:
  ```bash
  git add src/monaco/setup.ts
  git commit -m "$(cat <<'EOF'
  chore(editor): spike — monaco editor.worker verified offline in packaged tauri

  Gate result (design §14): pnpm tauri build launched with Wi-Fi OFF still loads
  the editor and its editor.worker from the local bundle (no CDN). Recorded the
  locked import choice, Monarch parity, and defineTheme/setTheme results as
  Phase 1 notes in setup.ts. Unblocks Phase 1.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 0.5 — Revert the throwaway mount (keep validated `setup.ts` as Phase 1 notes)

**Files:**
- Modify: `src/components/WorkspaceCenter.tsx` (remove the import + `SPIKE_MONACO` flag + overlay render added in Task 0.3 — restore to the original `FileViewer`-only workspace)
- Delete: `src/components/SpikeMonaco.tsx`
- Keep (do NOT touch): `src/monaco/setup.ts` (now carrying the findings notes), the `monaco-editor` dep, and the `vite.config.ts` `optimizeDeps` change — these are the validated pieces Phase 1 reuses.

> Per phase scope: revert **only the throwaway mount**. `setup.ts`, the dependency, and the Vite change are the validated harness and stay as the recorded Phase 1 reference. Note that after this task nothing imports `setup.ts`, so Vite tree-shakes it out of the bundle (zero boot cost until Phase 1 wires `initMonaco()` at startup).

- [ ] **Step 1: Restore `WorkspaceCenter` imports.** Revert Edit A from Task 0.3 — change:
  ```tsx
  import { TerminalView } from "./Terminal";
  import { FileViewer } from "./FileViewer";
  import { SpikeMonaco } from "./SpikeMonaco"; // THROWAWAY (Phase 0 spike) — removed in revert task
  import { TerminalIcon, FileIcon, CodeIcon, CloseIcon, SplitIcon } from "./Icons";

  // THROWAWAY (Phase 0 spike): full-panel Monaco overlay to validate offline load,
  // Monarch parity, and theme sync. Flip to false / remove in the revert task.
  const SPIKE_MONACO = true;
  ```
  back to:
  ```tsx
  import { TerminalView } from "./Terminal";
  import { FileViewer } from "./FileViewer";
  import { TerminalIcon, FileIcon, CodeIcon, CloseIcon, SplitIcon } from "./Icons";
  ```

- [ ] **Step 2: Restore the `.workspace` render.** Revert Edit B from Task 0.3 — change:
  ```tsx
          ))}
        </div>

        {/* THROWAWAY (Phase 0 spike) — remove in the revert task. */}
        {SPIKE_MONACO && <SpikeMonaco />}

        {/* Right-edge drop zone: drag a tab here to split it into a new group. */}
  ```
  back to:
  ```tsx
          ))}
        </div>

        {/* Right-edge drop zone: drag a tab here to split it into a new group. */}
  ```

- [ ] **Step 3: Delete the throwaway component.**
  ```bash
  git rm src/components/SpikeMonaco.tsx
  ```

- [ ] **Step 4: Typecheck.** Run:
  ```bash
  pnpm exec tsc --noEmit
  ```
  Expected: exits 0, no output. (`setup.ts` remains and still typechecks even though nothing imports it — `noUnusedLocals` applies within a module, not across the project, so an unimported module is fine.)

- [ ] **Step 5: MANUAL verify the baseline is restored.** Launch the dev app isolated:
  ```bash
  CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
  ```
  Expected on-screen: **no Monaco overlay** — the workspace is back to the pre-spike behavior: opening a file tab renders the read-only `FileViewer` (Prism) exactly as before, terminals and splits behave normally. Confirm `src/monaco/setup.ts` still exists on disk (`ls src/monaco/setup.ts` → the file is listed). Stop the dev app (Ctrl-C).

- [ ] **Step 6: Commit the revert.**
  ```bash
  git add src/components/WorkspaceCenter.tsx
  git commit -m "$(cat <<'EOF'
  chore(editor): revert monaco spike mount; keep setup.ts as phase-1 notes

  Removes the throwaway SpikeMonaco overlay and its WorkspaceCenter wiring,
  restoring the FileViewer baseline. Keeps the validated src/monaco/setup.ts
  (with recorded spike findings), the monaco-editor dep, and vite optimizeDeps
  as the Phase 1 foundation. Ends the Phase 0 spike.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Phase 1 — Core edit/save

This phase builds the whole open→edit→save loop: hardened Rust `read_file`, a new atomic `write_file`, the Monaco boot/setup + a framework-agnostic model registry (vitest-tested), the per-group `CodeEditorPane`, the store save/dirty/close plumbing, the `FileViewer`→`CodeEditorPane` swap with theme sync, and the retirement of `FileViewer`. Rust and the registry use strict red-green TDD; all UI is launch-verified because the frontend has no test runner.

Branch is `feat/monaco-editor` (create it if not already on it). Do **not** bump the app version.

---

### Task 1 — Harden `read_file` (error / strict UTF-8 / size tiers) with a pure `classify` helper

Rewrites the read contract to the `FileContent` shape from the contracts and extracts a pure, unit-tested `classify` so tiering/UTF-8/binary logic is covered by `cargo test`. Signature stays infallible (errors carried in `.error`).

**Files:**
- Modify `src-tauri/src/fsops.rs` (imports at 3-5; `FileContent` struct 41-47; `read_file` 49-78; append a `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests (RED).** Append this test module to the end of `src-tauri/src/fsops.rs` (after the closing `}` of `read_file`). It references `classify`, the new `FileContent` fields, and a temp-dir helper that do not exist yet.

```rust

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh unique dir under the OS temp dir (no external crate).
    fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "conduit-fsops-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn classify_small_utf8_is_editable() {
        let c = classify(b"hello world\n", 12);
        assert_eq!(c.content, "hello world\n");
        assert!(!c.binary);
        assert!(!c.read_only);
        assert!(!c.truncated);
    }

    #[test]
    fn classify_nul_is_binary_readonly() {
        let c = classify(b"ab\0cd", 5);
        assert!(c.binary);
        assert!(c.read_only);
        assert!(!c.truncated);
    }

    #[test]
    fn classify_invalid_utf8_is_readonly_preview() {
        // 0xFF/0xFE are invalid UTF-8 with no NUL — the non-UTF-8 (read-only preview) path.
        let c = classify(&[0xff, 0xfe, b'A'], 3);
        assert!(!c.binary);
        assert!(c.read_only);
        assert!(c.content.contains('\u{FFFD}'));
    }

    #[test]
    fn classify_large_tier_is_readonly_not_truncated() {
        // 10 MB on-disk (8..=24 MB tier): loaded but read-only, not truncated.
        let c = classify(b"data", 10 * 1024 * 1024);
        assert!(!c.binary);
        assert!(c.read_only);
        assert!(!c.truncated);
        assert_eq!(c.content, "data");
    }

    #[test]
    fn classify_oversized_is_truncated_readonly() {
        let c = classify(b"data", 30 * 1024 * 1024);
        assert!(c.truncated);
        assert!(c.read_only);
        assert!(!c.binary);
    }

    #[test]
    fn read_file_small_utf8_editable() {
        let dir = unique_temp_dir("read-small");
        let p = dir.join("hello.txt");
        fs::write(&p, b"hi there\n").unwrap();
        let fc = read_file(p.to_str().unwrap());
        assert_eq!(fc.content, "hi there\n");
        assert!(!fc.read_only);
        assert!(!fc.binary);
        assert!(fc.error.is_none());
        assert_eq!(fc.size, 9);
        assert!(fc.mtime_ms > 0.0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_file_missing_sets_error_not_content() {
        let fc = read_file("/no/such/conduit/path/file-xyz.txt");
        assert!(fc.error.is_some());
        assert_eq!(fc.content, "");
    }
}
```

- [ ] **Step 2: Run the tests, expect FAIL.** Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: **compile error / FAIL** — `cannot find function 'classify'`, `no field 'read_only' on FileContent`, and unresolved `SystemTime`/`UNIX_EPOCH`.

- [ ] **Step 3: Implement the new read contract (GREEN).** First widen the imports — replace lines 3-5:

```rust
use std::fs;
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
```

Then replace the entire old `FileContent` struct + `read_file` block (current lines 41-78) with:

```rust
// ---- read contract --------------------------------------------------------

/// Fully editable up to 8 MB.
const EDIT_CAP: usize = 8 * 1024 * 1024;
/// Loaded (read-only) up to 24 MB; beyond this the first 24 MB is shown, truncated.
const HARD_CAP: usize = 24 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub binary: bool,
    /// Buffer must never be written back (binary / oversized / truncated / non-UTF-8).
    pub read_only: bool,
    /// True on-disk size in bytes (metadata, not the possibly-truncated read length).
    pub size: u64,
    /// Modification time in fractional epoch-milliseconds (sub-ms nanos precision).
    pub mtime_ms: f64,
    /// Some(msg) on read failure — content stays empty so no message leaks into a buffer.
    pub error: Option<String>,
}

/// Modification time as fractional epoch-ms. Computed identically here, in `write_file`,
/// and (Phase 2) `stat_file`, so JS `{mtimeMs,size}` baselines compare equal.
fn mtime_ms_of(meta: &fs::Metadata) -> f64 {
    match meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    {
        Some(d) => d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1_000_000.0,
        None => 0.0,
    }
}

struct Classified {
    content: String,
    truncated: bool,
    binary: bool,
    read_only: bool,
}

/// Pure classification of already-read bytes into the editor text payload — split out so
/// tiering / UTF-8 / binary rules are unit-testable without the filesystem. `size` is the
/// TRUE on-disk length (drives the 8/24 MB tiers); `data` is what was read (capped at
/// HARD_CAP by the caller).
fn classify(data: &[u8], size: u64) -> Classified {
    // Crude binary sniff: a NUL byte in the first 8 KB.
    let sniff = &data[..data.len().min(8192)];
    if sniff.contains(&0) {
        return Classified {
            content: "(binary file — not shown)".into(),
            truncated: false,
            binary: true,
            read_only: true,
        };
    }
    // Oversized: keep the first 24 MB, read-only + truncated (lossy: a cut can split a codepoint).
    if size as usize > HARD_CAP {
        let slice = &data[..data.len().min(HARD_CAP)];
        return Classified {
            content: String::from_utf8_lossy(slice).into_owned(),
            truncated: true,
            binary: false,
            read_only: true,
        };
    }
    // Strict UTF-8: invalid bytes get a lossy PREVIEW and are never editable, so a
    // Latin-1/CP-1252 file can't be re-saved with U+FFFD substitutions destroying the original.
    match std::str::from_utf8(data) {
        Ok(s) => Classified {
            content: s.to_owned(),
            truncated: false,
            binary: false,
            read_only: size as usize > EDIT_CAP, // 8..=24 MB: loaded but read-only
        },
        Err(_) => Classified {
            content: String::from_utf8_lossy(data).into_owned(),
            truncated: false,
            binary: false,
            read_only: true,
        },
    }
}

/// Read a file for the editor. Infallible at the IPC layer: on failure `error` is set and
/// `content` stays empty.
pub fn read_file(path: &str) -> FileContent {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return err_content(format!("could not read file: {e}")),
    };
    let size = meta.len();
    let mtime_ms = mtime_ms_of(&meta);

    // Read at most HARD_CAP bytes so a giant file never exhausts memory.
    let mut data = Vec::new();
    match fs::File::open(path) {
        Ok(f) => {
            if let Err(e) = f.take(HARD_CAP as u64).read_to_end(&mut data) {
                return err_content(format!("could not read file: {e}"));
            }
        }
        Err(e) => return err_content(format!("could not read file: {e}")),
    }

    let c = classify(&data, size);
    FileContent {
        content: c.content,
        truncated: c.truncated,
        binary: c.binary,
        read_only: c.read_only,
        size,
        mtime_ms,
        error: None,
    }
}

fn err_content(msg: String) -> FileContent {
    FileContent {
        content: String::new(),
        truncated: false,
        binary: false,
        read_only: true,
        size: 0,
        mtime_ms: 0.0,
        error: Some(msg),
    }
}
```

- [ ] **Step 4: Run the tests, expect PASS.** Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: **PASS** — all seven `fsops::tests::*` pass. (`FileViewer.tsx` still compiles: its local `FileContent` interface ignores the new JSON keys; the only transient behavior change is that an unreadable file shows empty content instead of the old placeholder — resolved when `FileViewer` is retired in Task 8.)

- [ ] **Step 5: Format + commit.** Run `cargo fmt --manifest-path src-tauri/Cargo.toml`, then:

```bash
git add src-tauri/src/fsops.rs && git commit -m "fix(fsops): harden read_file contract (error/utf-8/size tiers)

Add size/mtimeMs/readOnly/error to FileContent; strict from_utf8 with lossy
preview for non-UTF-8; 8MB editable / 24MB read-only / >24MB truncated tiers.
Extract pure classify() and cover it with unit tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2 — Add atomic `write_file` + `FileStat`, register the command

std::fs-only atomic save: reject missing parent, sibling temp + `sync_all` + preserved Unix mode + `fs::rename`, returning the post-rename `FileStat`.

**Files:**
- Modify `src-tauri/src/fsops.rs` (add `FileStat` + `write_file` after `err_content`; extend the imports; add write tests to the `tests` mod)
- Modify `src-tauri/src/lib.rs` (add wrapper after `read_file` at 469-472; register in `generate_handler!` after `read_file,` at line 685)

- [ ] **Step 1: Write the failing tests (RED).** In `src-tauri/src/fsops.rs`, inside the existing `mod tests`, add these three tests immediately after `read_file_missing_sets_error_not_content` (before the mod's closing `}`):

```rust

    #[test]
    fn write_file_atomic_replace() {
        let dir = unique_temp_dir("write-replace");
        let p = dir.join("note.txt");
        fs::write(&p, b"old contents").unwrap();
        let stat = write_file(p.to_str().unwrap(), "new contents").expect("write ok");
        assert!(stat.exists);
        assert_eq!(stat.size, "new contents".len() as u64);
        assert_eq!(fs::read_to_string(&p).unwrap(), "new contents");
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn write_file_preserves_unix_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_temp_dir("write-mode");
        let p = dir.join("script.sh");
        fs::write(&p, b"#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        write_file(p.to_str().unwrap(), "#!/bin/sh\necho bye\n").expect("write ok");
        let mode = fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_file_rejects_missing_parent() {
        let dir = unique_temp_dir("write-missing");
        let p = dir.join("ghost-dir").join("file.txt");
        let res = write_file(p.to_str().unwrap(), "data");
        assert!(res.is_err());
        fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **Step 2: Run the tests, expect FAIL.** Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml write_file
```

Expected: **compile error / FAIL** — `cannot find function 'write_file'`, `cannot find type 'FileStat'`.

- [ ] **Step 3: Implement `write_file` + `FileStat` (GREEN).** Widen the io import — replace line 4 (`use std::io::Read;`) with:

```rust
use std::io::{Read, Write};
```

Then insert this block immediately after the `err_content` function (before the `#[cfg(test)]` module):

```rust

// ---- write contract (atomic, std-only) ------------------------------------

/// Size + mtime of a path. Shared by `write_file` (returns it, `exists:true`) and the
/// Phase 2 `stat_file`. `mtime_ms`/`size` are 0 and `exists:false` when the path is gone.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime_ms: f64,
    pub size: u64,
    pub exists: bool,
}

/// Atomically overwrite `path` with `content`. std::fs only. Rejects a missing parent dir
/// (a save must never conjure directories). Writes a sibling temp, fsyncs it, reapplies the
/// target's Unix mode, then `fs::rename`s it into place (atomic same-fs replace). Returns
/// the post-rename stat.
pub fn write_file(path: &str, content: &str) -> Result<FileStat, String> {
    let target = std::path::Path::new(path);
    let parent = target
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err(format!(
            "parent directory does not exist: {}",
            parent.display()
        ));
    }
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{name}.conduit-tmp-{}-{nanos}", std::process::id()));

    // Write + flush + fsync the temp so a crash can't leave a half-written target.
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create temp failed: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("write temp failed: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync temp failed: {e}"))?;
    }

    // Reapply the existing file's mode (a fresh temp is 0600 and would strip +x off scripts).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(target) {
            let _ =
                fs::set_permissions(&tmp, fs::Permissions::from_mode(meta.permissions().mode()));
        }
    }

    // Atomic replace. Clean up the temp on failure so we don't litter.
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("atomic rename failed: {e}"));
    }

    let meta = fs::metadata(target).map_err(|e| format!("post-write stat failed: {e}"))?;
    Ok(FileStat {
        mtime_ms: mtime_ms_of(&meta),
        size: meta.len(),
        exists: true,
    })
}
```

- [ ] **Step 4: Run the tests, expect PASS.** Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: **PASS** — all `fsops::tests::*` including the three write tests.

- [ ] **Step 5: Register the command.** In `src-tauri/src/lib.rs`, add the wrapper right after the `read_file` wrapper (after line 472):

```rust

#[tauri::command]
fn write_file(path: String, content: String) -> Result<fsops::FileStat, String> {
    fsops::write_file(&path, &content)
}
```

Then in the `tauri::generate_handler![` list, add `write_file,` on the line directly after `read_file,` (line 685):

```rust
            read_file,
            write_file,
```

- [ ] **Step 6: Verify the build.** Run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: **compiles clean** (Cargo.lock untouched — no new crates).

- [ ] **Step 7: Format + commit.** Run `cargo fmt --manifest-path src-tauri/Cargo.toml`, then:

```bash
git add src-tauri/src/fsops.rs src-tauri/src/lib.rs && git commit -m "feat(fsops): add atomic write_file + FileStat, register command

std::fs-only save: reject missing parent, sibling temp + sync_all + preserved
Unix mode + fs::rename, returns post-rename FileStat. Tested for atomic replace,
mode preservation, and missing-parent rejection.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 — Add vitest and the framework-agnostic model registry (TDD)

Adds vitest (dev-only) and builds `src/monaco/registry.ts` per the registry contract. The registry deliberately imports **no** monaco (so vitest runs with a fake model, no DOM); the real factory is injected by `initMonaco` in Task 4 via `setModelFactory`.

**Files:**
- Modify `package.json` (add `vitest` devDep + `"test"` script)
- Create `vitest.config.ts`
- Create `src/monaco/registry.test.ts`
- Create `src/monaco/registry.ts`

- [ ] **Step 1: Install vitest + wire the script/config.** Run:

```bash
pnpm add -D vitest
```

Add the test script to `package.json` `scripts` (after the `"tauri"` line):

```json
    "tauri": "tauri",
    "test": "vitest run"
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Node env only — the registry is framework-agnostic and never imports monaco,
// so its ref-count / dirty logic is exercised with a fake model (no DOM).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write the failing tests (RED).** Create `src/monaco/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  acquire,
  release,
  ensureModel,
  model,
  dirtyOf,
  setSaved,
  disposeIfUnreferenced,
  setModelFactory,
  saving,
  type RegistryModel,
  type ModelFactory,
} from "./registry";

// A fake ITextModel: version id bumps on every edit; jumpTo walks it back (undo-to-saved).
class FakeModel implements RegistryModel {
  version = 1;
  value = "";
  disposed = false;
  private listeners = new Set<() => void>();
  getValue() {
    return this.value;
  }
  getAlternativeVersionId() {
    return this.version;
  }
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
  dispose() {
    this.disposed = true;
  }
  edit() {
    this.version += 1;
    this.value += "x";
    this.listeners.forEach((l) => l());
  }
  jumpTo(v: number) {
    this.version = v;
    this.listeners.forEach((l) => l());
  }
}

let last: FakeModel;
let created = 0;
const fakeFactory: ModelFactory = () => {
  last = new FakeModel();
  created += 1;
  return last;
};

const B = { mtimeMs: 1, size: 1 };
function init() {
  return { value: "seed", languageId: "plaintext", readOnly: false, baseline: B };
}

beforeEach(() => {
  setModelFactory(fakeFactory);
  saving.clear();
  created = 0;
});

describe("registry ref-counting", () => {
  it("acquire/release track the count and only dispose at zero", () => {
    expect(acquire("/a")).toBe(1);
    expect(acquire("/a")).toBe(2);
    ensureModel("/a", init());
    expect(release("/a")).toBe(1);
    expect(disposeIfUnreferenced("/a")).toBe(false); // still referenced
    expect(model("/a")).toBeDefined();
    expect(release("/a")).toBe(0);
    expect(disposeIfUnreferenced("/a")).toBe(true); // now reclaimed
    expect(last.disposed).toBe(true);
    expect(model("/a")).toBeUndefined();
  });
});

describe("registry dirty logic (version-id idiom)", () => {
  it("is clean at load, dirty after an edit, clean again after undo-to-saved", () => {
    acquire("/b");
    ensureModel("/b", init());
    expect(dirtyOf("/b")).toBe(false);
    last.edit();
    expect(dirtyOf("/b")).toBe(true);
    last.jumpTo(1); // undo back to the saved version id
    expect(dirtyOf("/b")).toBe(false);
  });

  it("setSaved marks the current version as clean", () => {
    acquire("/c");
    ensureModel("/c", init());
    last.edit();
    expect(dirtyOf("/c")).toBe(true);
    setSaved("/c", { mtimeMs: 2, size: 2 });
    expect(dirtyOf("/c")).toBe(false);
  });

  it("dirtyOf is false when there is no loaded model", () => {
    acquire("/d"); // refCount only, no ensureModel
    expect(dirtyOf("/d")).toBe(false);
  });
});

describe("registry model reuse", () => {
  it("ensureModel is a no-op when a model already exists (no double read)", () => {
    acquire("/e");
    const m1 = ensureModel("/e", init()).model;
    const m2 = ensureModel("/e", init()).model;
    expect(m2).toBe(m1);
    expect(created).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests, expect FAIL.** Run:

```bash
pnpm test
```

Expected: **FAIL** — `Failed to resolve import "./registry"` (the module does not exist yet).

- [ ] **Step 4: Implement the registry (GREEN).** Create `src/monaco/registry.ts`:

```ts
// Framework-agnostic, path-keyed Monaco model registry — the one source of truth for
// buffers, dirty state, view state, and ref-counts. NO static monaco import, so vitest
// exercises this with a fake model (no DOM). The real model factory is injected by
// monaco/setup.ts initMonaco via setModelFactory.

export interface RegistryModel {
  getValue(): string;
  getAlternativeVersionId(): number;
  onDidChangeContent(listener: () => void): { dispose(): void };
  dispose(): void;
}

export type ModelFactory = (path: string, value: string, languageId: string) => RegistryModel;

export interface Baseline {
  mtimeMs: number;
  size: number;
}

export interface RegistryEntry {
  model: RegistryModel | null;
  savedVersionId: number;
  viewStates: Map<string, unknown>;
  baseline: Baseline;
  refCount: number;
  readOnly: boolean;
}

const entries = new Map<string, RegistryEntry>();

/** In-flight write guard: saveFile add()s before write_file and delete()s after;
 *  the Phase 2 watcher skips any path in this set (closes the save-vs-poll race). */
export const saving: Set<string> = new Set();

let modelFactory: ModelFactory = () => {
  throw new Error("registry: model factory not configured — call initMonaco/setModelFactory first");
};

export function setModelFactory(factory: ModelFactory): void {
  modelFactory = factory;
}

function blankEntry(baseline: Baseline, readOnly: boolean): RegistryEntry {
  return { model: null, savedVersionId: 0, viewStates: new Map(), baseline, refCount: 0, readOnly };
}

export function acquire(path: string): number {
  let e = entries.get(path);
  if (!e) {
    e = blankEntry({ mtimeMs: 0, size: 0 }, false);
    entries.set(path, e);
  }
  e.refCount += 1;
  return e.refCount;
}

export function release(path: string): number {
  const e = entries.get(path);
  if (!e) return 0;
  e.refCount -= 1;
  return e.refCount;
}

export function ensureModel(
  path: string,
  init: { value: string; languageId: string; readOnly: boolean; baseline: Baseline },
): RegistryEntry {
  let e = entries.get(path);
  if (!e) {
    e = blankEntry(init.baseline, init.readOnly);
    entries.set(path, e);
  }
  if (!e.model) {
    e.model = modelFactory(path, init.value, init.languageId);
    e.savedVersionId = e.model.getAlternativeVersionId();
    e.baseline = init.baseline;
    e.readOnly = init.readOnly;
    e.viewStates = new Map();
  }
  return e;
}

export function model(path: string): RegistryEntry | undefined {
  return entries.get(path);
}

/** Canonical dirty check: reports CLEAN after undo back to the saved state. */
export function dirtyOf(path: string): boolean {
  const e = entries.get(path);
  if (!e || !e.model) return false;
  return e.model.getAlternativeVersionId() !== e.savedVersionId;
}

export function setSaved(path: string, baseline: Baseline): void {
  const e = entries.get(path);
  if (!e || !e.model) return;
  e.savedVersionId = e.model.getAlternativeVersionId();
  e.baseline = baseline;
}

export function baseline(path: string): Baseline | undefined {
  return entries.get(path)?.baseline;
}

export function setBaseline(path: string, baseline: Baseline): void {
  const e = entries.get(path);
  if (e) e.baseline = baseline;
}

export function getViewState(path: string, groupId: string): unknown | undefined {
  return entries.get(path)?.viewStates.get(`${groupId}::${path}`);
}

export function setViewState(path: string, groupId: string, state: unknown): void {
  const e = entries.get(path);
  if (e) e.viewStates.set(`${groupId}::${path}`, state);
}

/** THE only place a model is ever disposed. No-op unless refCount<=0. */
export function disposeIfUnreferenced(path: string): boolean {
  const e = entries.get(path);
  if (!e) return false;
  if (e.refCount <= 0) {
    e.model?.dispose();
    entries.delete(path);
    return true;
  }
  return false;
}
```

- [ ] **Step 5: Run the tests, expect PASS.** Run:

```bash
pnpm test
```

Expected: **PASS** — all registry specs green.

- [ ] **Step 6: Typecheck + commit.** Run `pnpm exec tsc --noEmit` (expect no errors), then:

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/monaco/registry.ts src/monaco/registry.test.ts && git commit -m "test(editor): add vitest + framework-agnostic model registry

Path-keyed model registry with ref-counting, version-id dirty logic, view-state,
and an injectable model factory. Covered by vitest with a fake model (no DOM).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 — Monaco setup: worker wiring, languages, themes, boot init + theme bridge

Adds `monaco-editor`, builds `src/monaco/setup.ts` (single monaco import source, hand-wrapped like xterm), decouples `themes.ts` from monaco via a lazily-registered setter, wires `optimizeDeps`, and calls `initMonaco()` at boot. No test runner — verified by `tsc` + launch.

**Files:**
- Modify `package.json` (add `monaco-editor` dep — via `pnpm add`)
- Create `src/monaco/setup.ts`
- Modify `src/themes.ts` (add `registerMonacoThemeSetter` + `currentThemeId`; call the setter in `applyTheme` at 260-263)
- Modify `src/main.tsx` (import + call `initMonaco` after `applyTheme`, 5-11)
- Modify `vite.config.ts` (add `optimizeDeps.include`)

- [ ] **Step 1: Install monaco-editor.** Run:

```bash
pnpm add monaco-editor
```

- [ ] **Step 2: Add the themes.ts bridge.** In `src/themes.ts`, insert these exports directly above `applyTheme` (before line 251 `// ---- the one mutation...`):

```ts
// ---- Monaco theme bridge ----
// Registered lazily by monaco/setup.ts initMonaco so themes.ts never imports monaco
// (avoids a themes.ts -> monaco cycle at boot). Null until Monaco is loaded.
let monacoThemeSetter: ((id: ThemeId) => void) | null = null;

export function registerMonacoThemeSetter(fn: (id: ThemeId) => void): void {
  monacoThemeSetter = fn;
}

/** The currently-applied theme id (used by initMonaco to set Monaco's theme at boot). */
export function currentThemeId(): ThemeId {
  return currentId;
}
```

Then, inside `applyTheme`, add the guarded Monaco recolor after the terminal loop — replace the tail of the function:

```ts
  for (const term of liveTerminals) {
    term.options.theme = theme.terminal;
    term.refresh(0, term.rows - 1);
  }
  // Recolor the Monaco editors too — one global setTheme, guarded until Monaco loads.
  monacoThemeSetter?.(id);
}
```

- [ ] **Step 3: Create the setup module.** Create `src/monaco/setup.ts`:

```ts
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
// Main-thread Monarch tokenizers (cover the languages FileViewer handled). No TS/JSON/
// CSS/HTML language services — we don't want diagnostics/IntelliSense/built-in formatting.
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
// Local editor worker ONLY, bundled offline via Vite ?worker.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { THEMES, type ThemeId, registerMonacoThemeSetter, currentThemeId } from "../themes";
import { setModelFactory } from "./registry";

// Single monaco import source, re-exported (hand-wrapped like xterm; no @monaco-editor/react, no CDN).
export { monaco };

// File name / extension -> MONACO language id (default "plaintext"). Note this is a
// different id set than the retired FileViewer Prism map ("shell" not "bash", "html"
// not "markup", "plaintext" not "text").
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json", jsonc: "json",
  rs: "rust",
  py: "python", pyi: "python",
  go: "go",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp",
  css: "css", scss: "scss", sass: "scss", less: "less",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "html", svelte: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  yml: "yaml", yaml: "yaml",
  toml: "ini",
  sql: "sql",
  graphql: "graphql", gql: "graphql",
  lua: "lua",
  dart: "dart",
  scala: "scala",
  r: "r",
  pl: "perl",
  ex: "elixir", exs: "elixir",
};

/** Monaco language id for a path — sets both the model language and the breadcrumb label. */
export function languageFor(path: string): string {
  const name = (path.split("/").pop() || "").toLowerCase();
  if (name.startsWith("dockerfile")) return "dockerfile";
  if (name.startsWith("makefile")) return "plaintext";
  if (name === ".gitignore" || name === ".dockerignore" || name === ".env" || name.startsWith(".env."))
    return "shell";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return EXT_LANG[ext] ?? "plaintext";
}

/** Stable Monaco theme id for a Conduit theme: conduit-warm-near-black | -dim | -light. */
export function monacoThemeIdFor(themeId: ThemeId): string {
  return `conduit-${themeId}`;
}

// Monaco `rules[].foreground` wants 6 hex digits with no leading '#'.
function hex(color: string): string {
  return color.replace(/^#/, "");
}

/** Build the 3 Monaco themes once from the THEMES palette. */
export function defineConduitThemes(): void {
  (Object.keys(THEMES) as ThemeId[]).forEach((id) => {
    const t = THEMES[id];
    const v = t.cssVars;
    monaco.editor.defineTheme(monacoThemeIdFor(id), {
      base: t.appearance === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: [
        { token: "", foreground: hex(v["--term-fg"]) },
        { token: "comment", foreground: hex(v["--text-dim"]), fontStyle: "italic" },
        { token: "keyword", foreground: hex(v["--accent"]) },
        { token: "string", foreground: hex(v["--green"]) },
        { token: "number", foreground: hex(v["--amber"]) },
        { token: "type", foreground: hex(v["--accent"]) },
        { token: "identifier", foreground: hex(v["--term-fg"]) },
      ],
      colors: {
        "editor.background": v["--panel-bg"],
        "editor.foreground": v["--term-fg"],
        "editorLineNumber.foreground": v["--text-dim"],
        "editorLineNumber.activeForeground": v["--text-mid"],
        "editor.selectionBackground": v["--selection-bg"],
        "editor.lineHighlightBackground": v["--selection-bg"],
        "editorCursor.foreground": v["--accent"],
        "editorWidget.background": v["--sidebar-bg"],
        "editorWidget.border": v["--border"],
      },
    });
  });
}

let inited = false;

/** Idempotent boot init: worker wiring + Monarch languages + Conduit themes + factory. */
export function initMonaco(): void {
  if (inited) return;
  inited = true;
  (self as typeof self & { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
  defineConduitThemes();
  setModelFactory((path, value, languageId) =>
    monaco.editor.createModel(value, languageId, monaco.Uri.file(path)),
  );
  registerMonacoThemeSetter((id) => monaco.editor.setTheme(monacoThemeIdFor(id)));
  monaco.editor.setTheme(monacoThemeIdFor(currentThemeId()));
}
```

- [ ] **Step 4: Call initMonaco at boot.** In `src/main.tsx`, add the import after line 5 and the call right after `applyTheme(...)` (line 11):

```ts
import { applyTheme, resolveThemeId, readStoredPref, systemPrefersDark, watchSystemTheme } from "./themes";
import { initMonaco } from "./monaco/setup";
import "@xterm/xterm/css/xterm.css";
import "./theme.css";

// Apply the saved theme BEFORE the first paint so there is no flash of the
// default palette when launching into a non-default theme.
applyTheme(resolveThemeId(readStoredPref(), systemPrefersDark()));

// Boot Monaco once: worker wiring, Monarch languages, themes, model factory.
// (applyTheme above ran first; its Monaco recolor is a no-op until this registers the setter.)
initMonaco();
```

- [ ] **Step 5: Tune Vite.** In `vite.config.ts`, add `optimizeDeps` to the returned config (after `plugins`):

```ts
export default defineConfig(async () => ({
  plugins: [react()],

  // Pre-bundle the Monaco chunk; csp:null already permits the blob/module worker.
  optimizeDeps: {
    include: ["monaco-editor"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
```

- [ ] **Step 6: Typecheck.** Run:

```bash
pnpm exec tsc --noEmit
```

Expected: no errors (the `?worker` default import is typed by the existing `/// <reference types="vite/client" />` in `src/vite-env.d.ts`).

- [ ] **Step 7: Launch-verify the worker loads offline.** Run:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Expected on screen / in the dev console: the app boots normally, the existing (still-present) `FileViewer` renders files as before, and there are **no** console errors mentioning `MonacoEnvironment`, `getWorker`, or a failed worker fetch. (Monaco editors are not rendered yet — that lands in Task 6/7.) Stop the dev app.

- [ ] **Step 8: Commit.**

```bash
git add package.json pnpm-lock.yaml src/monaco/setup.ts src/themes.ts src/main.tsx vite.config.ts && git commit -m "feat(editor): monaco setup, worker wiring, theme bridge, boot init

Hand-wrapped monaco-editor (editor.worker only, basic-languages Monarch), languageFor
+ Conduit themes built from THEMES, model factory injected into the registry, and a
lazy themes.ts->monaco bridge for live theme sync. initMonaco() called once at boot.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 — Store: FS type mirrors + dirty/conflict maps + save/close/removeProject

Adds the non-persisted `dirty`/`conflict` maps, `setDirty`/`clearConflict`, the `saveFile` orchestrator, the dirty-guarded `requestCloseTab`, the `removeProject` dirty guard, and balances the registry ref-count by acquiring on `openFile`/`load` and releasing on close/remove. No test runner — verified by `tsc` now and by launch in Task 7.

**Files:**
- Modify `src/store.ts` (imports 1-13; add `FileContent`/`FileStat` types near 40-43; `AppState` additions near 338-351; initial state near 396-421; `load` acquire near 430-442; `removeProject` 554-564; `openFile` 666-667; new actions)

- [ ] **Step 1: Add imports + FS type mirrors.** In `src/store.ts`, after line 3 add:

```ts
import { ask } from "@tauri-apps/plugin-dialog";
import * as registry from "./monaco/registry";
```

Then, immediately after the `WsTab` interface (after line 43), add:

```ts

/** Mirror of fsops::FileContent (serde camelCase). read_file resolves (never rejects);
 *  inspect error/binary/readOnly before creating an editable model. */
export interface FileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
  readOnly: boolean;
  size: number;
  mtimeMs: number;
  error: string | null;
}

/** Mirror of fsops::FileStat — returned by write_file (and Phase 2 stat_file). */
export interface FileStat {
  mtimeMs: number;
  size: number;
  exists: boolean;
}
```

- [ ] **Step 2: Declare the new state in `AppState`.** In the `AppState` interface, add these members right after `openFile: (projectId: string, path: string) => void;` (line 350):

```ts
  openFile: (projectId: string, path: string) => void;

  // ---- editor buffer state (Monaco) — NON-PERSISTED ----
  /** absPath -> dirty; reactive mirror of registry.dirtyOf (delete key when false). */
  dirty: Record<string, boolean>;
  /** absPath -> external change (populated in Phase 2 by useFileWatch). */
  conflict: Record<string, { mtimeMs: number; size: number } | "deleted">;
  setDirty: (path: string, dirty: boolean) => void;
  clearConflict: (path: string) => void;
  saveFile: (path: string) => Promise<void>;
  requestCloseTab: (projectId: string, groupId: string, ref: string) => Promise<void>;
```

- [ ] **Step 3: Seed the initial state.** In the object returned from the store factory, add after `pendingPrompts: {},` (line 401):

```ts
    pendingPrompts: {},
    dirty: {},
    conflict: {},
```

- [ ] **Step 4: Acquire refs for restored file tabs in `load`.** In `load`, after the `layouts` loop and before `set({ ... })` (after line 433), add:

```ts
      // Balance close/removeProject release: acquire a model ref for every restored file tab.
      for (const p of projects) {
        for (const g of layouts[p.id].groups) {
          for (const t of g.tabs) {
            if (t.kind === "file") registry.acquire(t.ref);
          }
        }
      }
```

- [ ] **Step 5: Acquire on `openFile`.** Replace the `openFile` action (lines 666-667) with:

```ts
    openFile: (projectId, path) => {
      const l = get().layouts[projectId];
      // Only a genuinely new tab bumps the ref (rOpenTab just re-activates an existing one).
      const already = !!l && l.groups.some((g) => g.tabs.some((t) => t.ref === path));
      applyLayout(projectId, (l2) => rOpenTab(l2, { kind: "file", ref: path }));
      if (!already) registry.acquire(path);
    },
```

- [ ] **Step 6: Add the save/dirty/close actions.** Insert these actions right after `openFile` (before `closeTab` at line 669):

```ts
    setDirty: (path, dirty) =>
      set((s) => {
        const next = { ...s.dirty };
        if (dirty) next[path] = true;
        else delete next[path];
        return { dirty: next };
      }),

    clearConflict: (path) =>
      set((s) => {
        if (!(path in s.conflict)) return {};
        const next = { ...s.conflict };
        delete next[path];
        return { conflict: next };
      }),

    saveFile: async (path) => {
      const entry = registry.model(path);
      // Hard guard: no model, read-only buffer, or unrevealed => never write.
      if (!entry || entry.readOnly || !entry.model) return;
      const value = entry.model.getValue();
      registry.saving.add(path);
      try {
        const stat = await invoke<FileStat>("write_file", { path, content: value });
        registry.setSaved(path, { mtimeMs: stat.mtimeMs, size: stat.size });
        get().setDirty(path, false);
        get().clearConflict(path);
      } catch (e) {
        void invoke("notify_user", { title: "Conduit", body: `Save failed: ${String(e)}` }).catch(
          () => {},
        );
      } finally {
        registry.saving.delete(path);
      }
    },

    requestCloseTab: async (projectId, groupId, ref) => {
      const s = get();
      const group = s.layouts[projectId]?.groups.find((g) => g.id === groupId);
      const tab = group?.tabs.find((t) => t.ref === ref);
      const isFile = tab?.kind === "file";
      if (isFile && s.dirty[ref]) {
        const ok = await ask(`Discard unsaved changes to ${baseName(ref)}?`, {
          title: "Conduit",
          kind: "warning",
        });
        if (!ok) return;
      }
      s.closeTab(projectId, groupId, ref);
      if (isFile) {
        s.setDirty(ref, false);
        registry.release(ref);
        registry.disposeIfUnreferenced(ref);
      }
    },
```

- [ ] **Step 7: Add the `removeProject` dirty guard + model reclaim.** Replace the `removeProject` action (lines 554-564) with:

```ts
    removeProject: async (id) => {
      const s = get();
      const layout = s.layouts[id];
      const fileTabs = layout
        ? layout.groups.flatMap((g) => g.tabs.filter((t) => t.kind === "file").map((t) => t.ref))
        : [];
      if (fileTabs.some((ref) => s.dirty[ref])) {
        const ok = await ask("This project has unsaved file changes. Remove it and discard them?", {
          title: "Conduit",
          kind: "warning",
        });
        if (!ok) return;
      }
      await invoke("remove_project", { id });
      for (const ref of fileTabs) {
        s.setDirty(ref, false);
        registry.release(ref);
        registry.disposeIfUnreferenced(ref);
      }
      set((st) => {
        const layouts = { ...st.layouts };
        delete layouts[id];
        const projects = st.projects.filter((p) => p.id !== id);
        const selectedProjectId =
          st.selectedProjectId === id ? projects[0]?.id ?? null : st.selectedProjectId;
        return { projects, layouts, selectedProjectId };
      });
    },
```

- [ ] **Step 8: Typecheck.** Run:

```bash
pnpm exec tsc --noEmit && pnpm test
```

Expected: no type errors, and the registry vitest suite still passes (store changes don't touch it). Full behavioral verification is in Task 7 once the editor renders.

- [ ] **Step 9: Commit.**

```bash
git add src/store.ts && git commit -m "feat(editor): store save/dirty/close actions + FS type mirrors

Add non-persisted dirty/conflict maps, setDirty/clearConflict, saveFile (atomic
write_file + setSaved), dirty-guarded requestCloseTab and removeProject, and
balanced registry acquire/release across openFile/load/close.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6 — CodeEditorPane: one hand-wrapped Monaco editor per group

Builds the per-group editor: create-once, save-viewState→setModel→restoreViewState on active-file change, `layout()` on reveal + ResizeObserver, Cmd+S, transition-only dirty dispatch, read-only/binary/large/error banners + language breadcrumb, and editor-only disposal (never the model) on unmount. UI — verified by `tsc` here and launched in Task 7.

**Files:**
- Create `src/components/CodeEditorPane.tsx`
- Modify `src/theme.css` (add editor pane styles after the file-viewer block, ~1042)

- [ ] **Step 1: Create the component.** Create `src/components/CodeEditorPane.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { monaco, languageFor } from "../monaco/setup";
import * as registry from "../monaco/registry";
import { useStore, baseName, type FileContent } from "../store";

interface CodeEditorPaneProps {
  projectId: string;
  groupId: string;
  visible: boolean;
  style?: React.CSSProperties;
}

// Per-path load-result cache so banners survive tab switches without re-reading. Phase 2's
// reload path will refresh this; for Phase 1 a file is read once per open.
const EDIT_CAP = 8 * 1024 * 1024;
const fileCache = new Map<string, FileContent>();
async function loadFile(path: string): Promise<FileContent> {
  const cached = fileCache.get(path);
  if (cached) return cached;
  let fc: FileContent;
  try {
    fc = await invoke<FileContent>("read_file", { path });
  } catch (e) {
    fc = { content: "", truncated: false, binary: false, readOnly: true, size: 0, mtimeMs: 0, error: String(e) };
  }
  fileCache.set(path, fc);
  return fc;
}

type LoadState = { kind: "none" } | { kind: "loading" } | { kind: "ready"; fc: FileContent };

export function CodeEditorPane({ projectId, groupId, visible, style }: CodeEditorPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const contentSubRef = useRef<{ dispose(): void } | null>(null);
  const prevDirtyRef = useRef(false);
  const currentPathRef = useRef<string | null>(null);
  const visibleRef = useRef(visible);

  const setDirty = useStore((s) => s.setDirty);
  const saveFile = useStore((s) => s.saveFile);

  // Derive THIS group's active file path from the store (null when the active tab is a
  // session or the group is empty).
  const activePath = useStore((s) => {
    const g = s.layouts[projectId]?.groups.find((x) => x.id === groupId);
    if (!g || !g.activeRef) return null;
    const tab = g.tabs.find((t) => t.ref === g.activeRef);
    return tab && tab.kind === "file" ? tab.ref : null;
  });

  const [load, setLoad] = useState<LoadState>({ kind: "none" });

  // Create the editor exactly once (mirrors Terminal.tsx create-once).
  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      model: null,
      automaticLayout: false,
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 18,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "none",
      tabSize: 2,
    });
    editorRef.current = editor;

    // Cmd/Ctrl+S saves the active file. Fires only when THIS editor has focus, so it can
    // never collide with xterm (which binds only Shift+Enter / Cmd+Backspace).
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const p = currentPathRef.current;
      if (p) void saveFile(p);
    });

    const ro = new ResizeObserver(() => {
      if (visibleRef.current) editor.layout();
    });
    ro.observe(hostRef.current);

    return () => {
      // Persist the outgoing view state, then dispose the EDITOR only (never the model).
      const p = currentPathRef.current;
      if (p) registry.setViewState(p, groupId, editor.saveViewState());
      contentSubRef.current?.dispose();
      ro.disconnect();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap models on active-file change: save outgoing view state -> setModel -> restore.
  useEffect(() => {
    let alive = true;
    const editor = editorRef.current;
    const prev = currentPathRef.current;
    if (editor && prev && prev !== activePath) {
      registry.setViewState(prev, groupId, editor.saveViewState());
    }
    contentSubRef.current?.dispose();
    contentSubRef.current = null;
    prevDirtyRef.current = false;

    if (!activePath) {
      currentPathRef.current = null;
      editor?.setModel(null);
      setLoad({ kind: "none" });
      return;
    }
    currentPathRef.current = activePath;
    setLoad({ kind: "loading" });

    void loadFile(activePath).then((fc) => {
      if (!alive || currentPathRef.current !== activePath) return;
      setLoad({ kind: "ready", fc });
      const ed = editorRef.current;
      if (!ed) return;

      // No model at all for binary / error tabs — banner only.
      if (fc.binary || fc.error !== null) {
        ed.setModel(null);
        return;
      }
      // Editable only when nothing forbids it; large/non-UTF-8/truncated -> read-only model.
      const editable = !fc.readOnly;
      const entry = registry.ensureModel(activePath, {
        value: fc.content,
        languageId: languageFor(activePath),
        readOnly: fc.readOnly,
        baseline: { mtimeMs: fc.mtimeMs, size: fc.size },
      });
      ed.setModel(entry.model as unknown as monaco.editor.ITextModel);
      ed.updateOptions({ readOnly: !editable });
      const vs = registry.getViewState(activePath, groupId) as
        | monaco.editor.ICodeEditorViewState
        | undefined;
      if (vs) ed.restoreViewState(vs);
      if (visibleRef.current) {
        ed.layout();
        ed.focus();
      }

      // Dirty tracking: dispatch setDirty ONLY on a clean<->dirty transition.
      prevDirtyRef.current = registry.dirtyOf(activePath);
      if (entry.model) {
        contentSubRef.current = entry.model.onDidChangeContent(() => {
          const next = registry.dirtyOf(activePath);
          if (next !== prevDirtyRef.current) {
            prevDirtyRef.current = next;
            setDirty(activePath, next);
          }
        });
      }
    });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // Relayout + focus on reveal (mirrors Terminal.tsx).
  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) return;
    const ed = editorRef.current;
    if (!ed) return;
    requestAnimationFrame(() => {
      ed.layout();
      if (currentPathRef.current) ed.focus();
    });
  }, [visible]);

  const fc = load.kind === "ready" ? load.fc : null;
  const banner = ((): { text: string; error?: boolean } | null => {
    if (!fc) return null;
    if (fc.error !== null) return { text: `Could not read file: ${fc.error}`, error: true };
    if (fc.binary) return { text: "Binary file — not shown." };
    if (fc.truncated) return { text: "Showing first 24 MB (read-only)." };
    if (fc.readOnly) return { text: fc.size > EDIT_CAP ? "Read-only: large file." : "Read-only: non-UTF-8 encoding." };
    return null;
  })();
  const noModel = !!fc && (fc.binary || fc.error !== null);

  return (
    <div className={`code-pane ${visible ? "visible" : "hidden"}`} style={style}>
      <div className="code-breadcrumb">
        <span className="code-crumb-name">{activePath ? baseName(activePath) : ""}</span>
        <span className="code-crumb-lang">{activePath ? languageFor(activePath) : ""}</span>
      </div>
      {banner && <div className={`code-banner ${banner.error ? "error" : ""}`}>{banner.text}</div>}
      <div ref={hostRef} className={`code-host ${noModel ? "empty" : ""}`} />
    </div>
  );
}
```

- [ ] **Step 2: Add the pane styles.** In `src/theme.css`, insert after the `.fv-pre { ... }` block (after line 1042, before `/* ---- Right column ... */`):

```css

/* ---- Code editor pane (Monaco) ---- */
.code-pane {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
}
.code-pane.hidden {
  visibility: hidden;
  z-index: 0;
}
.code-pane.visible {
  visibility: visible;
  z-index: 1;
}
.code-breadcrumb {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 11px;
  color: var(--text-mid);
  border-bottom: 1px solid var(--border);
}
.code-crumb-name {
  color: var(--text-bright);
}
.code-crumb-lang {
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
}
.code-banner {
  flex: 0 0 auto;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--amber);
  background: var(--pill-needs-bg);
}
.code-banner.error {
  color: var(--red);
}
.code-host {
  flex: 1 1 auto;
  min-height: 0;
}
.code-host.empty {
  display: none;
}
```

- [ ] **Step 3: Typecheck.** Run:

```bash
pnpm exec tsc --noEmit
```

Expected: no errors. (The pane is not rendered anywhere yet — `WorkspaceCenter` still renders `FileViewer`; full launch-verify is the next task, which wires it in.)

- [ ] **Step 4: Commit.**

```bash
git add src/components/CodeEditorPane.tsx src/theme.css && git commit -m "feat(editor): CodeEditorPane hand-wrapped per-group Monaco editor

Create-once editor, viewState save/setModel/restore on active-file change, layout()
on reveal + ResizeObserver, Cmd+S, transition-only dirty dispatch, read-only/binary/
large/error banners + language breadcrumb, editor-only disposal on unmount.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7 — Swap FileViewer→CodeEditorPane in WorkspaceCenter + dirty dot + close-confirm (launch-verify)

Replaces the per-file `FileViewer` render with one `CodeEditorPane` per group, adds the VS Code-style dirty dot to the tab strip, and routes tab close through the dirty-guarded `requestCloseTab`. This is where the full editor loop is launch-verified.

**Files:**
- Modify `src/components/WorkspaceCenter.tsx` (import 14; drop `activeFiles` 89-98; render block 215-222; `GroupTabStrip` 251-352)
- Modify `src/theme.css` (add `.tab-dirty` after the `.tab-close`/`.tab-split` rules, ~948)

- [ ] **Step 1: Swap the import.** In `src/components/WorkspaceCenter.tsx`, replace line 14:

```tsx
import { CodeEditorPane } from "./CodeEditorPane";
```

- [ ] **Step 2: Delete the now-unused per-file array.** Remove the `activeFiles` block (lines 89-98):

```tsx
  // File tabs of the active project, with group placement.
  const activeFiles: { ref: string; gi: number; visible: boolean }[] = [];
  if (layout) {
    layout.groups.forEach((g, gi) => {
      g.tabs.forEach((t) => {
        if (t.kind === "file") {
          activeFiles.push({ ref: t.ref, gi, visible: g.activeRef === t.ref });
        }
      });
    });
  }

```

(Delete it entirely — nothing else references `activeFiles` after Step 3.)

- [ ] **Step 3: Render one CodeEditorPane per group.** In `.term-stack`, replace the `activeFiles.map(...)` `FileViewer` block (lines 215-222) with:

```tsx
          {layout &&
            projectId &&
            layout.groups.map((g, gi) => {
              const activeTab = g.tabs.find((t) => t.ref === g.activeRef);
              return (
                <CodeEditorPane
                  key={projectId + "::grp::" + g.id}
                  projectId={projectId}
                  groupId={g.id}
                  visible={!!activeTab && activeTab.kind === "file"}
                  style={{ left: `${geom[gi].left}%`, width: `${geom[gi].width}%` }}
                />
              );
            })}
```

- [ ] **Step 4: Dirty dot + dirty-guarded close in `GroupTabStrip`.** In `GroupTabStrip`, replace the `closeTab` selector (line 272) with the dirty map + guarded close:

```tsx
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveGroup = useStore((s) => s.setActiveGroup);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const dirty = useStore((s) => s.dirty);
  const openToSide = useStore((s) => s.openToSide);
```

Then, inside the `group.tabs.map((t) => ...)` render, add a dirty dot before the split button and swap the close handler. Replace the label + buttons region (lines 310-330) with:

```tsx
          <span className="tab-label">{label(t)}</span>
          {t.kind === "file" && dirty[t.ref] && (
            <span className="tab-dirty" title="Unsaved changes" />
          )}
          <button
            className="tab-split"
            title="Open to the side"
            onClick={(e) => {
              e.stopPropagation();
              openToSide(projectId, t);
            }}
          >
            <SplitIcon size={10} />
          </button>
          <button
            className="tab-close"
            title="Close tab"
            onClick={(e) => {
              e.stopPropagation();
              void requestCloseTab(projectId, group.id, t.ref);
            }}
          >
            <CloseIcon size={10} />
          </button>
```

- [ ] **Step 5: Style the dirty dot.** In `src/theme.css`, add after the `.tab-close:hover, .tab-split:hover { ... }` rule (after line 948):

```css

/* VS Code-style dirty dot: occupies the close-button slot until you hover. */
.tab-dirty {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-mid);
  flex-shrink: 0;
}
.tab:hover .tab-dirty {
  display: none;
}
```

- [ ] **Step 6: Typecheck.** Run:

```bash
pnpm exec tsc --noEmit
```

Expected: no errors (`FileViewer` import is gone from `WorkspaceCenter`; `closeTab`/`activeFiles` no longer referenced there).

- [ ] **Step 7: Launch-verify the full loop.** In one terminal, create a scratch file to edit safely and start the isolated dev app:

```bash
printf 'line one\nline two\n' > /tmp/conduit-editor-check.txt
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

In the app, add a project (or use an existing one), open the file tree, and verify each of the following on screen:
  1. **Open + syntax:** open a source file (e.g. a `.ts`) — it renders in Monaco with syntax colors and a breadcrumb header showing the file name + uppercased language (e.g. `TYPESCRIPT`).
  2. **Edit → dirty dot:** type a character — a dirty dot appears in the tab (in place of the close ✕ until you hover).
  3. **Cmd+S saves to disk:** press Cmd+S — the dirty dot clears. In another terminal confirm the write landed:
     ```bash
     cat /tmp/conduit-editor-check.txt
     ```
     (Open `/tmp/conduit-editor-check.txt` in the app, edit, Cmd+S, then `cat` — the new content is on disk.)
  4. **Undo-to-saved is clean:** edit, then undo (Cmd+Z) back to the saved text — the dirty dot disappears without saving.
  5. **Theme recolor:** switch the theme in Settings — the open editor recolors immediately (background + tokens) along with the terminals.
  6. **Read-only banners:** open a binary file (e.g. a `.png`) — a "Binary file — not shown." banner shows and there is no editable surface; opening a >8 MB text file shows a "Read-only: large file." banner and typing is blocked.
  7. **Close-unsaved warning:** make an edit, click the tab's close ✕ — a "Discard unsaved changes to <name>?" dialog appears; Cancel keeps the tab + edits, OK closes it.

Stop the dev app once all seven behaviors are confirmed.

- [ ] **Step 8: Commit.**

```bash
git add src/components/WorkspaceCenter.tsx src/theme.css && git commit -m "feat(editor): swap FileViewer for CodeEditorPane in WorkspaceCenter

Render one CodeEditorPane per group in .term-stack, add the VS Code dirty dot to the
tab strip, and route tab close through the dirty-guarded requestCloseTab.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8 — Retire FileViewer and drop react-syntax-highlighter

Removes the dead read-only viewer now that Monaco is the single `kind:"file"` renderer, and drops `react-syntax-highlighter` if nothing else imports it.

**Files:**
- Delete `src/components/FileViewer.tsx`
- Modify `src/theme.css` (remove the `.file-viewer` / `.fv-*` block, lines 985-1042)
- Modify `package.json` (drop `react-syntax-highlighter` + its `@types` if unused)

- [ ] **Step 1: Confirm nothing else imports FileViewer or the Prism lib.** Run:

```bash
grep -rn "FileViewer\|react-syntax-highlighter\|SyntaxHighlighter" src/ || echo "NO REMAINING IMPORTERS"
```

Expected: only matches are the `.prism` builder in `src/themes.ts` (the `makePrism`/`THEMES[...].prism` fields, which are the palette data — leave those, they are consumed by nothing after this task but are harmless typed data) and the definition inside `src/components/FileViewer.tsx` itself. Confirm there is **no** remaining `import ... FileViewer` and **no** `import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"` outside `FileViewer.tsx`.

- [ ] **Step 2: Delete the component.** Run:

```bash
git rm src/components/FileViewer.tsx
```

- [ ] **Step 3: Remove the dead CSS.** In `src/theme.css`, delete the entire read-only file-viewer block — from the comment `/* ---- Read-only file viewer ---- */` (line 985) through the closing `}` of `.fv-pre` (line 1042), inclusive. The section directly below it (`/* ---- Right column (split panels) ---- */`) must remain.

- [ ] **Step 4: Drop the now-unused runtime dep.** Run:

```bash
pnpm remove react-syntax-highlighter @types/react-syntax-highlighter
```

- [ ] **Step 5: Typecheck + verify a clean grep.** Run:

```bash
pnpm exec tsc --noEmit && grep -rn "react-syntax-highlighter" src/ package.json || echo "CLEAN"
```

Expected: `tsc` reports no errors and the grep prints `CLEAN` (only the `.prism`/`makePrism` palette data remains in `themes.ts`, which does not import the package).

- [ ] **Step 6: Launch-verify no regression.** Run:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

Open a file — it still renders in Monaco (edit + Cmd+S still work), and there are no console errors about a missing `FileViewer` or `react-syntax-highlighter` module. Stop the dev app.

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "chore(editor): retire FileViewer + drop react-syntax-highlighter

Monaco is now the single kind:\"file\" renderer; remove the dead read-only viewer,
its CSS, and the unused Prism dependency.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Smart reload (external/agent disk changes)

Phase 1 shipped the editable Monaco pane (`src/monaco/setup.ts`, `src/monaco/registry.ts`, `src/components/CodeEditorPane.tsx`), the `write_file`/`FileStat`/`mtime_ms` Rust plumbing, and the non‑persisted `dirty`/`conflict` store maps with `setDirty`/`clearConflict`/`saveFile`. This phase adds the on‑disk change detector: a `stat_file` command, one app‑level `useFileWatch` poll, silent reload of clean buffers, and the Reload/Keep‑mine and deleted banners in the pane. All Rust here is `std::fs` only; the only store addition is `setConflict`.

### Task 2.1 — `stat_file` Rust command (TDD)

**Files:**
- Modify: `src-tauri/src/fsops.rs` (append `stat_file`; add unit test to the existing `#[cfg(test)] mod tests`)
- Modify: `src-tauri/src/lib.rs` (wrapper after `read_file` ~470‑472; register in `generate_handler!` ~685)

- [ ] **Step 1: Write the failing test.** Add this test into the existing `#[cfg(test)] mod tests { use super::*; … }` block in `fsops.rs` (Phase 1 created that module for the read‑contract tiering tests). If it somehow does not exist, add the whole module shown here:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_file_reports_existing_and_missing() {
        // Real file: exists=true, size == bytes written, mtime_ms populated.
        let p = std::env::temp_dir().join(format!("conduit-stat-{}.txt", std::process::id()));
        std::fs::write(&p, b"hello").unwrap();
        let s = stat_file(p.to_str().unwrap());
        assert!(s.exists);
        assert_eq!(s.size, 5);
        assert!(s.mtime_ms > 0.0);

        // Missing path: exists=false with zeroed fields.
        std::fs::remove_file(&p).unwrap();
        let gone = stat_file(p.to_str().unwrap());
        assert!(!gone.exists);
        assert_eq!(gone.size, 0);
        assert_eq!(gone.mtime_ms, 0.0);
    }
}
```

- [ ] **Step 2: Run the test — expect FAIL.**

```bash
cargo test --manifest-path src-tauri/Cargo.toml stat_file_reports_existing_and_missing
```

Expected: compile error `cannot find function` `stat_file` `in this scope` (the function does not exist yet) — a RED build failure.

- [ ] **Step 3: Implement `stat_file`.** Append to `src-tauri/src/fsops.rs` (reusing the Phase‑1 `FileStat` struct and the Phase‑1 shared `mtime_ms` helper so the epoch‑millis are computed identically to `read_file`/`write_file` and JS `{mtimeMs,size}` baselines compare exactly):

```rust
/// Stat a path for the file watcher. Infallible: any error (missing file,
/// permission denied, broken symlink) reports exists=false with zeroed fields.
/// std::fs only — polled ~1500ms (visibility-gated) by useFileWatch.
pub fn stat_file(path: &str) -> FileStat {
    // Phase 1 factored the millis-from-mtime into `fn mtime_ms(meta: &fs::Metadata) -> f64`:
    //   meta.modified().ok()
    //       .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    //       .map(|d| d.as_secs_f64() * 1000.0)
    //       .unwrap_or(0.0)
    // Reuse it here (do NOT re-derive a different formula).
    match fs::metadata(path) {
        Ok(meta) => FileStat {
            mtime_ms: mtime_ms(&meta),
            size: meta.len(),
            exists: true,
        },
        Err(_) => FileStat {
            mtime_ms: 0.0,
            size: 0,
            exists: false,
        },
    }
}
```

- [ ] **Step 4: Run the test — expect PASS.**

```bash
cargo test --manifest-path src-tauri/Cargo.toml stat_file_reports_existing_and_missing
```

Expected: `test tests::stat_file_reports_existing_and_missing ... ok` (`1 passed`).

- [ ] **Step 5: Register the command.** In `src-tauri/src/lib.rs`, add the wrapper immediately after the existing `read_file` wrapper (the `write_file` wrapper added in Phase 1 also lives here):

```rust
#[tauri::command]
fn stat_file(path: String) -> fsops::FileStat {
    fsops::stat_file(&path)
}
```

Then add `stat_file,` to `tauri::generate_handler!` right after the `write_file,` line (which Phase 1 inserted after `read_file,`):

```rust
            list_dir,
            read_file,
            write_file,
            stat_file,
```

- [ ] **Step 6: Full Rust build + test, then commit.**

```bash
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/fsops.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(editor): add stat_file command for external-change detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.2 — `setConflict` store action + confirm save advances baseline

**Files:**
- Modify: `src/store.ts` (add `setConflict` to the `AppState` interface next to the Phase‑1 `setDirty`/`clearConflict` decls; add its implementation next to the Phase‑1 `clearConflict` body; verify `saveFile`)

- [ ] **Step 1: Add `setConflict` to the `AppState` interface.** Locate the Phase‑1 declarations (`setDirty`, `clearConflict`) in the `AppState` interface (`src/store.ts`) and add, verbatim from the contract:

```ts
  setConflict: (path: string, c: { mtimeMs: number; size: number } | "deleted") => void;
```

- [ ] **Step 2: Implement `setConflict`.** In the store body, directly after the Phase‑1 `clearConflict` implementation, add:

```ts
    setConflict: (path, c) =>
      set((s) => ({ conflict: { ...s.conflict, [path]: c } })),
```

- [ ] **Step 3: Confirm `saveFile` advances baseline + clears the banner.** Read the Phase‑1 `saveFile` in `src/store.ts` and confirm its success branch matches this shape (it must call `registry.setSaved` so a save overwrites the disk baseline, `clearConflict` so an own‑save clears any stale banner, and use the `registry.saving` guard so a save never self‑triggers the watcher):

```ts
    saveFile: async (path) => {
      const entry = registry.model(path);
      if (!entry || entry.readOnly || entry.model == null) return;
      const content = entry.model.getValue();
      registry.saving.add(path);
      try {
        const stat = await invoke<FileStat>("write_file", { path, content });
        registry.setSaved(path, { mtimeMs: stat.mtimeMs, size: stat.size }); // advances baseline
        get().setDirty(path, false);
        get().clearConflict(path);
      } catch (e) {
        void invoke("notify_user", { title: "Save failed", body: String(e) });
      } finally {
        registry.saving.delete(path);
      }
    },
```

If the `registry.setSaved(...)` or `clearConflict(path)` line is missing, add it now — the watcher relies on `write_file`’s returned stat becoming the new baseline.

- [ ] **Step 4: Typecheck and commit.**

```bash
pnpm exec tsc --noEmit
git add src/store.ts
git commit -m "$(cat <<'EOF'
feat(editor): add setConflict store action for disk-change banners

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.3 — `useFileWatch` app‑level poll + silent reload of clean buffers

**Files:**
- Create: `src/hooks/useFileWatch.ts`
- Modify: `src/App.tsx` (import + call `useFileWatch()` next to `useTelemetry` ~36)

- [ ] **Step 1: Write `src/hooks/useFileWatch.ts`.** A single visibility‑gated poll (mirrors `useClaudeAmbient`/the `RightColumn` git poll). It derives the open file paths from every project’s layout, skips in‑flight saves, and dispatches silent reload / conflict / deleted:

```ts
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { useStore } from "../store";
import type { FileContent, FileStat } from "../store";
import * as registry from "../monaco/registry";

const WATCH_POLL_MS = 1500;

/** Every open file-tab path across all projects' layouts, deduped. */
function openFilePaths(): string[] {
  const seen = new Set<string>();
  for (const layout of Object.values(useStore.getState().layouts)) {
    for (const g of layout.groups) {
      for (const t of g.tabs) {
        if (t.kind === "file") seen.add(t.ref);
      }
    }
  }
  return [...seen];
}

/**
 * Single app-level file watcher (mounted once in App, like useClaudeAmbient).
 * While the window is visible, every ~1500ms it stats each open file path and,
 * when the disk {mtimeMs,size} diverges from the registry baseline:
 *   - clean buffer  -> SILENT reload via pushEditOperations (undo preserved)
 *   - dirty buffer  -> store.conflict[path] = stat   (Reload / Keep mine banner)
 *   - exists:false  -> store.conflict[path] = "deleted"   (deleted banner)
 * Skips any path with an in-flight save (registry.saving) to close the
 * save-vs-poll-tick race, and only watches revealed, editable models.
 */
export function useFileWatch(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        for (const path of openFilePaths()) {
          if (registry.saving.has(path)) continue; // own-save in flight
          const entry = registry.model(path);
          // Only a revealed, editable model can be silently reloaded; binary /
          // read-only / not-yet-revealed tabs have no buffer to diff.
          if (!entry || entry.model == null || entry.readOnly) continue;
          const base = registry.baseline(path);
          if (!base) continue;

          let stat: FileStat;
          try {
            stat = await invoke<FileStat>("stat_file", { path });
          } catch {
            continue;
          }
          const store = useStore.getState();

          if (!stat.exists) {
            if (store.conflict[path] !== "deleted") store.setConflict(path, "deleted");
            continue;
          }
          if (stat.mtimeMs === base.mtimeMs && stat.size === base.size) continue;

          if (registry.dirtyOf(path)) {
            // Dirty buffer -> non-blocking banner; don't re-set the same stat.
            const cur = store.conflict[path];
            if (
              cur &&
              cur !== "deleted" &&
              cur.mtimeMs === stat.mtimeMs &&
              cur.size === stat.size
            )
              continue;
            store.setConflict(path, { mtimeMs: stat.mtimeMs, size: stat.size });
            continue;
          }

          // Clean buffer -> silent reload, preserving undo history.
          const fc = await invoke<FileContent>("read_file", { path });
          if (fc.error !== null || fc.binary || fc.readOnly) {
            // Became binary / oversized / unreadable: surface a banner instead of
            // silently pushing partial/lossy content.
            store.setConflict(path, { mtimeMs: stat.mtimeMs, size: stat.size });
            continue;
          }
          const m = entry.model as unknown as Monaco.editor.ITextModel;
          m.pushEditOperations(
            [],
            [{ range: m.getFullModelRange(), text: fc.content }],
            () => null,
          );
          // Baseline + saved point from the SAME read that produced the content.
          registry.setSaved(path, { mtimeMs: fc.mtimeMs, size: fc.size });
          store.clearConflict(path);
        }
      } finally {
        running = false;
      }
    };

    const start = () => {
      if (timer == null) {
        void tick();
        timer = setInterval(() => void tick(), WATCH_POLL_MS);
      }
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, []);
}
```

- [ ] **Step 2: Mount it once in `App`.** In `src/App.tsx` add the import near the other hook imports:

```ts
import { useFileWatch } from "./hooks/useFileWatch";
```

and call it inside `App()` immediately after the existing `useTelemetry(telemetryOptOut);` line (~36):

```ts
  // Anonymous engagement heartbeat; no-op while opted out (Settings/onboarding).
  useTelemetry(telemetryOptOut);

  // Single app-level poll: silently reload clean open files an agent edits on disk.
  useFileWatch();
```

- [ ] **Step 3: Typecheck.**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors (confirms `registry` exports `saving`/`model`/`baseline`/`dirtyOf`/`setSaved`, and `FileContent`/`FileStat` are exported from `../store`).

- [ ] **Step 4: Launch‑verify SILENT reload of a clean buffer.** No frontend test runner exists — verify in the real app against an isolated data dir:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

In the app: open a text file from the file tree (e.g. a project `README.md`) so a Monaco editor is showing. Do **not** type anything (buffer stays clean). From a separate terminal, simulate an external/agent write (use the file’s absolute path):

```bash
echo "// external edit $(date)" >> /ABSOLUTE/PATH/TO/README.md
```

Expected on screen: within ~1.5s the editor content updates to include the appended line **with no banner and no dirty dot**; the tab does not get marked dirty; pressing Cmd+Z once removes exactly the reloaded change (undo history is intact, because `pushEditOperations` was used instead of `setValue`). Switch the app window to the background and repeat the `echo` — nothing changes; bring it back to the foreground and the reload lands on the next tick (visibility gating works).

- [ ] **Step 5: Commit.**

```bash
git add src/hooks/useFileWatch.ts src/App.tsx
git commit -m "$(cat <<'EOF'
feat(editor): watch open files and silently reload clean buffers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.4 — Conflict + deleted banners in `CodeEditorPane`

**Files:**
- Modify: `src/components/CodeEditorPane.tsx` (imports; `conflict` selector + handlers; banner JSX in the pane’s returned container above the editor host)

- [ ] **Step 1: Ensure the imports the banner needs.** In `src/components/CodeEditorPane.tsx`, make sure these are present (add what Phase 1 didn’t already import). `invoke` and `registry` are already used by the pane’s save/model wiring; add `useCallback`, the `FileContent` type, and the Monaco type import:

```ts
import { useCallback } from "react"; // add to the existing React hook import
import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import type { FileContent } from "../store";
import * as registry from "../monaco/registry";
```

- [ ] **Step 2: Read the conflict state and define the four actions.** Inside the `CodeEditorPane` component, after the Phase‑1 derivation of the active file `path` (the pane derives its active file ref from the store; it is `null` when the active tab is a session), add:

```tsx
  const conflict = useStore((s) => (path ? s.conflict[path] : undefined));
  const clearConflict = useStore((s) => s.clearConflict);
  const requestCloseTab = useStore((s) => s.requestCloseTab);

  // External-change "Reload": overwrite the buffer with disk content, discarding
  // the user's edits, then clear the banner. Preserves undo via pushEditOperations.
  const onReload = useCallback(async () => {
    if (!path) return;
    const fc = await invoke<FileContent>("read_file", { path });
    if (fc.error === null && !fc.binary && !fc.readOnly) {
      const entry = registry.model(path);
      const m = entry?.model as unknown as Monaco.editor.ITextModel | undefined;
      if (m) {
        m.pushEditOperations(
          [],
          [{ range: m.getFullModelRange(), text: fc.content }],
          () => null,
        );
        registry.setSaved(path, { mtimeMs: fc.mtimeMs, size: fc.size });
      }
    }
    clearConflict(path);
  }, [path, clearConflict]);

  // "Keep mine": adopt the new disk stat as the baseline WITHOUT touching the
  // saved version id, so the watcher stops nagging until the next external change.
  const onKeepMine = useCallback(() => {
    if (path && conflict && conflict !== "deleted") registry.setBaseline(path, conflict);
    if (path) clearConflict(path);
  }, [path, conflict, clearConflict]);
```

- [ ] **Step 3: Render the non‑blocking banners.** In the pane’s returned JSX, inside the pane root container and immediately before the editor host `<div>` (the element the editor mounts into), add the banner overlay. It only shows for the active file tab (`visible && path`) and picks deleted vs changed:

```tsx
      {visible && path && conflict === "deleted" ? (
        <div style={bannerStyle} role="status">
          <span style={{ flex: 1 }}>File deleted on disk.</span>
          <button style={bannerBtn} onClick={() => clearConflict(path)}>
            Keep buffer (save recreates)
          </button>
          <button
            style={bannerBtn}
            onClick={() => void requestCloseTab(projectId, groupId, path)}
          >
            Close tab
          </button>
        </div>
      ) : visible && path && conflict ? (
        <div style={bannerStyle} role="status">
          <span style={{ flex: 1 }}>File changed on disk.</span>
          <button style={bannerBtn} onClick={() => void onReload()}>
            Reload
          </button>
          <button style={bannerBtn} onClick={onKeepMine}>
            Keep mine
          </button>
        </div>
      ) : null}
```

Add the two style objects at module scope (top of the file, after imports) so the banner is a self‑contained, theme‑neutral overlay that does not block editing:

```tsx
const bannerStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 5,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 8px",
  fontSize: 12,
  color: "inherit",
  background: "rgba(190, 150, 40, 0.20)",
  borderBottom: "1px solid rgba(255, 255, 255, 0.14)",
};

const bannerBtn: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 8px",
  cursor: "pointer",
  color: "inherit",
  background: "rgba(255, 255, 255, 0.10)",
  border: "1px solid rgba(255, 255, 255, 0.22)",
  borderRadius: 4,
};
```

The pane root container must be `position: relative` (Phase 1 already positions the editor host absolutely inside it) so the banner overlays the top edge without reflowing/remounting the editor — never conditionally unmount the editor to show the banner.

- [ ] **Step 4: Typecheck.**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Launch‑verify the dirty‑conflict and deleted banners.**

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

DIRTY CONFLICT — open a file, then type a character (do not save) so the tab shows the dirty dot. From another terminal, edit the same file externally (size changes, so detection is robust even on coarse‑mtime filesystems):

```bash
echo "// agent line $(date)" >> /ABSOLUTE/PATH/TO/OPEN_FILE
```

Expected: within ~1.5s an amber strip appears at the top of the editor reading **“File changed on disk.”** with **Reload** and **Keep mine**; your edits and the dirty dot remain (non‑blocking). Click **Keep mine** → banner disappears, your edits stay, and running the same `echo` value again does **not** re‑nag (baseline advanced); a *new* `echo` re‑raises the banner. Re‑dirty and re‑edit externally, then click **Reload** → the buffer is replaced by disk content, the dirty dot clears, and the banner disappears.

DELETED — with a file open, delete it on disk:

```bash
rm /ABSOLUTE/PATH/TO/OPEN_FILE
```

Expected: within ~1.5s a strip reads **“File deleted on disk.”** with **Keep buffer (save recreates)** and **Close tab**; the editor is never silently cleared and the file is never auto‑recreated. Click **Keep buffer** → banner clears, buffer stays; press Cmd+S → the file is recreated on disk (its parent dir still exists) and the banner does not reappear. Reproduce the delete again and click **Close tab** → the tab closes (if the buffer was dirty you get the discard confirm first).

REAL‑AGENT SPOT CHECK — instead of `echo`, point a live `claude` session at an open file (e.g. in a Conduit terminal session: `claude -p "append one comment line to /ABSOLUTE/PATH/TO/OPEN_FILE"`). A clean open file auto‑reloads; a dirty one shows the conflict banner — confirming the watcher works against a genuine agent edit, not just the shell.

- [ ] **Step 6: Commit.**

```bash
git add src/components/CodeEditorPane.tsx
git commit -m "$(cat <<'EOF'
feat(editor): show reload/keep-mine and deleted banners in the editor pane

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — File-tree CRUD

This phase adds the four std-only filesystem-mutation commands, wires them into the store with dirty-guarded open-file coordination, and gives `FileTree.tsx` a right-click menu with inline create/rename rows and targeted per-folder re-listing. It builds on primitives added in Phase 1 (`s.dirty`, `registry.release`/`disposeIfUnreferenced`, `import * as registry from "./monaco/registry"` in `store.ts`, and the existing `closeTab` reducer).

### Task 3.1 — Rust CRUD commands (`create_file` / `create_dir` / `rename_path` / `delete_path`)

Strict red-green TDD with `cargo test`. All `std::fs` only — no `trash`, no `tempfile` dev-dep (tests use `std::env::temp_dir()` + the already-present `uuid` crate for a unique scratch dir). Every command errors when the target/dest already exists (no clobber).

**Files:**
- Modify `src-tauri/src/fsops.rs` — add `use std::path::Path;` (line 3 region), append four `pub fn`s after `read_file` (after line 78), and a `#[cfg(test)] mod crud_tests` at end.
- Modify `src-tauri/src/lib.rs` — add four `#[tauri::command]` wrappers after the `read_file` wrapper (after line 472) and register them in `generate_handler!` after `read_file,` (line 685).

- [ ] **Step 1: Write the failing tests (full test module) at the end of `src-tauri/src/fsops.rs`.**

  Append this module. It references `create_file`/`create_dir`/`rename_path`/`delete_path`, which do not exist yet, so the crate's test build will not compile — that is the intended red.

  ```rust
  #[cfg(test)]
  mod crud_tests {
      use super::*;
      use std::path::{Path, PathBuf};

      fn tmpdir() -> PathBuf {
          let mut d = std::env::temp_dir();
          d.push(format!("conduit-fsops-{}", uuid::Uuid::new_v4()));
          std::fs::create_dir_all(&d).unwrap();
          d
      }
      fn s(p: &Path) -> String {
          p.to_string_lossy().into_owned()
      }

      #[test]
      fn create_file_makes_file_and_rejects_existing() {
          let d = tmpdir();
          let p = d.join("a.txt");
          assert!(create_file(&s(&p)).is_ok());
          assert!(p.is_file());
          // no clobber: a second create must fail and must not touch existing bytes
          std::fs::write(&p, b"keep").unwrap();
          assert!(create_file(&s(&p)).is_err());
          assert_eq!(std::fs::read(&p).unwrap(), b"keep");
          std::fs::remove_dir_all(&d).ok();
      }

      #[test]
      fn create_dir_single_level_and_rejects_existing() {
          let d = tmpdir();
          let sub = d.join("nested");
          assert!(create_dir(&s(&sub)).is_ok());
          assert!(sub.is_dir());
          assert!(create_dir(&s(&sub)).is_err()); // already exists
          // single level only — a missing intermediate parent must fail (NOT create_dir_all)
          let deep = d.join("x").join("y");
          assert!(create_dir(&s(&deep)).is_err());
          std::fs::remove_dir_all(&d).ok();
      }

      #[test]
      fn rename_moves_files_and_dirs_and_rejects_existing_dest() {
          let d = tmpdir();
          let a = d.join("a.txt");
          let b = d.join("b.txt");
          std::fs::write(&a, b"hi").unwrap();
          assert!(rename_path(&s(&a), &s(&b)).is_ok());
          assert!(!a.exists() && b.is_file());
          // dest exists -> refuse; source preserved, dest untouched
          let c = d.join("c.txt");
          std::fs::write(&c, b"c").unwrap();
          assert!(rename_path(&s(&c), &s(&b)).is_err());
          assert!(c.is_file());
          assert_eq!(std::fs::read(&b).unwrap(), b"hi");
          // also works for directories
          let dir1 = d.join("dir1");
          std::fs::create_dir(&dir1).unwrap();
          let dir2 = d.join("dir2");
          assert!(rename_path(&s(&dir1), &s(&dir2)).is_ok());
          assert!(dir2.is_dir() && !dir1.exists());
          std::fs::remove_dir_all(&d).ok();
      }

      #[test]
      fn delete_removes_files_and_dirs_recursively() {
          let d = tmpdir();
          let f = d.join("f.txt");
          std::fs::write(&f, b"x").unwrap();
          assert!(delete_path(&s(&f)).is_ok());
          assert!(!f.exists());
          // directories are removed recursively
          let sub = d.join("sub");
          std::fs::create_dir(&sub).unwrap();
          std::fs::write(sub.join("inner.txt"), b"y").unwrap();
          assert!(delete_path(&s(&sub)).is_ok());
          assert!(!sub.exists());
          // a missing path is an error
          assert!(delete_path(&s(&d.join("nope"))).is_err());
          std::fs::remove_dir_all(&d).ok();
      }
  }
  ```

- [ ] **Step 2: Run the tests and confirm they FAIL (compile error).**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml crud_tests
  ```

  Expected: build fails with `error[E0425]: cannot find function `create_file` in this scope` (and the same for `create_dir`, `rename_path`, `delete_path`). Red confirmed.

- [ ] **Step 3: Implement the four functions in `src-tauri/src/fsops.rs`.**

  Change the top import from `use std::fs;` to:

  ```rust
  use std::fs;
  use std::path::Path;
  ```

  Then insert these four functions immediately after the closing `}` of `read_file` (after line 78):

  ```rust
  // ---- Mutating ops (std::fs only; guarded, no clobber) -----------------------

  /// Create an empty file. Errors if the target already exists (no clobber).
  pub fn create_file(path: &str) -> Result<(), String> {
      if Path::new(path).exists() {
          return Err(format!("already exists: {path}"));
      }
      // create_new also closes the check-then-create race window.
      fs::OpenOptions::new()
          .write(true)
          .create_new(true)
          .open(path)
          .map(|_| ())
          .map_err(|e| format!("could not create file: {e}"))
  }

  /// Create a single directory level (parent must already exist). Errors if it exists.
  pub fn create_dir(path: &str) -> Result<(), String> {
      if Path::new(path).exists() {
          return Err(format!("already exists: {path}"));
      }
      fs::create_dir(path).map_err(|e| format!("could not create folder: {e}"))
  }

  /// Rename/move a file or directory. Errors if the destination already exists.
  pub fn rename_path(from: &str, to: &str) -> Result<(), String> {
      if Path::new(to).exists() {
          return Err(format!("destination already exists: {to}"));
      }
      fs::rename(from, to).map_err(|e| format!("could not rename: {e}"))
  }

  /// Permanently delete a file (or a directory and its contents). No trash.
  /// Uses symlink_metadata so a symlink is unlinked, never followed/recursed.
  pub fn delete_path(path: &str) -> Result<(), String> {
      let md = fs::symlink_metadata(path).map_err(|e| format!("could not stat: {e}"))?;
      if md.is_dir() {
          fs::remove_dir_all(path).map_err(|e| format!("could not delete folder: {e}"))
      } else {
          fs::remove_file(path).map_err(|e| format!("could not delete: {e}"))
      }
  }
  ```

- [ ] **Step 4: Run the tests and confirm they PASS.**

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml crud_tests
  ```

  Expected: `test result: ok. 4 passed; 0 failed`. Green confirmed.

- [ ] **Step 5: Register the commands in `src-tauri/src/lib.rs`.**

  Add the four wrappers immediately after the `read_file` wrapper (after line 472, following `}`):

  ```rust
  #[tauri::command]
  fn create_file(path: String) -> Result<(), String> {
      fsops::create_file(&path)
  }

  #[tauri::command]
  fn create_dir(path: String) -> Result<(), String> {
      fsops::create_dir(&path)
  }

  #[tauri::command]
  fn rename_path(from: String, to: String) -> Result<(), String> {
      fsops::rename_path(&from, &to)
  }

  #[tauri::command]
  fn delete_path(path: String) -> Result<(), String> {
      fsops::delete_path(&path)
  }
  ```

  Then register them in `generate_handler!` by replacing the `read_file,` line (line 685):

  ```rust
              read_file,
              create_file,
              create_dir,
              rename_path,
              delete_path,
  ```

  Verify the whole crate still builds (also refreshes `Cargo.lock`):

  ```bash
  cargo build --manifest-path src-tauri/Cargo.toml
  ```

  Expected: `Finished` with no errors.

- [ ] **Step 6: Commit.**

  ```bash
  git add src-tauri/src/fsops.rs src-tauri/src/lib.rs
  git commit -m "$(cat <<'EOF'
  feat(editor): add std-only file-tree CRUD commands

  create_file/create_dir/rename_path/delete_path in fsops.rs (all std::fs,
  no clobber, no trash crate) with cargo tests for the exists guards;
  registered in generate_handler!.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 3.2 — Store: `dirVersion` map, `bumpDir`, `parentDir`, and dirty-guarded rename/delete coordination

Adds the non-persisted `dirVersion` map plus the CRUD coordination actions. `renamePath`/`deletePath` BLOCK when the open buffer is dirty (notify "save or discard first"), and for a clean open file they close the old tab (releasing its model) and, for rename, `openFile(new)`. No frontend test runner exists, so this task is `tsc`-gated; behavioral verification happens in Task 3.3's launch-verify.

**Files:**
- Modify `src/store.ts` — `parentDir` helper (after `baseName`, line 823); `AppState` fields (after `openFile`, line 350); initial state `dirVersion: {}` (after `live: {}`, line 400); action impls (after the `openFile` impl, line 667).

- [ ] **Step 1: Confirm the registry import exists (added by Phase 1).**

  ```bash
  grep -n 'monaco/registry' src/store.ts
  ```

  Expected: a line `import * as registry from "./monaco/registry";`. If it is absent (running Phase 3 standalone), add it beside the other imports near the top of `src/store.ts`.

- [ ] **Step 2: Add the `parentDir` helper after `baseName` in `src/store.ts` (after line 823).**

  ```ts
  /** Parent directory of an absolute path (no trailing slash). Root stays "/". */
  export function parentDir(path: string): string {
    const p = path.replace(/\/+$/, "");
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  }
  ```

- [ ] **Step 3: Declare the new `AppState` members immediately after the `openFile` declaration (line 350).**

  ```ts
    openFile: (projectId: string, path: string) => void;

    // ---- Phase 3: file-tree CRUD (all non-persisted) ----
    /** dirPath -> bump counter; a FileTree entry re-lists when its counter changes. */
    dirVersion: Record<string, number>;
    /** Increment the counter for one directory so only that folder re-lists. */
    bumpDir: (dirPath: string) => void;
    /** Rename/move on disk; blocks a dirty open buffer; reconciles a clean open tab. */
    renamePath: (projectId: string, from: string, to: string) => Promise<void>;
    /** Permanent delete on disk; blocks a dirty open buffer; closes a clean open tab. */
    deletePath: (projectId: string, path: string) => Promise<void>;
  ```

- [ ] **Step 4: Seed the initial state — add `dirVersion: {}` between `live: {}` and `pendingPrompts: {}` (line 399 region).**

  ```ts
      layouts: {},
      live: {},
      dirVersion: {},
      pendingPrompts: {},
  ```

- [ ] **Step 5: Implement the three actions immediately after the `openFile` impl (after line 667).**

  Insert after:

  ```ts
      openFile: (projectId, path) =>
        applyLayout(projectId, (l) => rOpenTab(l, { kind: "file", ref: path })),
  ```

  the following:

  ```ts
      bumpDir: (dirPath) =>
        set((s) => ({
          dirVersion: { ...s.dirVersion, [dirPath]: (s.dirVersion[dirPath] ?? 0) + 1 },
        })),

      renamePath: async (projectId, from, to) => {
        // Block: a dirty open buffer must be saved or discarded first.
        if (get().dirty[from]) {
          void invoke("notify_user", {
            title: "Conduit",
            body: "Save or discard changes before renaming this file.",
          }).catch(() => {});
          return;
        }
        try {
          await invoke("rename_path", { from, to });
        } catch (e) {
          void invoke("notify_user", { title: "Conduit", body: String(e) }).catch(() => {});
          return;
        }
        // If `from` is a (clean) open file tab: close old + release its model, open new.
        const layout = get().layouts[projectId];
        const g = layout?.groups.find((gr) =>
          gr.tabs.some((t) => t.kind === "file" && t.ref === from),
        );
        if (g) {
          get().closeTab(projectId, g.id, from);
          registry.release(from);
          registry.disposeIfUnreferenced(from);
          get().openFile(projectId, to);
        }
        // Re-list only the affected folder(s).
        get().bumpDir(parentDir(from));
        const toParent = parentDir(to);
        if (toParent !== parentDir(from)) get().bumpDir(toParent);
      },

      deletePath: async (projectId, path) => {
        // Block: a dirty open buffer must be saved or discarded first.
        if (get().dirty[path]) {
          void invoke("notify_user", {
            title: "Conduit",
            body: "Save or discard changes before deleting this file.",
          }).catch(() => {});
          return;
        }
        try {
          await invoke("delete_path", { path });
        } catch (e) {
          void invoke("notify_user", { title: "Conduit", body: String(e) }).catch(() => {});
          return;
        }
        // Close a clean open tab for the deleted file + release its model.
        const layout = get().layouts[projectId];
        const g = layout?.groups.find((gr) =>
          gr.tabs.some((t) => t.kind === "file" && t.ref === path),
        );
        if (g) {
          get().closeTab(projectId, g.id, path);
          registry.release(path);
          registry.disposeIfUnreferenced(path);
        }
        get().bumpDir(parentDir(path));
      },
  ```

  Note: `release` + `disposeIfUnreferenced` mirror Phase 1's `requestCloseTab` teardown (explicit ref management — there is no auto-reconcile that also releases, so this releases exactly the one closed reference and never over-decrements a path shared across projects).

- [ ] **Step 6: Typecheck.**

  ```bash
  pnpm exec tsc --noEmit
  ```

  Expected: no errors. (`FileTree.tsx` still compiles against the old API; it starts using these actions in Task 3.3.)

- [ ] **Step 7: Commit.**

  ```bash
  git add src/store.ts
  git commit -m "$(cat <<'EOF'
  feat(editor): add dirVersion + rename/delete open-file coordination

  Non-persisted dirVersion map + bumpDir for targeted folder re-lists; a
  parentDir helper; renamePath/deletePath that block a dirty open buffer and,
  for a clean open file, close the old tab (release model) and reopen on rename.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 3.3 — FileTree: context menu, inline create/rename rows, and `dirVersion`-targeted re-list

Replaces `src/components/FileTree.tsx` with a version that has a right-click menu (New File / New Folder / Rename / Delete), inline editable rows for create/rename (Enter commits, Esc/blur cancels — mirroring the session-rename input and reusing its `.session-rename-input` class, so no new CSS), a `dialog.ask()` confirm for delete, and per-entry re-listing driven by `dirVersion`. No frontend test runner exists, so this is verified by `tsc` plus a mandatory launch-verify.

**Files:**
- Modify (full rewrite) `src/components/FileTree.tsx` (currently lines 1–117).

- [ ] **Step 1: Rewrite `src/components/FileTree.tsx` with the full contents below.**

  ```tsx
  import { useEffect, useRef, useState, type MouseEvent } from "react";
  import { invoke } from "@tauri-apps/api/core";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { useStore, activeGroup, baseName, parentDir } from "../store";
  import { FolderIcon, FileIcon, ChevronRightIcon } from "./Icons";

  export interface DirEntry {
    name: string;
    path: string;
    isDir: boolean;
  }

  type Pending = { parentDir: string; kind: "file" | "dir" } | null;
  type Menu = { x: number; y: number; entry: DirEntry | null } | null;

  function joinPath(dir: string, name: string): string {
    return `${dir.replace(/\/+$/, "")}/${name}`;
  }

  // Shared context threaded down the recursive tree (avoids prop drilling churn).
  interface TreeCtx {
    activePath?: string;
    expanded: Set<string>;
    toggle: (path: string) => void;
    onOpen: (path: string) => void;
    onContext: (e: MouseEvent, entry: DirEntry | null) => void;
    pending: Pending;
    renaming: string | null;
    commitCreate: (name: string) => void;
    cancelCreate: () => void;
    commitRename: (from: string, name: string) => void;
    cancelRename: () => void;
  }

  export function FileTree({
    projectId,
    rootDir,
  }: {
    projectId: string;
    rootDir: string;
  }) {
    const openFile = useStore((s) => s.openFile);
    const bumpDir = useStore((s) => s.bumpDir);
    const renamePath = useStore((s) => s.renamePath);
    const deletePath = useStore((s) => s.deletePath);
    const activePath = useStore((s) =>
      activeGroup(s.layouts[projectId])?.activeRef ?? undefined,
    );
    const rootVersion = useStore((s) => s.dirVersion[rootDir] ?? 0);

    const [entries, setEntries] = useState<DirEntry[] | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [menu, setMenu] = useState<Menu>(null);
    const [pending, setPending] = useState<Pending>(null);
    const [renaming, setRenaming] = useState<string | null>(null);

    // Show "Loading…" only when the root itself changes — NOT on a dirVersion bump.
    useEffect(() => {
      setEntries(null);
    }, [rootDir]);

    // (Re)list the root on mount, rootDir change, and targeted bumpDir(rootDir).
    useEffect(() => {
      let alive = true;
      void invoke<DirEntry[]>("list_dir", { dir: rootDir })
        .then((e) => alive && setEntries(e))
        .catch(() => alive && setEntries([]));
      return () => {
        alive = false;
      };
    }, [rootDir, rootVersion]);

    // Close the context menu on any outside interaction (mirrors SessionContextMenu).
    useEffect(() => {
      if (!menu) return;
      const close = () => setMenu(null);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setMenu(null);
      };
      window.addEventListener("click", close);
      window.addEventListener("resize", close);
      window.addEventListener("keydown", onKey);
      return () => {
        window.removeEventListener("click", close);
        window.removeEventListener("resize", close);
        window.removeEventListener("keydown", onKey);
      };
    }, [menu]);

    const toggle = (path: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });

    const startCreate = (parent: string, kind: "file" | "dir") => {
      setMenu(null);
      setRenaming(null);
      // Ensure the target folder is expanded so its inline row is visible.
      if (parent !== rootDir) setExpanded((prev) => new Set(prev).add(parent));
      setPending({ parentDir: parent, kind });
    };

    const commitCreate = async (raw: string) => {
      const p = pending;
      setPending(null);
      if (!p) return;
      const name = raw.trim();
      if (!name) return;
      const path = joinPath(p.parentDir, name);
      try {
        await invoke(p.kind === "file" ? "create_file" : "create_dir", { path });
      } catch (e) {
        void invoke("notify_user", { title: "Conduit", body: String(e) }).catch(() => {});
        return;
      }
      bumpDir(p.parentDir);
      if (p.kind === "file") openFile(projectId, path);
    };

    const commitRename = async (from: string, raw: string) => {
      setRenaming(null);
      const name = raw.trim();
      if (!name || name === baseName(from)) return;
      await renamePath(projectId, from, joinPath(parentDir(from), name));
    };

    const onDelete = async (entry: DirEntry) => {
      setMenu(null);
      // Pre-block a dirty open buffer (store.deletePath is the authoritative guard).
      if (useStore.getState().dirty[entry.path]) {
        void invoke("notify_user", {
          title: "Conduit",
          body: "Save or discard changes before deleting this file.",
        }).catch(() => {});
        return;
      }
      const kind = entry.isDir ? "folder" : "file";
      const ok = await ask(
        `Delete ${kind} "${entry.name}" permanently? This cannot be undone.`,
        { title: "Delete", kind: "warning" },
      );
      if (!ok) return;
      await deletePath(projectId, entry.path);
    };

    const onContext = (e: MouseEvent, entry: DirEntry | null) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, entry });
    };

    const ctx: TreeCtx = {
      activePath,
      expanded,
      toggle,
      onOpen: (p) => openFile(projectId, p),
      onContext,
      pending,
      renaming,
      commitCreate,
      cancelCreate: () => setPending(null),
      commitRename,
      cancelRename: () => setRenaming(null),
    };

    return (
      <div className="file-tree" onContextMenu={(e) => onContext(e, null)}>
        {entries === null ? (
          <p className="placeholder">Loading…</p>
        ) : entries.length === 0 && pending?.parentDir !== rootDir ? (
          <p className="placeholder">Empty directory.</p>
        ) : (
          <>
            {pending?.parentDir === rootDir && (
              <InlineRow
                depth={0}
                kind={pending.kind}
                onCommit={commitCreate}
                onCancel={() => setPending(null)}
              />
            )}
            {entries.map((e) => (
              <TreeEntry key={e.path} entry={e} depth={0} ctx={ctx} />
            ))}
          </>
        )}
        {menu && (
          <FileTreeMenu
            menu={menu}
            rootDir={rootDir}
            onNewFile={(parent) => startCreate(parent, "file")}
            onNewFolder={(parent) => startCreate(parent, "dir")}
            onRename={(entry) => {
              setMenu(null);
              setPending(null);
              setRenaming(entry.path);
            }}
            onDelete={onDelete}
          />
        )}
      </div>
    );
  }

  function TreeEntry({
    entry,
    depth,
    ctx,
  }: {
    entry: DirEntry;
    depth: number;
    ctx: TreeCtx;
  }) {
    const isOpen = ctx.expanded.has(entry.path);
    const dv = useStore((s) => s.dirVersion[entry.path] ?? 0);
    const [children, setChildren] = useState<DirEntry[] | null>(null);

    // Load / re-list children whenever this dir is expanded or its dirVersion bumps.
    useEffect(() => {
      if (!entry.isDir || !isOpen) return;
      let alive = true;
      void invoke<DirEntry[]>("list_dir", { dir: entry.path })
        .then((c) => alive && setChildren(c))
        .catch(() => alive && setChildren([]));
      return () => {
        alive = false;
      };
    }, [entry.isDir, entry.path, isOpen, dv]);

    const rowClick = () => {
      if (entry.isDir) ctx.toggle(entry.path);
      else ctx.onOpen(entry.path);
    };

    if (ctx.renaming === entry.path) {
      return (
        <InlineRow
          depth={depth}
          kind={entry.isDir ? "dir" : "file"}
          initial={entry.name}
          onCommit={(v) => ctx.commitRename(entry.path, v)}
          onCancel={ctx.cancelRename}
        />
      );
    }

    return (
      <>
        <div
          className={`tree-row ${!entry.isDir && ctx.activePath === entry.path ? "active" : ""}`}
          style={{ paddingLeft: 8 + depth * 13 }}
          onClick={rowClick}
          onContextMenu={(e) => ctx.onContext(e, entry)}
          title={entry.name}
        >
          {entry.isDir ? (
            <ChevronRightIcon size={11} className={`chev ${isOpen ? "open" : ""}`} />
          ) : (
            <span className="chev-spacer" />
          )}
          {entry.isDir ? (
            <FolderIcon size={12} className="tree-ic folder" />
          ) : (
            <FileIcon size={12} className="tree-ic" />
          )}
          <span className="tree-label">{entry.name}</span>
        </div>
        {entry.isDir && isOpen && (
          <>
            {ctx.pending?.parentDir === entry.path && (
              <InlineRow
                depth={depth + 1}
                kind={ctx.pending.kind}
                onCommit={ctx.commitCreate}
                onCancel={ctx.cancelCreate}
              />
            )}
            {children?.map((c) => (
              <TreeEntry key={c.path} entry={c} depth={depth + 1} ctx={ctx} />
            ))}
          </>
        )}
      </>
    );
  }

  function InlineRow({
    depth,
    kind,
    initial,
    onCommit,
    onCancel,
  }: {
    depth: number;
    kind: "file" | "dir";
    initial?: string;
    onCommit: (value: string) => void;
    onCancel: () => void;
  }) {
    // Guards against Enter's commit being followed by blur's cancel.
    const done = useRef(false);
    return (
      <div
        className="tree-row"
        style={{ paddingLeft: 8 + depth * 13 }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="chev-spacer" />
        {kind === "dir" ? (
          <FolderIcon size={12} className="tree-ic folder" />
        ) : (
          <FileIcon size={12} className="tree-ic" />
        )}
        <input
          className="session-rename-input"
          defaultValue={initial ?? ""}
          autoFocus
          spellCheck={false}
          placeholder={kind === "dir" ? "folder name" : "file name"}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              if (done.current) return;
              done.current = true;
              onCommit(e.currentTarget.value);
            } else if (e.key === "Escape") {
              done.current = true;
              onCancel();
            }
          }}
          onBlur={() => {
            if (done.current) return;
            done.current = true;
            onCancel();
          }}
        />
      </div>
    );
  }

  function FileTreeMenu({
    menu,
    rootDir,
    onNewFile,
    onNewFolder,
    onRename,
    onDelete,
  }: {
    menu: NonNullable<Menu>;
    rootDir: string;
    onNewFile: (parent: string) => void;
    onNewFolder: (parent: string) => void;
    onRename: (entry: DirEntry) => void;
    onDelete: (entry: DirEntry) => void;
  }) {
    const entry = menu.entry;
    // Folder -> create inside it; file -> create as sibling; empty area -> root.
    const parent = !entry ? rootDir : entry.isDir ? entry.path : parentDir(entry.path);
    return (
      <div
        className="context-menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={() => onNewFile(parent)}>New File</button>
        <button onClick={() => onNewFolder(parent)}>New Folder</button>
        {entry && <button onClick={() => onRename(entry)}>Rename</button>}
        {entry && (
          <button className="danger" onClick={() => onDelete(entry)}>
            Delete
          </button>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 2: Typecheck.**

  ```bash
  pnpm exec tsc --noEmit
  ```

  Expected: no errors.

- [ ] **Step 3: Launch-verify in the isolated dev app (required — no frontend test runner).**

  ```bash
  CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
  ```

  With a project open and its Files tab showing the tree, confirm each of the following:
  - **Create file:** right-click a folder → **New File** → the folder expands and an inline input appears as its first child → type `hello.txt` → Enter → the file appears in-place (only that folder re-lists, sibling folders keep their expansion) **and** `hello.txt` opens in the editor. Right-click empty tree area → **New File** creates at the project root.
  - **Create folder:** right-click a folder → **New Folder** → type a name → Enter → the new folder appears; Esc or clicking away (blur) cancels the inline row with no file created.
  - **Rename:** right-click a file → **Rename** → the row becomes an inline input pre-filled + selected → type a new name → Enter → the row updates; if that file was open (and clean), its tab reconciles (old tab closes, the renamed path opens).
  - **Delete:** right-click a file → **Delete** → the native confirm dialog ("Delete file "…" permanently? This cannot be undone.") appears → confirm → the entry disappears and, if open+clean, its tab closes. Cancel leaves everything untouched.
  - **Dirty block:** open a file, type an edit (dirty dot shows), then right-click it → **Rename** or **Delete** → a "Save or discard changes before …" notification appears and the file is NOT renamed/deleted. Save (Cmd+S), then repeat → it now succeeds.

- [ ] **Step 4: Commit.**

  ```bash
  git add src/components/FileTree.tsx
  git commit -m "$(cat <<'EOF'
  feat(editor): file-tree context menu + inline CRUD rows

  Right-click New File/New Folder/Rename/Delete; inline editable rows
  (Enter commits, Esc/blur cancels) reusing the session-rename input;
  delete via plugin-dialog ask(); per-entry re-list keyed on dirVersion so
  only the touched folder refreshes and expansion is preserved; open-on-create.

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---
