#!/usr/bin/env node
// UserPromptSubmit: sync this session's focus AND inject what changed since the
// last prompt (new sessions, others' file activity, decisions, handoffs). The
// shim throttles the backend fetch (~20s window) so rapid prompting only pays
// the focus heartbeat. Best-effort, fail-open; the prompt is truncated
// server-side.
import { runShim } from "./lib/run-shim.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

async function main() {
  const input = await readStdinJson()
  const prompt = typeof input.prompt === "string" ? input.prompt.replace(/\s+/g, " ").trim() : ""
  const out = runShim(input.cwd || process.cwd(), ["--prompt-sync", prompt.slice(0, 280)], {
    timeout: 5_000,
  })
  if (out?.trim()) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: out },
      }),
    )
  }
}

main().catch(() => process.exit(0))
