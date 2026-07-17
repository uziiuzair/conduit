---
name: decisions
description: Record and read shared decisions (architecture, tooling, process, scope) so parallel Claude Code sessions stay consistent. Use when you make a call other sessions must respect, when you hit a decision another session already made, or to resolve a decision conflict.
---

# Shared decisions

Decisions are typed, shared, append-only records. They're how parallel sessions
avoid silently contradicting each other (one picks Redis, another picks Postgres
for the same thing).

## When to act

**At the start of a task:** call `decision_recent` to load the current calls
before you make choices that might conflict.

**When you make a significant call** (an architecture/tooling/process/scope
decision others must follow): record it with `decision_write`, using a stable
`decision_key` (e.g. `auth.session-store`).

**On a conflict:** if `decision_write` returns a conflict, an active decision
already exists under that key. Read it. Then either:
- align with it (back off, no new write), or
- if it's genuinely superseded, call `decision_supersede` with the existing id,
  your new content, and a clear `reason`.

Never silently write around a conflict — the whole point is to make disagreements
loud.

## Tools
- `decision_recent` — recent active decisions.
- `decision_get_by_key` — the current decision for a topic.
- `decision_write` — record a new decision (conflict on key collision).
- `decision_supersede` — replace an existing decision.
