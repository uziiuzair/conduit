# Editor Polish Tier 3 — Design

**Date:** 2026-07-10 · **Status:** implemented alongside this spec (single PR, stacked
on the Tier-2 branch)

Tier 3 of the VS Code feature-gap audit: the moderate-effort items, still zero heavy
dependencies. Six features (the audit's seventh, markdown preview, already shipped in
its own PR). Everything shells out to tools the user already has — `git`, `rg`/`grep`,
the project's own formatter — per the repo's lean-deps doctrine.

## 0. Module layout (Rust)

`git.rs`'s header contract is "**never mutates**", and this tier is the first feature
set that needs git mutation. Read-only additions (`git show`, `git diff -U0`,
`git ls-files`) stay in `git.rs`; the mutating discard command lives in a new
`git_mut.rs` whose header states the opposite contract, so the safety property remains
auditable per-module. Content search gets its own `search.rs`; formatter shell-out
`format.rs`; hot-exit persistence `hotexit.rs` (beside `store.rs`, reusing its
`data_dir()`).

All shell-outs follow `git.rs::run`'s pattern (`Command` + `.no_window()`), but the new
commands return `Result` and surface stderr — `run`'s discard-everything contract is
fine for polling, wrong for user-invoked actions.

## 1. Diff viewing

The biggest genuine gap. Three parts:

- **`git_show_head(dir, path) -> Result<String, String>`** — content of
  `HEAD:<relpath>` (path made repo-relative via `git ls-files --full-name`-style
  `rev-parse --show-toplevel` + strip). A path not in HEAD (new/untracked file)
  resolves to the empty string, so the diff shows all-added rather than erroring.
  Output capped at the same 24 MB bound as `read_file`.
- **Side-by-side view** — `monaco.editor.createDiffEditor`, already exported by the
  slim entry and computing in the shipped editor.worker. CodeEditorPane lazily creates
  ONE diff editor per pane (same create-once discipline as the main editor), hidden
  behind a `diff-host` overlay div. The **modified side is the registry model itself**
  — edits made inside the diff view are real buffer edits, so dirty tracking, save,
  trim-on-save, and the quit guard all work unchanged. The original side is a
  throwaway read-only model (`conduit-git://HEAD/<path>` URI) disposed on close/swap.
  Toggling is per-pane ephemeral state, like the markdown preview overlay. Zoom and
  word-wrap subscriptions apply to the diff editor too.
- **Entry points** — Changes-view rows are now clickable: click opens the file as a
  preview tab AND arms `pendingDiff` in the store (one-shot, consumed by the pane the
  same way `pendingReveal` is). A breadcrumb chip (`± Diff`) toggles it for any
  file with changes; it also lets you leave diff mode.
- **Gutter change decorations** — `git_diff_hunks(dir, path) -> Vec<Hunk>` runs
  `git diff -U0 HEAD -- <path>` and parses only the `@@ -a,b +c,d @@` headers into
  `{kind: added|modified|deleted, start, count}` against the NEW file. The parser is
  pure and unit-tested. The pane renders them as a `createDecorationsCollection` of
  gutter stripes (VS Code's green/blue/red triangle language). Refresh triggers:
  model swap, successful save, watcher reload/conflict-clear — **not** the 1.5 s
  watcher tick and not per keystroke; between refreshes the stripes are allowed to
  drift (they mark "since HEAD", not live edit positions).

## 2. Quick Open (⌘P)

- **`git_ls_files(dir) -> Vec<String>`** — `git ls-files -co --exclude-standard`
  (tracked + untracked, gitignore-aware, zero new crates), deduped, capped at 20 000
  entries. Non-repo directories fall back to a bounded `list_dir` walk (depth 6,
  10 000 entries, skipping `.git`/`node_modules`/`target`), so Quick Open still works
  in a plain folder.
- **Fuzzy matching** is a hand-rolled subsequence scorer in `src/fuzzy.ts` (pure,
  unit-tested): case-insensitive subsequence match; bonuses for consecutive runs,
  path-boundary starts (`/`, `.`, `-`, `_`, camelCase), and basename hits; filename
  matches beat directory matches. No new dependency — fzf-quality is not the bar,
  "types `stots` and finds `store.ts`" is.
- **UI** — `QuickOpen.tsx`, the first palette: `.dialog-overlay` backdrop + a
  top-anchored `.palette` box (new theme.css recipe shared with Find-in-Files).
  Arrow keys/Enter/Escape; Enter opens as a **preview tab** (single-click-in-tree
  semantics), consistent with VS Code. The empty query shows an MRU list — a
  session-only `recentFiles` array the store updates on every `openFile`.
- Dispatch is a native menu item (File ▸ Go to File… `CmdOrCtrl+P`) through the
  existing `"menu"` event, like Find/Replace. No capture-phase chord needed: menu
  accelerators fire over a focused terminal (the ⌃Tab exception was a muda
  Tab-glyph bug, not a general limitation).

## 3. Find in Files (⌘⇧F)

- **`search_content(dir, query, SearchOpts) -> Result<SearchResult, String>`** —
  prefers `rg --json --smart-case --fixed-strings -n --max-columns 400`
  (`--hidden --glob !.git`), falling back to `git grep -In` inside repos, then
  `grep -rIn` outside them. The rg JSON-lines parser is pure Rust and unit-tested;
  fallback parsers share a `path:line:text` splitter. Results capped at 500 hits
  (the cap is reported so the UI can say "truncated"), individual lines truncated at
  400 chars. Fixed-string search — agents and humans here paste literal snippets;
  regex mode is a later toggle if anyone misses it.
- **UI** — `SearchPalette.tsx`, same `.palette` recipe as Quick Open (⌘⇧F opens it,
  typing is debounced 250 ms). Hits grouped by file with the match substring
  highlighted; Enter/click opens the file **at the hit line** by passing
  `{ reveal: { line, col } }` through `openFile` — the exact plumbing terminal
  path-clicks already use. No workspace-wide replace, per the audit: bulk edits are
  what the agent in the next pane is for.

## 4. Format Document (⇧⌥F)

- **`format_content(dir, path, content) -> Result<FormatResult, String>`** formats
  the BUFFER (stdin → stdout), never the file on disk, so unsaved changes are
  preserved and undo works:
  - `prettier` for js/ts/jsx/tsx/json/css/scss/less/html/md/yaml — resolved as the
    project's own `node_modules/.bin/prettier` first (walking up from the file), else
    PATH; invoked with `--stdin-filepath <path>` so the project's config applies.
  - `rustfmt --edition 2021` for `.rs`; `gofmt` for `.go`.
  - Anything else / formatter missing → a clear error, surfaced via the established
    `notify_user` toast.
  - Formatters run through a login shell (`$SHELL -lc`, mirroring `detect_agents`'s
    PATH probe) because GUI-launched apps miss nvm/homebrew PATH entries; the file
    path rides as `$0`-style argv, never string-interpolated into the shell line.
- Frontend applies the result as one full-range `pushEditOperations` **only if the
  text actually changed**, preserving undo and cursor (Monaco maps the selection
  through the edit). View ▸ Format Document, `Shift+Alt+F` on all platforms (VS
  Code's own binding; Shift+Alt is not the AltGr trap that plain-Alt combos are).

## 5. Discard file to HEAD

- **`git_mut.rs::git_discard_file(dir, path) -> Result<DiscardKind, String>`** —
  tracked files get `git restore --source=HEAD --worktree -- <path>`; untracked files
  (which `changes()` reports as status `A`) are instead deleted via the existing
  `fsops::delete_path` (that IS the discard semantic for a file HEAD doesn't have).
  The command reports which kind ran; stderr propagates on failure.
- **UI** — a hover `↺` button on each Changes row, confirm-guarded with the
  plugin-dialog `ask()` used by every other destructive action. The confirm copy
  warns when the buffer is also dirty (the discard wins over unsaved edits — that's
  its meaning), and in that case the buffer is reloaded from disk immediately
  (store `reloadBufferFromDisk`, using the same `registry.saving` reconciliation
  window as the banner Reload) — the user just chose to discard, so the watcher's
  "changed on disk" banner would be noise. Clean buffers converge through the
  existing machinery: the 2.5 s git poll refreshes the list and `useFileWatch`
  silently reloads / clears state for a deleted one.

## 6. Hot exit

Debounced backup of dirty buffers; restored as dirty on relaunch.

- **Persistence** — `hotexit.rs`: one JSON file `data_dir()/hot-exit.json` holding
  `[{path, content, mtimeMs}]`, written atomically (tmp + rename, same recipe as
  `Store::save`). Commands: `hotexit_save(entries)` (whole-set replace — dirty sets
  are small, one atomic write beats per-file bookkeeping), `hotexit_load()`,
  `hotexit_clear()`. Entries above read_file's 24 MB bound are skipped.
- **Backup cadence** — a `useHotExit` app-level hook flushes the current dirty set
  (paths + `registry` model contents) at most every 3 s while anything is dirty,
  plus immediately on `visibilitychange` → hidden. When the dirty set empties, it
  writes the empty set (clearing stale backups).
- **Quit flow (deliberate change to Tier 2's prompt)** — with restore-on-launch in
  place, the quit prompt becomes VS Code-style hot exit: the frontend `"quit"`
  handler now flushes the backup and, **on success, quits silently**. Only if the
  flush fails (disk error) does the Tier-2 "Quit with unsaved changes?" dialog
  appear as the fallback. The Rust side is unchanged: DirtyGuard still gates
  CloseRequested/⌘Q so a clean quit never round-trips through the webview.
- **Restore** — on load the store stashes `hotexit_load()` results as
  `hotExit: Record<path, {content, mtimeMs}>`. When CodeEditorPane creates a model
  for a path with a stashed entry, it seeds the model from DISK (baseline = disk),
  then `pushEditOperations` the backup content on top — the buffer comes up dirty
  by construction (version id differs), undo-to-disk works, and every Tier-2
  dirty-protocol invariant holds. The entry is consumed on restore; a backup whose
  content equals disk (file was saved by other means) restores clean automatically
  because the version-id round-trip nets out. Restored buffers appear because the
  persisted layout re-opens their tabs; a backup for a path with no surviving tab
  is dropped at the next flush.

## 7. Known limits (accepted)

- Diff view is HEAD-vs-buffer only (no arbitrary ref pickers, no staged-vs-unstaged
  split — Conduit has no staging UI).
- Gutter stripes refresh on save/reload, not per keystroke; they can drift during
  heavy editing between saves.
- Quick Open's scorer is a subsequence heuristic, not fzf; ties break by path length.
- Find-in-Files is literal-text only, 500-hit cap, no replace.
- Format Document covers prettier/rustfmt/gofmt; other languages report "no
  formatter" rather than guessing.
- Hot exit restores content, not cursor/scroll (view state persists separately per
  group already); backups exclude read-only and >24 MB buffers.
