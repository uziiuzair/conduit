# Monaco Editor in Conduit — Design

- **Date:** 2026-07-02
- **Status:** Approved (pending spec review)
- **Scope:** Add the Monaco Editor so Conduit can open and **edit** files in-app. Monaco
  **replaces** the read-only `FileViewer` as the single renderer for `kind:"file"` tabs.
  v1 ships open/edit/save, dirty tracking, theme sync, a language breadcrumb, smart reload on
  external (agent-driven) disk changes, and file-tree CRUD. **Format-on-save is explicitly cut
  from v1** (see §9).
- **Method:** Design produced via an adversarial judge-panel (3 independent architecture
  proposals × 2 correctness/pragmatism judges → synthesis). The runner-up and the reasons it lost
  are recorded in §10 so the *why* survives.

---

## 1. Why this is mostly a "renderer swap," not new plumbing

Conduit already models editor tabs as a first-class concept, so ~40% of this feature exists:

- `WsTab = { kind: "session" | "file", ref }` — for file tabs, `ref` is an **absolute path**.
- `EditorGroup = { id, tabs, activeRef }`; `ProjectLayout = { groups, activeGroupId, weights }`,
  persisted to `state.json`. **Open file tabs already survive restart.**
- `WorkspaceCenter.tsx` lays out groups as split columns via `geometry(weights)` → `left/width%`
  (no DOM measurement). The store action `openFile(projectId, path)` already opens a file tab.
- Today `FileViewer.tsx` (read-only, `react-syntax-highlighter`/Prism) renders for `kind:"file"`
  tabs inside the keep-alive `.term-stack`, CSS-placed exactly like terminals.

The real gaps: (1) **no write path** in Rust (`fsops.rs` is read-only), (2) **no dirty/unsaved
model**, (3) the **keep-alive rule** now has editor implications, and (4) two latent
**data-corruption bugs** in the current read path that become dangerous the moment files are editable.

## 2. Locked architecture — per-group editor + path-keyed model registry

**Decision:** One hand-wrapped Monaco editor **per `EditorGroup`** (i.e. per visible split column,
1–4 of them), plus a **global path-keyed `ITextModel` registry** that lives *outside* React —
mirroring the existing out-of-store `liveTerminals` singleton in `themes.ts`.

Rationale for splitting editors from models:
- Monaco **editors** are DOM/heap-heavy; **models** are cheap. Conduit's audience is
  multi-project / multi-agent power users who open many files. `G` editors (≤ group count) + `N`
  cheap models beats `N` heavy editors.
- The "mirror TerminalView / never unmount" instinct is a **PTY constraint**, not a Monaco one.
  Disposing an *editor* loses nothing while the *model* persists in the registry.

**Mounting / placement.** Render one `<CodeEditorPane groupId>` per group inside the existing
`.term-stack`, absolute-positioned and CSS-placed by `geometry[gi]` (a direct parallel to
`placeSession`), visible only when that group's `activeRef` is a file tab.

**Lifecycle.**
- Create the editor **once** in a mount-only effect (mirrors `Terminal.tsx` create-once).
- On active-file change within a group: `saveViewState` of the outgoing model into the registry
  → `editor.setModel(registry.model(path))` → `restoreViewState`.
- `editor.layout()` on reveal + via `ResizeObserver`.
- The editor **saves view state to the registry on unmount** (not only on tab-switch), so
  cursor/scroll survive a project round-trip. Editors dispose freely on project switch; **models
  are never disposed on unmount** — only when a path is referenced by zero tabs anywhere
  (ref-counted across all projects' layouts).

**Undo / view-state / dirty content** all live on the `ITextModel`, so they are preserved across
tab and project switches for free.

**Split-same-file.** Opening the same path in two columns is unreachable via the current reducers,
so no shared-model-across-two-columns machinery is needed for v1. The shared model (same path
across two *projects*) already gives correct content + dirty sync for free.

## 3. Dirty / buffer state — two tiers, one source of truth

- **Authoritative (module-level `src/monaco/registry.ts`, NOT Zustand — non-serializable):**
  per-path entry `{ model, savedVersionId, viewStates, baseline: { mtimeMs, size }, refCount,
  readOnly }`, plus an in-flight `saving: Set<path>` guard.
- **Dirty is `model.getAlternativeVersionId() !== savedVersionId`** — the correct Monaco idiom,
  which correctly reports **clean after undo back to the saved state** (not a string compare).
- **Reactive mirror (Zustand, non-persisted):** `dirty: Record<absPath, boolean>` and
  `conflict: Record<absPath, {mtimeMs,size} | "deleted">`. A `model.onDidChangeContent` handler
  recomputes the version-id comparison and calls `setDirty(path, next)` **only on a clean↔dirty
  transition** (no per-keystroke re-render).
- The tab strip reads `useStore(s => !!s.dirty[t.ref])` to show a **dirty dot** in place of the
  close ✕ until hover (VS Code style); the close-unsaved warning reads the same map.
- **Dirty content is intentionally NOT persisted** to `state.json` (matches today — only the tab
  list persists; restart discards unsaved edits, same as the current read-only viewer).

## 4. Save path — new std-only Rust `write_file`

New command in `fsops.rs`, registered in `lib.rs`'s `generate_handler!`, **std::fs only** (no new
crate):

`write_file(path, content) -> Result<FileStat, String>`
- **Reject if the parent dir is missing** — a save must never `create_dir_all` a directory into
  existence; a vanished parent is an error to surface. (Recreating a *deleted file* still works,
  since its parent survives.)
- Write to a sibling temp `.{name}.conduit-tmp-{rand}` in the **same directory** → `sync_all` →
  on Unix **reapply the existing file's mode** (temp defaults to 0600 and would strip `+x` off
  scripts) → `fs::rename(tmp, path)` (**atomic same-fs replace** — a concurrently-reading agent
  sees old-or-new, never torn).
- Return a **server-side post-rename `FileStat { mtimeMs, size }`** (not a separate re-stat call —
  closes a stat race window).
- **Save is hard-disabled whenever the buffer is `readOnly`** (binary / oversized / truncated /
  non-UTF-8) — a partial or lossy buffer can never overwrite the real file. Highest-severity guard.

**Cmd+S wiring:** `editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save)` in the
mount handler. This fires **only when a Monaco editor has focus**; xterm binds no Cmd+S
(`Terminal.tsx` handles only Shift+Enter and Cmd+Backspace) and only acts when a terminal is
focused, so the two can never collide. No document-level fallback in v1.

`save()` = `getValue` → `registry.saving.add(path)` → `invoke write_file` → on success set
`savedVersionId = model.getAlternativeVersionId()`, `baseline = returned stat`,
`setDirty(path,false)`, `clearConflict(path)`, `registry.saving.delete(path)`; on error surface a
notification.

## 5. Read-contract hardening (fixes latent corruption)

`read_file` (`fsops.rs`) changes — these close two silent data-corruption paths that only matter
once files are editable:

1. **On read failure, set `error: Some(msg)` — NEVER put the message in `content`** (as it does
   today). The frontend refuses to create an editable model on error (shows the error, no save).
   Closes the "Cmd+S writes the error placeholder back to disk" path.
2. **Replace `String::from_utf8_lossy` with strict `std::str::from_utf8`.** On invalid UTF-8, set
   `readOnly: true` + reason "non-UTF-8 encoding" and show a lossy **preview** only — so a
   Latin-1/Windows-1252 file can never be edited-then-saved with `U+FFFD` substitutions destroying
   the original bytes.

Size tiers (keep the NUL-in-first-8KB binary sniff): `EDIT_CAP = 8 MB` (fully editable);
`8–24 MB` → loaded but `readOnly:true` ("Read-only: large file"); `>24 MB (HARD_CAP)` →
`truncated:true` + `readOnly:true` ("Showing first 24 MB (read-only)"); binary → `binary:true`,
no model, placeholder. `FileContent` gains `size:u64`, `mtimeMs`, `readOnly:bool`,
`error:Option<String>`. The frontend creates an **editable** model only when
`!binary && !readOnly && error === null`; everything else is a read-only Monaco with a banner.
Large-but-editable files get `largeFileOptimizations` + minimap off.

## 6. Smart reload — the Conduit-specific requirement

Conduit runs `claude` agents that edit files on disk while you may have them open. Detection:

- **One app-level `src/hooks/useFileWatch.ts`** (mounted once like `useClaudeAmbient`, **not** a
  per-editor interval) polls `stat_file(path) -> FileStat{mtimeMs,size,exists}` for the set of
  currently-open file paths, ~1500 ms while the window is visible, gated on `visibilitychange`,
  with an immediate stat on tab reveal. This reuses the proven git-poll idiom in `RightColumn`
  (`GIT_POLL_MS=2500`, visibility-gated).
- **Lean-deps justification:** the `notify` crate is a heavyweight cross-platform FS-watcher
  (inotify/FSEvents/kqueue) that violates the policy; window-focus-only rechecks are documented as
  insufficient here (agents edit while the window is focused). Polling a handful of open paths is
  both necessary and precedented. `stat_file` is pure `std::fs::metadata`, zero crates.
- **Own-save vs external:** each path's `registry.baseline` is set from `read_file` and overwritten
  with `write_file`'s returned stat; the watcher flags only when disk `{mtimeMs,size} ≠ baseline`
  **AND** `path ∉ registry.saving` (in-flight guard closes the save-vs-poll-tick race).

On flag:
1. **Clean buffer → silent reload** via `model.pushEditOperations([], [{ range: fullRange, text:
   newContent }])` (NOT `setValue`, so undo history survives) → `savedVersionId = new
   alternativeVersionId`, update baseline.
2. **Dirty buffer → non-blocking in-pane banner** "File changed on disk — Reload / Keep mine."
   *Keep mine* advances baseline to the new disk stat so we stop nagging until the next change.
3. **`exists:false` (deleted/moved) → banner** "File deleted on disk — Keep buffer (save recreates)
   / Close tab." Never silent-reload, never auto-recreate.

A residual microsecond window between rename and server-side stat is accepted and documented (low
severity: at worst a missed notice on an already-saved file).

## 7. File-tree CRUD (Phase 3)

Four std-only commands in `fsops.rs` (registered in `lib.rs`), **no `trash` crate** (permanent
delete, guarded):
- `create_file(path)` / `create_dir(path)` — error if target exists (no clobber).
- `rename_path(from, to)` — error if dest exists; handles files, dirs, and moves.
- `delete_path(path)` — `remove_file` / `remove_dir_all`.

UX in `FileTree.tsx` (no context menu today): right-click menu **New File / New Folder / Rename /
Delete**; create and rename use an **inline editable row** committed on Enter (cancel on Esc/blur) —
matches the app's inline session-rename; delete uses the already-present `plugin-dialog`
`ask("Delete X permanently? This cannot be undone.")` (**no new capability** — `dialog:default` is
granted). On create-file, call `openFile(projectId, newPath)`.

**Refresh:** add a store map `dirVersion: Record<dirPath, number>`; each tree entry re-runs
`list_dir` when `dirVersion[entry.path]` changes and CRUD calls `bumpDir(parentDir)`, so only the
touched folder re-lists and expansion state is preserved.

**Open-file coordination:** block rename/delete of a **dirty** open buffer ("save or discard
first"). For a **clean** open file, delete closes its tab (release model) and rename
closes-old + `openFile(new)`. `removeProject` also gains a dirty guard.

## 8. Bundling, theme sync, and the retirement of FileViewer

- **`monaco-editor` is the only new dependency**, hand-wrapped imperatively like `xterm` in
  `Terminal.tsx`. **No `@monaco-editor/react`** (its runtime loader fetches Monaco and its
  controlled single-model API fights per-group `setModel` swapping). **No CDN.**
- **Local, offline `?worker` bundling, `editor.worker` ONLY.** In `src/monaco/setup.ts` (imported
  once at boot): import `monaco-editor/esm/vs/editor/editor.api`, the
  `basic-languages/monaco.contribution` (Monarch tokenizers, **main-thread**, cover the languages
  FileViewer handled), and wire `MonacoEnvironment.getWorker` to the `editor.worker` only. We
  deliberately **do not** import the TS/JSON/CSS/HTML language services — they exist for
  diagnostics/IntelliSense (unwanted without project/tsconfig context) and built-in formatting
  (cut), so they'd be pure bundle/cold-start/memory tax.
- `vite.config.ts`: `optimizeDeps.include: ['monaco-editor']`; optional `manualChunks` to isolate
  the Monaco chunk. `csp:null` already permits blob/module workers (if CSP is later enabled, add
  `worker-src blob: 'self'`).
- **Theme sync:** in `themes.ts` `applyTheme()`, after the `liveTerminals` recolor loop, call
  `monaco.editor.setTheme(monacoThemeIdFor(id))` (guarded on Monaco being loaded — a single global
  `setTheme`, no per-instance loop). Monaco themes are built once from the existing `THEMES[id]`
  palette roles.
- **Retire `FileViewer.tsx`** once Monaco is the single renderer; drop `react-syntax-highlighter`
  if nothing else imports it.

## 9. Deliberate scope cut — format-on-save

**Format-on-save is CUT from v1** (overriding the initially-confirmed scope item). Reasons:
- Monaco's built-in formatter only covers TS/JS/JSON/CSS/HTML and needs exactly the language
  workers we are not shipping; it **silently no-ops** on the repo's real languages
  (Rust/Python/Go/YAML/Markdown).
- Where it *does* fire, it reformats to Monaco's built-in opinions, **diverging from the project's
  own Prettier/rustfmt config** and churning noisy diffs in files that concurrent agents are
  editing — an active harm in this exact app.
- Shipping even an opt-in built-in formatter would force the 4 language workers back in for
  near-zero verified value.

**What ships instead:** the language auto-detect **breadcrumb** (cheap, valuable — reuse a
`languageFor()` helper moved out of `FileViewer` to set the model language and label the pane).

**Deferred, done right:** format-on-save that **shells out to the project's own formatter**
(`prettier`/`rustfmt`/`gofmt`) so it respects repo config — consistent with Conduit's lean
shell-out ethos (`curl`, not an HTTP client).

## 10. Runner-up and why it lost

**Runner-up:** one Monaco editor **per file tab**, a structural mirror of `TerminalView`, with all
projects' file tabs always mounted in `.term-stack`.

**Why not:** its central premise — editors should mirror the never-unmount terminal pattern — is
superficial. Terminals never unmount because that kills the PTY; Monaco has no such constraint
(disposing an editor loses nothing when the model persists in a registry). The real cost is
**memory**: N always-mounted heavy editors (worse because it must mount *all* projects' tabs to
preserve state across project switches) is materially heavier than the read-only Prism viewer it
replaces, for exactly Conduit's multi-project/multi-agent audience. Its one genuine advantage —
implicit view-state with no `saveViewState` bookkeeping — is outweighed: the per-group bookkeeping
is ~15 lines of the well-trodden VS Code pattern, and **both** approaches need the same path-keyed
model registry anyway (two Monaco editors cannot own two models at the same URI, so the runner-up
needs the registry for the cross-project same-path case regardless). We kept the runner-up's
strongest ideas: `write_file` returning the fresh stat directly, the version-id dirty idiom, and
the read-contract fixes.

## 11. New dependencies

- **`monaco-editor`** (frontend) — single new runtime dep, hand-wrapped like `xterm`,
  `editor.worker` bundled locally via Vite `?worker`. No `@monaco-editor/react`, no CDN loader.
- **No new Rust crates** — `write_file` / `stat_file` / CRUD are all `std::fs`. `notify` and
  `trash` deliberately rejected per lean-deps.
- **No new Tauri plugin/capability** — reuse `tauri-plugin-dialog` (`dialog:default` already
  granted) for the delete confirm.
- **Dev-only `vitest`** (recommended) — solely to unit-test the framework-agnostic model registry
  (ref-count / dirty logic), the one piece with data-loss risk and no default test coverage (the
  frontend has no test runner today).
- **Cleanup:** drop `react-syntax-highlighter` once `FileViewer` is retired (if unused elsewhere).

## 12. Files to add / change

**Add**
- `src/monaco/setup.ts` — boot-time Monaco init: `editor.api` + `basic-languages` + `editor.worker`
  wiring; `defineTheme` for the Conduit themes; export the `monaco` namespace, `languageFor()`
  (moved from `FileViewer`), `monacoThemeIdFor(activeThemeId)`.
- `src/monaco/registry.ts` — module singleton: path-keyed model map + `saving` set;
  `acquire/release` ref-counting across all layouts, `dirtyOf`, `disposeIfUnreferenced`.
- `src/components/CodeEditorPane.tsx` — one hand-wrapped editor per group; create-once; view-state
  save/setModel/restore on active-file change; `layout()` on reveal + `ResizeObserver`; Cmd+S;
  version-id dirty→store; read-only/binary/large/error + conflict/deleted banners + language
  breadcrumb header; save view state + dispose **editor** (never models) on unmount.
- `src/hooks/useFileWatch.ts` — single app-level visibility-gated `stat_file` poll of open paths,
  skipping `registry.saving`; dispatches silent reload / conflict / deleted.

**Change**
- `src/components/WorkspaceCenter.tsx` — replace the `FileViewer` block with one `<CodeEditorPane>`
  per group; dirty dot in the tab strip; route tab-close through a dirty-guarded confirm.
- `src/store.ts` — non-persisted `dirty`/`conflict`/`dirVersion` maps + `setDirty`/`clearConflict`/
  `bumpDir`; `saveFile` + dirty-guarded `requestCloseTab`; `removeProject` dirty guard;
  rename/delete-open-file coordination.
- `src/themes.ts` — `monaco.editor.setTheme(...)` in `applyTheme()` (guarded).
- `src/components/FileTree.tsx` (Phase 3) — context menu; inline create/rename rows; delete via
  `dialog.ask`; `dirVersion`-targeted re-list; open-on-create.
- `vite.config.ts` — `optimizeDeps.include`; optional worker/`manualChunks` tuning (validated in
  the spike).
- `src-tauri/src/fsops.rs` — read-contract fixes (`error`/UTF-8/`readOnly`/`size`/`mtimeMs` + caps);
  add `write_file`, `stat_file`, `FileStat` struct; (Phase 3) `create_file`/`create_dir`/
  `rename_path`/`delete_path`.
- `src-tauri/src/lib.rs` — register the new commands in `generate_handler!` (no capability change).

**Retire**
- `src/components/FileViewer.tsx`.

## 13. Implementation order (phased)

- **Phase 0 — SPIKE (gating, throwaway).** Prove `monaco-editor` + `editor.worker` (`?worker`) load
  **offline in a real packaged Tauri build**; confirm Monarch highlighting parity + `defineTheme`/
  `setTheme` against the 3 themes. If the slim `editor.api` import is finicky, lock the
  full-`monaco-editor` + `editor.worker`-only fallback here. **Gates everything** (unverifiable by
  `tsc`; Monaco workers under `tauri://localhost` must be run to confirm).
- **Phase 1 — CORE edit/save.** `read_file` contract fixes + `write_file`; `setup.ts` +
  `registry.ts` + `CodeEditorPane`; swap `FileViewer` → `CodeEditorPane`; dirty map + tab dot +
  Cmd+S + close-unsaved confirm + `removeProject` guard; theme sync; language breadcrumb.
  **Launch-verify** edit+save+dirty+theme (not just `tsc`).
- **Phase 2 — SMART RELOAD.** `stat_file` + single app-level `useFileWatch` + baseline/in-flight
  guard; clean reload via `pushEditOperations`; dirty-conflict banner; deleted-on-disk banner.
  **Launch-verify against a real `claude` agent editing an open file.**
- **Phase 3 — FILE-TREE CRUD.** `create_file`/`create_dir`/`rename_path`/`delete_path` + context
  menu + inline rows + delete `dialog.ask` + `dirVersion` refresh + block-CRUD-on-dirty.
- **Deferred (post-v1):** config-respecting format-on-save (shell out to prettier/rustfmt/gofmt);
  app-quit hot-exit for dirty buffers; OS-trash delete.

## 14. Open risks

- **Monaco workers in a PACKAGED build** under Tauri's asset protocol — must be verified offline
  (Wi-Fi off) in a real `tauri build`; unverifiable by `tsc`; the Phase 0 spike gates on it.
- **Slim `editor.api` + `basic-languages`** could fight the packaged bundler or miss a grammar;
  fallback is the full `monaco-editor` import (still `editor.worker` only). Verify highlighting
  parity against FileViewer's old language set in the spike.
- **Model ref-count correctness** — imperative FE state with no frontend test runner; a mis-count
  disposes a live model = silent lost buffer. Mitigate by keeping `registry.ts` framework-agnostic
  and adding a small `vitest` for `acquire/release/dirty`.
- **Save-vs-poll race** narrowed (server-side stat + in-flight guard) but a microsecond window
  remains; low severity, accepted + documented.
- **View state keyed by `${groupId}::path`** won't restore after `openToSide`/`moveTabToGroup`
  (new group id) — cursor/scroll resets in that one case; data is safe; acceptable for v1.
- **App-quit with dirty buffers loses edits silently** (no hot-exit in v1; `ExitRequested` only
  kills PTYs today) — consistent with not persisting dirty; documented, deferred.
- **Permanent delete** (no trash crate) is real data loss; mitigated by dialog confirm + git
  recoverability; revisit a justified `trash` dep later.
- **Bundle-size growth** from `monaco-editor`; acceptable for a desktop dev tool, mitigated by
  `editor.worker`-only + optional `manualChunks`; note first-build/cold-start cost.

## 15. Testing

- **Rust:** add `#[cfg(test)]` unit tests for the pure parts of the read-contract change
  (UTF-8/binary/size tiering) and `write_file` (atomic rename semantics, mode preservation,
  missing-parent rejection). Run `cargo test`.
- **Frontend registry:** dev-only `vitest` over the framework-agnostic `registry.ts`
  (ref-count/dirty/version-id logic).
- **Manual (required):** each phase is **launch-verified in the app** (not `tsc` alone), per the
  project's testing-reality rule — Phase 2 specifically against a live `claude` agent editing an
  open file. Dev runs use `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev` to avoid clobbering the
  installed app's state.
