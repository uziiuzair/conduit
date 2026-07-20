// Mirror of packages/mcp/src/doctor.ts (duplicate-install detection only).
// A stale second continuity plugin silently shadows this one's skills — the
// SessionStart hook surfaces that instead of leaving the user to guess.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function listContinuityInstalls(installedPluginsJson) {
  try {
    const parsed = JSON.parse(installedPluginsJson)
    const out = []
    for (const [key, entries] of Object.entries(parsed?.plugins ?? {})) {
      if (key.split("@")[0] !== "continuity") continue
      const first = Array.isArray(entries) ? entries[0] : undefined
      out.push({ key, scope: first?.scope ?? null, version: first?.version ?? null })
    }
    return out
  } catch {
    return []
  }
}

// Enable state resolves last-wins across the chain (user → project → local);
// an install never mentioned is enabled. A disabled duplicate is harmless.
function isEnabled(key, settingsChain) {
  let on = true
  for (const s of settingsChain) {
    const v = s?.enabledPlugins?.[key]
    if (typeof v === "boolean") on = v
  }
  return on
}

export function duplicateInstallWarning(installedPluginsJson, settingsChain = []) {
  const installs = listContinuityInstalls(installedPluginsJson).filter((i) =>
    isEnabled(i.key, settingsChain),
  )
  if (installs.length < 2) return null
  const listed = installs
    .map((i) => `${i.key}${i.scope ? ` (${i.scope} scope)` : ""}${i.version ? ` v${i.version}` : ""}`)
    .join(", ")
  return (
    `⚠ Continuity: ${installs.length} continuity plugins are installed — ${listed}. ` +
    `Duplicate installs shadow each other's skills and confuse coordination; uninstall all but one ` +
    `(claude plugin uninstall, or the /plugin menu). Please surface this warning to the user.`
  )
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// The enabledPlugins chain, in override order: user settings, then the
// project's settings, then its local settings.
export function settingsChain(projectDir) {
  const chain = [readJson(join(homedir(), ".claude", "settings.json"))]
  if (projectDir) {
    chain.push(readJson(join(projectDir, ".claude", "settings.json")))
    chain.push(readJson(join(projectDir, ".claude", "settings.local.json")))
  }
  return chain
}

// Convenience for hooks: read the registry and return the warning (or null).
// Fail-open: any read/parse problem is treated as "no duplicates".
export function duplicateInstallWarningFromDisk(projectDir) {
  try {
    const raw = readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8")
    return duplicateInstallWarning(raw, settingsChain(projectDir))
  } catch {
    return null
  }
}
