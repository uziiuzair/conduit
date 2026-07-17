---
name: coordination
description: Coordinate with other Claude Code sessions working on this project in parallel. Use at the start of substantive work, and before editing a file, to check who else is active and which files other sessions are touching — so you don't duplicate work or collide. Also use to advertise what you're working on.
---

# Coordinating with other sessions

When more than one Claude Code session runs at once — your own parallel sessions,
or teammates' — Continuity gives you a shared, live view of them. Use it
proactively; the point is to avoid two sessions silently editing the same code.

The SessionStart snapshot already shows you a point-in-time view. Use these tools
to refresh it during a session.

## When to act

**Before starting a distinct piece of work:**
1. Call `agent_list_active` to see who else is working and on what.
2. Call `agent_report_focus` with a one-line summary of what you're about to do,
   so other sessions can see it.

**Before editing a shared file:**
1. Call `agent_file_activity_recent` (optionally with `path_prefix` set to the
   directory you're about to touch).
2. If another session has touched that file recently **in the same repo**, treat
   it as a collision risk: prefer coordinating (leave it to them, pick a different
   file, or note the overlap to the user) over editing in parallel. Overlapping
   edits are the exact failure this system exists to prevent.

## Tools

- `agent_list_active` — other sessions currently active (presence + focus).
- `agent_file_activity_recent` — files other sessions edited recently.
- `agent_report_focus` — update your own current focus.
- `agent_get` — full detail for one session by id.

## Notes

- These tools are inert outside a git repo (and outside the allowlist, if one is
  configured) — they only do anything where Continuity is active.
- This is best-effort visibility, not a lock. It makes collisions *loud*; the
  judgment call (coordinate vs. proceed) is yours. When in doubt, surface the
  overlap to the user.
