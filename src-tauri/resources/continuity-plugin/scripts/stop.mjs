#!/usr/bin/env node
// Stop: block ending the turn while unexpired response-required messages are
// pending. At most one block per stop chain (stop_hook_active), and expired
// items never block — the timeout-override rule. Fail-open everywhere.
import { repoAllowlistFromEnv } from "./lib/env.mjs"
import { resolveRepoContext } from "./lib/gate.mjs"
import { stopGateDecision } from "./lib/guard.mjs"
import { readState } from "./lib/state.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  const repo = resolveRepoContext(input.cwd || process.cwd(), repoAllowlistFromEnv())
  if (!repo) return
  const state = readState(repo.cwdHash)
  const decision = stopGateDecision({
    pendingInbound: state?.pending_inbound,
    stopHookActive: Boolean(input.stop_hook_active),
    nowMs: Date.now(),
  })
  if (decision.block) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }))
  }
}

main().catch(() => process.exit(0))
