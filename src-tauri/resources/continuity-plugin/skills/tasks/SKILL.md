---
name: tasks
description: Claim a task or issue before working on it so other Claude Code sessions don't duplicate the work. Use when you begin substantive work tied to an issue — claim it first, update its status as you go, and complete or release it when done.
---

# Task claims

A claim is a soft, atomic "I've got this" marker on an issue or task. It makes
your work visible to other sessions immediately, before any external tracker
(GitHub, etc.) reflects it. Claims are race-proof: if two sessions claim the same
issue at once, exactly one wins and the other sees a conflict.

## When to act

**Before starting work on an issue:** call `task_claim` with the `repo_full_name`
and `issue_number`. If it returns a conflict, someone else holds it — pick another
task or coordinate, don't work it in parallel.

**As you progress:** call `task_update` to move it through `in_progress` →
`pr_open` (with the `pr_number`), adding `notes` as useful.

**When done:** call `task_complete`. If you're abandoning it, call `task_release`
so another session can pick it up.

**To see what's claimed:** call `task_list` (optionally filtered by status or
repo).

## Tools
- `task_claim` — claim an issue (conflict if already live-claimed).
- `task_update` — update status / PR number / notes.
- `task_release` — give up a claim.
- `task_complete` — mark a claim done.
- `task_list` — list current claims.

## Notes
- Claims auto-expire after a period of inactivity, so a crashed session doesn't
  block an issue forever.
- In team mode a separate set of `github_*` tools can also assign the issue to the
  human on GitHub; in local mode `task_claim` is the coordination layer.
