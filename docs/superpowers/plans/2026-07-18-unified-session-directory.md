# Unified Session Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All panels (Files, Changes, Git) and the right-panel companion shell bind to one confirmed per-session directory — the worktree once it exists on disk, the project root otherwise — and re-sync when it changes.

**Architecture:** Desired state vs. observed state. `session.worktreePath` is desired; a new runtime-only Zustand map `sessionDirs` is observed-confirmed, filled by one app-level polling hook backed by a new Rust `dir_exists` command. Panels read the observed value; the shell terminal defers its PTY spawn until the directory is confirmed and respawns if it changes afterwards. Agent terminals are untouched (keep-alive rule).

**Tech Stack:** React 19 + TypeScript + Zustand (`src/`), Rust Tauri commands (`src-tauri/src/`). Spec: `docs/superpowers/specs/2026-07-18-unified-session-directory-design.md`.

**Working directory:** `/Users/uziiuzair/ooozzy/Conduit/.claude/worktrees/file-terminal-git-2e5a4d` (git worktree, branch `worktree-file-terminal-git-2e5a4d`). Run everything from here.

## File structure

| File | Responsibility |
| --- | --- |
| Modify `src-tauri/src/fsops.rs` | pure `dir_exists` helper + unit tests |
| Modify `src-tauri/src/lib.rs` | `dir_exists` Tauri command + registration |
| Modify `src/store.ts` | `sessionDirs` state, `setSessionDir` action, `effectiveDirOf` selector |
| Create `src/hooks/useSessionDirs.ts` | the one resolver/poller |
| Modify `src/App.tsx` | mount the hook |
| Modify `src/components/RightColumn.tsx` | panels + shell consume effective dir; `dirReady` prop |
| Modify `src/components/WorkspaceCenter.tsx` | file-tab header dir (GroupTabStrip) consumes effective dir |
| Modify `src/components/Sidebar.tsx` | "Open in VS Code" consumes effective dir |
| Modify `src/components/Terminal.tsx` | `dirReady` spawn gate + shell respawn on dir change |
| Modify spec + `CHANGELOG.md` + 3 version files | dirReady amendment; release 0.17.1 |

**Note on the frontend:** there is NO JS test runner in this repo. Frontend verification is `pnpm exec tsc --noEmit` after every frontend task, `pnpm build` at the end, and a manual run of the dev app (Task 7). Do not claim UI behavior works from a typecheck.

---

### Task 1: Spec amendment — `dirReady` semantics

The committed spec defines `dirReady = !session.worktreePath || sessionDirs[session.id] === session.worktreePath`. That formula cannot distinguish "worktree not yet created" (shell must defer) from "worktree deleted" (shell must respawn at the project root) — both look like `worktreePath` set + unconfirmed. The fix: a *pending* worktree session keeps **no entry** in `sessionDirs` (the `effectiveDirOf` fallback supplies `project.path` for panels), so `dirReady` becomes "the session has an entry" — false only while pending.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-unified-session-directory-design.md`

- [ ] **Step 1: Replace the dirReady bullet in section 4**

Old text (single bullet under "### 4. Shell terminal — deferred spawn + respawn on change"):

> - **New prop `dirReady: boolean`** (default `true`, so agent terminals are unaffected).
>   The spawn effect waits for `visible && dirReady` before calling `pty_spawn`. RightColumn
>   computes `dirReady = !session.worktreePath || sessionDirs[session.id] ===
>   session.worktreePath` — i.e. non-worktree sessions are ready immediately; worktree
>   sessions are ready only once the worktree is confirmed on disk. A pending worktree
>   session's shell pane stays blank (unspawned) rather than spawning at the project root
>   and respawning seconds later. Both spawn paths honor the gate — the reveal path *and*
>   the eager restore-on-open path (`restoreSessionsOnOpen`) — since `spawnPty` is shared.

New text:

> - **New prop `dirReady: boolean`** (default `true`, so agent terminals are unaffected).
>   The spawn effect waits for `visible && dirReady` before calling `pty_spawn`. RightColumn
>   computes `dirReady = !session.worktreePath || sessionDirs[session.id] !== undefined` —
>   i.e. non-worktree sessions are ready immediately; a worktree session is ready once the
>   resolver has written *any* entry for it: the worktree path on confirmation, or the
>   project root after a confirmed worktree was deleted. A *pending* worktree session (no
>   entry yet — the worktree has never been seen on disk) keeps a blank, unspawned shell
>   pane rather than spawning at the project root and respawning seconds later. Panels are
>   unaffected while pending: `effectiveDirOf` falls back to `project.path`. Only the
>   reveal spawn path needs the gate — the eager restore-on-open path already skips
>   `shellOnly` terminals.

- [ ] **Step 2: Amend the resolver bullet in section 2**

Old text (first two bullets under "### 2. Resolver hook — one poller, app level"):

> - No `worktreePath` → `setSessionDir(id, project.path)` once; no polling.
> - `worktreePath` set → check `invoke("dir_exists", { path: worktreePath })` every **1 s**
>   until true, then `setSessionDir(id, worktreePath)` and stop the fast poll for that
>   session.

New text:

> - No `worktreePath` → `setSessionDir(id, project.path)` once; no polling.
> - `worktreePath` set, unconfirmed → check `invoke("dir_exists", { path: worktreePath })`
>   every **1 s**; on true, `setSessionDir(id, worktreePath)`. While pending, **no map
>   entry is written** — panels get `project.path` via the `effectiveDirOf` fallback, and
>   the absence of an entry is what keeps the shell's `dirReady` false (see section 4).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-18-unified-session-directory-design.md
git commit -m "docs(spec): dirReady keyed on map-entry presence so post-deletion respawn works"
```

---

### Task 2: Rust `dir_exists` (TDD)

**Files:**
- Modify: `src-tauri/src/fsops.rs` (function near `create_dir` at ~line 362; tests in the `#[cfg(test)] mod tests` at ~line 467 — the module that already defines the `unique_temp_dir` helper)
- Modify: `src-tauri/src/lib.rs` (command near `list_dir` at ~line 1100; registration near `list_dir,` at ~line 1584)

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/fsops.rs`, inside the `#[cfg(test)] mod tests` block that contains `unique_temp_dir` (~line 467), add:

```rust
    #[test]
    fn dir_exists_true_for_directory() {
        let dir = unique_temp_dir("direxists");
        assert!(dir_exists(dir.to_str().unwrap()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dir_exists_false_for_missing_path() {
        let dir = unique_temp_dir("direxists-missing");
        let missing = dir.join("nope");
        assert!(!dir_exists(missing.to_str().unwrap()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dir_exists_false_for_file() {
        let dir = unique_temp_dir("direxists-file");
        let file = dir.join("f.txt");
        fs::write(&file, b"x").unwrap();
        assert!(!dir_exists(file.to_str().unwrap()));
        fs::remove_dir_all(&dir).unwrap();
    }
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml dir_exists
```

Expected: **compile error** — `cannot find function `dir_exists` in this scope`. (In Rust TDD the failing state for a new function is a compile failure; that counts.)

- [ ] **Step 3: Implement**

In `src-tauri/src/fsops.rs`, after `create_dir` (~line 368), add:

```rust
/// True only for an existing directory (a file at `path` returns false). Backs the
/// frontend session-dir resolver: a worktree only becomes a session's effective
/// directory once it actually exists on disk.
pub fn dir_exists(path: &str) -> bool {
    Path::new(path).is_dir()
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cargo test --manifest-path src-tauri/Cargo.toml dir_exists
```

Expected: `test result: ok. 3 passed`.

- [ ] **Step 5: Wire the Tauri command**

In `src-tauri/src/lib.rs`, in the block commented `// ---- Read-only filesystem (Files tab + viewer)` (right after the `list_dir` command, ~line 1103), add:

```rust
#[tauri::command]
fn dir_exists(path: String) -> bool {
    fsops::dir_exists(&path)
}
```

Then register it in the `tauri::generate_handler![...]` list — add `dir_exists,` on its own line directly after `list_dir,` (~line 1584).

- [ ] **Step 6: Full Rust check**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

Expected: all tests pass, no fmt diff, no new clippy warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/fsops.rs src-tauri/src/lib.rs
git commit -m "feat(fsops): dir_exists command for session-dir confirmation"
```

---

### Task 3: Store — `sessionDirs`, `setSessionDir`, `effectiveDirOf`

**Files:**
- Modify: `src/store.ts` (interface fields near the usage block ending ~line 691; initial value near `agyUsageByAccount: {}` ~line 1018; action near `setAgyUsage` ~line 2259; selector directly after `workingDirOf` ~line 2347)

- [ ] **Step 1: Add the state + action to the `AppState` interface**

In `src/store.ts`, after the `setUsagePrefs` line (~line 691), add:

```ts
  // ---- unified session directory (observed effective dir per session) ----
  /** Session id → CONFIRMED effective working directory: the worktree once it exists
   *  on disk, or the project root. A worktree session PENDING first confirmation has
   *  no entry (consumers fall back to project.path via effectiveDirOf). Runtime-only —
   *  rebuilt by useSessionDirs; never persisted. */
  sessionDirs: Record<string, string>;
  setSessionDir: (sessionId: string, dir: string) => void;
```

- [ ] **Step 2: Add the initial value**

Next to `agyUsageByAccount: {},` (~line 1018), add:

```ts
    sessionDirs: {},
```

- [ ] **Step 3: Add the action**

Near `setAgyUsage` (~line 2259), add:

```ts
    setSessionDir: (sessionId, dir) =>
      set((s) =>
        s.sessionDirs[sessionId] === dir
          ? s
          : { sessionDirs: { ...s.sessionDirs, [sessionId]: dir } },
      ),
```

(The identity short-circuit matters: the resolver may call this every poll tick; returning `s` unchanged avoids re-rendering every subscriber each second.)

- [ ] **Step 4: Add the selector helper**

Directly after `workingDirOf` (~line 2347), add:

```ts
/** Observed effective working directory: the confirmed entry from `sessionDirs` when
 *  present, else the project root. Panels and the companion shell bind to THIS — never
 *  to `workingDirOf` — so a worktree only counts once it exists on disk. */
export function effectiveDirOf(
  project: Project,
  session: Session,
  sessionDirs: Record<string, string>,
): string {
  return sessionDirs[session.id] ?? project.path;
}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): sessionDirs observed-dir map + effectiveDirOf selector"
```

---

### Task 4: Resolver hook + mount

**Files:**
- Create: `src/hooks/useSessionDirs.ts`
- Modify: `src/App.tsx` (import next to `useClaudeAmbient` at line 18; call next to `useClaudeAmbient()` at line 54)

- [ ] **Step 1: Create `src/hooks/useSessionDirs.ts`**

```ts
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

const FAST_POLL_MS = 1000;
/** Confirmed worktrees are re-checked only every Nth tick (the deletion sweep). */
const SWEEP_EVERY_TICKS = 5;

/**
 * The ONE resolver that fills `sessionDirs` (observed effective dir per session).
 * Rules per session:
 *  - no worktreePath           → project.path, written once, never polled
 *  - worktreePath, no entry    → PENDING: poll dir_exists(worktreePath) each tick;
 *                                write worktreePath when it appears. No entry is
 *                                written while pending — effectiveDirOf falls back to
 *                                project.path for panels, and the missing entry keeps
 *                                the companion shell's dirReady false.
 *  - entry === worktreePath    → confirmed: sweep every 5th tick; if the dir is gone,
 *                                fall back to project.path (entry stays present, so
 *                                the shell respawns there instead of going blank).
 *  - entry === project.path,   → the deleted-worktree state; the pending rule above
 *    worktreePath set            keeps polling, so a recreated worktree re-confirms.
 * Local stat every second for the handful of unconfirmed sessions is negligible; no
 * visibility pause needed (unlike the 60 s network poll in useClaudeAmbient).
 */
export function useSessionDirs(): void {
  useEffect(() => {
    let tickCount = 0;
    let running = false;
    let cancelled = false;

    const tick = async () => {
      if (running) return; // a slow tick must not overlap the next interval fire
      running = true;
      tickCount++;
      try {
        const { projects, setSessionDir } = useStore.getState();
        for (const project of projects) {
          for (const session of project.sessions) {
            // Re-read inside the loop: earlier iterations may have written entries.
            const entry = useStore.getState().sessionDirs[session.id];
            const wt = session.worktreePath;
            if (!wt) {
              if (entry !== project.path) setSessionDir(session.id, project.path);
              continue;
            }
            if (entry === wt) {
              if (tickCount % SWEEP_EVERY_TICKS !== 0) continue;
              const exists = await invoke<boolean>("dir_exists", { path: wt }).catch(
                () => false,
              );
              if (cancelled) return;
              if (!exists) setSessionDir(session.id, project.path);
            } else {
              const exists = await invoke<boolean>("dir_exists", { path: wt }).catch(
                () => false,
              );
              if (cancelled) return;
              if (exists) setSessionDir(session.id, wt);
            }
          }
        }
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), FAST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
}
```

- [ ] **Step 2: Mount in `src/App.tsx`**

Add the import next to line 18:

```ts
import { useSessionDirs } from "./hooks/useSessionDirs";
```

Add the call directly after `useClaudeAmbient();` (line 54):

```ts
  useSessionDirs();
```

- [ ] **Step 3: Typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSessionDirs.ts src/App.tsx
git commit -m "feat(session-dirs): app-level resolver polling dir_exists into sessionDirs"
```

---

### Task 5: Consumers — RightColumn, WorkspaceCenter, Sidebar

**Files:**
- Modify: `src/components/RightColumn.tsx` (import ~line 8; new subscription near line 60; dir resolution lines 75–77; shell `TerminalView` props ~line 258)
- Modify: `src/components/WorkspaceCenter.tsx` (import line 6; `GroupTabStrip` subscription near line 384; `wd` at line 409 — line 245 is deliberately untouched)
- Modify: `src/components/Sidebar.tsx` (import line 9; `openInVscode` call line 770)

- [ ] **Step 1: RightColumn — effective dir + dirReady**

In the import block (line 8), replace `workingDirOf,` with `effectiveDirOf,` (after this task RightColumn no longer uses `workingDirOf`).

Near the other store reads (~line 60), add:

```ts
  const sessionDirs = useStore((s) => s.sessionDirs);
```

Replace lines 75–77:

```ts
  const workingDirectory = selected
    ? workingDirOf(selected.project, selected.session)
    : project?.path ?? "";
```

with:

```ts
  const workingDirectory = selected
    ? effectiveDirOf(selected.project, selected.session, sessionDirs)
    : project?.path ?? "";
```

Replace the shell `TerminalView` (~lines 258–266):

```tsx
            <TerminalView
              key={`${session.id}::term`}
              sessionId={`${session.id}::term`}
              projectId={project.id}
              workingDirectory={effectiveDirOf(project, session, sessionDirs)}
              dirReady={!session.worktreePath || sessionDirs[session.id] !== undefined}
              visible={activeSessionId === session.id && bottomTab === "terminal"}
              focusOnReveal={focusShellOnReveal}
              shellOnly
            />
```

(`dirReady` will exist on the props after Task 6; Tasks 5 and 6 typecheck together — see Step 4.)

- [ ] **Step 2: WorkspaceCenter — GroupTabStrip header dir**

Extend the import on line 6 to include `effectiveDirOf` (keep `workingDirOf` — line 245's agent-terminal spawn still uses it and MUST NOT change; the backend resolves that race natively).

In `GroupTabStrip` (function starts line 356), next to the other `useStore` subscriptions (~line 384), add:

```ts
  const sessionDirs = useStore((s) => s.sessionDirs);
```

Replace line 409:

```ts
  const wd = activeSession ? workingDirOf(project, activeSession) : null;
```

with:

```ts
  const wd = activeSession ? effectiveDirOf(project, activeSession, sessionDirs) : null;
```

- [ ] **Step 3: Sidebar — Open in VS Code**

In the import block (line 9), replace `workingDirOf,` with `effectiveDirOf,` (line 770 is Sidebar's only use).

Replace line 770:

```ts
          if (found) void openInVscode(workingDirOf(found.project, found.session));
```

with:

```ts
          if (found)
            void openInVscode(
              effectiveDirOf(found.project, found.session, useStore.getState().sessionDirs),
            );
```

(A click handler reads `getState()` — no subscription, no extra re-renders.)

- [ ] **Step 4: Typecheck expectation**

```bash
pnpm exec tsc --noEmit
```

Expected: exactly ONE error — `dirReady` does not exist on `TerminalView` props (added in Task 6). Any other error is a mistake in this task; fix it before moving on. If executing tasks as separate commits, commit Tasks 5+6 together after Task 6's typecheck passes — or do Task 6 first and this task second; either order leaves every commit green except this intermediate state, which is why Step 5 defers the commit.

- [ ] **Step 5: Do NOT commit yet**

Commit lands at the end of Task 6 so the branch never holds a non-compiling commit.

---

### Task 6: Terminal.tsx — dirReady gate + shell respawn

**Files:**
- Modify: `src/components/Terminal.tsx` (props interface ~line 28; destructure ~line 58; refs ~line 67; `spawnPty` ~line 77; `openPath` base line 149; reveal effect lines 350–380; new respawn effect after line 393)

- [ ] **Step 1: Add the prop**

In the `Props` interface, after `shellOnly?: boolean;` (line 28), add:

```ts
  /**
   * The workingDirectory has been confirmed by the session-dir resolver
   * (useSessionDirs). The PTY is not spawned until this is true, so a worktree
   * shell never spawns into a not-yet-created directory (the old "shell lands in
   * ~" bug). Agent terminals omit it (default true) — pty_spawn resolves their
   * worktree race natively via worktree::spawn_target.
   */
  dirReady?: boolean;
```

In the destructure (after `shellOnly = false,` ~line 58), add:

```ts
  dirReady = true,
```

- [ ] **Step 2: Track the spawned dir + live workingDirectory ref**

Next to the other refs (~line 67, after `spawnedRef`), add:

```ts
  /** Dir the live PTY was spawned in — respawn trigger compares against the prop. */
  const spawnedDirRef = useRef<string | null>(null);
  /** Latest workingDirectory for closures created in the mount-once effect (openPath). */
  const wdRef = useRef(workingDirectory);
  useEffect(() => {
    wdRef.current = workingDirectory;
  }, [workingDirectory]);
```

In `spawnPty`, directly after `spawnedRef.current = true;` (line 79), add:

```ts
    spawnedDirRef.current = workingDirectory;
```

In `openPath` (line 149), replace `base: workingDirectory,` with `base: wdRef.current,` — the mount-once effect captured the mount-time prop; after a shell respawn the old value would resolve Cmd+click paths against the dead directory.

- [ ] **Step 3: Gate the reveal spawn**

In the reveal effect (lines 350–380), replace:

```ts
      if (!spawnedRef.current) {
        spawnPty(cols, rows);
      } else {
```

with:

```ts
      if (!spawnedRef.current) {
        if (dirReady) spawnPty(cols, rows);
      } else {
```

and change the dependency array from `}, [visible]);` to `}, [visible, dirReady]);` — when the resolver confirms the dir while the pane is visible, the effect re-runs and spawns. (Side effect: `focusOnReveal` re-fires on that re-run; the shell passes `focusOnReveal=false` except when the user explicitly opened the Terminal tab, so no focus steal.)

The eager restore-on-open effect (line 386) already returns early for `shellOnly` — no change needed there, and agent terminals keep `dirReady = true`, so its behavior is identical.

- [ ] **Step 4: Respawn on dir change (shell only)**

After the eager restore-on-open effect (after line 393), add:

```ts
  // Shell-only: the resolved directory changed after spawn — a confirmed worktree was
  // deleted (fall back to the project root) or a deleted one came back. Kill + respawn
  // the shell there; scrollback for this pane is intentionally sacrificed. NEVER applied
  // to agent terminals — the keep-alive rule stands.
  useEffect(() => {
    if (!shellOnly || !spawnedRef.current) return;
    if (spawnedDirRef.current === workingDirectory) return;
    void invoke("pty_kill", { sessionId }).catch(() => {});
    spawnedRef.current = false;
    spawnedDirRef.current = null;
    const term = termRef.current;
    term?.reset();
    if (term && visibleRef.current && dirReady) {
      spawnPty(term.cols || 80, term.rows || 24);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDirectory]);
```

(If the pane is hidden when the dir changes, `spawnedRef` is now false and the gated reveal effect spawns fresh — in the new dir — on next reveal. Note `visibleRef` is declared at ~line 349, above this effect, so it is in scope.)

- [ ] **Step 5: Typecheck — must be fully green now**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors (this clears Task 5's expected `dirReady` error).

- [ ] **Step 6: Production build**

```bash
pnpm build
```

Expected: tsc + vite complete without errors.

- [ ] **Step 7: Commit Tasks 5 + 6 together**

```bash
git add src/components/RightColumn.tsx src/components/WorkspaceCenter.tsx src/components/Sidebar.tsx src/components/Terminal.tsx
git commit -m "feat(session-dirs): panels + companion shell bind to confirmed effective dir"
```

---

### Task 7: Manual verification in the dev app

**IMPORTANT — data-dir isolation:** the installed Conduit.app may be running (it hosts live agent sessions). NEVER run a bare `pnpm tauri dev`; always:

```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev
```

- [ ] **Step 1: Launch the dev app** with the command above. In the dev instance, add a scratch project (any small local git repo — create one with `git init /tmp/conduit-verify && cd /tmp/conduit-verify && git commit --allow-empty -m init` if needed).

- [ ] **Step 2: Non-worktree session — no regression.** New session WITHOUT worktree. Expect: shell terminal (bottom-right Terminal tab) spawns immediately, `pwd` prints the project root; Files/Changes/Git show the project root.

- [ ] **Step 3: Worktree session — the headline fix.** New session WITH worktree. Immediately open the bottom Terminal tab. Expect: pane stays blank until the agent creates the worktree (a few seconds), then the shell spawns; `pwd` prints `<project>/.claude/worktrees/<slug>` — NOT `~`, NOT the project root. Files/Changes/Git flip from project root to the worktree at the same moment.

- [ ] **Step 4: Deletion fallback.** From an outside terminal: `git -C <project> worktree remove --force <worktree-path>` (or `rm -rf` + `git worktree prune`). Expect within ~5 s: Files/Changes/Git fall back to the project root; the shell respawns and `pwd` prints the project root.

- [ ] **Step 5: Header + Open in VS Code.** With a worktree session active, the tab-strip path label shows the worktree path; right-click session → Open in VS Code opens the worktree (or project root if you just deleted it).

- [ ] **Step 6: Agent terminal untouched.** The center agent terminal behaves exactly as before in all of the above (spawns immediately, lands in the worktree via its own native handling).

- [ ] **Step 7: Restart with an existing worktree.** Quit the dev app and relaunch (same `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev`). Reopen the worktree session from Step 3 (recreate the worktree first if Step 4 deleted it). Expect: the first resolver tick confirms the on-disk worktree, so the shell spawns there with no visible deferral.

Record actual results per step. Any failure → stop, debug with superpowers:systematic-debugging, do not proceed to Task 8.

---

### Task 8: Version bump + changelog (release 0.17.1)

Panel/terminal directory sync is a fix, not a new capability → PATCH per CLAUDE.md. Verify the current version is still 0.17.0 first (`grep version package.json`); if the branch has moved, bump PATCH from whatever it shows and adjust below accordingly.

**Files:**
- Modify: `package.json` (`"version": "0.17.0"` → `"0.17.1"`)
- Modify: `src-tauri/Cargo.toml` (line 3 `version = "0.17.0"` → `"0.17.1"` — the `[package]` one, not a dependency)
- Modify: `src-tauri/tauri.conf.json` (`"version": "0.17.0"` → `"0.17.1"`)
- Modify: `CHANGELOG.md` (new top entry)

- [ ] **Step 1: Edit the three version fields** as above.

- [ ] **Step 2: Refresh Cargo.lock**

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 3: Add the changelog entry** at the top of the entry list in `CHANGELOG.md`:

```markdown
## 0.17.1 — 2026-07-18

- **Fixed — panels and the companion shell now follow the session's real directory.**
  Files, Changes, Git, and the right-panel terminal all bind to one confirmed
  per-session directory: the session's worktree once it exists on disk, the project
  root otherwise. The companion shell no longer lands in the home directory when it
  opens before a worktree has been created — it waits for the directory, and respawns
  into the right place if the worktree is later deleted (falling back to the project
  root) or recreated.
```

- [ ] **Step 4: Sanity-check lockstep**

```bash
grep -E '"?version"?\s*[:=]\s*"[0-9]' package.json src-tauri/tauri.conf.json; sed -n '3p' src-tauri/Cargo.toml
```

Expected: all three print `0.17.1`.

- [ ] **Step 5: Commit**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock CHANGELOG.md
git commit -m "release: unified session directory sync (v0.17.1)"
```

---

## Integration

Work stays on branch `worktree-file-terminal-git-2e5a4d` in this worktree. **Never push or merge to `main` without explicit human approval** (CLAUDE.md). When all tasks pass, use superpowers:finishing-a-development-branch to present merge/PR options.
