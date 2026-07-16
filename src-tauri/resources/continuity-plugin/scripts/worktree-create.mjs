#!/usr/bin/env node
// WorktreeCreate: a new git worktree is a new working context — check in so the
// session is visible there. Fail-open.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  // Prefer the new worktree path if the event provides one, else the cwd.
  const dir = input.worktree_path || input.path || input.cwd || process.cwd()
  runShim(dir, ["--checkin"])
}

main().catch(() => process.exit(0))
