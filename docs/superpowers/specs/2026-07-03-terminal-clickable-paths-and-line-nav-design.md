# Terminal clickable paths + line-nav keys — Design (Spec A)

- **Date:** 2026-07-03
- **Status:** Approved (pending spec review)
- **Scope:** Two focused terminal-UX wins, both centred on `Terminal.tsx`:
  1. **Cmd+Click a file path** that `claude` (or any command) prints in a session terminal →
     open it in Conduit's Monaco editor and **jump to the referenced line** (`path:line:col`).
  2. **Cmd+Left / Cmd+Right** while typing in a session terminal → move the shell cursor to
     **line start / line end** (readline `Ctrl+A` / `Ctrl+E`).
- **Out of scope (this is "Spec A" of a two-spec split):** making Conduit a recognised
  **IDE** — the `~/.claude/ide` lock file, a WebSocket/MCP server, IDE env vars (`CLAUDE_CODE_SSE_PORT`,
  `ENABLE_IDE_INTEGRATION`), `openDiff`, diagnostics, and selection sharing — is deferred to a
  separate **Spec B** (see §9). Feature A1 deliberately does **not** depend on any of that; it
  reuses the existing in-app file-open path.
- **Confirmed decisions (from brainstorming):** open in **Conduit's own editor** (not external
  VSCode) and jump to the line; **terminal-only** for the nav keys (Monaco already binds
  Cmd+Left/Right to line start/end on macOS); the underline/click affordance is **Cmd-gated**
  (VSCode-style); resolution is done by a **unit-tested Rust command** (worst case = a dead
  underline that no-ops, never the wrong file); **no** word-nav (Option+Left/Right) in v1.

---

## 1. Why this is small — the file-open path already exists

Feature A1's "open a file at a path" is already built end-to-end and used by the file tree:

- `openFile(projectId, path)` (`src/store.ts:777`) opens a `{ kind: "file", ref: absPath }` tab
  and `registry.acquire(path)`.
- `CodeEditorPane` (`src/components/CodeEditorPane.tsx`) reads the active file for its group,
  invokes the Rust `read_file` command, and sets a Monaco model via the path-keyed registry.
- Terminals are keep-alive panes CSS-placed inside `.term-stack`; `TerminalView`
  (`src/components/Terminal.tsx`) is constructed **once** (`registerLinkProvider` is a stable
  method on the xterm `Terminal` instance — no config change needed) and already owns a `writeSeq(d)` → Rust `pty_write`
  path and an `attachCustomKeyEventHandler` that special-cases Shift+Enter and Cmd+Backspace.

So the only genuinely new pieces are: (1) a **terminal link provider** that recognises paths and
routes Cmd+Click into `openFile`, (2) a small **Rust resolver** that turns a terminal token into a
verified absolute path + line, (3) a **reveal-to-line** hop so `openFile` can scroll the editor to
a line, and (4) **two key branches** in the existing terminal key handler. No change to the
keep-alive / CSS-weight layout model, no new dependency.

## 2. Feature A1 — architecture (detect → gate → resolve → open+reveal)

Four stages, each with a single clear owner:

**(a) Detect — JS link provider in `Terminal.tsx`.** Register `term.registerLinkProvider(provider)`.
Its `provideLinks(bufferLineNumber, callback)` runs a **path regex** over the reconstructed logical
line (joining wrapped rows) and returns an `ILink` per match with a 1-based `range`, the matched
`text`, and an `activate` handler. Candidate shapes matched:

- absolute — `/…`
- home — `~/…`
- explicit-relative — `./…`, `../…`
- workspace-relative — a token that **contains a `/`** and ends in a known code/text extension
  (the extension + slash requirement is what keeps false positives down)

…each optionally suffixed with `:line` or `:line:col`. Surrounding quotes/parens/trailing
punctuation are trimmed from the match range.

**(b) Gate on Cmd (VSCode-faithful).** A module-scoped `cmdHeld` flag is tracked via `keydown`/
`keyup` (Meta) listeners on the terminal element. `provideLinks` returns links **only while
`cmdHeld` is true**; otherwise it calls `callback(undefined)`, so with Cmd up the region is plain
text — normal selection works and nothing underlines. This yields the "paths light up and become
clickable only while ⌘ is held" behaviour and sidesteps any link-vs-selection conflict on plain
clicks. (Accepted minor: because xterm re-queries providers on mouse-move, the underline appears on
the first mouse-move after ⌘ is pressed, not on the keypress itself — standard terminal behaviour.)

**(c) Resolve — Rust command `resolve_terminal_path`.** `activate(event, text)` double-checks
`event.metaKey`, then `invoke("resolve_terminal_path", { base, token: text })` where `base` is the
session's `workingDirectory`. The command (see §4) parses off `:line:col`, expands `~`,
joins relatives against `base`, canonicalises, and confirms the target is an **existing file**,
returning `{ absPath, line, col } | null`.

**(d) Open + reveal.** On a non-null result, call `openFile(projectId, absPath, { line, col })`
(the reveal-carrying overload from §3). If null, no-op (a mistyped/stale path simply does nothing).

## 3. Reveal-to-line plumbing (`openFile` overload + one-shot store field)

`openFile` grows an optional third arg: `openFile(projectId, path, reveal?: { line: number; col?: number })`.

- When `reveal` is present, in addition to opening/activating the tab, it sets a **one-shot**
  store field `pendingReveal: { path: string; line: number; col: number } | null` (non-persisted,
  alongside the existing non-persisted `dirty`/`conflict` maps).
- `CodeEditorPane` gains a small effect keyed on `[pendingReveal, activePath, model-ready]`: when
  `pendingReveal?.path === activePath` and the model for that path is set, it calls
  `editor.revealLineInCenter(line)` + `editor.setPosition({ lineNumber: line, column: col })` +
  `editor.focus()`, then clears the field (`clearPendingReveal()`).
- This is robust to the async model load (`read_file` round-trip): the reveal fires when the model
  is ready, whether the file was freshly opened or already open (re-clicking a path to jump to a
  new line re-applies because the effect also depends on `pendingReveal`).

Only the pane whose `activeRef` equals the reveal path acts; opening the same path in two split
columns is unreachable via the current reducers (per the Monaco spec §2), so no ambiguity.

## 4. Rust `resolve_terminal_path` — pure parsing + one stat (unit-tested)

New command in `src-tauri/src/fsops.rs`, registered in `lib.rs`'s `generate_handler!`,
**`std::fs` + `dirs` only** (no new crate — `dirs` is already a dependency):

```
resolve_terminal_path(base: String, token: String) -> Option<ResolvedPath>
// ResolvedPath { abs_path: String, line: Option<u32>, col: Option<u32> }
```

Split into a **pure** helper and a thin fs wrapper so the parsing is fully testable:

- `parse_path_token(token) -> (path_part: &str, line: Option<u32>, col: Option<u32>)` — strips a
  trailing `:(\d+)(:(\d+))?`. Guards so a bare drive-ish `foo:bar` (non-numeric suffix) is treated
  as part of the path, not a line number. Pure — heavy unit coverage here.
- resolve: expand a leading `~`/`~/` via `dirs::home_dir()`; if `path_part` is relative
  (not `/`, not `~`), join onto `base`; `std::fs::canonicalize` (resolves `..`/symlinks **and**
  errors if the path doesn't exist — doubling as the existence check); require
  `metadata.is_file()` (reject directories). Any failure → `None`.

**Why Rust, not JS:** the repo has no frontend test runner but does test pure Rust logic with
`cargo test`; `:line:col` parsing, `~` expansion, and relative-join are exactly that kind of
pure logic, and canonicalisation/existence is more correct in `std::fs` than hand-rolled in TS.

## 5. Feature A2 — Cmd+Left / Cmd+Right in the terminal

In the existing `attachCustomKeyEventHandler` in `Terminal.tsx` (which already returns `false` to
swallow keys it handles, after `writeSeq`-ing a byte sequence), add two `keydown` branches:

- `e.metaKey && e.key === "ArrowLeft"` → `writeSeq("\x01")` (Ctrl+A, start-of-line) → return `false`
- `e.metaKey && e.key === "ArrowRight"` → `writeSeq("\x05")` (Ctrl+E, end-of-line) → return `false`

Both gated on `e.type === "keydown"` (mirroring the existing branches) so they don't double-fire on
keyup, and guarded to ignore when other modifiers that would change intent are present.

`\x01`/`\x05` are the standard **emacs/readline** line motions honoured by zsh (default `bindkey -e`),
bash, and Claude's own prompt. `macOptionIsMeta: true` affects the **Option** key only, so it does
not interact with these ⌘ bindings. **Accepted limitation:** a user who has put zsh in **vi** mode
(`bindkey -v`) will get emacs SOL/EOL semantics from these keys rather than vi motions; documented,
not handled in v1 (matches the "line start/end" intent for the overwhelming default).

## 6. Files to add / change

**Change**
- `src/components/Terminal.tsx` — register the link provider (regex + Cmd-gated `provideLinks`
  + `activate` → `resolve_terminal_path` → `openFile`); add the ⌘ArrowLeft/Right branches to
  `attachCustomKeyEventHandler`; track `cmdHeld` via element keydown/keyup; accept a `projectId`
  prop (already in scope where `TerminalView` is rendered in `WorkspaceCenter.tsx`).
- `src/components/WorkspaceCenter.tsx` — pass `projectId` to `<TerminalView>` if not already passed.
- `src/store.ts` — `openFile` reveal overload; non-persisted `pendingReveal` field +
  `clearPendingReveal()`.
- `src/components/CodeEditorPane.tsx` — reveal effect (`revealLineInCenter` + `setPosition` +
  `focus`, then clear) when `pendingReveal` matches the pane's active path and the model is ready.
- `src-tauri/src/fsops.rs` — `parse_path_token` (pure) + `resolve_terminal_path` command +
  `ResolvedPath` struct.
- `src-tauri/src/lib.rs` — register `resolve_terminal_path` in `generate_handler!` (no capability
  change).

**Add:** none (no new files, no new dependency, no new Tauri plugin/capability).

## 7. Testing / verification

- **Rust (`cargo test`):** `parse_path_token` — `src/x.ts`, `src/x.ts:45`, `src/x.ts:45:12`,
  `/abs/x.ts`, `~/x.ts`, no-suffix, non-numeric colon suffix (`a:b` stays a path); and
  `resolve_terminal_path` against a `tempdir` — relative-vs-base, absolute, `~`-expansion,
  non-existent → `None`, directory → `None`, file → `Some`.
- **Frontend:** `pnpm exec tsc --noEmit`.
- **Manual (required — no frontend test runner):** launch the isolated dev app
  (`CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`) and confirm: ⌘-hover underlines a real
  `path:line` in a session, plain hover does not; ⌘+Click opens the file at the right line; a
  bogus path no-ops; and ⌘+Left/⌘+Right move the shell cursor to line start/end in both a plain
  zsh prompt and the `claude` prompt.

## 8. Risks / accepted limitations

- **Regex false positives / negatives.** Mitigated by requiring a slash or an explicit `~/`, `./`,
  `../`, `/` prefix **and** by the Rust existence gate — a wrong match at worst underlines a token
  that no-ops on click; it can never open the wrong file. Tune the extension list during manual
  verification.
- **⌘-hold underline latency.** Underline appears on the first mouse-move after ⌘ is pressed (xterm
  re-queries link providers on move, not on modifier change). Standard terminal behaviour; accepted.
- **Line motions assume emacs-mode readline.** vi-mode zsh users get emacs SOL/EOL from ⌘Left/Right;
  documented, not special-cased in v1.
- **Canonicalise resolves symlinks**, so the opened tab shows the real target path rather than the
  symlink path. Acceptable (and consistent — the editor keys models by absolute path).

## 9. Relationship to Spec B (IDE integration)

Spec B will make Conduit a recognised Claude Code IDE: a loopback **WebSocket** JSON-RPC/MCP server
(precedent: `bridge.rs`'s `tungstenite` server and `fleet_mcp.rs`'s MCP server), a
`~/.claude/ide/<port>.lock` file, and `CLAUDE_CODE_SSE_PORT` / `ENABLE_IDE_INTEGRATION` injected at
the existing env choke point (`pty.rs:259`), exposing tools like `openFile`, `openDiff`,
`getCurrentSelection`, `getDiagnostics`, `getOpenEditors`. Spec A ships independently and is not
blocked by it; when Spec B lands, its `openFile` tool can reuse the same reveal plumbing from §3.
```
