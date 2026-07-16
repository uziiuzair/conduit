---
name: handoffs
description: Hand off work between Claude Code sessions (or to a human), and pick up handoffs left for you. Use when you're stopping mid-task, when work belongs in another session's lane, or at task start to check whether a pending handoff already covers what you're about to do.
---

# Handoffs

A handoff is a structured transfer of in-flight work: enough context and state for
another session (or a human) to continue cleanly.

## When to act

**At task start:** call `handoff_pending` to see if something is already waiting
for you. A pending handoff may be exactly the work you were about to start — if
so, `handoff_accept` it instead of duplicating.

**When you stop mid-task or hand work off:** call `handoff_create`. Target a
specific session (`to_session_id`) or broadcast (omit it). Put enough in `state`
(branch name, files touched, links, pending decisions) and
`suggested_next_actions` that the receiver doesn't have to reverse-engineer where
you were.

**When you finish handed-off work:** `handoff_complete` it.

## Tools
- `handoff_pending` — handoffs waiting for you.
- `handoff_create` — hand off work (targeted or broadcast).
- `handoff_accept` — take ownership of a pending handoff.
- `handoff_complete` — mark a handoff done.
