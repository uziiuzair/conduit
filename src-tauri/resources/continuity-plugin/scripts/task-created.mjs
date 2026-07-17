#!/usr/bin/env node
// TaskCreated: record a coordination audit event when a Claude Code task starts,
// so the audit log / digest reflects agent task activity. Fail-open.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  runShim(input.cwd || process.cwd(), ["--audit", "task.created"])
}

main().catch(() => process.exit(0))
