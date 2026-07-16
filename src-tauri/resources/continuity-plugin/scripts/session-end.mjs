#!/usr/bin/env node
// SessionEnd: check out this session and clear the rendezvous state. The shim
// also checks out on SIGTERM, and lazy/janitor expiry is a backstop — this just
// makes the departure prompt and clean. Fail-open.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  runShim(input.cwd || process.cwd(), ["--checkout"])
}

main().catch(() => process.exit(0))
