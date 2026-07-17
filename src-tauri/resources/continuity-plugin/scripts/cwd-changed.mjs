#!/usr/bin/env node
// CwdChanged: the working directory changed, which may be a different repo/
// checkout — re-establish presence for the new context. Fail-open.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  runShim(input.cwd || process.cwd(), ["--checkin"])
}

main().catch(() => process.exit(0))
