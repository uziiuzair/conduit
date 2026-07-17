#!/usr/bin/env node
// PreToolUse (Write|Edit|MultiEdit|NotebookEdit): two independent gates.
//
// 1. Collision guard: if another live session touched the same file recently
//    (per the others-activity cache the shim maintains in the state file),
//    deny the edit per collisionGuard mode (negotiate/warn/off — see guard.mjs)
//    with an instructive reason. No network, no DB: a pure state-file read, so
//    the hot path stays fast. Set collisionGuard=off in the plugin config to
//    disable.
// 2. Ack gate: response-required inbound messages block further edits until
//    answered or dismissed (or they expire). This runs regardless of the
//    collision guard mode — collisionGuard configures file-collision handling
//    only, not the separate obligation to respond to messages.
//
// Fail-open everywhere.
import { repoRelative } from "./lib/common.mjs"
import { collisionGuardFromEnv, repoAllowlistFromEnv } from "./lib/env.mjs"
import { resolveRepoContext } from "./lib/gate.mjs"
import { ackGateDecision, collisionDecisionV2, parseGuardMode } from "./lib/guard.mjs"
import { readState, writeState } from "./lib/state.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

const ALLOWED = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  )
}

async function main() {
  const input = await readStdinJson()
  const cwd = input.cwd || process.cwd()
  if (!ALLOWED.has(input.tool_name) || !input.tool_input?.file_path) return

  const mode = parseGuardMode(collisionGuardFromEnv())
  const repo = resolveRepoContext(cwd, repoAllowlistFromEnv())
  if (!repo) return

  const rel = repoRelative(repo.toplevel, input.tool_input.file_path)
  if (!rel) return

  const state = readState(repo.cwdHash)
  const nowMs = Date.now()

  if (mode !== "off") {
    const collision = collisionDecisionV2({
      mode,
      entries: state?.others_activity,
      relPath: rel,
      warned: state?.collision_warned,
      collisionSent: state?.collision_sent,
      nowMs,
    })
    if (collision.action === "deny") {
      // read-modify-write without a lock: a concurrent shim sync landing in this window is clobbered and self-heals next sync (accepted idiom, see persistCoordinationCaches)
      if (collision.warned && state) writeState(repo.cwdHash, { ...state, collision_warned: collision.warned })
      return deny(collision.reason)
    }
  }

  // Ack gate runs even when the collision guard is off — unanswered
  // response-required messages are a separate obligation.
  const ack = ackGateDecision({
    pendingInbound: state?.pending_inbound,
    messageWarned: state?.message_warned,
    nowMs,
  })
  if (ack.action === "deny") {
    // read-modify-write without a lock: a concurrent shim sync landing in this window is clobbered and self-heals next sync (accepted idiom, see persistCoordinationCaches)
    if (ack.warned && state) writeState(repo.cwdHash, { ...state, message_warned: ack.warned })
    return deny(ack.reason)
  }
}

main().catch(() => process.exit(0))
