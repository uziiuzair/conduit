#!/usr/bin/env node
// TaskCompleted: record a coordination audit event when a Claude Code task
// finishes. Fail-open.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  runShim(input.cwd || process.cwd(), ["--audit", "task.completed"])
}

main().catch(() => process.exit(0))
