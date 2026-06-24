# Worktree isolation per session — design

- **Date:** 2026-06-24
- **Status:** Approved (design); pending implementation plan
- **Topic:** Optional, per-session git worktree isolation for Conduit, delegating creation to Claude Code's native `--worktree`.

## Context

Conduit spawns a real `claude` CLI per session in a PTY (`pty.rs`), grouped by project. Today every session of a project runs in that project's working directory, so parallel sessions share one working tree and can clobber each other's edits. Worktree isolation gives each (opted-in) session its own checkout on its own branch.

Claude Code natively supports this. Verified against the installed CLI (Claude Code **2.1.186**) and the docs:

- `claude --worktree [name]` / `-w` creates a **new git worktree for the session**. There is no `/worktree` slash command or `claude worktree` subcommand. ([worktrees docs](https://code.claude.com/docs/en/worktrees))
- Claude creates the worktree itself (it runs `git worktree add`); it does not expect one to exist.
- **Default path is deterministic:** `<repo>/.claude/worktrees/<name>/`, on a new branch `worktree-<name>`. Omitting the name auto-generates a slug (e.g. `bright-running-fox`).
- Base branch is configurable via the `worktree.baseRef` setting (`fresh` = origin/HEAD default, or `head` = current local HEAD); can also branch from a PR (`--worktree "#1234"`).
- The `WorktreeCreate` hook is an **override** of creation (it must return the path); registering one tells Claude *we* will create the worktree. We must NOT register it.
- Cleanup on a clean interactive exit is automatic; a dirty tree prompts; `-p` runs never auto-clean.
- `--settings <file-or-json>` loads **additional** settings (additive/merge) regardless of working tree. `--setting-sources` also exists.

**Decision (user):** delegate worktree creation/management to Claude Code's native feature; do not invent our own `git worktree add`. Conduit's job is to opt sessions in, point its panels at the worktree, deliver its hooks into the worktree session, and handle cleanup when a Conduit session is deleted.

## Goals

- Per-session, opt-in worktree isolation, chosen at creation time.
- File tree, git graph, and changes panel follow the worktree.
- Live status hooks (status dots / to-dos / notifications) keep working inside worktree sessions.
- Safe cleanup when a Conduit session with a worktree is deleted.

## Non-goals (v1 scope cuts)

- No UI for base branch (`worktree.baseRef`); use Claude's default (`fresh`).
- No PR-based worktrees (`--worktree "#1234"`).
- No `--tmux` (Conduit has its own PTY terminal).
- No branch deletion on cleanup (keep `worktree-<slug>` so commits survive).
- No change to how *normal* (non-worktree) sessions deliver hooks.

## Key decisions

1. **Delegate creation to `claude --worktree <slug>`.** `git.rs` stays read-only for queries; the only Conduit-side git mutation is worktree *removal* during cleanup.
2. **Hooks-in-worktree via `--settings` (Approach A).** A worktree is a separate working tree created after spawn, so the project-root `.claude/settings.local.json` does not reach it, and its directory cannot be pre-seeded (`git worktree add` requires a non-existent dir). For worktree sessions, spawn `claude --worktree <slug> --settings <conduit-hooks.json>` so our hook block loads regardless of the resulting tree. Session routing is unaffected because `CONDUIT_SESSION_ID` is a per-process env var (`pty.rs:110`). Normal sessions are unchanged (they keep the existing project-file install).
   - Rejected B (user-scope `~/.claude/settings.json`): mutates global settings, fires on unrelated `claude` usage.
   - Rejected C (post-create install into the worktree dir): timing race — Claude already read settings at startup, early events lost.
3. **Opt-in UX: prompt on create.** "New Session" opens a small dialog every time: optional session name + an "Isolate in a git worktree" toggle (default off); when on, an optional worktree name. Toggle disabled when the project is not a git repo. This **replaces the current instant "Session N" creation**; leaving the name blank preserves today's behavior (the session is named, then auto-renamed from the first prompt via `maybeAutoName`).
4. **Cleanup on delete: prompt keep/remove.** On deleting a worktree session, check dirty state; prompt keep vs remove; clean tree removes with `git worktree remove`, dirty tree requires explicit force confirmation (`--force`). Branch kept.

## Architecture

### Data model (`store.rs`, `store.ts`)
`Session` already carries `use_worktree`, `worktree_path`, `branch` (all `#[serde(default)]`, so persisted state is compatible). On create-with-worktree:
- generate a safe **slug** = sanitized(name or "session") + short uid (avoids `git worktree add` path/branch collisions),
- set `worktree_path = <project>/.claude/worktrees/<slug>` and `branch = worktree-<slug>` deterministically.

`add_session` (Tauri command + `store.add_session`) gains `use_worktree: bool` and an optional name; it sets the three fields when isolating.

### Spawn (`pty.rs`)
The spawn shell line (`pty.rs:96`) currently runs bare `claude`. When `use_worktree`, build:
```
claude --worktree <slug> --settings <hooks-file>
```
cwd stays the project root so Claude roots the worktree under the repo. `pty_spawn` gains the worktree slug + hooks-file path (or a `use_worktree` flag from which Rust derives them). Normal sessions keep running bare `claude` with the existing project-file hook install.

### Shared hooks JSON (`hooks.rs`)
Refactor `hooks.rs` to expose a single helper that builds the hooks block (the `{ "hooks": { ... } }` object, including the existing curl entries and the Part B lifecycle events). Two consumers:
- the existing file installer (`install`) for normal sessions,
- a new writer that serializes the same block to the `--settings` file for worktree sessions.
A unit test asserts the two produce the same hook entries, so worktree sessions get identical status behavior.

### Panels / path discovery
No discovery hook needed: because we supply the slug, the path is known. `workingDirOf()` already returns `worktree_path ?? project.path`, so setting `worktree_path` makes the file tree, git graph, and changes panel follow automatically. The sidebar row surfaces `branch` so isolation is visible. A brief post-spawn existence check on the worktree dir lets panels fall back to the project root if creation failed.

### Cleanup (`lib.rs` `remove_session`, new git command)
On delete of a worktree session:
1. read-only dirty check (uncommitted / untracked / unmerged commits) on `worktree_path`,
2. frontend confirm: keep vs remove (force shown only when dirty),
3. remove → new `git_worktree_remove` command runs `git worktree remove <path>` (`--force` only when the user confirms on a dirty tree),
4. branch `worktree-<slug>` is kept.
PTY kill order is unchanged (`remove_session` already kills the session + `::term` PTYs first).

## Error handling
- **Collisions:** unique slug per session.
- **Non-git project:** the worktree toggle is disabled (detected via `git::current_branch`).
- **Creation failure:** if the worktree dir never appears, panels fall back to `project.path` and Claude's terminal error is surfaced, not masked.
- **Dirty cleanup:** never silently discard; force requires explicit confirmation.

## Testing
TDD the pure Rust pieces:
- slug generation (sanitization + uniqueness),
- worktree-path / branch-name computation,
- dirty-state parser,
- shared hooks-JSON builder equals the installed hook entries.
Regression: the existing `hooks.rs` install tests must stay green (normal-session path unchanged). Frontend verified by `tsc`; the create dialog and cleanup confirm are UI.

## Risks / to verify during implementation
- **`--settings` carries hooks and merges** (not replaces): confirm empirically that hook entries supplied via `--settings` actually fire in a worktree session. Fallback is Approach B (user-scope) if it does not.
- **Deterministic path/name stability:** confirm Claude does not re-slugify a clean provided name and that the `.claude/worktrees/<name>` + `worktree-<name>` convention holds on 2.1.186. The post-spawn existence check is the safety net.
- **Trust dialog:** first interactive `--worktree` use in a repo may require accepting Claude's workspace-trust prompt; normal Conduit sessions already run `claude` in the project, so trust is typically pre-accepted.

## Implementation status (2026-06-24)

Implemented per plan `docs/superpowers/plans/2026-06-24-worktree-isolation.md` (Tasks 1–6 backend, 8–12 frontend). Automated gates green: 25 Rust tests (incl. worktree slug/path/branch, dirty-check, force-remove, and the `spawn_target` re-enter-or-create decision) and a clean `tsc && vite build`. Two-stage review (spec compliance + code quality) passed for both halves; review nits fixed (notably: `worktree::is_dirty` and the `worktreeIsDirty` UI helper both default to **dirty** on git/IPC error, so a destructive force-remove is never gated by a falsely-clean reading).

**Approach A (hooks via `--settings`) — chosen and built. Empirical validation PENDING the Task 13 manual smoke** (`pnpm tauri dev`): the "submit a prompt → status dot + to-dos update inside a worktree session" check is the first point a worktree session can be spawned through the UI, and it confirms `--settings`-delivered hooks actually fire. If that check fails, switch to **Approach B** (user-scope install into `~/.claude/settings.json`) per Task 7 of the plan — the UI is unaffected; only hook delivery changes. Until the smoke is run, treat Approach A as unverified against a live `claude` session.

## References
- Worktrees: https://code.claude.com/docs/en/worktrees
- Hooks (WorktreeCreate/WorktreeRemove): https://code.claude.com/docs/en/hooks
- CLI reference (`--worktree`, `--settings`, `--setting-sources`): https://code.claude.com/docs/en/cli-reference
