# Session resume persistence — design

- **Date:** 2026-06-24
- **Status:** Approved (design); pending implementation plan
- **Topic:** Persist Claude conversations across a full Conduit restart by pinning each session's Claude session id to Conduit's own id and resuming it on cold spawn.

## Context

Conduit spawns a real `claude` CLI per session in a PTY (`pty.rs`). Session *metadata* (id, name, worktree, layout) is persisted to `~/Library/Application Support/ConduitTauri/state.json` and reloads on startup (`store.rs` → `load_projects`), so the sidebar survives an app restart. The *conversation* does not.

Traced root cause:

- `pty.rs:96` launches a **bare `claude`** every cold spawn: `... cd {dir} && claude; exec {shell}`. That starts a brand-new Claude conversation each time.
- `CONDUIT_SESSION_ID` is Conduit's own UUID, used **only** to route hook events back to the right sidebar entry (`hooks.rs:210`, via the `?session=` query param). Claude never receives it; Claude mints its *own* session UUID and writes the transcript to `~/.claude/projects/<cwd-slug>/<claude-uuid>.jsonl`.
- `lib.rs:327` calls `pty.kill_all()` on `ExitRequested`, killing every Claude process on quit. On relaunch the sidebar repopulates from `state.json`, but the first view of a session spawns a fresh `claude` with no link to the old transcript.

Verified against the installed `claude` CLI:

- `claude --session-id <uuid>` — "Use a specific session ID for the conversation." Lets us *pin* Claude's session id to a UUID we choose.
- `claude -r, --resume [value]` — "Resume a conversation by session ID" (no value → interactive picker; we always pass the id, so no picker).
- `claude -c, --continue` — "Continue the most recent conversation in [cwd]."
- `--fork-session` — "When resuming, create a new session ID." Its existence implies plain `--resume` is **non-forking** (appends to the same transcript) — the one assumption to confirm empirically.
- Transcript layout confirmed on disk: `~/.claude/projects/-Users-uziiuzair-ooozzy-Conduit/<uuid>.jsonl` (cwd slug = `/`→`-`).

**Decision (user):** identity-merge approach (A). Make Claude adopt Conduit's per-session UUID via `--session-id`, then resume it via `--resume`. Behavior: **auto-resume silently** on first view after restart; **replay only** on a mid-task session (the killed process is not auto-continued — which is exactly default `--resume` behavior).

## Goals

- A Claude conversation survives a full Conduit quit + relaunch.
- On the first view of a session after restart, its prior conversation is transparently restored and the user lands at the prompt.
- Correct for multiple sessions sharing one project directory (no cross-talk).
- Smallest viable change: no `state.json` schema change, no frontend change, no IPC change.

## Non-goals (v1 scope cuts)

- **No recovery of pre-feature history.** Sessions created before this feature have transcripts under Claude-chosen ids we never recorded; their old conversation is unreachable. They start fresh once, then persist forever after. (This is the cost of avoiding Approach B's capture-and-map machinery.)
- **No auto-continue of interrupted work.** Replay history and stop at the prompt; the user re-prompts. (User choice.)
- **No "Start fresh" / "Resume vs fresh" UI.** Auto-resume is unconditional for sessions that have a transcript. (Can be added later.)
- **No resume for the bottom-panel shell terminal** (`shell_only`, id `<id>::term`) — a shell has no transcript. Untouched.

## Key decisions

1. **Identity-merge via `--session-id` / `--resume` (Approach A).** Conduit already mints a per-session UUID (`Uuid::new_v4()` in `store.add_session`) and threads it as `CONDUIT_SESSION_ID`. Passing that same id to `--session-id` collapses Conduit's and Claude's session identities into one, so resume needs no mapping table.
   - Rejected B (capture Claude's id from hook payloads, persist a mapping, resume by it): needs a schema change, depends on hooks firing to *learn* the id, and must track id changes on `/clear`/compaction. More failure modes.
   - Rejected C (`claude --continue`): "most recent in cwd" breaks Conduit's multiple-sessions-per-project model — two tabs in one dir fight over one transcript.

2. **Stateless, slug-independent detection.** Decide resume-vs-new by checking whether a transcript file named `<session-id>.jsonl` exists anywhere under `~/.claude/projects/*/`. Searching by the globally-unique UUID *filename* avoids reproducing Claude's directory-slug algorithm (`/`→`-`, `.`→`-`, …), so it stays correct for worktree cwds too. The on-disk transcript is the source of truth — self-healing, no migration, no persisted flag to desync.

3. **Fallback chain so no branch ever strands the user.** Each invocation degrades to a working prompt:
   - exists → `claude --resume <id> || claude`
   - first launch → `claude --session-id <id> || claude`

4. **Decide in Rust, not shell.** The PTY runs `$SHELL -i -l -c <inner>`, and `$SHELL` may be zsh/bash/fish with incompatible globbing. Rust computes existence and emits a concrete command string — portable and unit-testable, matching the codebase's "Rust builds the command" style.

5. **Only cold spawns resume.** The keep-alive re-attach fast-path at the top of `pty.rs::spawn` is left untouched, so a live session on a webview reload still re-attaches to its running process and is never "resumed" out from under itself.

## Architecture

### Detection helper (`pty.rs`)
New pure-ish helper, e.g. `transcript_exists(session_id: &str, projects_dir: &Path) -> bool`:
- `read_dir(projects_dir)`; for each child dir, test `child.join(format!("{session_id}.jsonl")).exists()`; return on first hit.
- `projects_dir` resolved from `CLAUDE_CONFIG_DIR`/`projects` if set, else `dirs::home_dir()?/.claude/projects`. Taking `projects_dir` as a parameter keeps it testable with a temp dir.

### Command selection (`pty.rs`)
New helper, e.g. `claude_invocation(session_id: &str, projects_dir: &Path) -> String`, returns:
- `claude --resume '<id>' || claude` when the transcript exists,
- `claude --session-id '<id>' || claude` otherwise.
`<id>` interpolated through the existing `shell_quote`.

### Integration point (`pty.rs::spawn`, non-`shell_only` branch only)
The literal `claude` in the `inner` string (`pty.rs:96`) is replaced by the result of `claude_invocation(...)`. Everything else on that line is unchanged: `CONDUIT_SESSION_ID`, `CONDUIT_HOOK_PORT`, `CLAUDE_CODE_ENABLE_TASKS=0`, `cd {dir}`, and the trailing `exec {shell} -i -l`. The `shell_only` branch is unchanged.

### Blast radius
Single file (`pty.rs`) for behavior, plus its unit tests. No changes to `store.rs`/`store.ts` (no schema change), `lib.rs` (`pty_spawn` signature unchanged — `session_id` and `working_directory` already present), `hooks.rs`, IPC, or React.

### Side effect (positive, not relied upon)
Once Claude adopts Conduit's id, the hook payload's `session_id` equals `CONDUIT_SESSION_ID`. Routing still uses the `?session=` query param, so nothing depends on this; it's a consistency bonus.

## Error handling

- **Resume failure** (corrupt/locked/missing transcript): `|| claude` drops to a fresh working session rather than a dead prompt.
- **`--session-id` collision** (id already in use — shouldn't occur since we'd have chosen resume): `|| claude` falls through to a bare session.
- **Invalid UUID for `--session-id`:** not possible — session ids are minted by Rust `Uuid::new_v4()`. (The frontend `uid()` fallback is used only for group/layout ids, never session ids.)
- **Missing `~/.claude/projects`:** `transcript_exists` returns false → first-launch path → `--session-id` creates it. Correct.

## Testing

TDD the pure Rust pieces, mirroring the `hooks.rs` test style (temp dirs, `AtomicU32`-tagged fresh dirs):
- `transcript_exists`: false on empty temp projects dir; true when `<slug>/<id>.jsonl` is planted under an arbitrary slug dir (proving slug-independence); unaffected by a same-name file under a different id.
- `claude_invocation`: contains `--resume '<id>'` when the transcript exists; contains `--session-id '<id>'` when it does not; both end with the `|| claude` fallback; id is shell-quoted.

Manual verification (the assumption that needs a live run):
1. New session → send a message → quit the app → relaunch → click the session → confirm the conversation replays and lands at the prompt.
2. Send another message → quit → relaunch → confirm **both** rounds are present (proves `--resume` is non-forking and accumulates into one `<id>.jsonl`).
3. Two sessions in the same non-worktree project → confirm each resumes its own conversation, no cross-talk.

## Risks / to verify during implementation

- **`--resume` is non-forking.** Strongly implied by the separate `--fork-session` flag; confirm via manual step 2 above. If it *did* fork, repeated restarts would still resume the original transcript and silently drop the latest round — so this is the one must-verify.
- **Resume render volume.** `--resume` replays the conversation into the TTY; xterm scrollback is 5000 lines (`Terminal.tsx:55`). Claude's resume render is typically compact (state summary, not a full token re-stream); acceptable, but watch for truncation on very long histories.
- **`CLAUDE_CONFIG_DIR` honored** so detection still works for users who relocate `~/.claude`.

## References
- CLI reference (`--session-id`, `--resume`, `--continue`, `--fork-session`): https://code.claude.com/docs/en/cli-reference
- Transcript storage: `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
- Related design: `docs/superpowers/specs/2026-06-24-worktree-isolation-design.md` (worktree cwd interplay)
