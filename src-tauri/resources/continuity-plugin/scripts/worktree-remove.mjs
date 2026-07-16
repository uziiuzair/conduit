#!/usr/bin/env node
// WorktreeRemove: a worktree is going away — check out its session so it doesn't
// linger as active presence. Fail-open.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  const dir = input.worktree_path || input.path || input.cwd || process.cwd()
  runShim(dir, ["--checkout"])
}

main().catch(() => process.exit(0))
