#!/usr/bin/env node
// PostToolUse (Write|Edit|MultiEdit|NotebookEdit): record file activity. Appends
// the touched path to the rendezvous state file's pending_files (deduped). The
// long-lived shim flushes the buffer to whichever backend on its heartbeat —
// so this hook needs no network/DB access and works in both flavors.
import { repoRelative } from "./lib/common.mjs"
import { repoAllowlistFromEnv } from "./lib/env.mjs"
import { resolveRepoContext } from "./lib/gate.mjs"
import { readState, writeState } from "./lib/state.mjs"
import { readStdinJson } from "./lib/stdin.mjs"

const ALLOWED = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

async function main() {
  const input = await readStdinJson()
  const cwd = input.cwd || process.cwd()
  const tool = input.tool_name
  const filePath = input.tool_input?.file_path
  if (!ALLOWED.has(tool) || !filePath) return

  const repo = resolveRepoContext(cwd, repoAllowlistFromEnv())
  if (!repo) return

  const rel = repoRelative(repo.toplevel, filePath)
  if (!rel) return

  const state =
    readState(repo.cwdHash) ?? {
      session_id: null,
      agent_label: null,
      project_scope: null,
      pending_files: [],
      last_file_report_at: null,
    }
  // Dedupe within the buffer so repeated edits to one file don't bloat it.
  const pending = (state.pending_files ?? []).filter((p) => p.path !== rel)
  pending.push({ path: rel, tool })
  writeState(repo.cwdHash, { ...state, pending_files: pending })
}

main().catch(() => process.exit(0))
