import { execFileSync } from "node:child_process"
import { join } from "node:path"

// Continuity needs node:sqlite, which ships in Node 22.5+. Hooks use this to
// fail open (and SessionStart uses it to warn loudly) on older Nodes.
export function nodeSupported() {
  const [major, minor] = process.versions.node.split(".").map(Number)
  return major > 22 || (major === 22 && minor >= 5)
}

// Shell out to the bundled shim with a one-shot subcommand (e.g. --checkout,
// --focus, --audit). Keeping the backend logic in the shim lets the hooks stay
// zero-dependency and flavor-agnostic (the shim picks local vs team itself).
// Returns the child's stdout, or null on any failure (hooks always fail open).
// The default timeout stays under the tightest synchronous hook budget
// (UserPromptSubmit: 10s) so the shim never outlives the hook that ran it.
export function runShim(cwd, args, { timeout = 8_000 } = {}) {
  const root = process.env.CLAUDE_PLUGIN_ROOT
  if (!root) return null
  if (!nodeSupported()) return null

  // Prefer CONTINUITY_* (interpolated from ${user_config.*} in the hook env);
  // fall back to the CLAUDE_PLUGIN_OPTION_* forms Claude Code exports (the key
  // casing varies, so try both APIURL and API_URL).
  const opt = (...names) => {
    for (const n of names) {
      const v = process.env[n]
      if (v != null && v !== "") return v
    }
    return ""
  }
  const env = {
    ...process.env,
    CONTINUITY_API_URL: opt("CONTINUITY_API_URL", "CLAUDE_PLUGIN_OPTION_APIURL", "CLAUDE_PLUGIN_OPTION_API_URL"),
    CONTINUITY_API_KEY: opt("CONTINUITY_API_KEY", "CLAUDE_PLUGIN_OPTION_APIKEY", "CLAUDE_PLUGIN_OPTION_API_KEY"),
    CONTINUITY_REPO_ALLOWLIST: opt(
      "CONTINUITY_REPO_ALLOWLIST",
      "CLAUDE_PLUGIN_OPTION_REPOALLOWLIST",
      "CLAUDE_PLUGIN_OPTION_REPO_ALLOWLIST",
    ),
  }
  const dbPath = opt("CONTINUITY_DB_PATH", "CLAUDE_PLUGIN_OPTION_DBPATH", "CLAUDE_PLUGIN_OPTION_DB_PATH")
  if (dbPath) env.CONTINUITY_DB_PATH = dbPath
  // Silence the node:sqlite ExperimentalWarning on Node 22.x–23.x.
  env.NODE_NO_WARNINGS = "1"

  try {
    // launch.mjs handles the node:sqlite flag dance (needed on 22.x–23.x).
    return execFileSync(process.execPath, [join(root, "mcp", "launch.mjs"), ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    })
  } catch {
    return null
  }
}
