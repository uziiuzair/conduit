# Terminal Clickable Paths + Line-Nav Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a Conduit session terminal, ⌘+Click a file path `claude` prints to open it in the Monaco editor at the referenced line, and ⌘+Left/⌘+Right to jump the shell cursor to line start/end.

**Architecture:** A new unit-tested Rust command `resolve_terminal_path` turns a terminal token (`path:line:col`, relative/`~`/absolute) into a verified absolute file path + line. `Terminal.tsx` registers an xterm link provider that underlines path tokens **only while ⌘ is held**, and on ⌘+Click calls the resolver then the existing `openFile` store action — extended with a one-shot `pendingReveal` that `CodeEditorPane` consumes to `revealLineInCenter`. Two branches in the existing terminal key handler map ⌘←/⌘→ to readline `Ctrl+A`/`Ctrl+E`.

**Tech Stack:** Rust (`std::fs` + `dirs`, already a dep) for `src-tauri`; React 19 + TypeScript + Zustand + `monaco-editor` + `@xterm/xterm` for `src`.

**Conventions:** This repo uses Conventional Commits, scoped. **Every commit message in this plan must end with the trailer** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (per CLAUDE.md). The frontend has **no test runner** — the gate for TS changes is `pnpm exec tsc --noEmit`; behavioural correctness is confirmed only by launching the app (Task 7). Do **not** run a bare `pnpm tauri dev` (it clobbers the installed app's state) — always isolate with `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`.

---

## File Structure

**Modify (no new files, no new dependencies):**

- `src-tauri/src/fsops.rs` — add pure `parse_path_token`, the `resolve_terminal_path` fn + `ResolvedPath` struct, and their `#[cfg(test)]` module. Fits the file's existing "pure logic, unit-tested" pattern.
- `src-tauri/src/lib.rs` — add the `#[tauri::command] resolve_terminal_path` wrapper and register it in `generate_handler!`.
- `src/store.ts` — `AppState`: `pendingReveal` field + `clearPendingReveal`, and `openFile`'s optional `reveal` arg; initialise `pendingReveal: null`; implement `clearPendingReveal`; set `pendingReveal` inside `openFile`.
- `src/components/CodeEditorPane.tsx` — a reveal effect that consumes `pendingReveal`.
- `src/components/Terminal.tsx` — a `projectId` prop; the ⌘-gated link provider (detect → resolve → `openFile`); the ⌘←/⌘→ key branches; disposal in cleanup.
- `src/components/WorkspaceCenter.tsx` — pass `projectId={project.id}` to `<TerminalView>`.

**Dependency order:** Task 1 (resolver + tests) → Task 2 (command wrapper) → Task 3 (store) → Task 4 (editor reveal) → Task 5 (terminal provider + keys) → Task 6 (wire prop) → Task 7 (manual launch verification). Frontend Tasks 5–6 depend on the Task 2 command and the Task 3 signature; Task 4 depends on the Task 3 `pendingReveal`.

---

## Task 1: Rust path resolver (`parse_path_token` + `resolve_terminal_path`)

**Files:**
- Modify: `src-tauri/src/fsops.rs` (add code after `delete_path`, ~line 308; add a new test module after `crud_tests`, ~line 536)

- [ ] **Step 1: Write the failing tests**

Append this test module to the **end** of `src-tauri/src/fsops.rs` (after the closing `}` of `mod crud_tests`):

```rust
#[cfg(test)]
mod resolve_tests {
    use super::*;

    /// Fresh unique scratch dir under the OS temp dir (mirrors the other test modules).
    fn tmpdir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir()
            .join(format!("conduit-fsops-resolve-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_token_variants() {
        assert_eq!(parse_path_token("src/a.ts"), ("src/a.ts", None, None));
        assert_eq!(parse_path_token("src/a.ts:45"), ("src/a.ts", Some(45), None));
        assert_eq!(parse_path_token("src/a.ts:45:12"), ("src/a.ts", Some(45), Some(12)));
        assert_eq!(parse_path_token("/abs/a.ts:9"), ("/abs/a.ts", Some(9), None));
        assert_eq!(parse_path_token("~/a.ts"), ("~/a.ts", None, None));
        // a non-numeric colon suffix stays part of the path (not a line number)
        assert_eq!(parse_path_token("weird:name"), ("weird:name", None, None));
        // an empty/trailing colon group is not a line number either
        assert_eq!(parse_path_token("a.ts:"), ("a.ts:", None, None));
    }

    #[test]
    fn resolves_relative_against_base_with_line_col() {
        let dir = tmpdir();
        let f = dir.join("hello.txt");
        fs::write(&f, b"hi").unwrap();
        let r = resolve_terminal_path(dir.to_str().unwrap(), "hello.txt:3:2").expect("resolves");
        assert_eq!(r.abs_path, fs::canonicalize(&f).unwrap().to_string_lossy().into_owned());
        assert_eq!(r.line, Some(3));
        assert_eq!(r.col, Some(2));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_absolute_ignoring_base() {
        let dir = tmpdir();
        let f = dir.join("x.txt");
        fs::write(&f, b"hi").unwrap();
        let r = resolve_terminal_path("/no/such/base", f.to_str().unwrap()).expect("resolves");
        assert_eq!(r.abs_path, fs::canonicalize(&f).unwrap().to_string_lossy().into_owned());
        assert_eq!(r.line, None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_is_none() {
        let dir = tmpdir();
        assert!(resolve_terminal_path(dir.to_str().unwrap(), "nope.txt").is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn directory_is_none() {
        let dir = tmpdir();
        let sub = dir.join("sub");
        fs::create_dir(&sub).unwrap();
        assert!(resolve_terminal_path(dir.to_str().unwrap(), "sub").is_none());
        fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: Run tests to verify they fail (do not compile yet)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resolve_tests`
Expected: FAIL — compile errors, `cannot find function 'parse_path_token'` / `'resolve_terminal_path'` / `cannot find type 'ResolvedPath'`.

- [ ] **Step 3: Write the implementation**

Insert this block into `src-tauri/src/fsops.rs` **after** the `delete_path` function (after its closing `}`, ~line 308) and **before** `#[cfg(test)] mod tests`:

```rust
// ---- terminal path resolution (clickable paths) ---------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPath {
    pub abs_path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
}

/// Split a terminal token into its path part and optional 1-based line/col. A trailing
/// `:<line>` or `:<line>:<col>` (all-ASCII-digit groups) is stripped; a non-numeric colon
/// suffix (e.g. `foo:bar`) is left as part of the path. Pure — unit-tested without the fs.
fn parse_path_token(token: &str) -> (&str, Option<u32>, Option<u32>) {
    // Peel a single trailing `:<digits>` group off `s`, if present.
    fn peel(s: &str) -> Option<(&str, u32)> {
        let idx = s.rfind(':')?;
        let (head, tail) = s.split_at(idx);
        let num = &tail[1..]; // drop the ':'
        if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        num.parse::<u32>().ok().map(|n| (head, n))
    }
    if let Some((head1, n1)) = peel(token) {
        if let Some((head2, n2)) = peel(head1) {
            return (head2, Some(n2), Some(n1)); // head2:line:col
        }
        return (head1, Some(n1), None); // head1:line
    }
    (token, None, None)
}

/// Expand a leading `~` or `~/` to the user's home dir (not `~user`); otherwise unchanged.
fn expand_home(path: &str) -> String {
    if path == "~" {
        if let Some(h) = dirs::home_dir() {
            return h.to_string_lossy().into_owned();
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = dirs::home_dir() {
            return h.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Resolve a path token printed in a terminal into an existing regular file. `base` is the
/// session's working directory (used for relative tokens). Returns None when the token does
/// not resolve to an existing file (canonicalize confirms existence + resolves `..`/symlinks;
/// directories are rejected). Never opens or reads the file.
pub fn resolve_terminal_path(base: &str, token: &str) -> Option<ResolvedPath> {
    let (path_part, line, col) = parse_path_token(token.trim());
    if path_part.is_empty() {
        return None;
    }
    let expanded = expand_home(path_part);
    let joined = if Path::new(&expanded).is_absolute() {
        std::path::PathBuf::from(&expanded)
    } else {
        Path::new(base).join(&expanded)
    };
    let canon = fs::canonicalize(&joined).ok()?;
    if !canon.is_file() {
        return None;
    }
    Some(ResolvedPath {
        abs_path: canon.to_string_lossy().into_owned(),
        line,
        col,
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resolve_tests`
Expected: PASS — `test result: ok. 5 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fsops.rs
git commit -m "$(cat <<'EOF'
feat(fsops): resolve_terminal_path for clickable terminal paths

Pure parse_path_token (strips :line:col) + resolve_terminal_path (expand ~,
join against session cwd, canonicalize, verify existing file). Unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Expose `resolve_terminal_path` as a Tauri command

**Files:**
- Modify: `src-tauri/src/lib.rs` (add wrapper after `delete_path`, ~line 503; register in `generate_handler!`, ~line 729)

- [ ] **Step 1: Add the command wrapper**

In `src-tauri/src/lib.rs`, immediately after the `delete_path` command (its closing `}` at ~line 503), add:

```rust
#[tauri::command]
fn resolve_terminal_path(base: String, token: String) -> Option<fsops::ResolvedPath> {
    fsops::resolve_terminal_path(&base, &token)
}
```

- [ ] **Step 2: Register it in the handler**

In the `generate_handler!` list (`src-tauri/src/lib.rs`), add `resolve_terminal_path,` on the line **after** `delete_path,` (~line 729):

```rust
            delete_path,
            resolve_terminal_path,
            notify_user,
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds cleanly (no errors). A warning-free compile of the new command confirms the signature matches Tauri's expectations.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(commands): register resolve_terminal_path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Store — `pendingReveal` + `openFile` reveal overload

**Files:**
- Modify: `src/store.ts` (`AppState` interface ~408 & ~429; state init ~483; actions ~777 & ~867)

- [ ] **Step 1: Extend the `openFile` type**

In `src/store.ts`, change the `openFile` declaration in the `AppState` interface (line 408) from:

```ts
  openFile: (projectId: string, path: string) => void;
```

to:

```ts
  openFile: (projectId: string, path: string, reveal?: { line: number; col?: number }) => void;
```

- [ ] **Step 2: Declare `pendingReveal` + `clearPendingReveal` in `AppState`**

In `src/store.ts`, in the "editor buffer state (Monaco) — NON-PERSISTED" block, after the `requestCloseTab` declaration (line 429), add:

```ts
  /** One-shot editor reveal target set by a terminal path ⌘+Click; consumed by CodeEditorPane. */
  pendingReveal: { path: string; line: number; col: number } | null;
  clearPendingReveal: () => void;
```

- [ ] **Step 3: Initialise `pendingReveal`**

In `src/store.ts`, in the store's initial state, after `conflict: {},` (line 483) add:

```ts
    pendingReveal: null,
```

- [ ] **Step 4: Set `pendingReveal` inside `openFile`**

In `src/store.ts`, replace the `openFile` action (lines 777–783):

```ts
    openFile: (projectId, path) => {
      const l = get().layouts[projectId];
      // Only a genuinely new tab bumps the ref (rOpenTab just re-activates an existing one).
      const already = !!l && l.groups.some((g) => g.tabs.some((t) => t.ref === path));
      applyLayout(projectId, (l2) => rOpenTab(l2, { kind: "file", ref: path }));
      if (!already) registry.acquire(path);
    },
```

with:

```ts
    openFile: (projectId, path, reveal) => {
      const l = get().layouts[projectId];
      // Only a genuinely new tab bumps the ref (rOpenTab just re-activates an existing one).
      const already = !!l && l.groups.some((g) => g.tabs.some((t) => t.ref === path));
      applyLayout(projectId, (l2) => rOpenTab(l2, { kind: "file", ref: path }));
      if (!already) registry.acquire(path);
      // One-shot reveal target: CodeEditorPane scrolls to it once the model is set.
      if (reveal) set({ pendingReveal: { path, line: reveal.line, col: reveal.col ?? 1 } });
    },
```

- [ ] **Step 5: Implement `clearPendingReveal`**

In `src/store.ts`, after the `setConflict` action (line 867), add:

```ts
    clearPendingReveal: () => set((s) => (s.pendingReveal ? { pendingReveal: null } : {})),
```

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (The optional `reveal` arg is backward-compatible with existing `openFile(projectId, path)` callers in `FileTree.tsx` and `store.ts`'s `renamePath`.)

- [ ] **Step 7: Commit**

```bash
git add src/store.ts
git commit -m "$(cat <<'EOF'
feat(store): openFile reveal overload + one-shot pendingReveal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: CodeEditorPane — consume `pendingReveal` to jump to the line

**Files:**
- Modify: `src/components/CodeEditorPane.tsx` (add selectors ~line 104; add effect after the reveal-relayout effect ~line 274)

- [ ] **Step 1: Add the store selectors**

In `src/components/CodeEditorPane.tsx`, after the `requestCloseTab` selector (line 104), add:

```ts
  const pendingReveal = useStore((s) => s.pendingReveal);
  const clearPendingReveal = useStore((s) => s.clearPendingReveal);
```

- [ ] **Step 2: Add the reveal effect**

In `src/components/CodeEditorPane.tsx`, immediately after the "Relayout + focus on reveal" effect (the one closing with `}, [visible]);` at line 274), add:

```ts
  // Jump to a line when a terminal ⌘+Click opened this file with a reveal target. Fires once
  // the model for the reveal path is set (so it survives the async read_file), whether the file
  // was freshly opened or already open. Clears the one-shot flag once the target tab is loaded —
  // even a binary/error tab with no model — so a stale reveal can never linger.
  useEffect(() => {
    if (!pendingReveal || pendingReveal.path !== activePath) return;
    if (load.kind !== "ready") return;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (ed && model) {
      const line = Math.min(Math.max(pendingReveal.line, 1), model.getLineCount());
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: pendingReveal.col });
      ed.focus();
    }
    clearPendingReveal();
  }, [pendingReveal, activePath, load, clearPendingReveal]);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/CodeEditorPane.tsx
git commit -m "$(cat <<'EOF'
feat(editor): reveal-to-line on terminal path click

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Terminal — ⌘-gated path link provider + ⌘←/⌘→ line nav

**Files:**
- Modify: `src/components/Terminal.tsx` (import ~line 2; `Props` ~line 16; destructure ~line 44; link provider + ⌘-tracking inside the create-once effect ~line 82; key branches ~line 106; cleanup ~line 131)

- [ ] **Step 1: Import the xterm link type**

In `src/components/Terminal.tsx`, change the import on line 2 from:

```ts
import { Terminal as Xterm } from "@xterm/xterm";
```

to:

```ts
import { Terminal as Xterm, type ILink } from "@xterm/xterm";
```

- [ ] **Step 2: Add the `projectId` prop**

In the `Props` interface (line 16), add `projectId` right after `sessionId`:

```ts
interface Props {
  sessionId: string;
  projectId: string;
  workingDirectory: string;
```

And in the destructured params of `TerminalView` (line 44), add `projectId`:

```ts
export function TerminalView({
  sessionId,
  projectId,
  workingDirectory,
  visible,
```

- [ ] **Step 3: Add ⌘-tracking + the link provider inside the create-once effect**

In `src/components/Terminal.tsx`, inside the create-once `useEffect`, immediately after the `term.onData((d) => writeSeq(d));` line (line 85), insert:

```ts
    // --- ⌘+Click a file path -> open it in Conduit's editor (VS Code parity) ---
    // Track whether ⌘ is held so path tokens only light up / activate with the modifier;
    // a plain click keeps normal terminal selection.
    let cmdHeld = false;
    const onMod = (ev: KeyboardEvent) => {
      cmdHeld = ev.metaKey;
    };
    const onBlur = () => {
      cmdHeld = false;
    };
    window.addEventListener("keydown", onMod, true);
    window.addEventListener("keyup", onMod, true);
    window.addEventListener("blur", onBlur);

    const openPath = async (raw: string) => {
      try {
        const r = await invoke<{ absPath: string; line: number | null; col: number | null } | null>(
          "resolve_terminal_path",
          { base: workingDirectory, token: raw },
        );
        if (!r) return;
        useStore.getState().openFile(
          projectId,
          r.absPath,
          r.line != null ? { line: r.line, col: r.col ?? 1 } : undefined,
        );
      } catch {
        /* a stale/mistyped path simply does nothing */
      }
    };

    // Absolute (/…), home (~/…), explicit-relative (./,../) or workspace-relative (≥2 segments)
    // path with an optional :line or :line:col suffix. Deliberately permissive — the Rust
    // resolver verifies existence, so a false match at worst underlines a dead token.
    const PATH_SOURCE =
      "(?:(?:~\\/|\\.\\.?\\/|\\/)[\\w.\\-@]+(?:\\/[\\w.\\-@]+)*|[\\w.\\-@]+(?:\\/[\\w.\\-@]+)+)(?::\\d+(?::\\d+)?)?";

    const linkDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        if (!cmdHeld) return callback(undefined);
        const buf = term.buffer.active;
        // Walk up to the first row of the (possibly wrapped) logical line.
        let start = bufferLineNumber - 1;
        while (start > 0 && buf.getLine(start)?.isWrapped) start--;
        // Concatenate wrapped rows at FULL width (translateToString(false)) so a string index
        // maps exactly to a cell: row = floor(i/cols), col = i % cols.
        const cols = term.cols;
        let text = "";
        let row = start;
        for (;;) {
          const line = buf.getLine(row);
          if (!line) break;
          text += line.translateToString(false);
          const next = buf.getLine(row + 1);
          if (next?.isWrapped) row++;
          else break;
        }
        const re = new RegExp(PATH_SOURCE, "g");
        const links: ILink[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const raw = m[0];
          const s = m.index;
          const e = s + raw.length - 1;
          links.push({
            range: {
              start: { x: (s % cols) + 1, y: start + Math.floor(s / cols) + 1 },
              end: { x: (e % cols) + 1, y: start + Math.floor(e / cols) + 1 },
            },
            text: raw,
            activate: (ev: MouseEvent, matched: string) => {
              if (!ev.metaKey) return;
              void openPath(matched);
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });
```

- [ ] **Step 4: Add the ⌘←/⌘→ branches to the key handler**

In `src/components/Terminal.tsx`, inside `attachCustomKeyEventHandler`, immediately **before** the final `return true;` (line 107), add:

```ts
      // Cmd+Left / Cmd+Right → start / end of line (readline Ctrl-A / Ctrl-E). VS Code parity.
      if (e.key === "ArrowLeft" && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        writeSeq("\x01");
        return false;
      }
      if (e.key === "ArrowRight" && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        writeSeq("\x05");
        return false;
      }
```

- [ ] **Step 5: Dispose the provider + listeners in cleanup**

In `src/components/Terminal.tsx`, in the create-once effect's cleanup `return () => { … }` (starting line 131), add these lines before `term.dispose();` (line 137):

```ts
      linkDisposable.dispose();
      window.removeEventListener("keydown", onMod, true);
      window.removeEventListener("keyup", onMod, true);
      window.removeEventListener("blur", onBlur);
```

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (`projectId` is now required on `TerminalView`; Task 6 supplies it — expect a type error here until Task 6 is done **if** you typecheck before wiring the prop. If so, proceed to Task 6 then re-run; do not add a placeholder.)

- [ ] **Step 7: Commit**

```bash
git add src/components/Terminal.tsx
git commit -m "$(cat <<'EOF'
feat(terminal): Cmd+Click opens file paths + Cmd+Left/Right line nav

Cmd-gated xterm link provider resolves path:line:col via resolve_terminal_path
and opens it in the editor at the line; Cmd+Left/Right emit readline Ctrl-A/E.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire `projectId` into `TerminalView`

**Files:**
- Modify: `src/components/WorkspaceCenter.tsx` (`<TerminalView>` render, ~line 177)

- [ ] **Step 1: Pass the prop**

In `src/components/WorkspaceCenter.tsx`, in the `<TerminalView>` element (line 177), add `projectId={project.id}` right after `sessionId={session.id}` (line 179):

```tsx
              <TerminalView
                key={session.id}
                sessionId={session.id}
                projectId={project.id}
                workingDirectory={session.useWorktree ? project.path : workingDirOf(project, session)}
```

- [ ] **Step 2: Typecheck the whole frontend**

Run: `pnpm exec tsc --noEmit`
Expected: no errors (Task 5's required `projectId` prop is now satisfied).

- [ ] **Step 3: Commit**

```bash
git add src/components/WorkspaceCenter.tsx
git commit -m "$(cat <<'EOF'
feat(workspace): pass projectId to TerminalView for path opening

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual launch verification (no test runner for the frontend)

**Files:** none (verification only).

- [ ] **Step 1: Full pre-launch checks**

Run each and confirm clean:
```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
pnpm exec tsc --noEmit
```
Expected: tests pass, no clippy errors, no TS errors.

- [ ] **Step 2: Launch the isolated dev app**

Run (from the worktree root): `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev`
Expected: the dev app opens against `…/ConduitTauri-dev/state.json` (does not touch the installed app's state).

- [ ] **Step 3: Verify ⌘+Click path opening**

In a session terminal, `cd` into a project and run something that prints a real path with a line, e.g. `grep -n import src/store.ts | head -1` (prints `src/store.ts:1:…`) or ask `claude` to reference a file.
- Hover a printed path **without** ⌘ → no underline; a plain click selects text normally.
- Hold ⌘ and move over the path → it underlines. ⌘+Click → the file opens in the Monaco editor and the cursor/scroll lands on the referenced line.
- ⌘+Click a **relative** path (e.g. `src/store.ts:100`) → resolves against the session cwd and opens at line 100.
- ⌘+Click a token that is not a real file (e.g. `foo/bar.baz`) → nothing happens (no wrong tab).

- [ ] **Step 4: Verify ⌘←/⌘→ line nav**

At a plain zsh prompt, type a long command, move the cursor to the middle, then:
- ⌘+Left → cursor jumps to the start of the line.
- ⌘+Right → cursor jumps to the end of the line.
Repeat inside the `claude` prompt (type a multi-word message) and confirm the same.

- [ ] **Step 5: Regression sanity**

Confirm the two pre-existing terminal chords still work: **Shift+Enter** inserts a newline in the `claude` prompt, and **⌘+Backspace** deletes to line start. Confirm editor **⌘+S** still saves. (These share the same key handler / editor and must be unaffected.)

- [ ] **Step 6: Finish**

No code commit for this task. If any check fails, fix under the owning task, re-commit there, and re-run this task. When all steps pass, the branch is ready for the finishing-a-development-branch flow (merge to `main` is gated on explicit human approval per CLAUDE.md).

---

## Self-Review (completed while authoring)

- **Spec coverage:** A1 detect (Task 5 provider) · A1 ⌘-gate (Task 5 `cmdHeld`) · A1 resolve (Tasks 1–2) · A1 open+reveal (Tasks 3–4) · A2 ⌘←/→ (Task 5 key branches) · testing (Task 1 unit tests, Task 7 manual) — all mapped.
- **Type consistency:** Rust `ResolvedPath { abs_path, line, col }` serialises (camelCase) to JS `{ absPath, line, col }`, matching the `invoke<…>` type in Task 5 and the `openFile(…, { line, col })` shape in Tasks 3–5. `pendingReveal: { path; line; col }` is identical in the `AppState` type (Task 3), the `set(...)` in `openFile` (Task 3), and the consumer in Task 4.
- **No placeholders:** every code and command step is concrete.
- **Ordering caveat surfaced:** Task 5 introduces the required `projectId` prop; Task 6 supplies it — called out in Task 5 Step 6 so a mid-sequence typecheck error isn't mistaken for a defect.
